import {
  handleCgMitmBridge,
  setPinnedTrustRoots,
  type CgMitmBridgeRequest
} from "./cgMitmBridge.js";

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// cs-relay crypto bridge (relay-P6): pages → extension via chrome.runtime.sendMessage.
chrome.runtime.onMessage.addListener(
  (
    message: { channel?: string; request?: CgMitmBridgeRequest },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (!message || message.channel !== "cg-mitm-bridge" || !message.request) return false;
    void handleCgMitmBridge(message.request).then(sendResponse);
    return true;
  }
);

try {
  const roots = (globalThis as { __CG_TRUST_ROOTS__?: unknown }).__CG_TRUST_ROOTS__;
  if (Array.isArray(roots)) setPinnedTrustRoots(roots as never);
} catch {
  // ignore
}
