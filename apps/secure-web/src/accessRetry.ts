import { GatewayApiError } from "./api.js";

export type AccessRetryEvent = {
  attempt: number;
  consecutiveSuccesses: number;
  transientFailures: number;
  code: string | null;
  delayMs: number;
};

export type AccessRetryOptions<T> = {
  probe: () => Promise<T>;
  signal?: AbortSignal;
  totalTimeoutMs?: number;
  maxAttempts?: number;
  maxTransientFailures?: number;
  requiredConsecutiveSuccesses?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onAttempt?: (event: AccessRetryEvent) => void;
};

const TRANSIENT_CODES = new Set([
  "network_unreachable",
  "request_timeout",
  "access_bridge_fetch_timeout",
  "access_bridge_fetch_channel_closed",
  "access_bridge_not_ready",
  "access_bridge_ready_channel_closed"
]);

export function accessErrorCode(error: unknown): string {
  if (error instanceof GatewayApiError) return error.code;
  if (error instanceof Error && error.message.trim()) return error.message.trim().split(":")[0]!;
  if (typeof error === "string" && error.trim()) return error.trim().split(":")[0]!;
  return "access_unknown_error";
}

export function isRetryableAccessError(error: unknown): boolean {
  const code = accessErrorCode(error);
  return code === "cloudflare_login_required" || TRANSIENT_CODES.has(code);
}

export function accessRetryDelay(input: {
  transientFailures: number;
  waitingForLogin: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}): number {
  const random = input.random ?? Math.random;
  const base = input.waitingForLogin
    ? 2_000
    : Math.min(
        input.maxDelayMs ?? 8_000,
        (input.baseDelayMs ?? 500) * 2 ** Math.max(0, input.transientFailures - 1)
      );
  const jitter = input.waitingForLogin ? 0.1 : 0.2;
  return Math.max(100, Math.round(base * (1 - jitter + random() * jitter * 2)));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("access_login_cancelled"));
      return;
    }
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        reject(new Error("access_login_cancelled"));
      },
      { once: true }
    );
  });
}

export async function waitForStableAccess<T>(
  options: AccessRetryOptions<T>
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = now() + (options.totalTimeoutMs ?? 300_000);
  const maxAttempts = options.maxAttempts ?? 120;
  const maxTransientFailures = options.maxTransientFailures ?? 8;
  const requiredSuccesses = options.requiredConsecutiveSuccesses ?? 2;
  let attempts = 0;
  let transientFailures = 0;
  let consecutiveSuccesses = 0;
  let lastValue: T | undefined;

  while (attempts < maxAttempts && now() < deadline) {
    if (options.signal?.aborted) throw new Error("access_login_cancelled");
    attempts += 1;
    try {
      lastValue = await options.probe();
      consecutiveSuccesses += 1;
      transientFailures = 0;
      options.onAttempt?.({
        attempt: attempts,
        consecutiveSuccesses,
        transientFailures,
        code: null,
        delayMs: consecutiveSuccesses >= requiredSuccesses ? 0 : 350
      });
      if (consecutiveSuccesses >= requiredSuccesses) return lastValue;
      await sleep(350, options.signal);
    } catch (error) {
      if (accessErrorCode(error) === "access_login_cancelled") throw error;
      const code = accessErrorCode(error);
      if (!isRetryableAccessError(error)) throw error;
      consecutiveSuccesses = 0;
      const waitingForLogin = code === "cloudflare_login_required";
      if (!waitingForLogin) {
        transientFailures += 1;
        if (transientFailures > maxTransientFailures) {
          throw new Error("access_network_retry_exhausted");
        }
      }
      const delayMs = accessRetryDelay({
        transientFailures,
        waitingForLogin,
        ...(options.baseDelayMs !== undefined
          ? { baseDelayMs: options.baseDelayMs }
          : {}),
        ...(options.maxDelayMs !== undefined
          ? { maxDelayMs: options.maxDelayMs }
          : {}),
        ...(options.random ? { random: options.random } : {})
      });
      options.onAttempt?.({
        attempt: attempts,
        consecutiveSuccesses,
        transientFailures,
        code,
        delayMs
      });
      if (now() + delayMs >= deadline) break;
      await sleep(delayMs, options.signal);
    }
  }

  if (options.signal?.aborted) throw new Error("access_login_cancelled");
  if (lastValue !== undefined && consecutiveSuccesses > 0) {
    throw new Error("access_stability_not_confirmed");
  }
  throw new Error("access_bridge_login_timeout");
}
