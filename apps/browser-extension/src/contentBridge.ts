/**
 * Content-script bridge for cs.joelzt.org pages (relay-P6).
 * Pages postMessage; this forwards to the extension background via runtime.
 */
const ALLOWED_HOST_SUFFIXES = ["joelzt.org"];

function hostAllowed(hostname: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );
}

type RuntimeBridge = {
  sendMessage: (
    message: unknown,
    responseCallback?: (response: unknown) => void
  ) => void;
  lastError?: { message?: string };
};

const runtime = chrome.runtime as unknown as RuntimeBridge;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data as {
    channel?: string;
    requestId?: string;
    request?: unknown;
  };
  if (!data || data.channel !== "cg-mitm-page" || !data.requestId) return;
  if (!hostAllowed(location.hostname)) {
    window.postMessage(
      {
        channel: "cg-mitm-page-response",
        requestId: data.requestId,
        response: { ok: false, type: "host", reason: "host_not_allowed" }
      },
      "*"
    );
    return;
  }
  try {
    runtime.sendMessage(
      { channel: "cg-mitm-bridge", request: data.request },
      (response) => {
        window.postMessage(
          {
            channel: "cg-mitm-page-response",
            requestId: data.requestId,
            response:
              response ??
              {
                ok: false,
                type: "bridge",
                reason: runtime.lastError?.message ?? "no_response"
              }
          },
          "*"
        );
      }
    );
  } catch (error) {
    window.postMessage(
      {
        channel: "cg-mitm-page-response",
        requestId: data.requestId,
        response: {
          ok: false,
          type: "bridge",
          reason: error instanceof Error ? error.message : "bridge_error"
        }
      },
      "*"
    );
  }
});

// Announce presence so CS web can prefer trusted-CS relay path.
window.postMessage(
  { channel: "cg-mitm-bridge-ready", protocol: "cg-mitm/1", bridge: "extension-v1" },
  "*"
);
