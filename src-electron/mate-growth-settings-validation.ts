import {
  type ModelCatalogSnapshot,
  type ModelReasoningEffort,
  resolveModelSelection,
} from "../src/model-catalog.js";
import type { UpdateMateGrowthSettingsInput } from "../src/mate/mate-state.js";

export function validateMateGrowthSettingsAgainstModelCatalog(
  input: UpdateMateGrowthSettingsInput,
  snapshot: ModelCatalogSnapshot,
): void {
  const { modelPreferences } = input;
  if (modelPreferences === undefined || !Array.isArray(modelPreferences)) {
    return;
  }

  for (const preference of modelPreferences) {
    if (preference === null || typeof preference !== "object" || Array.isArray(preference)) {
      continue;
    }

    if (preference.purpose !== "memory_candidate") {
      continue;
    }

    const providerId = typeof preference.provider === "string" ? preference.provider.trim() : "";
    const provider = snapshot.providers.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new Error(`Mate Growth provider が model catalog に存在しないよ: ${providerId}`);
    }

    resolveModelSelection(
      provider,
      preference.model,
      preference.depth as ModelReasoningEffort,
    );
  }
}
