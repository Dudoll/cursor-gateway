/**
 * relay-P5: decryptor worker IPC isolation.
 * Proves the worker (sole master-key holder) performs wrap/unwrap over loopback
 * IPC for a caller that never sees the key — the model of a keyless HTTP front.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const workerJs = join(here, "..", "dist", "csapi", "decryptorWorker.js");

function rpc(port: number, req: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk;
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          sock.end();
          try {
            resolve(JSON.parse(buf.slice(0, idx)));
          } catch (e) {
            reject(e);
          }
        }
      });
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("rpc_timeout")), 5000);
  });
}

test("decryptor worker wraps/unwraps over IPC without exposing the key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decryptor-"));
  const keyFile = join(dir, "master.key");
  writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  const port = 4700 + Math.floor(Math.random() * 500);

  const child = spawn(process.execPath, [workerJs], {
    env: {
      ...process.env,
      CS_RELAY_MASTER_KEY_FILE: keyFile,
      CS_RELAY_DECRYPTOR_PORT: String(port)
    },
    stdio: ["ignore", "ignore", "inherit"]
  });

  try {
    // Wait for the listener.
    await new Promise((r) => setTimeout(r, 800));

    const ping = await rpc(port, { id: "1", method: "ping" });
    assert.equal(ping.ok, true);
    assert.equal((ping.result as { role: string }).role, "decryptor");

    const secret = "cs-relay-DEK-material-PLAINTEXT";
    const wrapRes = await rpc(port, {
      id: "2",
      method: "wrap",
      params: { plaintextB64: Buffer.from(secret).toString("base64"), aad: { ctx: "test" } }
    });
    assert.equal(wrapRes.ok, true);
    const ciphertext = (wrapRes.result as { ciphertext: unknown }).ciphertext;
    // Ciphertext must not carry the plaintext anywhere.
    assert.equal(JSON.stringify(ciphertext).includes(secret), false);
    assert.equal(
      JSON.stringify(ciphertext).includes(Buffer.from(secret).toString("base64")),
      false
    );

    const unwrapRes = await rpc(port, {
      id: "3",
      method: "unwrap",
      params: { ciphertext, aad: { ctx: "test" } }
    });
    assert.equal(unwrapRes.ok, true);
    const back = Buffer.from(
      (unwrapRes.result as { plaintextB64: string }).plaintextB64,
      "base64"
    ).toString();
    assert.equal(back, secret);

    // Wrong AAD must fail closed.
    const bad = await rpc(port, {
      id: "4",
      method: "unwrap",
      params: { ciphertext, aad: { ctx: "wrong" } }
    });
    assert.equal(bad.ok, false);
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
