import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Paths served under `/api` (Fastify prefix) for the Windows desktop shell. */
export const DESKTOP_DOWNLOAD_PATH = "/api/desktop/download";
export const DESKTOP_VERSION_PATH = "/api/desktop/version";
export const DESKTOP_ACCESS_BRIDGE_PATH = "/api/desktop/access/bridge";

/**
 * CSP for the Access bridge HTML. Must allow the inline bootstrap that sets
 * `window.__CG_ACCESS_BRIDGE__` and emits `cg-access-bridge-ready` to the
 * Tauri shell. The global app CSP (`script-src 'self'`) must NOT overwrite this.
 */
export const DESKTOP_ACCESS_BRIDGE_CSP =
  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
  "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'";

/** True when the global onSend hook should leave the route CSP alone. */
export function shouldPreserveRouteContentSecurityPolicy(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? url;
  return path === DESKTOP_ACCESS_BRIDGE_PATH || path.startsWith(`${DESKTOP_ACCESS_BRIDGE_PATH}/`);
}

/** Minimal HTML loaded inside the Tauri Access bridge window (same-site as the Gateway). */
export function desktopAccessBridgeHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Cloudflare Access · Desktop</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", "IBM Plex Sans", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: linear-gradient(180deg, #e8eef5, #f7fafc); color: #0f172a; }
    main { max-width: 28rem; padding: 1.5rem; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; letter-spacing: -0.02em; }
    p { color: #475569; line-height: 1.5; margin: 0 0 0.75rem; }
    .ok { color: #0f766e; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1 class="ok">Cloudflare Access 已登录</h1>
    <p>可返回 Cursor Gateway 桌面窗口继续配对。本窗口已收纳到系统托盘；桌面壳通过此页同源转发 API，以便带上 Access Cookie。</p>
    <p id="status">桥接就绪</p>
  </main>
  <script>
    window.__CG_ACCESS_BRIDGE__ = { ready: true, version: 1 };
    (async function notify() {
      try {
        var t = window.__TAURI__;
        if (t && t.event && typeof t.event.emit === "function") {
          await t.event.emit("cg-access-bridge-ready", { ok: true, at: Date.now() });
        }
      } catch (e) {}
    })();
  </script>
</body>
</html>`;
}

export type DesktopVersionMeta = {
  version: string;
  sha256: string | null;
  installerAvailable: boolean;
};

export function readDesktopVersionMeta(paths: {
  versionPath: string;
  sha256SumsPath: string;
  installerPath: string;
}): DesktopVersionMeta {
  let version = "0.0.0";
  let sha256: string | null = null;
  if (existsSync(paths.versionPath)) {
    try {
      const raw = JSON.parse(readFileSync(paths.versionPath, "utf8")) as {
        version?: unknown;
        sha256?: unknown;
      };
      if (typeof raw.version === "string" && /^\d+\.\d+\.\d+/.test(raw.version)) {
        version = raw.version;
      }
      if (typeof raw.sha256 === "string" && /^[a-f0-9]{64}$/i.test(raw.sha256)) {
        sha256 = raw.sha256.toLowerCase();
      }
    } catch {
      // fall through
    }
  }
  if (!sha256 && existsSync(paths.sha256SumsPath)) {
    try {
      const line = readFileSync(paths.sha256SumsPath, "utf8")
        .split(/\r?\n/)
        .find((row) => row.includes("cursor-gateway-desktop-setup.exe"));
      const hash = line?.trim().split(/\s+/)[0];
      if (hash && /^[a-f0-9]{64}$/i.test(hash)) sha256 = hash.toLowerCase();
    } catch {
      // ignore
    }
  }
  return {
    version,
    sha256,
    installerAvailable: existsSync(paths.installerPath)
  };
}

/** Resolve artifact paths relative to the compiled server entry (`dist/`). */
export function desktopArtifactPaths(serverDistDir: string) {
  const artifactsRoot = join(serverDistDir, "../../../artifacts");
  return {
    installerPath: join(artifactsRoot, "cursor-gateway-desktop-setup.exe"),
    versionPath: join(artifactsRoot, "desktop/version.json"),
    sha256SumsPath: join(artifactsRoot, "desktop/SHA256SUMS")
  };
}
