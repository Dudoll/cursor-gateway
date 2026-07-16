/**
 * cs-relay-v1 — DEK/KEK wrap helpers + KmsProvider abstraction for trusted-CS history.
 * See docs/trusted-cs-relay.md §7.
 */
import type { E2eeCiphertext } from "@cursor-gateway/shared";
import {
  decodeBase64Url,
  encodeBase64Url,
  encryptJson,
  decryptJson,
  generateRootKeyBytes,
  importRootKey
} from "./index.js";

export const CS_RELAY_MSG_PURPOSE = "cs-relay/1:conversation-message" as const;
export const CS_RELAY_DEK_WRAP_PURPOSE = "cs-relay/1:dek-wrap" as const;
export const CS_RELAY_KEK_WRAP_PURPOSE = "cs-relay/1:kek-wrap" as const;

export interface KmsProvider {
  readonly kind: string;
  readonly keyId: string;
  wrap(plaintext: Uint8Array, aad: unknown): Promise<E2eeCiphertext>;
  unwrap(ciphertext: E2eeCiphertext, aad: unknown): Promise<Uint8Array>;
}

/** File / inline master-key provider (scrypt-derived AES via HKDF root). For prod prefer external KMS. */
export class FileMasterKeyProvider implements KmsProvider {
  readonly kind = "file-master-key";
  private root: CryptoKey | null = null;

  constructor(
    readonly keyId: string,
    private readonly masterSecret: string
  ) {
    if (masterSecret.length < 16) throw new Error("kms_master_key_too_short");
  }

  private async ensureRoot(): Promise<CryptoKey> {
    if (this.root) return this.root;
    const material = new TextEncoder().encode(this.masterSecret);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
    this.root = await importRootKey(digest, false);
    digest.fill(0);
    return this.root;
  }

  async wrap(plaintext: Uint8Array, aad: unknown): Promise<E2eeCiphertext> {
    const root = await this.ensureRoot();
    return encryptJson(root, CS_RELAY_KEK_WRAP_PURPOSE, aad, {
      key: encodeBase64Url(plaintext)
    });
  }

  async unwrap(ciphertext: E2eeCiphertext, aad: unknown): Promise<Uint8Array> {
    const root = await this.ensureRoot();
    const opened = (await decryptJson(root, CS_RELAY_KEK_WRAP_PURPOSE, aad, ciphertext)) as {
      key?: string;
    };
    if (!opened.key || typeof opened.key !== "string") throw new Error("kms_unwrap_invalid");
    return decodeBase64Url(opened.key);
  }
}

/** In-memory provider for unit tests (not for production). */
export class MemoryKmsProvider implements KmsProvider {
  readonly kind = "memory";
  private rootPromise: Promise<CryptoKey>;

  constructor(readonly keyId = "memory-kms-1") {
    const bytes = generateRootKeyBytes();
    this.rootPromise = importRootKey(bytes, false).then((key) => {
      bytes.fill(0);
      return key;
    });
  }

  async wrap(plaintext: Uint8Array, aad: unknown): Promise<E2eeCiphertext> {
    const root = await this.rootPromise;
    return encryptJson(root, CS_RELAY_KEK_WRAP_PURPOSE, aad, {
      key: encodeBase64Url(plaintext)
    });
  }

  async unwrap(ciphertext: E2eeCiphertext, aad: unknown): Promise<Uint8Array> {
    const root = await this.rootPromise;
    const opened = (await decryptJson(root, CS_RELAY_KEK_WRAP_PURPOSE, aad, ciphertext)) as {
      key?: string;
    };
    if (!opened.key || typeof opened.key !== "string") throw new Error("kms_unwrap_invalid");
    return decodeBase64Url(opened.key);
  }
}

export async function sealDek(
  accountKek: CryptoKey,
  dekBytes: Uint8Array,
  aad: unknown
): Promise<E2eeCiphertext> {
  return encryptJson(accountKek, CS_RELAY_DEK_WRAP_PURPOSE, aad, {
    dek: encodeBase64Url(dekBytes)
  });
}

export async function openDek(
  accountKek: CryptoKey,
  wrapped: E2eeCiphertext,
  aad: unknown
): Promise<Uint8Array> {
  const opened = (await decryptJson(accountKek, CS_RELAY_DEK_WRAP_PURPOSE, aad, wrapped)) as {
    dek?: string;
  };
  if (!opened.dek || typeof opened.dek !== "string") throw new Error("dek_unwrap_invalid");
  return decodeBase64Url(opened.dek);
}

export async function encryptRelayMessage(
  dek: CryptoKey,
  aad: unknown,
  value: { role: string; text: string; [k: string]: unknown }
): Promise<E2eeCiphertext> {
  return encryptJson(dek, CS_RELAY_MSG_PURPOSE, aad, value);
}

export async function decryptRelayMessage<T = unknown>(
  dek: CryptoKey,
  aad: unknown,
  ciphertext: E2eeCiphertext
): Promise<T> {
  return decryptJson(dek, CS_RELAY_MSG_PURPOSE, aad, ciphertext) as Promise<T>;
}

export function zeroize(buf: Uint8Array): void {
  buf.fill(0);
}
