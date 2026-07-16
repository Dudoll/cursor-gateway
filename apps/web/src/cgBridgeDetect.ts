/**
 * Detect signed extension / Secure Adapter bridge for CS web (relay-P6).
 * Pure web under enterprise MITM must NOT claim first-load trust.
 */
export type CgBridgeKind = "extension" | "secure-adapter" | "none";

export type CgBridgeStatus = {
  kind: CgBridgeKind;
  protocol?: string;
  bridge?: string;
  /** When none: honest UX copy for install guidance. */
  installHint?: string;
};

const INSTALL_HINT =
  "纯网页无法在企业 TLS 中间人环境下自证首次加载。请安装 Cursor Gateway Secure 扩展，或本机 Secure Adapter（localhost）。";

export function detectCgMitmBridge(timeoutMs = 800): Promise<CgBridgeStatus> {
  if (typeof window === "undefined") {
    return Promise.resolve({ kind: "none", installHint: INSTALL_HINT });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: CgBridgeStatus) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      resolve(status);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as {
        channel?: string;
        protocol?: string;
        bridge?: string;
        kind?: string;
      };
      if (!data) return;
      if (data.channel === "cg-mitm-bridge-ready") {
        finish({
          kind: "extension",
          ...(data.protocol ? { protocol: data.protocol } : {}),
          ...(data.bridge ? { bridge: data.bridge } : {})
        });
        return;
      }
      if (data.channel === "cg-secure-adapter-ready") {
        finish({
          kind: "secure-adapter",
          ...(data.protocol ? { protocol: data.protocol } : {}),
          ...(data.bridge ? { bridge: data.bridge } : {})
        });
      }
    };

    window.addEventListener("message", onMessage);
    // Probe ping for already-injected bridges.
    window.postMessage({ channel: "cg-mitm-page", requestId: "probe", request: { type: "cg.ping" } }, "*");
    window.setTimeout(() => finish({ kind: "none", installHint: INSTALL_HINT }), timeoutMs);
  });
}

/** Prefer trusted-CS relay path when a bridge is present. */
export function preferredContentMode(bridge: CgBridgeStatus): "cs-relay-v1" | "e2ee-v1" | "prompt-install" {
  if (bridge.kind === "extension" || bridge.kind === "secure-adapter") return "cs-relay-v1";
  return "prompt-install";
}
