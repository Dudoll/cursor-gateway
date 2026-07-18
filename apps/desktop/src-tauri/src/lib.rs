//! Cursor Gateway desktop shell.
//!
//! The shell intentionally does almost nothing: it loads the bundled Secure Web
//! E2EE UI from the local `tauri://`/`http://tauri.localhost` protocol (assets are
//! shipped inside the installer, not fetched from the network on first load, which
//! is what makes this more MITM-resistant than a plain browser tab). All pairing,
//! encryption, RAMC and Passkey logic lives in the reused Secure Web frontend and
//! runs unchanged inside WebView2.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Cursor Gateway desktop application");
}
