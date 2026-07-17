# Runner-assisted manual code (RAMC) — `secure-web-runner-code/1`

Status: **P0 spec frozen.** Primary device-verification flow for Secure Web
that needs **no QR scan and no external email**. The operator reads a one-time
code (and a 6-word SAS) off the **Runner's own terminal / TTY** and types it
into the browser. Passkey, paired-device approval, recovery codes, email
magic-link and QR remain as fallbacks (see [Fallback ordering](#fallback-ordering)).

This document is authoritative. It freezes the wire schema, the state machine,
the transcript binding and the security model. Implementation phases P1–P5 must
not diverge from it without updating this file first.

---

## 1. Threat model & honest scope

RAMC binds a **new browser device key** to a **Runner** under a **Cloudflare
Access account**, using a short human-carried secret as the authenticator over
an untrusted relay (the Gateway/VPS). It defends against:

- A passive or active relay (Gateway/VPS, cg-mitm, cs-relay) that tries to
  read the code, swap public keys, or splice a different Runner/account.
- Replay, cross-account grafting, and offline brute force of the code
  (the code never appears server-side; only an HMAC tag over the full
  transcript does, and the enrollment is TTL- and attempt-limited).

RAMC **does not** by itself prove the integrity of the first-load Secure Web
JavaScript. A malicious server could serve tampered JS that lies about the SAS.
Two independent mechanisms close that gap and are **required** for a full trust
story:

1. **Trusted PWA bootstrap** — the Secure Web app is installed as a PWA from a
   known-good build; subsequent loads are served from the local service worker
   cache, not re-fetched from the server on every launch (P4).
2. **Desktop localhost verifier** — a Local Runner loopback service fetches the
   Secure Web asset manifest and verifies an **offline Ed25519 root signature +
   per-asset content hashes**, printing PASS/FAIL in the terminal, independent
   of the page JS (P3).

We do **not** claim RAMC alone attests first-load JS. Documentation, README and
UI copy must repeat this boundary.

---

## 2. Roles

| Party   | Holds                                              | Trust anchor |
|---------|----------------------------------------------------|--------------|
| Browser | non-extractable P-256 signing + ECDH keys (`clientId`) | Cloudflare Access session (account/email) + offline trust roots |
| Runner  | signing + ECDH keys, offline-signed identity cert, **the one-time code** | offline Ed25519/ES256 trust root |
| Gateway | nothing secret; relays public envelopes + an HMAC tag | CF Access (browser) / shared secret (runner) |

The **code lives only on the Runner** and is carried by the human to the
browser. This is the mirror image of recovery pairing (where the browser holds
the pre-provisioned secret).

---

## 3. State machine

```
requested ──(runner offer)──▶ offered ──(browser confirm)──▶ confirm_submitted
                                  ▲                                   │
                    (bad code, attempts left)                         │ (runner verifies MAC + SAS)
                                  └───────────────────────────────────┤
                                                                       ├─(ok)──▶ paired ──(server signs cg cert)──▶ cert_issued
                                                                       ├─(bad code, attempts exhausted)──▶ locked
                                                                       └─(operator reject)──▶ rejected
any state, on TTL ─────────────────────────────────────────────────────────────▶ expired
```

- **TTL:** 5 minutes (`E2EE_RUNNER_CODE_TTL_SECONDS`, default 300).
- **Attempts:** 3 bad-code confirmations → `locked` (terminal).
- One-time: a code pairs at most one `clientId`; success is idempotent, any
  further confirm is rejected.

---

## 4. Wire schema (`secure-web-runner-code/1`)

Defined in `packages/shared/src/index.ts`. All envelopes carry
`protocol: "cg-e2ee/1"`, `pairingKind: "secure-web-runner-code/1"`.

| Envelope | Direction | Key fields |
|----------|-----------|-----------|
| `e2eeRunnerCodePairingStart` | Browser → GW | `enrollId`, `clientId`, `clientChallenge`, `signingKey`, `encryptionKey`, `secureOrigin`, `gatewayOrigin` |
| `e2eeRunnerCodePairingOffer` | Runner → GW → Browser | `serverNonce`, `runnerChallenge`, runner `encryptionKey`/`signingKey`, `runnerCertificate`, client fingerprints, `expiresAt` |
| `e2eeRunnerCodePairingConfirm` | Browser → GW → Runner | `transcriptMac` = HMAC(code, transcript), `sas` (6 words), client `signature` |
| `e2eeRunnerCodePairingAck` | Runner → GW → Browser | `status` (`paired`/`rejected`), optional `reason`, runner keys + cert, runner `signature` |

`accountId`/`email` are **never** taken from any of these; they come from the
Cloudflare Access session on the browser-facing endpoints.

## 5. Transcript binding

`runnerCodePairingTranscript(offer)` (in `packages/e2ee`) canonicalises and
binds, per P0 requirement:

- `enrollId`, `serverNonce`
- client signing + encryption fingerprints
- runner signing + encryption fingerprints
- runner cert id
- root key id + fingerprint + epoch
- `secureOrigin`, `gatewayOrigin`, `expiresAt`

The one-time **code** authenticates this transcript two ways:

- `transcriptMac = HMAC-SHA256(HKDF(code, "…-mac"), canonical(transcript))`
- `sas = first 6 bytes of HMAC-SHA256(HKDF(code, "…-sas"), canonical(transcript))`
  mapped through the frozen 256-word `RAMC_SAS_WORDLIST`.

Both sides derive the SAS independently; they match iff the same code was used
over the same untampered transcript. This is the P2 mode-B human channel.

## 6. Cryptographic rules

- **Code:** 128-bit CSPRNG, base64url (22 chars); displayed as Crockford
  base32 groups (`runnerDeviceCodeDisplay`). Never uploaded, never logged,
  never persisted server-side in cleartext.
- **HMAC transcript** binds all public material; a relay that swaps a key or
  origin changes the transcript and both the MAC and SAS fail.
- **Runner certificate** is verified by the browser against offline trust roots
  before the code is entered.
- **Both parties sign:** browser signs the confirm; runner signs the ack.
- **Replay / idempotency / one-time** enforced by the server row + runner
  single-use check.
- **Short numeric/word-only codes are forbidden with plain HMAC.** If a future
  10-digit / 6-word *primary* code is desired it MUST use a PAKE
  (SPAKE2-P256 / OPAQUE); see P2 notes. The current 128-bit code is safe with
  HMAC because it is high-entropy.

## 7. Server persistence

Table `e2ee_runner_code_enrollments` (Postgres, see `apps/server/src/db.ts`):

```
enroll_id uuid pk, user_id uuid, email text, status text,
start_envelope jsonb, offer_envelope jsonb, confirm_envelope jsonb,
ack_envelope jsonb, device_cert jsonb, runner_id text,
attempts int default 0, max_attempts int default 3,
expires_at timestamptz, created_at, updated_at
```

Row-level `for update skip locked` claiming; TTL sweep to `expired`.
Production must persist to Postgres — **no memory-only fallback**.

## 8. Endpoints

Browser (Cloudflare Access user, `/api/e2ee/v1`):

- `POST /runner-code/start`
- `GET  /runner-code/:enrollId` (status + offer + ack + attemptsRemaining)
- `POST /runner-code/:enrollId/confirm`

Runner (`requireRunner`, `/api/runner/e2ee/v1`):

- `POST /runner-code/claim-start`  → claims a `requested` enrollment
- `POST /runner-code/offer`
- `POST /runner-code/claim-confirm` → claims a `confirm_submitted` enrollment
- `POST /runner-code/ack`

On `paired`, the server signs a `cg-device-cert/2` (`accountId`+`deviceId`+
`epoch`) and `upsertCgDevice`s it (when the cg-mitm secure server config is
present); the browser retrieves it through the cg-mitm ciphertext channel. The
E2EE device row (`e2ee_devices`) is always written so RAMC works even when
cg-mitm is disabled.

## 9. Runner terminal UX

- Poll `claim-start`; on a new enrollment print, to the Runner's **TTY / local
  UI** (not journald-persisted logs): account/email, device label, the 6-word
  SAS, and the high-entropy code.
- `RUNNER_CODE_APPROVAL=auto|manual` (default `manual`): manual requires the
  operator to compare the SAS shown in the browser and approve/reject.
- If stdout is captured by journald, the code is written to a single
  `0600` file shown once then deleted, or to `/dev/tty` directly — never to the
  persistent structured log.

## 10. Fallback ordering

Secure Web presents, in order:

1. **Runner 设备码 (RAMC)** — recommended default, no QR/email.
2. 已授权设备批准 (paired-device approval)
3. Passkey
4. 恢复码 (recovery code)
5. 邮箱 magic-link
6. QR

All fallbacks remain fully functional and regression-tested.

## 11. Feature flags

- Server: `RUNNER_CODE_PAIRING_ENABLED` (default off for gray rollout),
  `E2EE_RUNNER_CODE_TTL_SECONDS`, `E2EE_RUNNER_CODE_MAX_ATTEMPTS`.
- Runner: `RUNNER_CODE_ENABLED`, `RUNNER_CODE_APPROVAL`.
- Secure Web: entry is shown when the server policy advertises it; rollback is
  turning the server flag off (browser hides the panel, other methods stay).
