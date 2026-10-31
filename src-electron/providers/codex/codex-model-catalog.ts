import type { ModelCatalogItem } from "../../../src-shared/settings/model-catalog.js";

export function parseCodexModelPage(value: unknown): { models: ModelCatalogItem[]; defaultModelId?: string; nextCursor: string | null } {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) {
    throw new Error("Codex model list is invalid");
  }
  const models: ModelCatalogItem[] = [];
  let defaultModelId: string | undefined;
  for (const model of value.data) {
    if (!model || typeof model !== "object" || typeof model.model !== "string" || !model.model.trim()
      || typeof model.displayName !== "string" || !model.displayName.trim()
      || !Array.isArray(model.supportedReasoningEfforts) || typeof model.defaultReasoningEffort !== "string") {
      throw new Error("Codex model metadata is invalid");
    }
    if (model.hidden === true) continue;
    const reasoningEfforts = model.supportedReasoningEfforts.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("reasoningEffort" in entry)
        || typeof entry.reasoningEffort !== "string" || !entry.reasoningEffort.trim()) {
        throw new Error("Codex model reasoning metadata is invalid");
      }
      return entry.reasoningEffort;
    });
    models.push({ id: model.model, label: model.displayName, reasoningEfforts,
      defaultReasoningEffort: reasoningEfforts.length ? model.defaultReasoningEffort : "" });
    if (model.isDefault === true) defaultModelId = model.model;
  }
  const nextCursor = "nextCursor" in value ? value.nextCursor : null;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor)) throw new Error("Codex model cursor is invalid");
  return { models, defaultModelId, nextCursor };
}
