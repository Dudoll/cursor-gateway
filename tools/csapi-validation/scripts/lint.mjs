#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checkedExtensions = new Set([".json", ".md", ".mjs", ".ts"]);
const skippedDirectories = new Set([".git", "dist", "node_modules"]);
const failures = [];

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      result.push(...(await filesIn(path)));
    }
    else if (checkedExtensions.has(extname(entry.name))) result.push(path);
  }
  return result;
}

for (const path of await filesIn(root)) {
  const name = relative(root, path);
  const source = await readFile(path, "utf8");
  if (!source.endsWith("\n")) failures.push(`${name}: missing final newline`);
  if (/[ \t]+$/mu.test(source)) failures.push(`${name}: trailing whitespace`);
  if (source.includes("\r")) failures.push(`${name}: CRLF is not allowed`);
  if (
    (name.startsWith("src/") || name.startsWith("scripts/")) &&
    /\bconsole\.(?:log|error|warn|info)\b/u.test(source)
  ) {
    failures.push(`${name}: direct console output bypasses redaction`);
  }
}

const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8")
);
if (packageJson.private !== true) failures.push("package.json: package must remain private");
if (
  packageJson.dependencies &&
  Object.keys(packageJson.dependencies).length > 0
) {
  failures.push("package.json: runtime dependencies are not allowed");
}

const httpSource = await readFile(join(root, "src", "http.ts"), "utf8");
if (/process\.stdout|process\.stderr/u.test(httpSource)) {
  failures.push("src/http.ts: transport must never print request or response data");
}
const testSource = await readFile(join(root, "test", "validation.test.ts"), "utf8");
if (/setTimeout\s*\([^,]+,\s*3\d{5}/u.test(testSource)) {
  failures.push("test/validation.test.ts: long tests must use a fake clock");
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("lint: isolated-tool checks passed\n");
}
