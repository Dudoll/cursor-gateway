import { expect, test, type Page } from "@playwright/test";
import {
  E2EE_PASSKEY_PAIRING_KIND,
  E2EE_PROTOCOL,
  E2EE_RUNNER_CERT_KIND,
  E2EE_TRUST_ROOT_KIND,
  type E2eeKeyDescriptor,
  type E2eePasskeyPairingAck,
  type E2eePasskeyPairingOptions,
  type E2eePasskeyPairingStart,
  type E2eeRunnerIdentityCert,
  type E2eeSignature,
  type E2eeTrustRootPublic
} from "../../../packages/shared/dist/index.js";

const SECURE_ORIGIN = "https://secure.joelzt.org";
const UPDATE_URL =
  "https://raw.githubusercontent.com/Dudoll/cursor-gateway/main/apps/secure-web/public/desktop-version.json";
const UPDATE_HASH = "a".repeat(64);

type UpdateMetadata = {
  schemaVersion: 1;
  version: string;
  sha256: string;
  installerAvailable: boolean;
  installerUrl: string;
  publishedAt: string;
};

type BridgeInput = {
  gatewayOrigin: string;
  path: string;
  method?: string;
  body?: string;
};

type TestTrustRoot = {
  privateKey: CryptoKey;
  public: E2eeTrustRootPublic;
};

const encoder = new TextEncoder();

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("non_json_test_fixture");
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const copy = Uint8Array.from(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
}

function challenge(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function signingKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  ) as Promise<CryptoKeyPair>;
}

async function encryptionKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  ) as Promise<CryptoKeyPair>;
}

async function descriptor(key: CryptoKey): Promise<E2eeKeyDescriptor> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("invalid_test_key");
  }
  const publicKey = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
  const digest = base64Url(await sha256(encoder.encode(canonicalJson(publicKey))));
  return {
    keyId: `p256-${digest.slice(0, 22)}`,
    fingerprint: `sha256:${digest}`,
    publicKey
  };
}

async function signature(
  value: unknown,
  privateKey: CryptoKey,
  keyId: string
): Promise<E2eeSignature> {
  const signed = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      encoder.encode(canonicalJson(value))
    )
  );
  return { alg: "ES256", keyId, value: base64Url(signed) };
}

async function trustRoot(): Promise<TestTrustRoot> {
  const pair = await signingKeyPair();
  const key = await descriptor(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    public: {
      protocol: E2EE_PROTOCOL,
      kind: E2EE_TRUST_ROOT_KIND,
      keyId: key.keyId,
      fingerprint: key.fingerprint,
      publicKey: key.publicKey,
      epoch: 1,
      createdAt: new Date().toISOString()
    }
  };
}

async function runnerCertificate(input: {
  root: TestTrustRoot;
  signingKey: E2eeKeyDescriptor;
  encryptionKey: E2eeKeyDescriptor;
}): Promise<E2eeRunnerIdentityCert> {
  const unsigned = {
    protocol: E2EE_PROTOCOL,
    kind: E2EE_RUNNER_CERT_KIND,
    version: 1 as const,
    certId: crypto.randomUUID(),
    runnerId: "runner-e2e",
    epoch: 1,
    encryptionKey: input.encryptionKey,
    signingKey: input.signingKey,
    allowedSecureOrigins: [SECURE_ORIGIN],
    allowedRpIds: ["secure.joelzt.org"],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    rootKeyId: input.root.public.keyId,
    rootFingerprint: input.root.public.fingerprint
  };
  const transcript = {
    protocol: unsigned.protocol,
    kind: unsigned.kind,
    version: unsigned.version,
    certId: unsigned.certId,
    runnerId: unsigned.runnerId,
    epoch: unsigned.epoch,
    encryptionFingerprint: unsigned.encryptionKey.fingerprint,
    encryptionKeyId: unsigned.encryptionKey.keyId,
    signingFingerprint: unsigned.signingKey.fingerprint,
    signingKeyId: unsigned.signingKey.keyId,
    allowedSecureOrigins: [...unsigned.allowedSecureOrigins].sort(),
    allowedRpIds: [...unsigned.allowedRpIds].sort(),
    issuedAt: unsigned.issuedAt,
    expiresAt: unsigned.expiresAt,
    rootKeyId: unsigned.rootKeyId,
    rootFingerprint: unsigned.rootFingerprint
  };
  return {
    ...unsigned,
    signature: await signature(
      transcript,
      input.root.privateKey,
      input.root.public.keyId
    )
  };
}

class DesktopBackend {
  loggedIn = false;
  passkeyFailuresLeft = 0;
  accessTransientFailuresLeft = 0;
  permanentAccessError = false;
  calls: string[] = [];
  passkeyOrigins: string[] = [];
  diagnosticEntries: Array<Record<string, unknown>> = [];
  updateMetadata: UpdateMetadata = {
    schemaVersion: 1,
    version: "0.1.7",
    sha256: UPDATE_HASH,
    installerAvailable: true,
    installerUrl: "https://cs.joelzt.org/api/desktop/download",
    publishedAt: "2026-07-19T00:00:00.000Z"
  };

  private requestNumber = 0;
  private start: E2eePasskeyPairingStart | null = null;
  private options: E2eePasskeyPairingOptions | null = null;
  private ack: E2eePasskeyPairingAck | null = null;

  private constructor(
    private readonly trustRoot: TestTrustRoot,
    private readonly runnerSigning: CryptoKeyPair,
    private readonly runnerSigningKey: E2eeKeyDescriptor,
    private readonly runnerEncryptionKey: E2eeKeyDescriptor,
    private readonly runnerCertificate: E2eeRunnerIdentityCert
  ) {}

  static async create() {
    const root = await trustRoot();
    const runnerSigning = await signingKeyPair();
    const runnerEncryption = await encryptionKeyPair();
    const runnerSigningKey = await descriptor(runnerSigning.publicKey);
    const runnerEncryptionKey = await descriptor(runnerEncryption.publicKey);
    const cert = await runnerCertificate({
      root,
      signingKey: runnerSigningKey,
      encryptionKey: runnerEncryptionKey
    });
    return new DesktopBackend(
      root,
      runnerSigning,
      runnerSigningKey,
      runnerEncryptionKey,
      cert
    );
  }

  async invoke(command: string, args: Record<string, unknown> | undefined) {
    switch (command) {
      case "desktop_app_version":
        return { version: "0.1.6" };
      case "desktop_log_diagnostic":
        this.diagnosticEntries.push(
          (args?.entry ?? {}) as Record<string, unknown>
        );
        return null;
      case "desktop_read_diagnostics":
        return this.diagnosticEntries;
      case "desktop_diagnostics_path":
        return "C:\\safe\\diagnostics.jsonl";
      case "desktop_access_show":
        this.loggedIn = true;
        return null;
      case "desktop_bridge_fetch":
        return this.bridgeFetch(
          (args?.request ?? {}) as BridgeInput
        );
      case "desktop_perform_passkey": {
        const request = (args?.request ?? {}) as {
          passkeyOrigin?: string;
        };
        this.passkeyOrigins.push(String(request.passkeyOrigin ?? ""));
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (this.passkeyFailuresLeft > 0) {
          this.passkeyFailuresLeft -= 1;
          throw new Error("passkey_rp_id_mismatch");
        }
        const credentialId = "AQIDBAUGBwgJCgsMDQ4PEBESExQ";
        return {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          authenticatorAttachment: "platform",
          clientExtensionResults: {},
          response: {
            clientDataJSON: credentialId,
            attestationObject: credentialId,
            transports: ["internal"],
            publicKeyAlgorithm: -7
          }
        };
      }
      case "desktop_install_update":
        return null;
      default:
        throw new Error(`unexpected_desktop_command:${command}`);
    }
  }

  private response(status: number, body: unknown) {
    this.requestNumber += 1;
    return {
      status,
      body: body === undefined ? "" : JSON.stringify(body),
      contentType: "application/json",
      requestId: `e2e-${this.requestNumber}`,
      opaqueRedirect: false
    };
  }

  private async bridgeFetch(input: BridgeInput) {
    const method = (input.method ?? "GET").toUpperCase();
    this.calls.push(`${method} ${input.path}`);
    if (!this.loggedIn) {
      return {
        status: 0,
        body: "",
        contentType: null,
        requestId: `e2e-${++this.requestNumber}`,
        opaqueRedirect: true
      };
    }

    if (input.path === "/api/e2ee-policy") {
      if (this.permanentAccessError) {
        return this.response(403, { error: "email_not_allowed" });
      }
      if (this.accessTransientFailuresLeft > 0) {
        this.accessTransientFailuresLeft -= 1;
        throw new Error("Failed to fetch");
      }
      return this.response(200, {
        runnerCodePairingEnabled: false,
        secureClientOrigin: SECURE_ORIGIN,
        cfAccessLogoutUrl: null,
        trustRoots: [this.trustRoot.public]
      });
    }
    if (input.path === "/api/desktop/version") {
      return this.response(200, this.updateMetadata);
    }
    if (input.path === "/api/e2ee/v1/passkey/start" && method === "POST") {
      this.start = (JSON.parse(input.body ?? "{}") as { start: E2eePasskeyPairingStart }).start;
      const now = new Date().toISOString();
      this.options = {
        protocol: E2EE_PROTOCOL,
        pairingKind: E2EE_PASSKEY_PAIRING_KIND,
        pairId: this.start.pairId,
        runnerId: "runner-e2e",
        mode: "registration",
        options: {
          challenge: challenge(),
          rp: { id: "secure.joelzt.org", name: "Secure Gateway" },
          user: {
            id: challenge(),
            name: "e2e@example.test",
            displayName: "E2E"
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 120_000,
          attestation: "none",
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required"
          }
        },
        runnerEncryptionKey: this.runnerEncryptionKey,
        runnerSigningKey: this.runnerSigningKey,
        runnerCertificate: this.runnerCertificate,
        clientId: this.start.clientId,
        clientChallenge: this.start.clientChallenge,
        clientSigningFingerprint: this.start.signingKey.fingerprint,
        clientEncryptionFingerprint: this.start.encryptionKey.fingerprint,
        secureOrigin: SECURE_ORIGIN,
        gatewayOrigin: this.start.gatewayOrigin,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        createdAt: now
      };
      return this.response(202, {
        pairId: this.start.pairId,
        status: "pending_start",
        expiresAt: this.options.expiresAt
      });
    }
    if (
      this.start &&
      input.path === `/api/e2ee/v1/passkey/${this.start.pairId}/complete` &&
      method === "POST"
    ) {
      const unsignedAck = {
        protocol: E2EE_PROTOCOL,
        pairingKind: E2EE_PASSKEY_PAIRING_KIND,
        pairId: this.start.pairId,
        clientId: this.start.clientId,
        runnerId: "runner-e2e",
        status: "paired" as const,
        runnerEncryptionKey: this.runnerEncryptionKey,
        runnerSigningKey: this.runnerSigningKey,
        runnerCertificate: this.runnerCertificate,
        createdAt: new Date().toISOString()
      };
      this.ack = {
        ...unsignedAck,
        signature: await signature(
          unsignedAck,
          this.runnerSigning.privateKey,
          this.runnerSigningKey.keyId
        )
      };
      return this.response(200, {
        pairId: this.start.pairId,
        status: "complete_submitted"
      });
    }
    if (
      this.start &&
      input.path === `/api/e2ee/v1/passkey/${this.start.pairId}` &&
      method === "GET"
    ) {
      return this.response(200, {
        pairId: this.start.pairId,
        status: this.ack ? "paired" : "offer_ready",
        options: this.options,
        ack: this.ack,
        expiresAt: this.options?.expiresAt
      });
    }
    if (input.path === "/api/e2ee/v1/runners") {
      return this.response(200, { runners: [] });
    }
    if (input.path === "/api/e2ee/v1/conversations") {
      return this.response(200, { conversations: [] });
    }
    return this.response(404, { error: "not_found" });
  }
}

async function installDesktopMock(page: Page, backend: DesktopBackend) {
  await page.exposeFunction(
    "__desktopE2eInvoke",
    (command: string, args: Record<string, unknown> | undefined) =>
      backend.invoke(command, args)
  );
  await page.addInitScript(() => {
    const invoke = (
      command: string,
      args?: Record<string, unknown>
    ): Promise<unknown> => {
      const bridge = (
        window as Window & {
          __desktopE2eInvoke?: (
            command: string,
            args?: Record<string, unknown>
          ) => Promise<unknown>;
        }
      ).__desktopE2eInvoke;
      if (!bridge) return Promise.reject(new Error("desktop_e2e_bridge_missing"));
      return bridge(command, args);
    };
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { core: { invoke } }
    });
  });
}

async function mockPublicUpdate(page: Page, metadata: UpdateMetadata, failures = 0) {
  let requests = 0;
  await page.route(`${UPDATE_URL}*`, async (route) => {
    requests += 1;
    if (requests <= failures) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary" })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(metadata)
    });
  });
  return () => requests;
}

test("desktop flow stays top-down, explains failure, retries, and reaches chat", async ({
  page
}) => {
  const backend = await DesktopBackend.create();
  backend.passkeyFailuresLeft = 1;
  backend.accessTransientFailuresLeft = 2;
  await installDesktopMock(page, backend);
  await mockPublicUpdate(page, backend.updateMetadata);
  await page.goto("/");

  await expect(page.locator('[data-flow-step="access"]')).toBeVisible();
  await expect(page.locator("[data-flow-step]")).toHaveCount(1);
  await expect(page.getByTestId("desktop-upgrade")).toBeVisible();
  await expect(page.getByRole("list", { name: "设置进度" }).locator("li")).toHaveText([
    "1登录",
    "2验证设备",
    "3完成",
    "4加密聊天"
  ]);

  await page.getByRole("button", { name: "登录以继续" }).click();
  await expect(page.locator('[data-flow-step="pairing"]')).toBeVisible();
  await expect(page.locator("[data-flow-step]")).toHaveCount(1);
  await expect(page.locator('[data-flow-step="pairing"]')).toContainText("选择一种方式");

  await page.getByRole("button", { name: "使用 Passkey", exact: true }).click();
  await page.getByRole("button", { name: "使用 Passkey 继续" }).click();
  await expect(page.locator('[data-flow-step="verification"]')).toBeVisible();
  await expect(page.locator('[data-flow-step="pairing"]')).toHaveCount(0);

  await expect(page.getByRole("alert")).toContainText("此处不能使用 Passkey");
  await expect(page.locator('[data-flow-step="pairing"]')).toBeVisible();
  await page.getByText("查看诊断信息").click();
  await expect(page.getByRole("alert")).toContainText("完成 Passkey 验证");
  await expect(page.getByRole("alert")).toContainText(SECURE_ORIGIN);
  await expect(page.getByRole("alert")).not.toContainText("Failed to fetch");
  await expect(page.getByRole("alert")).not.toContainText("unknown_error");

  await page.getByRole("button", { name: "使用 Passkey 继续" }).click();
  await expect(page.locator('[data-flow-step="complete"]')).toBeVisible();
  await expect(page.locator("[data-flow-step]")).toHaveCount(1);
  await page.getByRole("button", { name: "开始对话" }).click();
  await expect(page.locator('[data-flow-step="chat"]')).toBeVisible();
  await expect(page.locator('[data-flow-step="chat"]')).toContainText(
    "授权设备离线"
  );
  await expect(page.locator("[data-flow-step]")).toHaveCount(1);

  expect(backend.passkeyOrigins).toEqual([SECURE_ORIGIN, SECURE_ORIGIN]);
  expect(
    backend.diagnosticEntries.some(
      (entry) => entry.errorCode === "network_unreachable"
    )
  ).toBe(true);
  expect(backend.calls).toEqual(
    expect.arrayContaining([
      "POST /api/e2ee/v1/passkey/start",
      expect.stringMatching(/^GET \/api\/e2ee\/v1\/passkey\//),
      expect.stringMatching(/^POST \/api\/e2ee\/v1\/passkey\/.*\/complete$/),
      "GET /api/e2ee/v1/runners",
      "GET /api/e2ee/v1/conversations"
    ])
  );
});

test("permanent Access error stops without blind retry", async ({ page }) => {
  const backend = await DesktopBackend.create();
  backend.permanentAccessError = true;
  await installDesktopMock(page, backend);
  await mockPublicUpdate(page, backend.updateMetadata);
  await page.goto("/");
  const callsBeforeLogin = backend.calls.filter(
    (call) => call === "GET /api/e2ee-policy"
  ).length;
  await page.getByRole("button", { name: "登录以继续" }).click();
  await expect(page.locator('[data-flow-step="access"]')).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("请求未被接受");
  const policyCalls = backend.calls.filter(
    (call) => call === "GET /api/e2ee-policy"
  );
  // StrictMode may run startup probes twice; the explicit login itself must
  // stop after exactly one permanent HTTP 403.
  expect(policyCalls.length - callsBeforeLogin).toBe(1);
});

for (const item of [
  { name: "same version", version: "0.1.6", installerAvailable: true },
  { name: "older version", version: "0.1.5", installerAvailable: true },
  { name: "installer missing", version: "0.1.7", installerAvailable: false }
]) {
  test(`upgrade stays hidden for ${item.name}`, async ({ page }) => {
    const backend = await DesktopBackend.create();
    const metadata = {
      ...backend.updateMetadata,
      version: item.version,
      installerAvailable: item.installerAvailable
    };
    await installDesktopMock(page, backend);
    await mockPublicUpdate(page, metadata);
    await page.goto("/");
    await expect(page.locator('[data-flow-step="access"]')).toBeVisible();
    await expect(page.getByTestId("desktop-upgrade")).toHaveCount(0);
    if (!item.installerAvailable) {
      await expect(page.getByText("更新状态")).toBeVisible();
    }
  });
}

test("temporary public metadata failure recovers after Access login", async ({ page }) => {
  const backend = await DesktopBackend.create();
  await installDesktopMock(page, backend);
  await page.route(`${UPDATE_URL}*`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary" })
    })
  );
  await page.goto("/");
  await expect(page.getByTestId("desktop-upgrade")).toHaveCount(0);
  await page.getByRole("button", { name: "登录以继续" }).click();
  await expect(page.locator('[data-flow-step="pairing"]')).toBeVisible();
  await expect(page.getByTestId("desktop-upgrade")).toBeVisible();
  expect(backend.calls).toContain("GET /api/desktop/version");
});

test("trusted bridge completes registration and authentication with a virtual authenticator", async ({
  page
}) => {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });

  try {
    await page.goto("/passkey-bridge.html");
    await expect(page.getByRole("heading", { name: "完成设备验证" })).toBeVisible();
    const challenge = Buffer.alloc(32, 7).toString("base64url");
    const userId = Buffer.alloc(32, 9).toString("base64url");
    const registration = await page.evaluate(
      async ({ challenge, userId }) => {
        const bridge = (
          window as Window & {
            __CG_PASSKEY_BRIDGE__?: {
              perform(input: unknown): Promise<Record<string, unknown>>;
            };
          }
        ).__CG_PASSKEY_BRIDGE__;
        if (!bridge) throw new Error("bridge_missing");
        return bridge.perform({
          mode: "registration",
          options: {
            challenge,
            rp: { id: "localhost", name: "Secure Gateway Test" },
            user: { id: userId, name: "e2e@example.test", displayName: "E2E" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            timeout: 60_000,
            attestation: "none",
            authenticatorSelection: {
              residentKey: "preferred",
              userVerification: "required"
            }
          }
        });
      },
      { challenge, userId }
    );
    expect(registration.type).toBe("public-key");
    expect(typeof registration.id).toBe("string");

    const authentication = await page.evaluate(
      async ({ challenge, credentialId }) => {
        const bridge = (
          window as Window & {
            __CG_PASSKEY_BRIDGE__?: {
              perform(input: unknown): Promise<Record<string, unknown>>;
            };
          }
        ).__CG_PASSKEY_BRIDGE__;
        if (!bridge) throw new Error("bridge_missing");
        return bridge.perform({
          mode: "authentication",
          options: {
            challenge,
            rpId: "localhost",
            allowCredentials: [
              { id: credentialId, type: "public-key", transports: ["internal"] }
            ],
            timeout: 60_000,
            userVerification: "required"
          }
        });
      },
      {
        challenge: Buffer.alloc(32, 11).toString("base64url"),
        credentialId: String(registration.id)
      }
    );
    expect(authentication.type).toBe("public-key");
    expect(authentication.id).toBe(registration.id);
  } finally {
    await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await client.send("WebAuthn.disable");
  }
});

test("built Secure Web serves an exact JSON update manifest instead of SPA HTML", async ({
  request
}) => {
  const response = await request.get("/desktop-version.json", {
    headers: { origin: "http://tauri.localhost" }
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    version: "0.1.9",
    installerUrl: "https://cs.joelzt.org/api/desktop/download"
  });
  expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
});
