import { coerceModelSelection, type ModelCatalogSnapshot } from "../settings/model-catalog.js";
import type { SessionExecutionOptions } from "./session-execution-options.js";

/** Explicit active-catalog changes reconcile selections without treating old checkpoints as new intent. */
export function applyExecutionOptionsCatalog<T extends Pick<SessionExecutionOptions, "catalogRevision" | "model" | "reasoningEffort"> & { provider: string }>(
  source: T,
  catalog: ModelCatalogSnapshot | null,
): T {
  if (!catalog) return source;
  const provider = catalog.providers.find((entry) => entry.id === source.provider);
  if (!provider) return source;
  const selection = coerceModelSelection(provider, source.model, source.reasoningEffort);
  if (source.catalogRevision === catalog.revision && source.model === selection.resolvedModel
    && source.reasoningEffort === selection.resolvedReasoningEffort) return source;
  return {
    ...source,
    catalogRevision: catalog.revision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
  };
}
