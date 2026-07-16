import {
  handleCgMitmBridge,
  setPinnedTrustRoots,
  type CgMitmBridgeRequest
} from "./cgMitmBridge.js";

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// cs-relay crypto bridge (relay-P6)
(chrome.runtime as unknown as {
  onMessage: {
    addListener: (
      cb: (
        message: { channel?: string; request?: CgMitmBridgeRequest },
        sender: unknown,
        sendResponse: (response: unknown) => void
      ) => boolean
    ) => void;
  };
}).onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.channel !== "cg-mitm-bridge" || !message.request) return false;
  void handleCgMitmBridge(message.request).then(sendResponse);
  return true;
});

try {
  const roots = (globalThis as { __CG_TRUST_ROOTS__?: unknown }).__CG_TRUST_ROOTS__;
  if (Array.isArray(roots)) setPinnedTrustRoots(roots as never);
} catch {
  // ignore
}
