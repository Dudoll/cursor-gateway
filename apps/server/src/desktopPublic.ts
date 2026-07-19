import { existsSync, readFileSync, statSync } from "node:fs";
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
    <h1 class="ok">登录成功</h1>
    <p>现在可以返回客户端继续。</p>
    <p id="status">已准备好</p>
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
  publishedAt: string;
};

/**
 * Resolve the installer path across supported artifact layouts.
 *
 * CI (`.github/workflows/desktop-windows.yml`) and the sign script both emit the
 * NSIS installer into `artifacts/desktop/`. Older deploys dropped a copy at the
 * `artifacts/` root. Prefer the canonical `desktop/` path, fall back to the root
 * so a mixed/legacy deploy still serves a real `.exe` instead of a 404.
 */
export function resolveDesktopInstallerPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? "";
}

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
    installerAvailable: existsSync(paths.installerPath),
    publishedAt: existsSync(paths.versionPath)
      ? new Date(statSync(paths.versionPath).mtimeMs).toISOString()
      : new Date(0).toISOString()
  };
}

/** Resolve artifact paths relative to the compiled server entry (`dist/`). */
export function desktopArtifactPaths(serverDistDir: string) {
  const artifactsRoot = join(serverDistDir, "../../../artifacts");
  // Canonical CI/sign output lives in artifacts/desktop/; keep the legacy
  // artifacts/ root as a fallback so older deploys keep serving a real exe.
  const installerCandidates = [
    join(artifactsRoot, "desktop/cursor-gateway-desktop-setup.exe"),
    join(artifactsRoot, "cursor-gateway-desktop-setup.exe")
  ];
  return {
    installerPath: resolveDesktopInstallerPath(installerCandidates),
    installerCandidates,
    versionPath: join(artifactsRoot, "desktop/version.json"),
    sha256SumsPath: join(artifactsRoot, "desktop/SHA256SUMS")
  };
}
