import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  e2eeClientPairingBundleSchema,
  e2eeKeyDescriptorSchema,
  e2eeResultEnvelopeSchema,
  type E2eeClientPairingBundle,
  type E2eeResultEnvelope,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  exportPrivateJwk,
  generateHpkeKeyPair,
  generateSigningKeyPair,
  importHpkePrivateKey,
  importSigningPrivateKey
} from "@cursor-gateway/e2ee";
import { config } from "./config.js";

const privateJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(1),
    y: z.string().min(1),
    d: z.string().min(1)
  })
  .passthrough();

const storedStateSchema = z
  .object({
    version: z.literal(1),
    runnerId: z.string().min(1),
    encryption: z
      .object({
        privateJwk: privateJwkSchema,
        descriptor: e2eeKeyDescriptorSchema
      })
      .strict(),
    signing: z
      .object({
        privateJwk: privateJwkSchema,
        descriptor: e2eeKeyDescriptorSchema
      })
      .strict(),
    pairedClients: z.record(z.string(), e2eeClientPairingBundleSchema),
    seenMessages: z.record(
      z.string(),
      z
        .object({
          runId: z.string().uuid(),
          state: z.enum(["running", "finished"]),
          seenAt: z.string()
        })
        .strict()
    ),
    cachedResults: z.record(z.string(), e2eeResultEnvelopeSchema),
    conversationAgents: z.record(z.string(), z.string().min(1)),
    conversationDigests: z.record(z.string(), z.string().min(1)).default({}),
    conversationSequences: z.record(
      z.string(),
      z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    ).default({})
  })
  .strict();

type StoredState = z.infer<typeof storedStateSchema>;

const DEV_PREFIX = "CURSOR_GATEWAY_INSECURE_DEV_STATE\n";
const MAX_REPLAY_ENTRIES = 10_000;
const MAX_CACHED_RESULTS = 1_000;

function runDpapi(operation: "Protect" | "Unprotect", input: Uint8Array): Uint8Array {
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$encoded=[Console]::In.ReadToEnd();",
    "$data=[Convert]::FromBase64String($encoded);",
    `$output=[Security.Cryptography.ProtectedData]::${operation}(`,
    "$data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($output));"
  ].join("");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: Buffer.from(input).toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`dpapi_${operation.toLowerCase()}_failed`);
  }
  try {
    return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
  } catch {
    throw new Error(`dpapi_${operation.toLowerCase()}_failed`);
  }
}

function protectState(plaintext: Uint8Array): Uint8Array {
  if (process.platform === "win32") return runDpapi("Protect", plaintext);
  if (!config.e2eeAllowInsecureDevStorage) {
    throw new Error(
      "Runner E2EE private state requires Windows DPAPI; set " +
        "RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE=true only for local tests"
    );
  }
  return new TextEncoder().encode(`${DEV_PREFIX}${new TextDecoder().decode(plaintext)}`);
}

function unprotectState(stored: Uint8Array): Uint8Array {
  if (process.platform === "win32") return runDpapi("Unprotect", stored);
  if (!config.e2eeAllowInsecureDevStorage) {
    throw new Error("Refusing to load E2EE state without Windows DPAPI");
  }
  const value = new TextDecoder().decode(stored);
  if (!value.startsWith(DEV_PREFIX)) throw new Error("invalid_insecure_dev_state");
  return new TextEncoder().encode(value.slice(DEV_PREFIX.length));
}

function pruneRecord<T>(record: Record<string, T>, maxEntries: number, dateOf: (value: T) => string) {
  const entries = Object.entries(record);
  if (entries.length <= maxEntries) return;
  entries
    .sort(([, left], [, right]) => Date.parse(dateOf(left)) - Date.parse(dateOf(right)))
    .slice(0, entries.length - maxEntries)
    .forEach(([key]) => delete record[key]);
}

export class RunnerE2eeState {
  readonly encryptionPrivateKey: CryptoKey;
  readonly signingPrivateKey: CryptoKey;
  private writeQueue = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly state: StoredState,
    encryptionPrivateKey: CryptoKey,
    signingPrivateKey: CryptoKey
  ) {
    this.encryptionPrivateKey = encryptionPrivateKey;
    this.signingPrivateKey = signingPrivateKey;
  }

  static async loadOrCreate(filePath = config.e2eeStateFile) {
    let state: StoredState;
    if (existsSync(filePath)) {
      const protectedBytes = new Uint8Array(readFileSync(filePath));
      const plaintext = unprotectState(protectedBytes);
      try {
        state = storedStateSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
      } finally {
        plaintext.fill(0);
      }
      if (state.runnerId !== config.runnerId) {
        throw new Error("e2ee_state_runner_id_mismatch");
      }
    } else {
      const [encryptionKeys, signingKeys] = await Promise.all([
        generateHpkeKeyPair(),
        generateSigningKeyPair()
      ]);
      const [
        encryptionPrivateJwk,
        signingPrivateJwk,
        encryptionDescriptor,
        signingDescriptor
      ] = await Promise.all([
        exportPrivateJwk(encryptionKeys.privateKey),
        exportPrivateJwk(signingKeys.privateKey),
        createKeyDescriptor(encryptionKeys.publicKey),
        createKeyDescriptor(signingKeys.publicKey)
      ]);
      state = {
        version: 1,
        runnerId: config.runnerId,
        encryption: {
          privateJwk: privateJwkSchema.parse(encryptionPrivateJwk),
          descriptor: encryptionDescriptor
        },
        signing: {
          privateJwk: privateJwkSchema.parse(signingPrivateJwk),
          descriptor: signingDescriptor
        },
        pairedClients: {},
        seenMessages: {},
        cachedResults: {},
        conversationAgents: {},
        conversationDigests: {},
        conversationSequences: {}
      };
    }

    const instance = new RunnerE2eeState(
      filePath,
      state,
      await importHpkePrivateKey(state.encryption.privateJwk),
      await importSigningPrivateKey(state.signing.privateJwk)
    );
    if (!existsSync(filePath)) await instance.persist();
    return instance;
  }

  get encryptionKey() {
    return this.state.encryption.descriptor;
  }

  get signingKey() {
    return this.state.signing.descriptor;
  }

  runnerPairingBundle(): E2eeRunnerPairingBundle {
    return {
      protocol: "cg-e2ee/1",
      kind: "runner-pairing",
      runnerId: this.state.runnerId,
      encryptionKey: this.state.encryption.descriptor,
      signingKey: this.state.signing.descriptor,
      createdAt: new Date().toISOString()
    };
  }

  getPairedClient(clientId: string, keyId: string) {
    const paired = this.state.pairedClients[clientId];
    return paired?.signingKey.keyId === keyId ? paired : undefined;
  }

  async pairClient(bundle: E2eeClientPairingBundle) {
    const parsed = e2eeClientPairingBundleSchema.parse(bundle);
    const existing = this.state.pairedClients[parsed.clientId];
    if (existing && existing.signingKey.fingerprint !== parsed.signingKey.fingerprint) {
      throw new Error("client_id_already_paired_with_different_key");
    }
    this.state.pairedClients[parsed.clientId] = parsed;
    await this.persist();
    return parsed;
  }

  pairedClients() {
    return Object.values(this.state.pairedClients).sort((left, right) =>
      left.clientId.localeCompare(right.clientId)
    );
  }

  async revokeClient(clientId: string) {
    if (!this.state.pairedClients[clientId]) return false;
    delete this.state.pairedClients[clientId];
    await this.persist();
    return true;
  }

  messageState(messageId: string) {
    return this.state.seenMessages[messageId];
  }

  async markMessageStarted(messageId: string, runId: string) {
    const existing = this.state.seenMessages[messageId];
    if (existing) {
      if (existing.runId !== runId) throw new Error("e2ee_message_id_run_mismatch");
      return existing;
    }
    this.state.seenMessages[messageId] = {
      runId,
      state: "running",
      seenAt: new Date().toISOString()
    };
    await this.persist();
    return undefined;
  }

  async markMessageFinished(
    messageId: string,
    runId: string,
    result: E2eeResultEnvelope
  ) {
    this.state.seenMessages[messageId] = {
      runId,
      state: "finished",
      seenAt: new Date().toISOString()
    };
    this.state.cachedResults[runId] = result;
    await this.persist();
  }

  cachedResult(runId: string) {
    return this.state.cachedResults[runId];
  }

  agentId(conversationId: string) {
    return this.state.conversationAgents[conversationId] ?? null;
  }

  async setAgentId(conversationId: string, agentId: string | null) {
    if (agentId) this.state.conversationAgents[conversationId] = agentId;
    else delete this.state.conversationAgents[conversationId];
    await this.persist();
  }

  conversationDigest(conversationId: string) {
    return this.state.conversationDigests[conversationId] ?? null;
  }

  conversationSequence(conversationId: string) {
    return this.state.conversationSequences[conversationId] ?? 0;
  }

  async setConversationPosition(conversationId: string, sequence: number, digest: string) {
    this.state.conversationDigests[conversationId] = digest;
    this.state.conversationSequences[conversationId] = sequence;
    await this.persist();
  }

  async flush() {
    await this.writeQueue;
  }

  private async persist() {
    pruneRecord(this.state.seenMessages, MAX_REPLAY_ENTRIES, (value) => value.seenAt);
    pruneRecord(
      this.state.cachedResults,
      MAX_CACHED_RESULTS,
      (value) => value.createdAt
    );
    const snapshot = JSON.stringify(this.state);
    this.writeQueue = this.writeQueue.then(async () => {
      const directory = dirname(this.filePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        chmodSync(directory, 0o700);
      } catch {
        // Windows ACLs and DPAPI are the security boundary on Windows.
      }
      const plaintext = new TextEncoder().encode(snapshot);
      const protectedBytes = protectState(plaintext);
      plaintext.fill(0);
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, protectedBytes, { mode: 0o600 });
      renameSync(temporaryPath, this.filePath);
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // Windows ACLs and DPAPI are the security boundary on Windows.
      }
    });
    await this.writeQueue;
  }
}
