import type { ModelInfo } from "@cursor-gateway/shared";

/**
 * Build the model dropdown for an E2EE-paired session from the paired runner's
 * advertised catalog. Legacy `/api/models` only unions in-memory legacy/Hermes
 * heartbeats and is empty (or Hermes-only) when runners are E2EE-only.
 *
 * Always expose gateway `auto`. Drop SDK alias `default` (also labeled Auto) and
 * Hermes models (rejected on the E2EE submit path).
 */
export function buildPairedModelCatalog(runnerModels: ModelInfo[]): ModelInfo[] {
  const rest = runnerModels.filter(
    (model) =>
      model.id !== "auto" &&
      model.id !== "default" &&
      !model.id.startsWith("hermes:")
  );
  return [{ id: "auto", displayName: "Auto" }, ...rest];
}

export function modelIsAvailable(models: ModelInfo[], modelId: string): boolean {
  return models.some((item) => item.id === modelId);
}
