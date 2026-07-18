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
    opaque_redirect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopVersionInfo {
    version: String,
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

fn hide_bridge_to_tray(window: &WebviewWindow) {
    let _ = window.hide();
}

async fn wait_bridge_ready(
    app: &AppHandle,
    window: &WebviewWindow,
    timeout: Duration,
) -> Result<(), String> {
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    let tx = std::sync::Mutex::new(Some(tx));
    let id = app.listen(BRIDGE_READY_EVENT, move |_| {
        if let Ok(mut slot) = tx.lock() {
            if let Some(sender) = slot.take() {
                let _ = sender.send(());
            }
        }
    });

    let deadline = tokio::time::Instant::now() + timeout;
    let result = loop {
        if eval_bridge_ready(window).await.unwrap_or(false) {
            break Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            break Err("access_bridge_login_timeout".into());
        }
        tokio::select! {
            recv = &mut rx => {
                match recv {
                    Ok(()) => break Ok(()),
                    Err(_) => break Err("access_bridge_ready_channel_closed".into()),
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(400)) => {}
        }
    };

    app.unlisten(id);
    result
}

async fn ensure_bridge_window(
    app: &AppHandle,
    origin: &str,
    interactive: bool,
) -> Result<WebviewWindow, String> {
    let url = bridge_url(origin)?;

    if let Some(existing) = app.get_webview_window(BRIDGE_LABEL) {
        let ready = eval_bridge_ready(&existing).await.unwrap_or(false);
        if ready {
            if !interactive {
                hide_bridge_to_tray(&existing);
            }
            return Ok(existing);
        }
        if !interactive {
            return Err("cloudflare_login_required".into());
        }
        existing
            .navigate(url)
            .map_err(|e| format!("access_bridge_navigate:{e}"))?;
        existing.show().map_err(|e| format!("access_bridge_show:{e}"))?;
        existing
            .set_focus()
            .map_err(|e| format!("access_bridge_focus:{e}"))?;
        wait_bridge_ready(app, &existing, Duration::from_secs(300)).await?;
        hide_bridge_to_tray(&existing);
        return Ok(existing);
    }

    if !interactive {
        return Err("cloudflare_login_required".into());
    }

    let window = WebviewWindowBuilder::new(app, BRIDGE_LABEL, WebviewUrl::External(url))
        .title("Cloudflare Access 登录")
        .inner_size(520.0, 780.0)
        .resizable(true)
        .center()
        .skip_taskbar(true)
        .build()
        .map_err(|e| format!("access_bridge_create:{e}"))?;

    wait_bridge_ready(app, &window, Duration::from_secs(300)).await?;
    hide_bridge_to_tray(&window);
    Ok(window)
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
      contentType
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

    let payload = tokio::time::timeout(Duration::from_secs(120), rx)
        .await
        .map_err(|_| "access_bridge_fetch_timeout".to_string())?
        .map_err(|_| "access_bridge_fetch_channel_closed".to_string())?;

    app.unlisten(listen_id);

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
    let _ = ensure_bridge_window(&app, &origin, true).await?;
    Ok(())
}

#[tauri::command]
async fn desktop_access_show(app: AppHandle, gateway_origin: String) -> Result<(), String> {
    let origin = normalize_gateway_origin(&gateway_origin)?;
    let window = ensure_bridge_window(&app, &origin, true).await?;
    // Login completed — keep WebView alive but out of the way (tray).
    hide_bridge_to_tray(&window);
    Ok(())
}

#[tauri::command]
async fn desktop_bridge_fetch(
    app: AppHandle,
    state: State<'_, BridgeState>,
    request: BridgeFetchRequest,
) -> Result<BridgeFetchResponse, String> {
    let origin = normalize_gateway_origin(&request.gateway_origin)?;
    let window = ensure_bridge_window(&app, &origin, false).await?;
    let mut req = request;
    req.gateway_origin = origin;
    bridge_fetch_via_window(&app, &window, &state, &req).await
}

#[tauri::command]
async fn desktop_install_update(
    app: AppHandle,
    state: State<'_, BridgeState>,
    gateway_origin: String,
) -> Result<(), String> {
    let origin = normalize_gateway_origin(&gateway_origin)?;
    let window = ensure_bridge_window(&app, &origin, false).await?;
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
    if bytes.len() < 1024 {
        return Err("desktop_download_too_small".into());
    }

    let path: PathBuf = std::env::temp_dir().join("cursor-gateway-desktop-setup.exe");
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
    tauri::Builder::default()
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![
            desktop_app_version,
            desktop_access_ensure,
            desktop_access_show,
            desktop_bridge_fetch,
            desktop_install_update
        ])
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cursor Gateway desktop application");
}
