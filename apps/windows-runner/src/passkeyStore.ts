import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { e2eePasskeyCredentialPublicSchema, type E2eePasskeyCredentialPublic } from "@cursor-gateway/shared";

const storeSchema = z
  .object({
    version: z.literal(1),
    // Keyed by lowercased Access email. Public credential metadata only —
    // the private key never leaves the authenticator/platform keystore.
    credentials: z.record(z.string(), z.array(e2eePasskeyCredentialPublicSchema))
  })
  .strict();

type Store = z.infer<typeof storeSchema>;

/**
 * Runner-local store of WebAuthn/passkey credential *public* metadata, keyed
 * by the Cloudflare-Access-authenticated email. Mirrors the plaintext-adjacent
 * style of `pairingPendingStore.ts` (0600 JSON, no secrets — public keys and
 * counters only). The Runner is the sole source of truth for verification;
 * the Gateway never sees credential material.
 */
export class PasskeyStore {
  private state: Store = { version: 1, credentials: {} };

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.state = storeSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      console.warn("[passkey-store] failed to load passkey store; starting empty");
      this.state = { version: 1, credentials: {} };
    }
  }

  private save(): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best-effort on filesystems without POSIX permission semantics.
    }
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Best-effort.
    }
  }

  credentialsForEmail(email: string): E2eePasskeyCredentialPublic[] {
    return this.state.credentials[email.toLowerCase()] ?? [];
  }

  activeCredentialsForEmail(email: string): E2eePasskeyCredentialPublic[] {
    return this.credentialsForEmail(email).filter((credential) => !credential.revokedAt);
  }

  findCredential(
    email: string,
    credentialId: string
  ): E2eePasskeyCredentialPublic | undefined {
    return this.credentialsForEmail(email).find(
      (credential) => credential.credentialId === credentialId
    );
  }

  addCredential(email: string, credential: E2eePasskeyCredentialPublic): void {
    const parsed = e2eePasskeyCredentialPublicSchema.parse(credential);
    const key = email.toLowerCase();
    const existing = this.state.credentials[key] ?? [];
    if (existing.some((item) => item.credentialId === parsed.credentialId)) {
      throw new Error("passkey_credential_already_registered");
    }
    this.state.credentials[key] = [...existing, parsed];
    this.save();
  }

  updateCounter(email: string, credentialId: string, counter: number): void {
    const key = email.toLowerCase();
    const list = this.state.credentials[key];
    if (!list) throw new Error("passkey_credential_not_found");
    const index = list.findIndex((item) => item.credentialId === credentialId);
    if (index === -1) throw new Error("passkey_credential_not_found");
    list[index] = { ...list[index]!, counter };
    this.save();
  }

  revoke(email: string, credentialId: string): boolean {
    const key = email.toLowerCase();
    const list = this.state.credentials[key];
    if (!list) return false;
    const index = list.findIndex((item) => item.credentialId === credentialId);
    if (index === -1 || list[index]!.revokedAt) return false;
    list[index] = { ...list[index]!, revokedAt: new Date().toISOString() };
    this.save();
    return true;
  }
}
