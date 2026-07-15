import type { ModelInfo } from "@cursor-gateway/shared";

/**
 * Build the model dropdown for an E2EE-paired session from the paired runner's
 * advertised catalog. Legacy `/api/models` only unions in-memory legacy/Hermes
 * heartbeats and is empty (or Hermes-only) when runners are E2EE-only.
 *
 * Always expose gateway `auto`. Drop SDK alias `default` (also labeled Auto)
 * and any `hermes:` model the paired *cursor* runner might advertise (its runs
 * go over the E2EE submit path, which rejects Hermes).
 *
 * Hermes is a plaintext, Q&A-only sidecar that cannot participate in E2EE. It
 * lives on the legacy in-memory heartbeat registry, not on the paired runner.
 * Pass its models via `hermesModels` so E2EE web users can still pick Hermes;
 * those runs are routed over the plaintext `/api/runs` path by the caller.
 */
export function buildPairedModelCatalog(
  runnerModels: ModelInfo[],
  hermesModels: ModelInfo[] = []
): ModelInfo[] {
  const rest = runnerModels.filter(
    (model) =>
      model.id !== "auto" &&
      model.id !== "default" &&
      !model.id.startsWith("hermes:")
  );
  const hermes = hermesModels.filter((model) => model.id.startsWith("hermes:"));

  const seen = new Set<string>();
  const catalog: ModelInfo[] = [];
  for (const model of [{ id: "auto", displayName: "Auto" }, ...rest, ...hermes]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    catalog.push(model);
  }
  return catalog;
}

export function modelIsAvailable(models: ModelInfo[], modelId: string): boolean {
  return models.some((item) => item.id === modelId);
}
