#!/usr/bin/env node
/**
 * Foolproof deploy wizard — host-side (not inside the app container).
 *
 *   ./scripts/foolproof-deploy/start.sh
 *   # open http://127.0.0.1:19090/  (or reverse-proxy /deploy → this port)
 *
 * Generates secrets, writes .env (0600), optional git sync + compose restart.
 * Never echoes full private keys in HTML/JSON (fingerprints + one-time pack only).
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  authenticate,
  ensureBootstrapToken,
  newCsrfToken,
  parseCookies,
  requireCsrf,
  signSession
} from "./lib/auth.mjs";
import {
  buildGatewayEnv,
  buildRunnerEnvSnippet,
  readEnvFile,
  serializeEnv,
  writeSecretFile
} from "./lib/envfile.mjs";
import { generateDeploySecrets, fingerprint } from "./lib/secrets.mjs";
import {
  composePs,
  composeUp,
  getGitStatus,
  placeE2eeMasterKey,
  sanitizeStep,
  syncGit
} from "./lib/actions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const PUBLIC_DIR = join(__dirname, "public");

const HOST = process.env.DEPLOY_WIZARD_HOST || "127.0.0.1";
const PORT = Number(process.env.DEPLOY_WIZARD_PORT || 19090);
const STATE_DIR =
  process.env.CURSOR_GATEWAY_HOME || join(process.env.HOME || "/tmp", ".cursor-gateway");
const TOKEN_PATH = join(STATE_DIR, "deploy-bootstrap.token");
const ENV_PATH = join(REPO_ROOT, ".env");
const ENV_EXAMPLE = join(REPO_ROOT, ".env.example");

const bootstrap = ensureBootstrapToken(TOKEN_PATH);
const sessionSecret = bootstrap.token;
const trustCloudflareAccess = process.env.DEPLOY_TRUST_CF_ACCESS !== "0";

/** @type {Map<string, { expires: number, filename: string, body: string }>} */
const oneTimePacks = new Map();

function allowedEmailsFromEnv() {
  const existing = readEnvFile(ENV_PATH);
  const raw =
    process.env.ALLOWED_EMAILS ||
    existing?.ALLOWED_EMAILS ||
    process.env.DEPLOY_ALLOWED_EMAILS ||
    "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  res.end(payload);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} name
 * @param {string} value
 * @param {number} maxAgeSec
 * @param {{ httpOnly?: boolean }} [opts]
 */
function setCookie(res, name, value, maxAgeSec, opts = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`
  ];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (process.env.DEPLOY_COOKIE_SECURE === "1") parts.push("Secure");
  const prev = res.getHeader("Set-Cookie");
  const next = parts.join("; ");
  if (!prev) res.setHeader("Set-Cookie", next);
  else if (Array.isArray(prev)) res.setHeader("Set-Cookie", [...prev, next]);
  else res.setHeader("Set-Cookie", [String(prev), next]);
}

function requireAuth(req, res) {
  const auth = authenticate({
    req,
    bootstrapToken: bootstrap.token,
    sessionSecret,
    allowedEmails: allowedEmailsFromEnv(),
    trustCloudflareAccess
  });
  if (!auth.ok) {
    sendJson(res, 401, { error: auth.error || "unauthorized" });
    return null;
  }
  return auth;
}

function requireAuthAndCsrf(req, res, auth) {
  if (!requireCsrf(req, auth.csrf)) {
    sendJson(res, 403, { error: "csrf_failed" });
    return false;
  }
  return true;
}

/**
 * Ensure browser has session + CSRF cookies after CF Access or bearer auth.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ method: string, email: string | null, csrf: string | null }} auth
 */
function ensureBrowserSession(req, res, auth) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.deploy_session && cookies.deploy_csrf) {
    return cookies.deploy_csrf;
  }
  const csrf = newCsrfToken();
  const method = auth.method === "cloudflare" ? "cloudflare" : "bootstrap";
  const session = signSession(sessionSecret, {
    auth: method,
    email: auth.email
  });
  setCookie(res, "deploy_session", session, 8 * 3600, { httpOnly: true });
  setCookie(res, "deploy_csrf", csrf, 8 * 3600, { httpOnly: false });
  auth.csrf = csrf;
  return csrf;
}

async function handleStatus(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  ensureBrowserSession(req, res, auth);

  const existing = readEnvFile(ENV_PATH);
  const git = await getGitStatus(REPO_ROOT);
  let compose = { ok: false, summary: "not_checked" };
  try {
    const ps = await composePs(REPO_ROOT);
    compose = {
      ok: ps.ok,
      summary: ps.ok ? "compose_reachable" : "compose_unavailable",
      detail: (ps.stderr || ps.stdout || "").slice(0, 500)
    };
  } catch {
    compose = { ok: false, summary: "compose_error" };
  }

  sendJson(res, 200, {
    ok: true,
    auth: { method: auth.method, email: auth.email },
    bootstrapTokenFingerprint: bootstrap.fingerprint,
    env: {
      exists: Boolean(existing),
      publicOrigin: existing?.PUBLIC_ORIGIN || null,
      fingerprints: existing
        ? {
            jwtSecret: fingerprint(existing.JWT_SECRET),
            runnerSharedSecret: fingerprint(existing.RUNNER_SHARED_SECRET),
            postgresPassword: fingerprint(existing.POSTGRES_PASSWORD)
          }
        : null
    },
    git,
    compose,
    limits: {
      masterKeyUnseal:
        "Linux/WSL 主密钥口令解封无法全自动：重启后仍需在 Runner 机运行 scripts/e2ee/unseal-master-key.sh 或 e2ee-up.sh。",
      cursorApiKey: "CURSOR_API_KEY 必须由你本人粘贴到 Runner 配置，系统不会代填。",
      cloudflareDns: "DNS / Cloudflare Access 策略需在 Cloudflare 控制台完成。",
      reality: "Reality 伪装可选，默认不强制写入；启用时只生成 UUID/shortId 指纹。"
    }
  });
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "invalid_body" });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token !== bootstrap.token) {
    // Constant-ish delay to slow brute force a bit
    await new Promise((r) => setTimeout(r, 400));
    return sendJson(res, 401, { error: "invalid_bootstrap_token" });
  }
  const csrf = newCsrfToken();
  const session = signSession(sessionSecret, { auth: "bootstrap" });
  setCookie(res, "deploy_session", session, 8 * 3600, { httpOnly: true });
  // CSRF cookie must be readable by JS (double-submit).
  setCookie(res, "deploy_csrf", csrf, 8 * 3600, { httpOnly: false });
  sendJson(res, 200, { ok: true, csrf });
}

async function handleLogout(req, res) {
  setCookie(res, "deploy_session", "", 0);
  setCookie(res, "deploy_csrf", "", 0);
  sendJson(res, 200, { ok: true });
}

async function handleInitialize(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!requireAuthAndCsrf(req, res, auth)) return;

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "invalid_body" });
  }

  const dryRun = Boolean(body.dryRun);
  const force = Boolean(body.force);
  const includeReality = Boolean(body.includeReality);
  const insecureDevInject = Boolean(body.insecureDevInject);
  const publicOrigin =
    (typeof body.publicOrigin === "string" && body.publicOrigin.trim()) ||
    readEnvFile(ENV_PATH)?.PUBLIC_ORIGIN ||
    "https://gateway.example.com";
  const allowedEmails =
    typeof body.allowedEmails === "string"
      ? body.allowedEmails.trim()
      : readEnvFile(ENV_PATH)?.ALLOWED_EMAILS || "";
  const workspaces =
    typeof body.workspaces === "string" && body.workspaces.trim()
      ? body.workspaces.trim()
      : "/home/you/projects";

  if (existsSync(ENV_PATH) && !force && !dryRun) {
    const existing = readEnvFile(ENV_PATH);
    if (existing?.JWT_SECRET && existing.JWT_SECRET.length >= 32) {
      return sendJson(res, 409, {
        error: "env_exists",
        message: "已存在 .env。勾选「强制重新生成」才会覆盖密钥（危险，会断开现有 Runner）。",
        fingerprints: {
          jwtSecret: fingerprint(existing.JWT_SECRET),
          runnerSharedSecret: fingerprint(existing.RUNNER_SHARED_SECRET)
        }
      });
    }
  }

  const secrets = generateDeploySecrets({ includeReality });
  const built = buildGatewayEnv({
    examplePath: ENV_EXAMPLE,
    existingPath: ENV_PATH,
    secrets,
    publicOrigin,
    allowedEmails,
    e2eeRequiredForWeb: false,
    force,
    preserveExistingSecrets: !force
  });

  const master = dryRun
    ? {
        ok: false,
        path: null,
        fingerprint: built.fingerprints.e2eeMasterKey,
        note: "dry-run：未写入主密钥文件。"
      }
    : placeE2eeMasterKey(secrets.e2eeMasterKey, {
        insecureDevInject,
        homeDir: STATE_DIR
      });

  const runnerSnippet = buildRunnerEnvSnippet({
    gatewayUrl: publicOrigin,
    runnerSharedSecret: built.packMaterial.runnerSharedSecret,
    workspaces,
    e2eeMasterKeyFile: master.path || undefined,
    allowInsecureDevStorage: insecureDevInject && !existsSync("/dev/shm")
  });

  /** @type {Record<string, string>} */
  const packExtra = {};
  if (secrets.reality) {
    packExtra.REALITY_UUID = secrets.reality.uuid;
    packExtra.REALITY_SHORT_ID = secrets.reality.shortId;
  }
  packExtra.E2EE_MASTER_KEY_FINGERPRINT = built.fingerprints.e2eeMasterKey || "";
  if (master.path) packExtra.RUNNER_E2EE_MASTER_KEY_FILE = master.path;

  const packBody = [
    "# cursor-gateway one-time client pack — download once, store offline, delete from browser downloads",
    `# generated_at=${new Date().toISOString()}`,
    `# fingerprints: jwt=${built.fingerprints.jwtSecret} runner=${built.fingerprints.runnerSharedSecret}`,
    "",
    "# --- gateway .env was written on the server (not embedded here in full) ---",
    `# PUBLIC_ORIGIN=${publicOrigin}`,
    "",
    "# --- runner apps/windows-runner/.env ---",
    runnerSnippet,
    Object.keys(packExtra).length
      ? serializeEnv(packExtra, "Optional / Reality / E2EE path hints")
      : ""
  ].join("\n");

  let downloadToken = null;
  if (!dryRun) {
    writeSecretFile(ENV_PATH, serializeEnv(built.values, "Written by scripts/foolproof-deploy — do not commit"));
    downloadToken = randomBytes(24).toString("base64url");
    oneTimePacks.set(downloadToken, {
      expires: Date.now() + 10 * 60 * 1000,
      filename: "cursor-gateway-runner-pack.env",
      body: packBody
    });
  }

  sendJson(res, 200, {
    ok: true,
    dryRun,
    wroteEnv: !dryRun,
    fingerprints: built.fingerprints,
    masterKey: {
      placed: master.ok,
      path: master.path,
      fingerprint: master.fingerprint,
      note: master.note
    },
    download: downloadToken
      ? {
          token: downloadToken,
          once: true,
          expiresInSec: 600,
          path: `/api/deploy/download/${downloadToken}`
        }
      : null,
    nextSteps: [
      "下载一次性 Runner 配置包（私钥不会在页面明文展示）。",
      "在 Runner 机填入 CURSOR_API_KEY 与真实 RUNNER_WORKSPACES。",
      dryRun ? "（dry-run）未写入磁盘；取消 dry-run 再点初始化。" : "可点「同步并重启」拉齐代码并 docker compose up。",
      "E2EE：用 scripts/e2ee/seal-master-key.sh 封存主密钥；重启后需口令解封。"
    ]
  });
}

async function handleSync(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!requireAuthAndCsrf(req, res, auth)) return;

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "invalid_body" });
  }
  const dryRun = body.dryRun !== false; // default safe: dry-run unless apply=true
  const apply = Boolean(body.apply);
  const doGit = body.git !== false;
  const doCompose = body.compose !== false;
  const effectiveDryRun = apply ? false : dryRun;

  /** @type {unknown[]} */
  const steps = [];
  let ok = true;

  if (doGit) {
    const gitResult = await syncGit(REPO_ROOT, { dryRun: effectiveDryRun });
    steps.push(...gitResult.steps.map(sanitizeStep));
    ok = ok && gitResult.ok;
  }
  if (doCompose && ok) {
    const composeResult = await composeUp(REPO_ROOT, { dryRun: effectiveDryRun, build: true });
    steps.push(...composeResult.steps.map(sanitizeStep));
    ok = ok && composeResult.ok;
  }

  const git = await getGitStatus(REPO_ROOT);
  sendJson(res, 200, {
    ok,
    dryRun: effectiveDryRun,
    applied: apply && !effectiveDryRun,
    steps,
    git,
    rollbackHint:
      "回滚：在仓库目录 git checkout <previous-sha> && cd infra && docker compose up -d --build。保留 .env.bak.* 若你手动备份过。"
  });
}

function handleDownload(req, res, token) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const pack = oneTimePacks.get(token);
  if (!pack || pack.expires < Date.now()) {
    oneTimePacks.delete(token);
    return sendJson(res, 404, { error: "pack_expired_or_missing" });
  }
  oneTimePacks.delete(token);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${pack.filename}"`,
    "cache-control": "no-store"
  });
  res.end(pack.body);
}

function serveStatic(res, relPath) {
  const safe = relPath.replace(/\\/g, "/").replace(/\.\./g, "");
  const filePath = join(PUBLIC_DIR, safe === "/" || safe === "" ? "index.html" : safe);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    return sendText(res, 404, "not found");
  }
  const ext = filePath.split(".").pop();
  const types = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    svg: "image/svg+xml"
  };
  sendText(res, 200, readFileSync(filePath), types[ext] || "application/octet-stream");
}

function purgeExpiredPacks() {
  const now = Date.now();
  for (const [k, v] of oneTimePacks) {
    if (v.expires < now) oneTimePacks.delete(k);
  }
}

const server = createServer(async (req, res) => {
  try {
    purgeExpiredPacks();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let path = url.pathname;
    // Allow mounting under /deploy via reverse proxy that strips or keeps prefix
    if (path.startsWith("/deploy")) {
      path = path.slice("/deploy".length) || "/";
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return serveStatic(res, "index.html");
    }
    if (req.method === "GET" && (path === "/app.js" || path === "/style.css")) {
      return serveStatic(res, path.slice(1));
    }
    if (req.method === "GET" && path === "/api/deploy/status") {
      return await handleStatus(req, res);
    }
    if (req.method === "POST" && path === "/api/deploy/login") {
      return await handleLogin(req, res);
    }
    if (req.method === "POST" && path === "/api/deploy/logout") {
      return await handleLogout(req, res);
    }
    if (req.method === "POST" && path === "/api/deploy/initialize") {
      return await handleInitialize(req, res);
    }
    if (req.method === "POST" && path === "/api/deploy/sync") {
      return await handleSync(req, res);
    }
    if (req.method === "GET" && path.startsWith("/api/deploy/download/")) {
      return handleDownload(req, res, path.slice("/api/deploy/download/".length));
    }
    if (req.method === "GET" && path === "/api/deploy/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    console.error("[foolproof-deploy]", error instanceof Error ? error.message : error);
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("Cursor Gateway — foolproof deploy wizard");
  console.log(`  listening: http://${HOST}:${PORT}/`);
  console.log(`  (proxy):   https://<your-direct-host>/deploy/  →  ${HOST}:${PORT}`);
  console.log(`  bootstrap token fingerprint: ${bootstrap.fingerprint}`);
  if (bootstrap.created) {
    console.log("  NEW bootstrap token written (0600):");
    console.log(`    ${TOKEN_PATH}`);
    console.log("  Paste the token from that file into the web UI once.");
  } else {
    console.log(`  bootstrap token file: ${TOKEN_PATH}`);
  }
  console.log("  Tip: cat the token file on the host, then open the page and paste it.");
  console.log("  Secrets are never printed here in full.");
  console.log("");
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
