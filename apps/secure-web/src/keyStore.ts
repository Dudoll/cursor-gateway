import {
  type E2eeHpkeEnvelope,
  type E2eeKeyDescriptor,
  type E2eeRunnerPairingBundle
} from "@cursor-gateway/shared";
import {
  createKeyDescriptor,
  exportE2eePublicKey,
  generateNonExtractableDeviceKeys,
  generateRootKeyBytes,
  importRootKey,
  utf8
} from "@cursor-gateway/e2ee";

const DB_NAME = "cursor-gateway-secure-web";
const DB_VERSION = 1;
const META_STORE = "meta";
const RUNNER_STORE = "runners";
const CONVERSATION_STORE = "conversations";

export type DeviceRecord = {
  id: "device";
  clientId: string;
  signingPrivateKey: CryptoKey;
  signingKey: E2eeKeyDescriptor;
  encryptionPrivateKey: CryptoKey;
  encryptionKey: E2eeKeyDescriptor;
  vaultKey: CryptoKey;
  memoryRootKey: CryptoKey;
  createdAt: string;
  pairedRunnerId: string | null;
};

export type RunnerPin = E2eeRunnerPairingBundle & {
  importedAt: string;
};

export type ConversationSecret = {
  id: string;
  rootKey: CryptoKey;
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
  };
  return requestValue(request);
}

/**
 * Detect private / ephemeral storage that cannot keep CryptoKeys.
 * Returns a human-readable failure reason or null when OK.
 */
export async function detectIncompatibleStorage(): Promise<string | null> {
  try {
    if (!window.isSecureContext) return "insecure_context";
    if (!window.crypto?.subtle) return "webcrypto_unavailable";
    if (!window.indexedDB) return "indexeddb_unavailable";

    // Probe: write a non-extractable key, reopen, and use it.
    const probeDbName = `${DB_NAME}-probe-${crypto.randomUUID()}`;
    const open = indexedDB.open(probeDbName, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("k", { keyPath: "id" });
    };
    const db = await requestValue(open);
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    const write = db.transaction("k", "readwrite");
    write.objectStore("k").put({ id: "probe", key });
    await transactionDone(write);
    db.close();

    const reopen = await requestValue(indexedDB.open(probeDbName, 1));
    const read = reopen.transaction("k", "readonly");
    const stored = (await requestValue(read.objectStore("k").get("probe"))) as
      | { key?: CryptoKey }
      | undefined;
    await transactionDone(read);
    reopen.close();
    indexedDB.deleteDatabase(probeDbName);

    if (!stored?.key || !(stored.key instanceof CryptoKey)) {
      return "cryptokey_persistence_failed";
    }
    if (stored.key.extractable) return "key_unexpectedly_extractable";

    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const probeBytes = utf8("probe");
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      stored.key,
      probeBytes as BufferSource
    );
    return null;
  } catch {
    return "storage_self_test_failed";
  }
}

export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) {
      return navigator.storage.persist();
    }
  } catch {
    // ignore
  }
  return false;
}

async function createDeviceRecord(): Promise<DeviceRecord> {
  const vaultKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const { signing, encryption } = await generateNonExtractableDeviceKeys();
  if (signing.privateKey.extractable || encryption.privateKey.extractable) {
    throw new Error("device_keys_must_be_non_extractable");
  }
  const [signingKey, encryptionKey] = await Promise.all([
    createKeyDescriptor(signing.publicKey),
    createKeyDescriptor(encryption.publicKey)
  ]);
  // Public keys are always extractable; verify export path works.
  await exportE2eePublicKey(signing.publicKey);
  await exportE2eePublicKey(encryption.publicKey);

  const rawMemoryRoot = generateRootKeyBytes();
  const memoryRootKey = await importRootKey(rawMemoryRoot);
  rawMemoryRoot.fill(0);

  return {
    id: "device",
    clientId: crypto.randomUUID(),
    signingPrivateKey: signing.privateKey,
    signingKey,
    encryptionPrivateKey: encryption.privateKey,
    encryptionKey,
    vaultKey,
    memoryRootKey,
    createdAt: new Date().toISOString(),
    pairedRunnerId: null
  };
}

export class SecureWebKeyStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open() {
    return new SecureWebKeyStore(await openDatabase());
  }

  close() {
    this.database.close();
  }

  /** Delete all local E2EE state for this Secure Web origin. */
  static async wipe(openStore?: SecureWebKeyStore | null) {
    openStore?.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      request.onsuccess = () => finish(() => resolve());
      request.onerror = () =>
        finish(() => reject(request.error ?? new Error("indexeddb_delete_failed")));
    });
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

  async markPaired(runnerId: string) {
    const device = await this.device();
    const updated = { ...device, pairedRunnerId: runnerId };
    const write = this.database.transaction(META_STORE, "readwrite");
    write.objectStore(META_STORE).put(updated);
    await transactionDone(write);
    return updated;
  }

  async importRunner(bundle: E2eeRunnerPairingBundle) {
    const pin: RunnerPin = { ...bundle, importedAt: new Date().toISOString() };
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
    return values;
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
    const now = new Date().toISOString();
    const conversation: ConversationSecret = {
      id: input.id,
      rootKey: input.rootKey,
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
    // Keep rawRoot only in-memory for wrap; non-extractable rootKey is stored.
    void input.rawRoot;
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
}

export function parseMagicLinkFragment(hash: string): {
  pairId: string;
  token: string;
} | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw.includes("=") ? raw : `pair=${raw}`);
  const value = params.get("pair");
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const pairId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(pairId)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return { pairId, token };
}

export function clearMagicLinkFragment() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}
