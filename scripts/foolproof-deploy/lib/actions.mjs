import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { fingerprint } from "./secrets.mjs";

const execFileAsync = promisify(execFile);

/**
 * @param {string} cwd
 * @param {string} file
 * @param {string[]} args
 * @param {{ dryRun?: boolean, timeoutMs?: number }} [opts]
 */
async function run(cwd, file, args, opts = {}) {
  if (opts.dryRun) {
    return {
      dryRun: true,
      command: [file, ...args].join(" "),
      stdout: "",
      stderr: "",
      code: 0
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      timeout: opts.timeoutMs ?? 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    return { dryRun: false, command: [file, ...args].join(" "), stdout, stderr, code: 0 };
  } catch (error) {
    const err = /** @type {Error & { stdout?: string, stderr?: string, code?: number }} */ (error);
    return {
      dryRun: false,
      command: [file, ...args].join(" "),
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
      code: typeof err.code === "number" ? err.code : 1
    };
  }
}

/**
 * @param {string} repoRoot
 */
export async function getGitStatus(repoRoot) {
  const head = await run(repoRoot, "git", ["rev-parse", "HEAD"]);
  const branch = await run(repoRoot, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = await run(repoRoot, "git", ["rev-parse", "--verify", "origin/main"]);
  const dirty = await run(repoRoot, "git", ["status", "--porcelain"]);
  return {
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    originMain: remote.code === 0 ? remote.stdout.trim() : null,
    dirty: dirty.code === 0 ? Boolean(dirty.stdout.trim()) : null,
    behindMain:
      head.code === 0 && remote.code === 0
        ? head.stdout.trim() !== remote.stdout.trim()
        : null
  };
}

/**
 * Fast-forward pull origin/main (or current tracking branch).
 * @param {string} repoRoot
 * @param {{ dryRun?: boolean, ref?: string }} opts
 */
export async function syncGit(repoRoot, opts = {}) {
  const ref = opts.ref || "origin/main";
  const steps = [];
  steps.push(await run(repoRoot, "git", ["fetch", "origin"], { dryRun: opts.dryRun }));
  if (steps[0].code !== 0 && !opts.dryRun) return { ok: false, steps };

  // Prefer ff-only merge onto current branch from origin/main when on main.
  const branch = await run(repoRoot, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const onMain = branch.stdout.trim() === "main";
  if (onMain) {
    steps.push(
      await run(repoRoot, "git", ["merge", "--ff-only", ref], { dryRun: opts.dryRun })
    );
  } else {
    steps.push(
      await run(repoRoot, "git", ["merge", "--ff-only", "@{u}"], { dryRun: opts.dryRun })
    );
  }
  const last = steps[steps.length - 1];
  return { ok: opts.dryRun ? true : last.code === 0, steps };
}

/**
 * @param {string} repoRoot
 * @param {{ dryRun?: boolean, build?: boolean }} opts
 */
export async function composeUp(repoRoot, opts = {}) {
  const infra = join(repoRoot, "infra");
  if (!existsSync(join(infra, "docker-compose.yml"))) {
    return {
      ok: false,
      steps: [
        {
          dryRun: Boolean(opts.dryRun),
          command: "(missing infra/docker-compose.yml)",
          stdout: "",
          stderr: "infra/docker-compose.yml not found",
          code: 1
        }
      ]
    };
  }
  const args = ["compose", "-f", "docker-compose.yml", "up", "-d"];
  if (opts.build !== false) args.push("--build");
  const step = await run(infra, "docker", args, {
    dryRun: opts.dryRun,
    timeoutMs: 20 * 60 * 1000
  });
  return { ok: opts.dryRun ? true : step.code === 0, steps: [step] };
}

/**
 * @param {string} repoRoot
 */
export async function composePs(repoRoot) {
  const infra = join(repoRoot, "infra");
  if (!existsSync(join(infra, "docker-compose.yml"))) {
    return { ok: false, stdout: "", stderr: "missing compose file" };
  }
  const step = await run(infra, "docker", ["compose", "-f", "docker-compose.yml", "ps", "--format", "json"]);
  return { ok: step.code === 0, stdout: step.stdout, stderr: step.stderr };
}

/**
 * Place E2EE master key in tmpfs when available; return path + fingerprint.
 * Never returns the key itself to HTTP callers — only writes to disk.
 *
 * @param {string} masterKeyBase64
 * @param {{ insecureDevInject?: boolean, homeDir?: string }} opts
 */
export function placeE2eeMasterKey(masterKeyBase64, opts = {}) {
  const shmDir = "/dev/shm/cursor-gateway";
  const home = opts.homeDir || join(process.env.HOME || "/tmp", ".cursor-gateway");
  /** @type {string} */
  let targetDir;
  /** @type {string} */
  let note;

  if (existsSync("/dev/shm")) {
    targetDir = shmDir;
    note =
      "主密钥已写入 tmpfs。重启后需用 scripts/e2ee/unseal-master-key.sh（或 e2ee-up.sh）口令解封；网页无法代你记住口令。";
  } else if (opts.insecureDevInject) {
    targetDir = join(home, "dev-insecure");
    note =
      "开发态：主密钥写在持久盘（RUNNER_E2EE_ALLOW_INSECURE_DEV_STORAGE 风险）。勿用于生产。";
  } else {
    return {
      ok: false,
      path: null,
      fingerprint: fingerprint(masterKeyBase64),
      note: "本机无 /dev/shm。请在 Runner 机上手动配置 RUNNER_E2EE_MASTER_KEY_FILE，或勾选「开发态自动注入」（有风险）。"
    };
  }

  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const path = join(targetDir, "runner-e2ee-master.key");
  writeFileSync(path, `${masterKeyBase64}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    ok: true,
    path,
    fingerprint: fingerprint(masterKeyBase64),
    note
  };
}

/**
 * Sanitize step output so secrets never leak into API responses.
 * @param {{ stdout?: string, stderr?: string, command?: string, code?: number, dryRun?: boolean }} step
 */
export function sanitizeStep(step) {
  const scrub = (text) =>
    (text || "")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/(PASSWORD|SECRET|TOKEN|KEY)=([^\s]+)/gi, "$1=[REDACTED]")
      .slice(0, 4000);
  return {
    dryRun: Boolean(step.dryRun),
    command: step.command,
    code: step.code,
    stdout: scrub(step.stdout),
    stderr: scrub(step.stderr)
  };
}
