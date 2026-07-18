import assert from "node:assert/strict";
import test from "node:test";
import { isNewerDesktopVersion, shouldRegisterServiceWorker } from "../src/desktopShell.js";

test("isNewerDesktopVersion detects upgrades", () => {
  assert.equal(isNewerDesktopVersion("0.1.1", "0.1.0"), true);
  assert.equal(isNewerDesktopVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerDesktopVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerDesktopVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerDesktopVersion("0.1.0", "0.1.1"), false);
  assert.equal(isNewerDesktopVersion("v0.1.2", "0.1.1"), true);
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
