import type { ModelInfo, Workspace } from "@cursor-gateway/shared";
import { upsertWorkspace } from "./db.js";

export type RunnerHeartbeat = {
  runnerId: string;
  models: ModelInfo[];
  workspaces: Workspace[];
  lastSeenAt: string;
};

const runners = new Map<string, RunnerHeartbeat>();
const RUNNER_ONLINE_WINDOW_MS = 3 * 60_000;

export async function registerRunner(input: {
  runnerId: string;
  models: ModelInfo[];
  workspaces: Workspace[];
}) {
  for (const workspace of input.workspaces) {
    await upsertWorkspace(workspace);
  }

  const heartbeat = {
    runnerId: input.runnerId,
    models: input.models,
    workspaces: input.workspaces,
    lastSeenAt: new Date().toISOString()
  };
  runners.set(input.runnerId, heartbeat);
  return heartbeat;
}

export function listRunnerHeartbeats(now = Date.now()) {
  for (const [runnerId, runner] of runners) {
    if (now - Date.parse(runner.lastSeenAt) >= RUNNER_ONLINE_WINDOW_MS) {
      runners.delete(runnerId);
    }
  }
  return [...runners.values()].sort((a, b) => a.runnerId.localeCompare(b.runnerId));
}

export function listModels(): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const runner of runners.values()) {
    for (const model of runner.models) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function modelIsKnown(model: string) {
  if (model === "auto") return true;
  return listModels().some((item) => item.id === model);
}

export function modelIsHermes(model: string) {
  return model.startsWith("hermes:");
}
