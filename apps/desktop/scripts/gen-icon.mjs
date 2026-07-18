#!/usr/bin/env node
// Generates apps/desktop/app-icon.png (1024x1024) with zero image dependencies.
// `tauri icon app-icon.png` (see `npm run icon`) fans this out into the platform
// icon set required by the bundler. Regenerate with: node scripts/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "app-icon.png");

// Palette (matches Secure Web theme-color #0f172a).
const BG = [15, 23, 42];       // slate-900
const PLATE = [56, 189, 248];  // sky-400 accent
const DARK = [15, 23, 42];     // keyhole cut-out

const buf = Buffer.alloc(SIZE * SIZE * 4);
const cx = SIZE / 2;
const cy = SIZE / 2;
const plateR = SIZE * 0.30;         // rounded-square "lock body" radius
const shackleR = SIZE * 0.16;       // shackle outer radius
const shackleInner = SIZE * 0.095;  // shackle inner radius
const shackleCy = cy - SIZE * 0.19; // shackle center (above body)
const holeR = SIZE * 0.055;         // keyhole circle
const holeCy = cy + SIZE * 0.02;

function roundedSquareAlpha(x, y) {
  // Signed-distance rounded square centered at (cx, cy).
  const half = SIZE * 0.24;
  const r = SIZE * 0.06;
  const dx = Math.abs(x - cx) - (half - r);
  const dy = Math.abs(y - cy) - (half - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside <= 0;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    let [r, g, b] = BG;
    let a = 255;

    // Background: transparent corners for a modern app-icon look.
    const dCorner = Math.hypot(x - cx, y - cy);
    if (dCorner > SIZE * 0.52) {
      a = 0;
    }

    // Shackle (ring) above the body.
    const dS = Math.hypot(x - cx, y - shackleCy);
    if (dS <= shackleR && dS >= shackleInner && y <= shackleCy + SIZE * 0.02) {
      [r, g, b] = PLATE;
    }

    // Lock body.
    if (roundedSquareAlpha(x, y)) {
      [r, g, b] = PLATE;
      // Keyhole cut-out.
      const dHole = Math.hypot(x - cx, y - holeCy);
      const stemHalf = SIZE * 0.018;
      const inStem = Math.abs(x - cx) <= stemHalf && y >= holeCy && y <= holeCy + SIZE * 0.09;
      if (dHole <= holeR || inStem) {
        [r, g, b] = DARK;
      }
    }

    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  }
}

writeFileSync(out, encodePng(buf, SIZE, SIZE));
console.log(`wrote ${out} (${SIZE}x${SIZE})`);

function crc32(bytes) {
  let c = ~0;
  for (let n = 0; n < bytes.length; n++) {
    c ^= bytes[n];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Add per-scanline filter byte (0 = none).
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
