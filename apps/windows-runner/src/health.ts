import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const healthDir = join(dirname(fileURLToPath(import.meta.url)), "../logs");
export const healthFilePath = join(healthDir, "runner-health.json");

export type RunnerHealthSnapshot = {
  runnerId: string;
  pid: number;
  gatewayUrl: string;
  lastHeartbeatAt: string;
  lastHeartbeatOk: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  updatedAt: string;
};

export function writeHealthSnapshot(partial: {
  lastHeartbeatOk: boolean;
  consecutiveFailures: number;
  lastError?: string | null;
  lastHeartbeatAt?: string;
}) {
  mkdirSync(healthDir, { recursive: true });

  const snapshot: RunnerHealthSnapshot = {
    runnerId: config.runnerId,
    pid: process.pid,
    gatewayUrl: config.gatewayUrl,
    lastHeartbeatAt: partial.lastHeartbeatAt ?? new Date().toISOString(),
    lastHeartbeatOk: partial.lastHeartbeatOk,
    consecutiveFailures: partial.consecutiveFailures,
    lastError: partial.lastError ?? null,
    updatedAt: new Date().toISOString()
  };

  writeFileSync(healthFilePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}
