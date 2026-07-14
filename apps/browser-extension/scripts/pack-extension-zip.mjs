#!/usr/bin/env node
/**
 * Pack apps/browser-extension/dist into a downloadable zip for the Gateway UI.
 * Run after `npm run build -w @cursor-gateway/browser-extension`.
 *
 * Pure Node implementation (zlib) so Docker slim images need no python/zip CLI.
 *
 * Usage:
 *   node apps/browser-extension/scripts/pack-extension-zip.mjs [distDir] [outZip]
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

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

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

const distStat = await stat(distDir).catch(() => null);
if (!distStat?.isDirectory()) {
  console.error(`Extension dist not found: ${distDir}`);
  console.error("Build first: npm run build -w @cursor-gateway/browser-extension");
  process.exit(1);
}

const files = (await listFiles(distDir)).sort((a, b) => a.localeCompare(b));
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

const localParts = [];
const centralParts = [];
let offset = 0;

for (const filePath of files) {
  const name = relative(distDir, filePath).replaceAll("\\", "/");
  const nameBuf = Buffer.from(name, "utf8");
  const data = await readFile(filePath);
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(crc),
    u32(compressed.length),
    u32(data.length),
    u16(nameBuf.length),
    u16(0),
    nameBuf
  ]);
  const centralHeader = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(crc),
    u32(compressed.length),
    u32(data.length),
    u16(nameBuf.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    nameBuf
  ]);
  localParts.push(localHeader, compressed);
  centralParts.push(centralHeader);
  offset += localHeader.length + compressed.length;
}

const centralDirectory = Buffer.concat(centralParts);
const endRecord = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(files.length),
  u16(files.length),
  u32(centralDirectory.length),
  u32(offset),
  u16(0)
]);

await new Promise((resolvePromise, reject) => {
  const stream = createWriteStream(outZip);
  stream.on("error", reject);
  stream.on("finish", resolvePromise);
  for (const part of localParts) stream.write(part);
  stream.write(centralDirectory);
  stream.write(endRecord);
  stream.end();
});

const zipStat = await stat(outZip);
if (zipStat.size < 64) {
  console.error(`Packed zip looks empty: ${outZip}`);
  process.exit(1);
}

console.log(`Packed ${files.length} files → ${outZip} (${zipStat.size} bytes)`);
