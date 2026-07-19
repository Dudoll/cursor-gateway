import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser";
import { classifyWebauthnError } from "./passkeyErrors.js";

type PasskeyBridgeRequest = {
  mode: "registration" | "authentication";
  options: Record<string, unknown>;
};

type PasskeyBridge = {
  ready: true;
  version: 1;
  origin: string;
  perform(request: PasskeyBridgeRequest): Promise<Record<string, unknown>>;
};

declare global {
  interface Window {
    __CG_PASSKEY_BRIDGE__?: PasskeyBridge;
  }
}

function setStatus(text: string) {
  const element = document.getElementById("passkey-status");
  if (element) element.textContent = text;
}

window.__CG_PASSKEY_BRIDGE__ = {
  ready: true,
  version: 1,
  origin: window.location.origin,
  async perform(request) {
    if (!browserSupportsWebAuthn()) throw new Error("passkey_bridge_unsupported");
    setStatus("请在系统窗口中完成验证。");
    try {
      const response =
        request.mode === "registration"
          ? await startRegistration({ optionsJSON: request.options as never })
          : await startAuthentication({ optionsJSON: request.options as never });
      setStatus("验证已完成，可以返回客户端。");
      return JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
    } catch (error) {
      const code = classifyWebauthnError(error);
      setStatus(code === "passkey_user_cancelled" ? "验证已取消。" : "验证未完成，请返回客户端重试。");
      throw new Error(code);
    }
  }
};

void (async () => {
  try {
    const tauri = (
      window as Window & {
        __TAURI__?: { event?: { emit?: (name: string, payload: unknown) => Promise<void> } };
      }
    ).__TAURI__;
    await tauri?.event?.emit?.("cg-passkey-bridge-ready", {
      ready: true,
      origin: window.location.origin
    });
  } catch {
    // The desktop shell also probes readiness; this notification is best-effort.
  }
})();
