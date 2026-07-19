import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DESKTOP_ACCESS_BRIDGE_CSP,
  DESKTOP_ACCESS_BRIDGE_PATH,
  DESKTOP_DOWNLOAD_PATH,
  DESKTOP_VERSION_PATH,
  desktopAccessBridgeHtml,
  desktopArtifactPaths,
  readDesktopVersionMeta,
  resolveDesktopInstallerPath,
  shouldPreserveRouteContentSecurityPolicy
} from "../src/desktopPublic.js";

test("desktop public paths are stable API contracts", () => {
  assert.equal(DESKTOP_DOWNLOAD_PATH, "/api/desktop/download");
  assert.equal(DESKTOP_VERSION_PATH, "/api/desktop/version");
  assert.equal(DESKTOP_ACCESS_BRIDGE_PATH, "/api/desktop/access/bridge");
});

test("bridge HTML marks Access ready and emits Tauri event (no external assets)", () => {
  const html = desktopAccessBridgeHtml();
  assert.match(html, /__CG_ACCESS_BRIDGE__/);
  assert.match(html, /ready:\s*true/);
  assert.match(html, /cg-access-bridge-ready/);
  assert.match(html, /__TAURI__/);
  assert.equal(html.includes("<script src="), false);
  assert.equal(html.includes("http://"), false);
  assert.equal(html.includes("https://"), false);
});

test("bridge CSP allows inline bootstrap script and same-origin API fetches", () => {
  assert.match(DESKTOP_ACCESS_BRIDGE_CSP, /script-src 'unsafe-inline'/);
  assert.match(DESKTOP_ACCESS_BRIDGE_CSP, /connect-src 'self'/);
  assert.equal(DESKTOP_ACCESS_BRIDGE_CSP.includes("script-src 'self'"), false);
});

test("global CSP must not overwrite the Access bridge route", () => {
  assert.equal(shouldPreserveRouteContentSecurityPolicy("/api/desktop/access/bridge"), true);
  assert.equal(
    shouldPreserveRouteContentSecurityPolicy("/api/desktop/access/bridge?x=1"),
    true
  );
  assert.equal(shouldPreserveRouteContentSecurityPolicy("/api/desktop/version"), false);
  assert.equal(shouldPreserveRouteContentSecurityPolicy("/api/desktop/download"), false);
  assert.equal(shouldPreserveRouteContentSecurityPolicy("/api/e2ee-policy"), false);
  assert.equal(shouldPreserveRouteContentSecurityPolicy(undefined), false);
});

test("readDesktopVersionMeta reports missing installer as unavailable (404 path)", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-desktop-meta-"));
  const versionPath = join(root, "version.json");
  const shaPath = join(root, "SHA256SUMS");
  const installerPath = join(root, "missing-setup.exe");
  writeFileSync(versionPath, JSON.stringify({ version: "0.1.2", sha256: "a".repeat(64) }));
  writeFileSync(shaPath, `${"b".repeat(64)}  cursor-gateway-desktop-setup.exe\n`);

  const meta = readDesktopVersionMeta({ versionPath, sha256SumsPath: shaPath, installerPath });
  assert.equal(meta.version, "0.1.2");
  assert.equal(meta.sha256, "a".repeat(64));
  assert.equal(meta.installerAvailable, false);
  assert.ok(Number.isFinite(Date.parse(meta.publishedAt)));
});

test("readDesktopVersionMeta detects installer file and falls back to SHA256SUMS", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-desktop-meta-"));
  mkdirSync(join(root, "desktop"), { recursive: true });
  const installerPath = join(root, "cursor-gateway-desktop-setup.exe");
  const versionPath = join(root, "desktop", "version.json");
  const shaPath = join(root, "desktop", "SHA256SUMS");
  writeFileSync(installerPath, "MZ-fake-installer");
  writeFileSync(versionPath, JSON.stringify({ version: "0.1.2" }));
  writeFileSync(shaPath, `${"c".repeat(64)}  cursor-gateway-desktop-setup.exe\n`);

  const meta = readDesktopVersionMeta({ versionPath, sha256SumsPath: shaPath, installerPath });
  assert.equal(meta.version, "0.1.2");
  assert.equal(meta.sha256, "c".repeat(64));
  assert.equal(meta.installerAvailable, true);
  assert.ok(Number.isFinite(Date.parse(meta.publishedAt)));
});

test("desktopArtifactPaths resolve under repo artifacts/ (canonical desktop/ layout)", () => {
  const paths = desktopArtifactPaths("/app/apps/server/dist");
  const norm = (p: string) => p.replace(/\\/g, "/");
  // Canonical path (matches CI + sign script output) comes first.
  assert.equal(
    norm(paths.installerCandidates[0]),
    "/app/artifacts/desktop/cursor-gateway-desktop-setup.exe"
  );
  // Legacy artifacts/ root path kept as a fallback for older deploys.
  assert.equal(
    norm(paths.installerCandidates[1]),
    "/app/artifacts/cursor-gateway-desktop-setup.exe"
  );
  // With no files present, installerPath defaults to the canonical candidate.
  assert.equal(
    norm(paths.installerPath),
    "/app/artifacts/desktop/cursor-gateway-desktop-setup.exe"
  );
  assert.equal(norm(paths.versionPath), "/app/artifacts/desktop/version.json");
  assert.equal(norm(paths.sha256SumsPath), "/app/artifacts/desktop/SHA256SUMS");
});

test("resolveDesktopInstallerPath prefers desktop/ but falls back to legacy root", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-desktop-resolve-"));
  const desktopDir = join(root, "desktop");
  mkdirSync(desktopDir, { recursive: true });
  const canonical = join(desktopDir, "cursor-gateway-desktop-setup.exe");
  const legacy = join(root, "cursor-gateway-desktop-setup.exe");
  const candidates = [canonical, legacy];

  // Nothing present → returns the canonical candidate (so /download 404s cleanly).
  assert.equal(resolveDesktopInstallerPath(candidates), canonical);

  // Only the legacy root copy exists (mirrors the current VPS workaround).
  writeFileSync(legacy, "MZ-legacy");
  assert.equal(resolveDesktopInstallerPath(candidates), legacy);

  // Canonical desktop/ copy present → preferred over legacy.
  writeFileSync(canonical, "MZ-canonical");
  assert.equal(resolveDesktopInstallerPath(candidates), canonical);
});
