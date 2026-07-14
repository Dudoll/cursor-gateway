#!/usr/bin/env node
/**
 * Pack apps/browser-extension/dist into a downloadable zip for the Gateway UI.
 * Run after `npm run build -w @cursor-gateway/browser-extension`.
 *
 * Uses Python's zipfile (available in Debian slim / most hosts) so the image
 * does not need the `zip` CLI.
 *
 * Usage:
 *   node apps/browser-extension/scripts/pack-extension-zip.mjs [distDir] [outZip]
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDist = resolve(here, "../dist");
const defaultOut = resolve(here, "../../../artifacts/cursor-gateway-secure.zip");

const distDir = resolve(process.argv[2] ?? defaultDist);
const outZip = resolve(process.argv[3] ?? defaultOut);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
  );
  return nested.flat();
}

const distStat = await stat(distDir).catch(() => null);
if (!distStat?.isDirectory()) {
  console.error(`Extension dist not found: ${distDir}`);
  console.error("Build first: npm run build -w @cursor-gateway/browser-extension");
  process.exit(1);
}

const files = await listFiles(distDir);
if (files.length === 0) {
  console.error(`Extension dist is empty: ${distDir}`);
  process.exit(1);
}

const hasManifest = files.some(
  (path) => relative(distDir, path).replaceAll("\\", "/") === "manifest.json"
);
if (!hasManifest) {
  console.error("manifest.json missing from extension dist; refuse to pack.");
  process.exit(1);
}

await mkdir(dirname(outZip), { recursive: true });

const packer = `
import pathlib, sys, zipfile
dist = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(dist.rglob("*")):
        if path.is_file():
            zf.write(path, path.relative_to(dist).as_posix())
print(out.stat().st_size)
`;

const packerPath = join(dirname(outZip), ".pack-extension-zip.py");
await writeFile(packerPath, packer, { encoding: "utf8", mode: 0o600 });

try {
  const sizeText = await new Promise((resolvePromise, reject) => {
    const child = spawn("python3", [packerPath, distDir, outZip], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`python zip packer exited with code ${code}`));
    });
  });

  const zipStat = await stat(outZip);
  if (zipStat.size < 64) {
    console.error(`Packed zip looks empty: ${outZip}`);
    process.exit(1);
  }
  console.log(`Packed ${files.length} files → ${outZip} (${sizeText || zipStat.size} bytes)`);
} finally {
  await writeFile(packerPath, "", { encoding: "utf8" }).catch(() => undefined);
  const { unlink } = await import("node:fs/promises");
  await unlink(packerPath).catch(() => undefined);
}
