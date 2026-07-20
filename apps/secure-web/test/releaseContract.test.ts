import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "../../desktop");

test("desktop package, Tauri, Cargo, and public update metadata versions stay aligned", () => {
  const packageJson = JSON.parse(
    readFileSync(join(desktopRoot, "package.json"), "utf8")
  ) as { version: string };
  const tauri = JSON.parse(
    readFileSync(join(desktopRoot, "src-tauri/tauri.conf.json"), "utf8")
  ) as { version: string };
  const cargo = readFileSync(join(desktopRoot, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
  const publicMetadata = JSON.parse(
    readFileSync(join(here, "../public/desktop-version.json"), "utf8")
  ) as {
    schemaVersion: number;
    version: string;
    sha256: string;
    installerAvailable: boolean;
    installerUrl: string;
    publishedAt: string;
  };

  assert.equal(packageJson.version, "0.1.11");
  assert.equal(tauri.version, packageJson.version);
  assert.equal(cargoVersion, packageJson.version);
  assert.equal(publicMetadata.version, packageJson.version);
  assert.equal(publicMetadata.schemaVersion, 1);
  assert.match(publicMetadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof publicMetadata.installerAvailable, "boolean");
  assert.equal(
    publicMetadata.installerUrl,
    "https://cs.joelzt.org/api/desktop/download"
  );
  assert.ok(Number.isFinite(Date.parse(publicMetadata.publishedAt)));
});

test("Secure nginx serves the manifest exactly and never through SPA fallback", () => {
  const nginx = readFileSync(
    join(here, "../../../infra/nginx-secure.joelzt.org.conf"),
    "utf8"
  );
  assert.match(nginx, /location = \/desktop-version\.json/);
  assert.match(nginx, /try_files \/desktop-version\.json =404/);
  assert.match(nginx, /default_type application\/json/);
  assert.match(nginx, /Access-Control-Allow-Origin "\*"/);
});
