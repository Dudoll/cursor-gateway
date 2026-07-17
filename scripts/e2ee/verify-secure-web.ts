#!/usr/bin/env -S npx tsx
/**
 * Desktop localhost Secure Web verifier (RAMC P3).
 *
 * Independently attests the *served* Secure Web first-load assets WITHOUT
 * trusting the page JS: it fetches `<origin>/asset-manifest.json`, verifies the
 * offline Ed25519 signature against a PINNED public key, then fetches every
 * listed asset and checks its SHA-256. Prints PASS/FAIL in the terminal.
 *
 * Two modes:
 *   verify-secure-web.ts --origin https://secure.joelzt.org [--public PATH]
 *   verify-secure-web.ts --serve [--port 8790] [--allow a,b] [--public PATH]
 *
 * The --serve mode binds 127.0.0.1 ONLY, enforces a host allowlist, and does
 * NOT emit CORS headers — a malicious page cannot read the result and thus
 * cannot fake a PASS. The authoritative signal is the terminal / JSON output.
 *
 * See docs/secure-web-verifier.md.
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MANIFEST_NAME = "asset-manifest.json";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

type VerifyResult = {
  ok: boolean;
  origin: string;
  reason?: string;
  version?: string;
  checked: number;
  mismatches: string[];
};

function loadPinnedKey(publicPath: string) {
  const pinned = JSON.parse(readFileSync(publicPath, "utf8")) as {
    publicKey: { kty: string; crv: string; x: string };
    fingerprint: string;
  };
  return {
    key: createPublicKey({ key: pinned.publicKey as object, format: "jwk" }),
    fingerprint: pinned.fingerprint,
    jwkX: pinned.publicKey.x
  };
}

async function verifyOrigin(origin: string, publicPath: string): Promise<VerifyResult> {
  const base = origin.replace(/\/$/, "");
  const pinned = loadPinnedKey(publicPath);
  const result: VerifyResult = { ok: false, origin: base, checked: 0, mismatches: [] };
  let signed: (Record<string, unknown> & { signature: string; assets: { path: string; sha256: string }[] });
  try {
    const res = await fetch(`${base}/${MANIFEST_NAME}`, { redirect: "error" });
    if (!res.ok) {
      result.reason = `manifest_http_${res.status}`;
      return result;
    }
    signed = (await res.json()) as typeof signed;
  } catch (error) {
    result.reason = `manifest_fetch_failed:${error instanceof Error ? error.message : "unknown"}`;
    return result;
  }

  const { signature, ...manifest } = signed;
  if ((manifest as { publicKeyFingerprint?: string }).publicKeyFingerprint !== pinned.fingerprint) {
    result.reason = "public_key_fingerprint_mismatch";
    return result;
  }
  const sigOk = edVerify(null, Buffer.from(canonical(manifest)), pinned.key, fromB64url(signature));
  if (!sigOk) {
    result.reason = "signature_invalid";
    return result;
  }
  result.version = (manifest as { version?: string }).version;

  for (const asset of signed.assets) {
    result.checked += 1;
    try {
      const res = await fetch(`${base}/${asset.path}`, { redirect: "error" });
      if (!res.ok) {
        result.mismatches.push(`${asset.path} (http ${res.status})`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (b64url(createHash("sha256").update(bytes).digest()) !== asset.sha256) {
        result.mismatches.push(`${asset.path} (hash)`);
      }
    } catch (error) {
      result.mismatches.push(`${asset.path} (${error instanceof Error ? error.message : "fetch"})`);
    }
  }
  result.ok = result.mismatches.length === 0;
  if (!result.ok) result.reason = "asset_mismatch";
  return result;
}

async function runCli(args: Record<string, string>) {
  const origin = args.origin;
  const publicPath = resolve(
    args.public ?? "scripts/e2ee/trust/secure-web-asset-manifest-public.json"
  );
  if (!origin) {
    process.stderr.write("--origin is required (or use --serve)\n");
    process.exit(2);
  }
  const result = await verifyOrigin(origin, publicPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok) {
    process.stdout.write(`PASS: ${result.origin} v${result.version} — ${result.checked} assets verified\n`);
    process.exit(0);
  }
  process.stdout.write(`FAIL: ${result.origin} — ${result.reason}\n`);
  process.exit(1);
}

function runServer(args: Record<string, string>) {
  const port = Number(args.port ?? "8790");
  const publicPath = resolve(
    args.public ?? "scripts/e2ee/trust/secure-web-asset-manifest-public.json"
  );
  const allow = new Set(
    (args.allow ?? "https://secure.joelzt.org")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean)
  );
  const server = createServer((req, res) => {
    // Never emit CORS headers: a web page must not be able to read this result.
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/verify") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const origin = (url.searchParams.get("origin") ?? "").replace(/\/$/, "");
    if (!allow.has(origin)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "origin_not_allowed", allow: [...allow] }));
      return;
    }
    void verifyOrigin(origin, publicPath)
      .then((result) => {
        res.writeHead(result.ok ? 200 : 502, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        process.stdout.write(`[verify] ${origin} → ${result.ok ? "PASS" : `FAIL:${result.reason}`}\n`);
      })
      .catch((error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal", message: error instanceof Error ? error.message : "unknown" }));
      });
  });
  // Loopback bind ONLY.
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Secure Web verifier listening on http://127.0.0.1:${port}/verify\n`);
    process.stdout.write(`Allowed origins: ${[...allow].join(", ")}\n`);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.serve) return runServer(args);
  return void runCli(args);
}

main();
