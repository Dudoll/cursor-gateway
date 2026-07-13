import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(fileURLToPath(new URL("../dist", import.meta.url)));

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    })
  );
  return nested.flat();
}

const paths = (await files(root))
  .filter((path) => !path.endsWith("/SHA256SUMS"))
  .sort((left, right) => left.localeCompare(right));
const lines = [];
for (const path of paths) {
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  lines.push(`${digest}  ${relative(root, path).replaceAll("\\", "/")}`);
}
await writeFile(resolve(root, "SHA256SUMS"), `${lines.join("\n")}\n`, {
  encoding: "utf8",
  mode: 0o644
});
