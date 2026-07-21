#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const textExtensions = new Set([".json", ".md", ".mjs", ".ts"]);
const skippedDirectories = new Set([".git", "dist", "node_modules"]);

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      result.push(...(await filesIn(path)));
    }
    else if (textExtensions.has(extname(entry.name))) result.push(path);
  }
  return result;
}

function formatText(path, source) {
  if (extname(path) === ".json") {
    return `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
  }
  const normalized = source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n*$/u, "\n");
  return normalized;
}

let changed = 0;
for (const path of await filesIn(root)) {
  const source = await readFile(path, "utf8");
  const formatted = formatText(path, source);
  if (formatted !== source) {
    await writeFile(path, formatted, "utf8");
    changed += 1;
  }
}
process.stdout.write(`format: ${changed} file(s) updated\n`);
