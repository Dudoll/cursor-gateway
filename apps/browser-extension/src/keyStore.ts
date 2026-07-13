import { z } from "zod";
import {
  E2EE_PROTOCOL,
  conversationSchema,
  e2eeHpkeEnvelopeSchema,
  e2eeKeyDescriptorSchema,
  e2eeRunnerPairingBundleSchema,
  memoryFactSchema,
  runRecordSchema,
  type E2eeCiphertext,
  type E2eeClientPairingBundle,
  type E2eeHpkeEnvelope,
  type E2eeKeyDescriptor,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  exportPrivateJwk,
  generateRootKeyBytes,
  generateSigningKeyPair,
  importRootKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  signValue,
  verifyValue,
  utf8
} from "@cursor-gateway/e2ee";

const DB_NAME = "cursor-gateway-secure";
const DB_VERSION = 2;
const META_STORE = "meta";
const RUNNER_STORE = "runners";
const CONVERSATION_STORE = "conversations";
const LEGACY_ARCHIVE_STORE = "legacy-archives";
const PBKDF2_ITERATIONS = 600_000;

type ProtectedBytes = E2eeCiphertext;

export type DeviceRecord = {
  id: "device";
  clientId: string;
  signingPrivateKey: CryptoKey;
  signingKey: E2eeKeyDescriptor;
  protectedSigningPrivate: ProtectedBytes;
  vaultKey: CryptoKey;
  memoryRootKey: CryptoKey;
  protectedMemoryRoot: ProtectedBytes;
  createdAt: string;
};

export type RunnerPin = E2eeRunnerPairingBundle & {
  importedAt: string;
};

export type ConversationSecret = {
  id: string;
  rootKey: CryptoKey;
  protectedRoot: ProtectedBytes;
  wrappedConversationKey: E2eeHpkeEnvelope;
  runnerId: string;
  runnerKeyId: string;
  workspaceId: string;
  model: string;
  sequence: number;
  lastDigest: string | null;
  createdAt: string;
  updatedAt: string;
};

export const legacyArchivePayloadSchema = z
  .object({
    version: z.literal(1),
    exportedAt: z.string(),
    conversations: z
      .array(
        z
          .object({
            conversation: conversationSchema,
            runs: z.array(runRecordSchema).max(10_000)
          })
          .strict()
      )
      .max(1_000),
    memory: z.array(memoryFactSchema).max(10_000)
  })
  .strict();
export type LegacyArchivePayload = z.infer<typeof legacyArchivePayloadSchema>;

export type LegacyArchiveRecord = {
  id: string;
  protectedPayload: ProtectedBytes;
  conversationCount: number;
  runCount: number;
  memoryCount: number;
  createdAt: string;
};

const backupConversationSchema = z
  .object({
    id: z.string().uuid(),
    rawRoot: z.string().min(1),
    wrappedConversationKey: e2eeHpkeEnvelopeSchema,
    runnerId: z.string().min(1),
    runnerKeyId: z.string().min(1),
    workspaceId: z.string().min(1),
    model: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    lastDigest: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict();

const backupSchema = z
  .object({
    version: z.literal(1),
    protocol: z.literal(E2EE_PROTOCOL),
    exportedAt: z.string(),
    device: z
      .object({
        clientId: z.string().min(8),
        signingPrivateJwk: z.record(z.string(), z.unknown()),
        signingKey: e2eeKeyDescriptorSchema,
        memoryRoot: z.string().min(1),
        createdAt: z.string()
      })
      .strict(),
    runners: z.array(e2eeRunnerPairingBundleSchema),
    conversations: z.array(backupConversationSchema),
    legacyArchives: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            payload: legacyArchivePayloadSchema,
            createdAt: z.string()
          })
          .strict()
      )
      .default([])
  })
  .strict();

const backupContainerSchema = z
  .object({
    version: z.literal(1),
    kdf: z.literal("PBKDF2-SHA256"),
    iterations: z.number().int().min(100_000),
    salt: z.string().min(1),
    cipher: z.literal("A256GCM"),
    nonce: z.string().min(1),
    ciphertext: z.string().min(1)
  })
  .strict();

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(value.byteLength);
  output.set(value);
  return output.buffer;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb_request_failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("indexeddb_transaction_failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("indexeddb_transaction_aborted"));
  });
}

async function openDatabase() {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(META_STORE)) {
      database.createObjectStore(META_STORE, { keyPath: "id" });
    }
    if (!database.objectStoreNames.contains(RUNNER_STORE)) {
      database.createObjectStore(RUNNER_STORE, { keyPath: "runnerId" });
    }
    if (!database.objectStoreNames.contains(CONVERSATION_STORE)) {
      database.createObjectStore(CONVERSATION_STORE, { keyPath: "id" });
    }
    if (!database.objectStoreNames.contains(LEGACY_ARCHIVE_STORE)) {
      database.createObjectStore(LEGACY_ARCHIVE_STORE, { keyPath: "id" });
    }
  };
  return requestValue(request);
}

async function sealBytes(key: CryptoKey, purpose: string, plaintext: Uint8Array) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(utf8(`cursor-gateway-vault:${purpose}`)),
        tagLength: 128
      },
      key,
      toArrayBuffer(plaintext)
    )
  );
  return {
    alg: "A256GCM",
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext)
  } satisfies ProtectedBytes;
}

async function openBytes(key: CryptoKey, purpose: string, encrypted: ProtectedBytes) {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(decodeBase64Url(encrypted.nonce)),
          additionalData: toArrayBuffer(utf8(`cursor-gateway-vault:${purpose}`)),
          tagLength: 128
        },
        key,
        toArrayBuffer(decodeBase64Url(encrypted.ciphertext))
      )
    );
  } catch {
    throw new Error("vault_decryption_failed");
  }
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array, iterations: number) {
  if (passphrase.length < 12) throw new Error("backup_passphrase_too_short");
  const material = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(utf8(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function createDeviceRecord(): Promise<DeviceRecord> {
  const vaultKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const generatedSigningKeys = await generateSigningKeyPair(true);
  const signingPrivateJwk = await exportPrivateJwk(generatedSigningKeys.privateKey);
  const signingPrivateKey = await importSigningPrivateKey(signingPrivateJwk);
  const signingKey = await createKeyDescriptor(generatedSigningKeys.publicKey);
  const signingBytes = utf8(JSON.stringify(signingPrivateJwk));
  const protectedSigningPrivate = await sealBytes(
    vaultKey,
    "signing-private",
    signingBytes
  );
  signingBytes.fill(0);

  const rawMemoryRoot = generateRootKeyBytes();
  const memoryRootKey = await importRootKey(rawMemoryRoot);
  const protectedMemoryRoot = await sealBytes(vaultKey, "memory-root", rawMemoryRoot);
  rawMemoryRoot.fill(0);

  return {
    id: "device",
    clientId: crypto.randomUUID(),
    signingPrivateKey,
    signingKey,
    protectedSigningPrivate,
    vaultKey,
    memoryRootKey,
    protectedMemoryRoot,
    createdAt: new Date().toISOString()
  };
}

export function encodePairingBundle(value: unknown) {
  return encodeBase64Url(utf8(JSON.stringify(value)));
}

export function decodeRunnerPairingBundle(value: string) {
  return e2eeRunnerPairingBundleSchema.parse(
    JSON.parse(decodeUtf8(decodeBase64Url(value.trim())))
  );
}

export class SecureKeyStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open() {
    return new SecureKeyStore(await openDatabase());
  }

  async device() {
    const transaction = this.database.transaction(META_STORE, "readonly");
    const existing = (await requestValue(
      transaction.objectStore(META_STORE).get("device")
    )) as DeviceRecord | undefined;
    await transactionDone(transaction);
    if (existing) return existing;

    const created = await createDeviceRecord();
    const write = this.database.transaction(META_STORE, "readwrite");
    write.objectStore(META_STORE).put(created);
    await transactionDone(write);
    return created;
  }

  async clientPairingBundle(): Promise<E2eeClientPairingBundle> {
    const device = await this.device();
    return {
      protocol: E2EE_PROTOCOL,
      kind: "client-pairing",
      clientId: device.clientId,
      signingKey: device.signingKey,
      createdAt: new Date().toISOString()
    };
  }

  async importRunner(bundle: E2eeRunnerPairingBundle) {
    const parsed = e2eeRunnerPairingBundleSchema.parse(bundle);
    const existing = await this.runner(parsed.runnerId);
    if (
      existing &&
      (existing.encryptionKey.fingerprint !== parsed.encryptionKey.fingerprint ||
        existing.signingKey.fingerprint !== parsed.signingKey.fingerprint)
    ) {
      throw new Error("runner_fingerprint_changed");
    }
    const pin: RunnerPin = { ...parsed, importedAt: new Date().toISOString() };
    const transaction = this.database.transaction(RUNNER_STORE, "readwrite");
    transaction.objectStore(RUNNER_STORE).put(pin);
    await transactionDone(transaction);
    return pin;
  }

  async runner(runnerId: string) {
    const transaction = this.database.transaction(RUNNER_STORE, "readonly");
    const value = (await requestValue(
      transaction.objectStore(RUNNER_STORE).get(runnerId)
    )) as RunnerPin | undefined;
    await transactionDone(transaction);
    return value;
  }

  async runners() {
    const transaction = this.database.transaction(RUNNER_STORE, "readonly");
    const values = (await requestValue(
      transaction.objectStore(RUNNER_STORE).getAll()
    )) as RunnerPin[];
    await transactionDone(transaction);
    return values.sort((left, right) => left.runnerId.localeCompare(right.runnerId));
  }

  async createConversation(input: {
    id: string;
    rawRoot: Uint8Array;
    rootKey: CryptoKey;
    wrappedConversationKey: E2eeHpkeEnvelope;
    runnerId: string;
    runnerKeyId: string;
    workspaceId: string;
    model: string;
  }) {
    const device = await this.device();
    const now = new Date().toISOString();
    const conversation: ConversationSecret = {
      id: input.id,
      rootKey: input.rootKey,
      protectedRoot: await sealBytes(
        device.vaultKey,
        `conversation:${input.id}`,
        input.rawRoot
      ),
      wrappedConversationKey: input.wrappedConversationKey,
      runnerId: input.runnerId,
      runnerKeyId: input.runnerKeyId,
      workspaceId: input.workspaceId,
      model: input.model,
      sequence: 0,
      lastDigest: null,
      createdAt: now,
      updatedAt: now
    };
    const transaction = this.database.transaction(CONVERSATION_STORE, "readwrite");
    transaction.objectStore(CONVERSATION_STORE).add(conversation);
    await transactionDone(transaction);
    return conversation;
  }

  async conversation(id: string) {
    const transaction = this.database.transaction(CONVERSATION_STORE, "readonly");
    const value = (await requestValue(
      transaction.objectStore(CONVERSATION_STORE).get(id)
    )) as ConversationSecret | undefined;
    await transactionDone(transaction);
    return value;
  }

  async conversations() {
    const transaction = this.database.transaction(CONVERSATION_STORE, "readonly");
    const values = (await requestValue(
      transaction.objectStore(CONVERSATION_STORE).getAll()
    )) as ConversationSecret[];
    await transactionDone(transaction);
    return values;
  }

  async advanceConversation(id: string, sequence: number, lastDigest: string) {
    const conversation = await this.conversation(id);
    if (!conversation) throw new Error("conversation_key_missing");
    if (sequence < conversation.sequence) throw new Error("conversation_sequence_regression");
    const updated = {
      ...conversation,
      sequence,
      lastDigest,
      updatedAt: new Date().toISOString()
    };
    const transaction = this.database.transaction(CONVERSATION_STORE, "readwrite");
    transaction.objectStore(CONVERSATION_STORE).put(updated);
    await transactionDone(transaction);
    return updated;
  }

  async archiveLegacyData(value: LegacyArchivePayload) {
    const payload = legacyArchivePayloadSchema.parse(value);
    const device = await this.device();
    const id = crypto.randomUUID();
    const bytes = utf8(JSON.stringify(payload));
    const runCount = payload.conversations.reduce(
      (count, conversation) => count + conversation.runs.length,
      0
    );
    const record: LegacyArchiveRecord = {
      id,
      protectedPayload: await sealBytes(
        device.vaultKey,
        `legacy-archive:${id}`,
        bytes
      ),
      conversationCount: payload.conversations.length,
      runCount,
      memoryCount: payload.memory.length,
      createdAt: new Date().toISOString()
    };
    bytes.fill(0);
    const transaction = this.database.transaction(LEGACY_ARCHIVE_STORE, "readwrite");
    transaction.objectStore(LEGACY_ARCHIVE_STORE).add(record);
    await transactionDone(transaction);
    await this.legacyArchive(id);
    return record;
  }

  async legacyArchiveRecords() {
    const transaction = this.database.transaction(LEGACY_ARCHIVE_STORE, "readonly");
    const records = (await requestValue(
      transaction.objectStore(LEGACY_ARCHIVE_STORE).getAll()
    )) as LegacyArchiveRecord[];
    await transactionDone(transaction);
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async legacyArchive(id: string) {
    const transaction = this.database.transaction(LEGACY_ARCHIVE_STORE, "readonly");
    const record = (await requestValue(
      transaction.objectStore(LEGACY_ARCHIVE_STORE).get(id)
    )) as LegacyArchiveRecord | undefined;
    await transactionDone(transaction);
    if (!record) throw new Error("legacy_archive_not_found");
    const plaintext = await openBytes(
      (await this.device()).vaultKey,
      `legacy-archive:${id}`,
      record.protectedPayload
    );
    try {
      return legacyArchivePayloadSchema.parse(JSON.parse(decodeUtf8(plaintext)));
    } finally {
      plaintext.fill(0);
    }
  }

  async exportBackup(passphrase: string) {
    const device = await this.device();
    const [signingPrivate, memoryRoot, runners, conversations, archiveRecords] = await Promise.all([
      openBytes(device.vaultKey, "signing-private", device.protectedSigningPrivate),
      openBytes(device.vaultKey, "memory-root", device.protectedMemoryRoot),
      this.runners(),
      this.conversations(),
      this.legacyArchiveRecords()
    ]);
    const legacyArchives = await Promise.all(
      archiveRecords.map(async (record) => ({
        id: record.id,
        payload: await this.legacyArchive(record.id),
        createdAt: record.createdAt
      }))
    );
    const backupConversations = await Promise.all(
      conversations.map(async (conversation) => {
        const rawRoot = await openBytes(
          device.vaultKey,
          `conversation:${conversation.id}`,
          conversation.protectedRoot
        );
        try {
          return {
            id: conversation.id,
            rawRoot: encodeBase64Url(rawRoot),
            wrappedConversationKey: conversation.wrappedConversationKey,
            runnerId: conversation.runnerId,
            runnerKeyId: conversation.runnerKeyId,
            workspaceId: conversation.workspaceId,
            model: conversation.model,
            sequence: conversation.sequence,
            lastDigest: conversation.lastDigest,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt
          };
        } finally {
          rawRoot.fill(0);
        }
      })
    );
    const plaintext = utf8(
      JSON.stringify({
        version: 1,
        protocol: E2EE_PROTOCOL,
        exportedAt: new Date().toISOString(),
        device: {
          clientId: device.clientId,
          signingPrivateJwk: JSON.parse(decodeUtf8(signingPrivate)),
          signingKey: device.signingKey,
          memoryRoot: encodeBase64Url(memoryRoot),
          createdAt: device.createdAt
        },
        runners: runners.map(({ importedAt: _importedAt, ...runner }) => runner),
        conversations: backupConversations,
        legacyArchives
      })
    );
    signingPrivate.fill(0);
    memoryRoot.fill(0);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveBackupKey(passphrase, salt, PBKDF2_ITERATIONS);
    try {
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: toArrayBuffer(nonce),
            additionalData: toArrayBuffer(utf8("cursor-gateway-backup-v1")),
            tagLength: 128
          },
          key,
          toArrayBuffer(plaintext)
        )
      );
      return encodeBase64Url(
        utf8(
          JSON.stringify({
            version: 1,
            kdf: "PBKDF2-SHA256",
            iterations: PBKDF2_ITERATIONS,
            salt: encodeBase64Url(salt),
            cipher: "A256GCM",
            nonce: encodeBase64Url(nonce),
            ciphertext: encodeBase64Url(ciphertext)
          })
        )
      );
    } finally {
      plaintext.fill(0);
    }
  }

  async importBackup(encoded: string, passphrase: string) {
    const container = backupContainerSchema.parse(
      JSON.parse(decodeUtf8(decodeBase64Url(encoded.trim())))
    );
    const key = await deriveBackupKey(
      passphrase,
      decodeBase64Url(container.salt),
      container.iterations
    );
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: toArrayBuffer(decodeBase64Url(container.nonce)),
            additionalData: toArrayBuffer(utf8("cursor-gateway-backup-v1")),
            tagLength: 128
          },
          key,
          toArrayBuffer(decodeBase64Url(container.ciphertext))
        )
      );
    } catch {
      throw new Error("backup_decryption_failed");
    }
    let backup: z.infer<typeof backupSchema>;
    try {
      backup = backupSchema.parse(JSON.parse(decodeUtf8(plaintext)));
    } finally {
      plaintext.fill(0);
    }

    const vaultKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    const signingPrivateJwk = backup.device.signingPrivateJwk as JsonWebKey;
    const signingPrivateKey = await importSigningPrivateKey(signingPrivateJwk);
    const importedPublic = await importSigningPublicKey(
      backup.device.signingKey.publicKey
    );
    const descriptor = await createKeyDescriptor(importedPublic);
    if (
      descriptor.keyId !== backup.device.signingKey.keyId ||
      descriptor.fingerprint !== backup.device.signingKey.fingerprint
    ) {
      throw new Error("backup_signing_key_mismatch");
    }
    const proofValue = {
      protocol: E2EE_PROTOCOL,
      purpose: "backup-private-key-proof",
      challenge: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    };
    const proof = await signValue(
      proofValue,
      signingPrivateKey,
      backup.device.signingKey.keyId
    );
    if (!(await verifyValue(proofValue, proof, importedPublic))) {
      throw new Error("backup_signing_private_key_mismatch");
    }
    const signingBytes = utf8(JSON.stringify(signingPrivateJwk));
    const memoryRootRaw = decodeBase64Url(backup.device.memoryRoot);
    const device: DeviceRecord = {
      id: "device",
      clientId: backup.device.clientId,
      signingPrivateKey,
      signingKey: backup.device.signingKey,
      protectedSigningPrivate: await sealBytes(
        vaultKey,
        "signing-private",
        signingBytes
      ),
      vaultKey,
      memoryRootKey: await importRootKey(memoryRootRaw),
      protectedMemoryRoot: await sealBytes(vaultKey, "memory-root", memoryRootRaw),
      createdAt: backup.device.createdAt
    };
    signingBytes.fill(0);
    memoryRootRaw.fill(0);

    const conversationRecords: ConversationSecret[] = [];
    for (const conversation of backup.conversations) {
      const rawRoot = decodeBase64Url(conversation.rawRoot);
      conversationRecords.push({
        id: conversation.id,
        rootKey: await importRootKey(rawRoot),
        protectedRoot: await sealBytes(
          vaultKey,
          `conversation:${conversation.id}`,
          rawRoot
        ),
        wrappedConversationKey: conversation.wrappedConversationKey,
        runnerId: conversation.runnerId,
        runnerKeyId: conversation.runnerKeyId,
        workspaceId: conversation.workspaceId,
        model: conversation.model,
        sequence: conversation.sequence,
        lastDigest: conversation.lastDigest,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt
      });
      rawRoot.fill(0);
    }

    const legacyArchiveRecords: LegacyArchiveRecord[] = [];
    for (const archive of backup.legacyArchives) {
      const bytes = utf8(JSON.stringify(archive.payload));
      const runCount = archive.payload.conversations.reduce(
        (count, conversation) => count + conversation.runs.length,
        0
      );
      legacyArchiveRecords.push({
        id: archive.id,
        protectedPayload: await sealBytes(
          vaultKey,
          `legacy-archive:${archive.id}`,
          bytes
        ),
        conversationCount: archive.payload.conversations.length,
        runCount,
        memoryCount: archive.payload.memory.length,
        createdAt: archive.createdAt
      });
      bytes.fill(0);
    }

    const transaction = this.database.transaction(
      [META_STORE, RUNNER_STORE, CONVERSATION_STORE, LEGACY_ARCHIVE_STORE],
      "readwrite"
    );
    const metaStore = transaction.objectStore(META_STORE);
    const runnerStore = transaction.objectStore(RUNNER_STORE);
    const conversationStore = transaction.objectStore(CONVERSATION_STORE);
    const legacyArchiveStore = transaction.objectStore(LEGACY_ARCHIVE_STORE);
    metaStore.clear();
    runnerStore.clear();
    conversationStore.clear();
    legacyArchiveStore.clear();
    metaStore.put(device);
    backup.runners.forEach((runner) =>
      runnerStore.put({ ...runner, importedAt: new Date().toISOString() })
    );
    conversationRecords.forEach((conversation) => conversationStore.put(conversation));
    legacyArchiveRecords.forEach((archive) => legacyArchiveStore.put(archive));
    await transactionDone(transaction);
  }
}
