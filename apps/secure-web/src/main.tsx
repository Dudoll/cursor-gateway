import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { isDesktopShell } from "./desktopShell.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root_missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Service workers fight Tauri's custom protocol (navigate/assets can 404).
// Only register for the hosted Secure Web / PWA build.
if ("serviceWorker" in navigator && !isDesktopShell()) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW is best-effort for offline shell; pairing still works without it.
    });
  });
}
