import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions
} from "@simplewebauthn/server";
import { PasskeyStore } from "../src/passkeyStore.js";
import { PendingRecordStore } from "../src/pendingRecordStore.js";

test("WebAuthn registration options require UV and bind rpId", async () => {
  const options = await generateRegistrationOptions({
    rpName: "Cursor Gateway Secure",
    rpID: "secure.joelzt.org",
    userName: "user@example.com",
    userID: new Uint8Array(16).fill(7),
    userDisplayName: "user@example.com",
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required"
    }
  });
  assert.equal(options.rp.id, "secure.joelzt.org");
  assert.equal(options.authenticatorSelection?.userVerification, "required");
  assert.ok(typeof options.challenge === "string" && options.challenge.length >= 32);
});

test("WebAuthn authentication options require UV and bind rpId", async () => {
  const options = await generateAuthenticationOptions({
    rpID: "secure.joelzt.org",
    userVerification: "required",
    allowCredentials: [{ id: "cred-1" }]
  });
  assert.equal(options.rpId, "secure.joelzt.org");
  assert.equal(options.userVerification, "required");
  assert.ok(typeof options.challenge === "string" && options.challenge.length >= 32);
});

test("pending WebAuthn challenge store is single-use and TTL-pruned", () => {
  const dir = mkdtempSync(join(tmpdir(), "webauthn-pending-"));
  const filePath = join(dir, "pending.json");
  try {
    const store = new PendingRecordStore<{ challenge: string; expiresAt: string }>(
      filePath,
      (value) => value.expiresAt
    );
    store.set("pair-1", {
      challenge: "chal-a",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    store.set("pair-expired", {
      challenge: "chal-b",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    });
    assert.equal(store.get("pair-1")?.challenge, "chal-a");
    store.pruneExpired();
    assert.equal(store.get("pair-expired"), undefined);
    store.delete("pair-1");
    assert.equal(store.get("pair-1"), undefined);
    // Replay after delete must miss (single-use).
    assert.equal(store.get("pair-1"), undefined);
    const persisted = JSON.parse(readFileSync(filePath, "utf8")) as {
      records: Record<string, unknown>;
    };
    assert.deepEqual(persisted.records, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passkey store keeps public metadata only and advances counter", () => {
  const dir = mkdtempSync(join(tmpdir(), "passkey-store-"));
  const filePath = join(dir, "passkeys.json");
  try {
    const store = new PasskeyStore(filePath);
    const credentialId = "cred-abcdefghijklmnopqrstuv";
    const publicKey = "AQIDBAUGBwgJCgsMDQ4PEBESExQV";
    store.addCredential("User@Example.com", {
      credentialId,
      publicKey,
      counter: 0,
      transports: ["internal"],
      label: "phone",
      createdAt: new Date().toISOString(),
      revokedAt: null
    });
    assert.equal(store.credentialsForEmail("user@example.com").length, 1);
    store.updateCounter("user@example.com", credentialId, 3);
    assert.equal(store.findCredential("user@example.com", credentialId)?.counter, 3);
    const raw = readFileSync(filePath, "utf8");
    assert.doesNotMatch(raw, /privateKey|secret|seed/i);
    assert.match(raw, /cred-abcdefghijklmnopqrstuv/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
