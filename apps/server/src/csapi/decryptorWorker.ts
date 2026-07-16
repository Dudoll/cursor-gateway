/**
 * Decryptor worker (relay-P5): holds KMS master key; HTTP front must run with
 * CS_RELAY_HTTP_NO_KMS=true and talk over a local Unix socket / loopback IPC.
 *
 * Usage:
 *   CS_RELAY_DECRYPTOR_ONLY=true node apps/server/dist/csapi/decryptorWorker.js
 */
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { FileMasterKeyProvider, type KmsProvider } from "@cursor-gateway/e2ee";

function loadMaster(): string {
  const relayFile = (process.env.CS_RELAY_MASTER_KEY_FILE ?? "").trim();
  const cgFile = (process.env.CG_MASTER_KEY_FILE ?? "").trim();
  const inline = (process.env.CG_MASTER_KEY ?? "").trim();
  const fromFile =
    (relayFile && existsSync(relayFile) ? readFileSync(relayFile, "utf8").trim() : "") ||
    (cgFile && existsSync(cgFile) ? readFileSync(cgFile, "utf8").trim() : "");
  const master = fromFile || inline;
  if (master.length < 16) {
    console.error("[decryptor] master key missing or too short");
    process.exit(1);
  }
  return master;
}

function createKms(): KmsProvider {
  const master = loadMaster();
  const keyId = (process.env.CS_RELAY_KMS_KEY_ID ?? "file-master-1").trim() || "file-master-1";
  return new FileMasterKeyProvider(keyId, master);
}

type RpcRequest = {
  id: string;
  method: "ping" | "wrap" | "unwrap";
  params?: { plaintextB64?: string; ciphertext?: unknown; aad?: unknown };
};

async function handleRpc(kms: KmsProvider, req: RpcRequest): Promise<unknown> {
  if (req.method === "ping") return { ok: true, role: "decryptor", keyId: kms.keyId };
  if (req.method === "wrap") {
    const plain = Buffer.from(req.params?.plaintextB64 ?? "", "base64");
    const wrapped = await kms.wrap(plain, req.params?.aad);
    return { ciphertext: wrapped };
  }
  if (req.method === "unwrap") {
    const opened = await kms.unwrap(req.params?.ciphertext as never, req.params?.aad);
    return { plaintextB64: Buffer.from(opened).toString("base64") };
  }
  throw new Error("unknown_method");
}

function attachLineHandler(
  kms: KmsProvider,
  write: (line: string) => void
): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      void (async () => {
        let id = "unknown";
        try {
          const req = JSON.parse(line) as RpcRequest;
          id = req.id;
          const result = await handleRpc(kms, req);
          write(JSON.stringify({ id, ok: true, result }) + "\n");
        } catch (error) {
          write(
            JSON.stringify({
              id,
              ok: false,
              error: error instanceof Error ? error.message : "error"
            }) + "\n"
          );
        }
      })();
    }
  };
}

async function main() {
  const kms = createKms();
  const port = Number(process.env.CS_RELAY_DECRYPTOR_PORT ?? "0");
  if (port > 0) {
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      const onData = attachLineHandler(kms, (line) => socket.write(line));
      socket.on("data", onData);
    });
    server.listen(port, "127.0.0.1", () => {
      console.error(`[decryptor] listening on 127.0.0.1:${port}`);
    });
    return;
  }

  process.stdin.setEncoding("utf8");
  const onData = attachLineHandler(kms, (line) => process.stdout.write(line));
  process.stdin.on("data", onData);
  console.error("[decryptor] ready on stdin/stdout");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
