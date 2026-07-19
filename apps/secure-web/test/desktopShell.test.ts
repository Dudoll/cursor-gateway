import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopDiagnosticsPath,
  desktopLogDiagnostic,
  desktopReadDiagnostics,
  desktopUpgradeTarget,
  isNewerDesktopVersion,
  shouldRegisterServiceWorker
} from "../src/desktopShell.js";

test("isNewerDesktopVersion detects upgrades", () => {
  assert.equal(isNewerDesktopVersion("0.1.1", "0.1.0"), true);
  assert.equal(isNewerDesktopVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerDesktopVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerDesktopVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerDesktopVersion("0.1.0", "0.1.1"), false);
  assert.equal(isNewerDesktopVersion("v0.1.2", "0.1.1"), true);
});

test("desktop diagnostics use bounded Tauri commands without payload bodies", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __TAURI__: {
          core: {
            invoke: async (command: string, args?: Record<string, unknown>) => {
              calls.push({ command, ...(args ? { args } : {}) });
              if (command === "desktop_read_diagnostics") return [{ errorCode: "network" }];
              if (command === "desktop_diagnostics_path") return "C:\\safe\\diagnostics.jsonl";
              return null;
            }
          }
        }
      }
    });
    await desktopLogDiagnostic({
      stage: "access",
      operation: "检查登录状态",
      endpoint: "https://cs.joelzt.org/api/e2ee-policy",
      errorCode: "network_unreachable",
      clientRequestId: "client-safe"
    });
    assert.deepEqual(await desktopReadDiagnostics(25), [{ errorCode: "network" }]);
    assert.equal(await desktopDiagnosticsPath(), "C:\\safe\\diagnostics.jsonl");
    assert.equal(calls[0]?.command, "desktop_log_diagnostic");
    assert.equal(
      JSON.stringify(calls[0]?.args).includes("cookie"),
      false
    );
    assert.deepEqual(calls.slice(1).map((call) => call.command), [
      "desktop_read_diagnostics",
      "desktop_diagnostics_path"
    ]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("desktopUpgradeTarget shows the icon only when a newer installer exists", () => {
  // Newer remote + installer present → show, returning the target version.
  assert.equal(
    desktopUpgradeTarget({ remoteVersion: "0.1.4", localVersion: "0.1.3", installerAvailable: true }),
    "0.1.4"
  );
  // Same version → hidden (this is why a fresh 0.1.4 install shows no icon).
  assert.equal(
    desktopUpgradeTarget({ remoteVersion: "0.1.4", localVersion: "0.1.4", installerAvailable: true }),
    null
  );
  // Newer version but installer missing (the download-404 bug) → hidden.
  assert.equal(
    desktopUpgradeTarget({ remoteVersion: "0.1.4", localVersion: "0.1.3", installerAvailable: false }),
    null
  );
  // Older/missing remote → hidden.
  assert.equal(
    desktopUpgradeTarget({ remoteVersion: "0.1.2", localVersion: "0.1.3", installerAvailable: true }),
    null
  );
  assert.equal(
    desktopUpgradeTarget({ remoteVersion: null, localVersion: "0.1.3", installerAvailable: true }),
    null
  );
});

test("shouldRegisterServiceWorker is false in desktop shell (avoids Tauri 404s)", () => {
  const prevWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { __TAURI__: { core: {} } }
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { serviceWorker: {} }
    });
    assert.equal(shouldRegisterServiceWorker(), false);

    (globalThis as { window: object }).window = {};
    assert.equal(shouldRegisterServiceWorker(), true);
  } finally {
    if (prevWindow) Object.defineProperty(globalThis, "window", prevWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (prevNavigator) Object.defineProperty(globalThis, "navigator", prevNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
