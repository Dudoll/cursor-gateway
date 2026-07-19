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
    version: string;
    sha256: string;
    installerAvailable: boolean;
    downloadPath: string;
  };

  assert.equal(packageJson.version, "0.1.8");
  assert.equal(tauri.version, packageJson.version);
  assert.equal(cargoVersion, packageJson.version);
  assert.equal(publicMetadata.version, packageJson.version);
  assert.match(publicMetadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof publicMetadata.installerAvailable, "boolean");
  assert.equal(publicMetadata.downloadPath, "/api/desktop/download");
});
