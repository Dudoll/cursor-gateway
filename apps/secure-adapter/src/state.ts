// Sealed-at-rest (or 0600 plaintext) persistence for the Adapter's device
// identity: non-exportable-at-runtime signing/encryption keys + the server-
// issued device certificate. Mirrors the MASTER_MAGIC seal format used across
// the repo so the same master key tooling applies.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import type { CgDeviceCert, E2eeKeyDescriptor } from "@cursor-gateway/shared";

export interface DeviceState {
  version: 1;
  deviceId: string;
  signingKeyId: string;
  signingPrivateJwk: JsonWebKey;
  signingDescriptor: E2eeKeyDescriptor;
  encryptionPrivateJwk: JsonWebKey;
  encryptionDescriptor: E2eeKeyDescriptor;
  deviceCert: CgDeviceCert;
}

const MASTER_MAGIC = "CG-E2EE-SCRYPT-AESGCM-v1";
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function sealWithMasterKey(plaintext: Uint8Array, masterKey: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(Buffer.from(masterKey, "utf8"), salt, 32, SCRYPT_PARAMS);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return [
    MASTER_MAGIC,
    salt.toString("base64"),
    iv.toString("base64"),
    Buffer.concat([ciphertext, tag]).toString("base64")
  ].join("\n");
}

function openWithMasterKey(stored: string, masterKey: string): Uint8Array {
  const [magic, saltB64, ivB64, blobB64] = stored.split("\n");
  if (magic !== MASTER_MAGIC || !saltB64 || !ivB64 || !blobB64) {
    throw new Error("invalid_sealed_state_format");
  }
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const blob = Buffer.from(blobB64, "base64");
  const ciphertext = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const key = scryptSync(Buffer.from(masterKey, "utf8"), salt, 32, SCRYPT_PARAMS);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } finally {
    key.fill(0);
  }
}

export class StateStore {
  constructor(
    private readonly path: string,
    private readonly masterKey?: string
  ) {}

  read(): DeviceState | null {
    if (!existsSync(this.path)) return null;
    const raw = readFileSync(this.path, "utf8");
    const text = raw.startsWith(MASTER_MAGIC)
      ? new TextDecoder().decode(
          openWithMasterKey(raw, this.masterKey ?? throwMissingMaster())
        )
      : raw;
    try {
      return JSON.parse(text) as DeviceState;
    } catch {
      return null;
    }
  }

  write(state: DeviceState): void {
    const json = JSON.stringify(state);
    const contents = this.masterKey
      ? sealWithMasterKey(new TextEncoder().encode(json), this.masterKey)
      : json;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // best-effort on filesystems without POSIX permissions
    }
  }
}

function throwMissingMaster(): never {
  throw new Error("cg_adapter_master_key_required_for_sealed_state");
}
