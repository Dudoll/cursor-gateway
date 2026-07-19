//! Cursor Gateway desktop shell.
//!
//! Loads the bundled Secure Web E2EE UI from the local `tauri://` /
//! `http://tauri.localhost` protocol. Cloudflare Access cookies are **not**
//! sent on cross-site fetches from that origin, so API traffic is proxied
//! through a same-site "Access bridge" WebView pointed at the Gateway.
//!
//! After Access login the bridge window is hidden (kept alive for cookies) and
//! controlled from the system tray.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Listener, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const BRIDGE_LABEL: &str = "access-bridge";
const BRIDGE_READY_EVENT: &str = "cg-access-bridge-ready";
const PASSKEY_BRIDGE_LABEL: &str = "passkey-bridge";

struct BridgeState {
    next_id: AtomicU64,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeFetchRequest {
    gateway_origin: String,
    path: String,
    method: Option<String>,
    headers: Option<serde_json::Map<String, serde_json::Value>>,
    body: Option<String>,
    /// When true, response body is base64 (for installer downloads).
    binary: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeFetchResponse {
    status: u16,
    body: String,
    content_type: Option<String>,
    request_id: Option<String>,
    opaque_redirect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopVersionInfo {
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPasskeyRequest {
    passkey_origin: String,
    mode: String,
    options: serde_json::Value,
}

fn normalize_gateway_origin(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|e| format!("invalid_gateway_origin:{e}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("invalid_gateway_origin_scheme".into());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("invalid_gateway_origin_credentials".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn bridge_url(origin: &str) -> Result<url::Url, String> {
    let base = format!("{}/api/desktop/access/bridge", origin.trim_end_matches('/'));
    url::Url::parse(&base).map_err(|e| format!("invalid_bridge_url:{e}"))
}

fn normalize_passkey_origin(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "passkey_origin_invalid".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("passkey_origin_invalid".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "passkey_origin_invalid".to_string())?;
    // This signed desktop build only grants remote IPC to the production
    // domain family. Keep the WebAuthn bridge equally narrow.
    if host != "joelzt.org" && !host.ends_with(".joelzt.org") {
        return Err("passkey_origin_not_allowed".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn passkey_bridge_url(origin: &str) -> Result<url::Url, String> {
    let base = format!(
        "{}/passkey-bridge.html?desktop=1",
        origin.trim_end_matches('/')
    );
    url::Url::parse(&base).map_err(|_| "passkey_bridge_url_invalid".to_string())
}

fn passkey_rp_id(request: &DesktopPasskeyRequest) -> Result<String, String> {
    let value = match request.mode.as_str() {
        "registration" => request
            .options
            .get("rp")
            .and_then(|rp| rp.get("id"))
            .and_then(|id| id.as_str()),
        "authentication" => request.options.get("rpId").and_then(|id| id.as_str()),
        _ => return Err("passkey_mode_invalid".into()),
    }
    .ok_or_else(|| "passkey_rp_id_missing".to_string())?
    .trim()
    .to_ascii_lowercase();

    if value.is_empty()
        || value.len() > 253
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
    {
        return Err("passkey_rp_id_invalid".into());
    }
    Ok(value)
}

fn origin_can_use_rp_id(origin: &str, rp_id: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let rp_id = rp_id.to_ascii_lowercase();
    host == rp_id || host.ends_with(&format!(".{rp_id}"))
}

/// WebView2 (Windows) throttles and eventually suspends the renderer of a
/// hidden / minimized / occluded WebView. That silently stalled the Access
/// bridge's `fetch()` — the injected request never ran, so the POST to
/// `/api/e2ee/v1/approvals/request` never reached the Gateway and the command
/// timed out with `access_bridge_fetch_timeout` (surfaced as the generic
/// "设备批准失败：unknown_error" before the error-mapping fix).
///
/// Tauri's `backgroundThrottling` config only takes effect on WebKit
/// (macOS/iOS), so on Windows we disable throttling through Chromium's startup
/// flags. WebView2 reads these from `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
/// when its environment is created, so this must be set before any window (and
/// thus the shared WebView2 environment) is built.
const WEBVIEW2_ARGS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

const WEBVIEW2_NO_THROTTLE_FLAGS: &[&str] = &[
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
];

/// Merge our no-throttle flags into any pre-existing WebView2 argument string
/// without duplicating flags already present. Pure so it can be unit-tested.
fn webview2_browser_args(existing: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(existing) = existing {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }
    for flag in WEBVIEW2_NO_THROTTLE_FLAGS {
        let already = parts.iter().any(|p| p.split_whitespace().any(|t| t == *flag));
        if !already {
            parts.push((*flag).to_string());
        }
    }
    parts.join(" ")
}

/// Ensure the hidden Access-bridge WebView keeps running (no background
/// throttling) so it can proxy API calls while parked in the tray.
fn ensure_webview2_no_throttle() {
    let existing = std::env::var(WEBVIEW2_ARGS_ENV).ok();
    let combined = webview2_browser_args(existing.as_deref());
    std::env::set_var(WEBVIEW2_ARGS_ENV, combined);
}

/// Park the bridge out of the user's way after login. The WebView2 renderer is
/// kept alive (throttling is disabled globally, see `ensure_webview2_no_throttle`)
/// so the hidden window can still proxy API calls.
fn hide_bridge_to_tray(window: &WebviewWindow) {
    let _ = window.set_skip_taskbar(true);
    let _ = window.hide();
}

async fn wait_bridge_ready(
    app: &AppHandle,
    window: &WebviewWindow,
    timeout: Duration,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let tx = std::sync::Mutex::new(Some(tx));
    let id = app.listen(BRIDGE_READY_EVENT, move |_| {
        if let Ok(mut slot) = tx.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(());
            }
        }
    });

    let deadline = tokio::time::Instant::now() + timeout;
    let mut rx = rx;
    let result = loop {
        if eval_bridge_ready(window).await.unwrap_or(false) {
            break Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            break Err("access_bridge_login_timeout".into());
        }
        // Prefer the page-emitted ready event when remote IPC works; otherwise
        // the eval probe above eventually succeeds after Access redirects.
        match tokio::time::timeout(Duration::from_millis(400), &mut rx).await {
            Ok(Ok(())) => break Ok(()),
            Ok(Err(_)) => break Err("access_bridge_ready_channel_closed".into()),
            Err(_) => {} // poll again
        }
    };

    app.unlisten(id);
    result
}

/// Create the Access bridge window if missing, then show + focus it.
///
/// This deliberately does **not** wait for Cloudflare Access login to complete:
/// the window must pop up immediately when the user clicks "登录 Cloudflare
/// Access". Login completion is observed separately (frontend polling of
/// `/api/e2ee-policy`, or `wait_bridge_ready` in `desktop_access_ensure`).
///
/// Window creation runs from an `async` command, which is required on Windows —
/// `WebviewWindowBuilder::build()` deadlocks inside synchronous commands
/// (WebView2 UI-thread reentrancy).
async fn open_bridge_window(app: &AppHandle, origin: &str) -> Result<WebviewWindow, String> {
    let url = bridge_url(origin)?;

    if let Some(existing) = app.get_webview_window(BRIDGE_LABEL) {
        // Already logged in and hidden to tray → nothing to show; the next API
        // call through the bridge will succeed. Otherwise surface the window so
        // the user can complete Access login.
        let ready = eval_bridge_ready(&existing).await.unwrap_or(false);
        if !ready {
            let _ = existing.show();
            let _ = existing.unminimize();
            let _ = existing.set_focus();
        }
        return Ok(existing);
    }

    let window = WebviewWindowBuilder::new(app, BRIDGE_LABEL, WebviewUrl::External(url))
        .title("Cloudflare Access 登录")
        .inner_size(520.0, 780.0)
        .resizable(true)
        .center()
        .visible(true)
        .focused(true)
        .build()
        .map_err(|e| format!("access_bridge_create:{e}"))?;

    // Explicit show/focus: external-URL windows on Windows do not always appear
    // in the foreground on build alone.
    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

/// Return the bridge window only if it exists and Access login is complete.
/// Used by non-interactive API proxying — never creates a window.
async fn require_ready_bridge_window(app: &AppHandle, _origin: &str) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(BRIDGE_LABEL) {
        if eval_bridge_ready(&existing).await.unwrap_or(false) {
            // Login is done: keep the WebView alive for cookies but out of the way.
            hide_bridge_to_tray(&existing);
            return Ok(existing);
        }
    }
    Err("cloudflare_login_required".into())
}

async fn eval_bridge_ready(window: &WebviewWindow) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let tx = std::sync::Mutex::new(Some(tx));
    let event_name = format!("cg-bridge-ready-probe-{}", std::process::id());
    let app = window.app_handle().clone();
    let listen_id = app.listen(event_name.clone(), move |event| {
        let ok = event.payload().contains("true");
        if let Ok(mut slot) = tx.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(ok);
            }
        }
    });

    let js = format!(
        r#"(async () => {{
  const ready = !!(window.__CG_ACCESS_BRIDGE__ && window.__CG_ACCESS_BRIDGE__.ready);
  try {{
    if (window.__TAURI__ && window.__TAURI__.event) {{
      await window.__TAURI__.event.emit("{event}", {{ ready }});
    }}
  }} catch (e) {{}}
}})()"#,
        event = event_name
    );
    window.eval(&js).map_err(|e| format!("access_bridge_eval:{e}"))?;

    let result = tokio::time::timeout(Duration::from_secs(2), rx).await;
    app.unlisten(listen_id);
    match result {
        Ok(Ok(v)) => Ok(v),
        _ => Ok(false),
    }
}

async fn eval_passkey_bridge_ready(window: &WebviewWindow, probe_id: u64) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let tx = std::sync::Mutex::new(Some(tx));
    let event_name = format!("cg-passkey-ready-probe-{probe_id}");
    let app = window.app_handle().clone();
    let listen_id = app.listen(event_name.clone(), move |event| {
        let ready = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|value| value.get("ready").and_then(|item| item.as_bool()))
            .unwrap_or(false);
        if let Ok(mut slot) = tx.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(ready);
            }
        }
    });

    let js = format!(
        r#"(async () => {{
  const bridge = window.__CG_PASSKEY_BRIDGE__;
  const ready = !!(bridge && bridge.ready === true && bridge.origin === window.location.origin);
  try {{
    if (window.__TAURI__ && window.__TAURI__.event) {{
      await window.__TAURI__.event.emit({event}, {{ ready }});
    }}
  }} catch (_) {{}}
}})()"#,
        event = serde_json::to_string(&event_name).unwrap()
    );
    if let Err(error) = window.eval(&js) {
        app.unlisten(listen_id);
        return Err(format!("passkey_bridge_eval:{error}"));
    }

    let result = tokio::time::timeout(Duration::from_secs(2), rx).await;
    app.unlisten(listen_id);
    match result {
        Ok(Ok(value)) => Ok(value),
        _ => Ok(false),
    }
}

async fn open_passkey_bridge_window(
    app: &AppHandle,
    state: &BridgeState,
    origin: &str,
) -> Result<WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(PASSKEY_BRIDGE_LABEL) {
        let _ = existing.close();
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let url = passkey_bridge_url(origin)?;
    let window = WebviewWindowBuilder::new(
        app,
        PASSKEY_BRIDGE_LABEL,
        WebviewUrl::External(url),
    )
    .title("完成设备验证")
    .inner_size(520.0, 320.0)
    .resizable(false)
    .center()
    .visible(true)
    .focused(true)
    .build()
    .map_err(|_| "passkey_bridge_create".to_string())?;

    let _ = window.show();
    let _ = window.set_focus();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let probe_id = state.next_id.fetch_add(1, Ordering::Relaxed);
        if eval_passkey_bridge_ready(&window, probe_id)
            .await
            .unwrap_or(false)
        {
            return Ok(window);
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = window.close();
            return Err("passkey_bridge_load_timeout".into());
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
}

async fn perform_passkey_via_window(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &BridgeState,
    request: &DesktopPasskeyRequest,
    expected_origin: &str,
) -> Result<serde_json::Value, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let event_name = format!("cg-passkey-result-{id}");
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    let listen_id = app.listen(event_name.clone(), move |event| {
        if let Ok(mut slot) = tx.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(event.payload().to_string());
            }
        }
    });

    let bridge_request = serde_json::json!({
        "mode": request.mode,
        "options": request.options
    });
    let js = format!(
        r#"(async () => {{
  const emit = async (payload) => {{
    if (window.__TAURI__ && window.__TAURI__.event) {{
      await window.__TAURI__.event.emit({event}, payload);
    }}
  }};
  try {{
    const bridge = window.__CG_PASSKEY_BRIDGE__;
    if (!(bridge && bridge.ready === true && typeof bridge.perform === "function")) {{
      await emit({{ ok: false, error: "passkey_bridge_not_ready" }});
      return;
    }}
    const response = await bridge.perform({request});
    await emit({{
      ok: true,
      origin: window.location.origin,
      response
    }});
  }} catch (error) {{
    const raw = String(error && error.message ? error.message : "");
    const safe = /^passkey_[a-z0-9_]+$/i.test(raw) ? raw : "passkey_bridge_failed";
    await emit({{ ok: false, error: safe }});
  }}
}})()"#,
        event = serde_json::to_string(&event_name).unwrap(),
        request = serde_json::to_string(&bridge_request)
            .map_err(|_| "passkey_bridge_request_invalid".to_string())?
    );

    if let Err(error) = window.eval(&js) {
        app.unlisten(listen_id);
        return Err(format!("passkey_bridge_eval:{error}"));
    }

    let payload_result = tokio::time::timeout(Duration::from_secs(150), rx).await;
    app.unlisten(listen_id);
    let payload = payload_result
        .map_err(|_| "passkey_timed_out".to_string())?
        .map_err(|_| "passkey_bridge_channel_closed".to_string())?;

    let value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|_| "passkey_bridge_bad_payload".to_string())?;
    if value.get("ok").and_then(|item| item.as_bool()) != Some(true) {
        let code = value
            .get("error")
            .and_then(|item| item.as_str())
            .filter(|code| {
                code.starts_with("passkey_")
                    && code
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            })
            .unwrap_or("passkey_bridge_failed");
        return Err(code.to_string());
    }
    if value.get("origin").and_then(|item| item.as_str()) != Some(expected_origin) {
        return Err("passkey_bridge_origin_mismatch".into());
    }
    value
        .get("response")
        .cloned()
        .ok_or_else(|| "passkey_bridge_response_missing".to_string())
}

async fn bridge_fetch_via_window(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &BridgeState,
    req: &BridgeFetchRequest,
) -> Result<BridgeFetchResponse, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let event_name = format!("cg-bridge-fetch-result-{id}");
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    let listen_id = app.listen(event_name.clone(), move |event| {
        if let Ok(mut slot) = tx.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(event.payload().to_string());
            }
        }
    });

    let method = req
        .method
        .clone()
        .unwrap_or_else(|| "GET".to_string())
        .to_uppercase();
    let path = &req.path;
    if !path.starts_with('/') {
        app.unlisten(listen_id);
        return Err("bridge_path_must_be_absolute".into());
    }
    let binary = req.binary.unwrap_or(false);
    let headers_json =
        serde_json::to_string(&req.headers.clone().unwrap_or_default()).unwrap_or_else(|_| "{}".into());
    let body_js = match &req.body {
        Some(b) => serde_json::to_string(b).unwrap_or_else(|_| "null".into()),
        None => "null".to_string(),
    };

    let js = format!(
        r#"(async () => {{
  const eventName = {event_name};
  const emit = async (payload) => {{
    try {{
      if (window.__TAURI__ && window.__TAURI__.event) {{
        await window.__TAURI__.event.emit(eventName, payload);
      }}
    }} catch (e) {{
      console.error(e);
    }}
  }};
  try {{
    if (!(window.__CG_ACCESS_BRIDGE__ && window.__CG_ACCESS_BRIDGE__.ready)) {{
      await emit({{ error: "access_bridge_not_ready" }});
      return;
    }}
    const headers = Object.assign({{}}, {headers});
    const body = {body};
    if (body !== null && body !== undefined) {{
      if (!headers["content-type"] && !headers["Content-Type"]) {{
        headers["content-type"] = "application/json";
      }}
    }}
    const init = {{
      method: {method},
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      headers
    }};
    if (body !== null && body !== undefined) {{
      init.body = body;
    }}
    const response = await fetch({path}, init);
    if (response.type === "opaqueredirect" || response.status === 0) {{
      await emit({{ status: 0, body: "", opaqueRedirect: true, contentType: null }});
      return;
    }}
    const contentType = response.headers.get("content-type");
    const requestId = response.headers.get("x-request-id");
    let bodyOut;
    if ({binary}) {{
      const buf = await response.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {{
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }}
      bodyOut = btoa(binary);
    }} else {{
      bodyOut = await response.text();
    }}
    await emit({{
      status: response.status,
      body: bodyOut,
      opaqueRedirect: false,
      contentType,
      requestId
    }});
  }} catch (e) {{
    await emit({{ error: String(e && e.message ? e.message : e) }});
  }}
}})()"#,
        event_name = serde_json::to_string(&event_name).unwrap(),
        headers = headers_json,
        method = serde_json::to_string(&method).unwrap(),
        body = body_js,
        path = serde_json::to_string(path).unwrap(),
        binary = if binary { "true" } else { "false" },
    );

    window
        .eval(&js)
        .map_err(|e| format!("access_bridge_fetch_eval:{e}"))?;

    let payload_result = tokio::time::timeout(Duration::from_secs(120), rx).await;
    app.unlisten(listen_id);
    let payload = payload_result
        .map_err(|_| "access_bridge_fetch_timeout".to_string())?
        .map_err(|_| "access_bridge_fetch_channel_closed".to_string())?;

    let value: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("access_bridge_bad_payload:{e}"))?;
    if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(BridgeFetchResponse {
        status: value
            .get("status")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u16,
        body: value
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        content_type: value
            .get("contentType")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        request_id: value
            .get("requestId")
            .and_then(|v| v.as_str())
            .filter(|value| {
                value.len() <= 96
                    && value
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || "._:-".contains(ch))
            })
            .map(|value| value.to_string()),
        opaque_redirect: value
            .get("opaqueRedirect")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

#[tauri::command]
async fn desktop_app_version(app: AppHandle) -> Result<DesktopVersionInfo, String> {
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".into());
    Ok(DesktopVersionInfo { version })
}

#[tauri::command]
async fn desktop_access_ensure(app: AppHandle, gateway_origin: String) -> Result<(), String> {
    let origin = normalize_gateway_origin(&gateway_origin)?;
    let window = open_bridge_window(&app, &origin).await?;
    wait_bridge_ready(&app, &window, Duration::from_secs(300)).await?;
    // Login completed — keep WebView alive but out of the way (tray).
    hide_bridge_to_tray(&window);
    Ok(())
}

/// Open (or reveal) the Access login window and return immediately. The window
/// must pop up on click; the frontend then polls the Gateway until Access login
/// succeeds. Blocking here risks the click appearing to "do nothing".
#[tauri::command]
async fn desktop_access_show(app: AppHandle, gateway_origin: String) -> Result<(), String> {
    let origin = normalize_gateway_origin(&gateway_origin)?;
    let _ = open_bridge_window(&app, &origin).await?;
    Ok(())
}

#[tauri::command]
async fn desktop_bridge_fetch(
    app: AppHandle,
    state: State<'_, BridgeState>,
    request: BridgeFetchRequest,
) -> Result<BridgeFetchResponse, String> {
    let origin = normalize_gateway_origin(&request.gateway_origin)?;
    let window = require_ready_bridge_window(&app, &origin).await?;
    let mut req = request;
    req.gateway_origin = origin;
    bridge_fetch_via_window(&app, &window, &state, &req).await
}

#[tauri::command]
async fn desktop_perform_passkey(
    app: AppHandle,
    state: State<'_, BridgeState>,
    request: DesktopPasskeyRequest,
) -> Result<serde_json::Value, String> {
    let origin = normalize_passkey_origin(&request.passkey_origin)?;
    let rp_id = passkey_rp_id(&request)?;
    if !origin_can_use_rp_id(&origin, &rp_id) {
        return Err("passkey_rp_id_mismatch".into());
    }

    let window = open_passkey_bridge_window(&app, &state, &origin).await?;
    let result = perform_passkey_via_window(&app, &window, &state, &request, &origin).await;
    let _ = window.close();
    result
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_installer_payload(bytes: &[u8], expected_sha256: &str) -> Result<(), String> {
    let expected = expected_sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("desktop_update_hash_invalid".into());
    }
    if bytes.len() < 1024 || !bytes.starts_with(b"MZ") {
        return Err("desktop_download_invalid_executable".into());
    }
    if sha256_hex(bytes) != expected {
        return Err("desktop_update_hash_mismatch".into());
    }
    Ok(())
}

#[tauri::command]
async fn desktop_install_update(
    app: AppHandle,
    state: State<'_, BridgeState>,
    gateway_origin: String,
    expected_version: String,
    expected_sha256: String,
) -> Result<(), String> {
    let origin = normalize_gateway_origin(&gateway_origin)?;
    let window = require_ready_bridge_window(&app, &origin).await?;
    let response = bridge_fetch_via_window(
        &app,
        &window,
        &state,
        &BridgeFetchRequest {
            gateway_origin: origin,
            path: "/api/desktop/download".into(),
            method: Some("GET".into()),
            headers: None,
            body: None,
            binary: Some(true),
        },
    )
    .await?;

    if response.opaque_redirect || response.status == 0 {
        return Err("cloudflare_login_required".into());
    }
    if response.status != 200 {
        return Err(format!("desktop_download_http_{}", response.status));
    }

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(response.body.trim())
        .map_err(|e| format!("desktop_download_b64:{e}"))?;
    validate_installer_payload(&bytes, &expected_sha256)?;
    if !expected_version
        .chars()
        .all(|ch| ch.is_ascii_digit() || ch == '.')
        || expected_version.len() > 32
    {
        return Err("desktop_update_version_invalid".into());
    }

    let path: PathBuf = std::env::temp_dir().join(format!(
        "cursor-gateway-desktop-{expected_version}-setup.exe"
    ));
    std::fs::write(&path, &bytes).map_err(|e| format!("desktop_download_write:{e}"))?;

    #[cfg(target_os = "windows")]
    {
        Command::new(&path)
            .spawn()
            .map_err(|e| format!("desktop_installer_spawn:{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("desktop_install_windows_only".into());
    }

    let _ = app;
    Ok(())
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_main = MenuItem::with_id(app, "show_main", "显示主窗口", true, None::<&str>)?;
    let show_bridge =
        MenuItem::with_id(app, "show_bridge", "显示 Access 桥接窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_main, &show_bridge, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Cursor Gateway")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_main" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
            "show_bridge" => {
                if let Some(bridge) = app.get_webview_window(BRIDGE_LABEL) {
                    let _ = bridge.show();
                    let _ = bridge.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run before the WebView2 environment is created (i.e. before any
    // window is built) so the hidden Access bridge keeps proxying fetches
    // instead of being suspended in the tray.
    ensure_webview2_no_throttle();

    tauri::Builder::default()
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            desktop_app_version,
            desktop_access_ensure,
            desktop_access_show,
            desktop_bridge_fetch,
            desktop_perform_passkey,
            desktop_install_update
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cursor Gateway desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_args_injects_no_throttle_flags_when_empty() {
        let args = webview2_browser_args(None);
        for flag in WEBVIEW2_NO_THROTTLE_FLAGS {
            assert!(args.contains(flag), "missing {flag} in `{args}`");
        }
    }

    #[test]
    fn browser_args_preserves_existing_and_dedupes() {
        let existing = "--disable-background-timer-throttling --foo=bar";
        let args = webview2_browser_args(Some(existing));
        // Pre-existing flags are kept.
        assert!(args.contains("--foo=bar"));
        // Already-present flag is not duplicated.
        assert_eq!(args.matches("--disable-background-timer-throttling").count(), 1);
        // Missing flags are appended.
        assert!(args.contains("--disable-renderer-backgrounding"));
        assert!(args.contains("--disable-backgrounding-occluded-windows"));
    }

    #[test]
    fn browser_args_ignores_blank_existing() {
        let args = webview2_browser_args(Some("   "));
        assert!(!args.starts_with(' '));
        assert!(args.contains("--disable-renderer-backgrounding"));
    }

    #[test]
    fn normalize_gateway_origin_strips_path_and_lowercases() {
        assert_eq!(
            normalize_gateway_origin("https://secure.joelzt.org/foo?x=1").unwrap(),
            "https://secure.joelzt.org"
        );
    }

    #[test]
    fn normalize_gateway_origin_rejects_bad_scheme_and_credentials() {
        assert!(normalize_gateway_origin("ftp://example.com").is_err());
        assert!(normalize_gateway_origin("https://user:pw@example.com").is_err());
        assert!(normalize_gateway_origin("not a url").is_err());
    }

    #[test]
    fn bridge_url_targets_desktop_access_bridge() {
        let url = bridge_url("https://secure.joelzt.org").unwrap();
        assert_eq!(
            url.as_str(),
            "https://secure.joelzt.org/api/desktop/access/bridge"
        );
    }

    #[test]
    fn passkey_bridge_requires_https_allowed_origin_and_matching_rp_id() {
        assert_eq!(
            normalize_passkey_origin("https://secure.joelzt.org").unwrap(),
            "https://secure.joelzt.org"
        );
        assert!(normalize_passkey_origin("http://secure.joelzt.org").is_err());
        assert!(normalize_passkey_origin("https://example.com").is_err());
        assert!(origin_can_use_rp_id(
            "https://secure.joelzt.org",
            "secure.joelzt.org"
        ));
        assert!(origin_can_use_rp_id(
            "https://login.joelzt.org",
            "joelzt.org"
        ));
        assert!(!origin_can_use_rp_id(
            "https://tauri.localhost",
            "secure.joelzt.org"
        ));
    }

    #[test]
    fn passkey_rp_id_reads_registration_and_authentication_options() {
        let registration = DesktopPasskeyRequest {
            passkey_origin: "https://secure.joelzt.org".into(),
            mode: "registration".into(),
            options: serde_json::json!({ "rp": { "id": "secure.joelzt.org" } }),
        };
        assert_eq!(passkey_rp_id(&registration).unwrap(), "secure.joelzt.org");

        let authentication = DesktopPasskeyRequest {
            passkey_origin: "https://secure.joelzt.org".into(),
            mode: "authentication".into(),
            options: serde_json::json!({ "rpId": "secure.joelzt.org" }),
        };
        assert_eq!(
            passkey_rp_id(&authentication).unwrap(),
            "secure.joelzt.org"
        );
    }

    #[test]
    fn installer_payload_requires_pe_header_and_exact_sha256() {
        let mut bytes = vec![0_u8; 2048];
        bytes[0] = b'M';
        bytes[1] = b'Z';
        let hash = sha256_hex(&bytes);
        assert!(validate_installer_payload(&bytes, &hash).is_ok());
        assert_eq!(
            validate_installer_payload(&bytes, &"0".repeat(64)).unwrap_err(),
            "desktop_update_hash_mismatch"
        );
        bytes[0] = b'X';
        assert_eq!(
            validate_installer_payload(&bytes, &sha256_hex(&bytes)).unwrap_err(),
            "desktop_download_invalid_executable"
        );
    }
}
