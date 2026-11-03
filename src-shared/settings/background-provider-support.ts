import type { ModelCatalogSnapshot } from "./model-catalog.js";
import type { BackgroundExecutionSelection } from "./background-settings.js";

export type BackgroundProviderAvailability =
  | { status: "not_configured" }
  | { status: "available"; providerId: string; modelId: string }
  | { status: "unavailable"; code: "BACKGROUND_PROVIDER_UNSUPPORTED" | "BACKGROUND_MODEL_UNAVAILABLE"; reason: string }
  | { status: "failed"; code: "BACKGROUND_CATALOG_UNAVAILABLE"; reason: string };

export function resolveBackgroundProviderAvailability(
  selection: BackgroundExecutionSelection | null | undefined,
  catalog: ModelCatalogSnapshot | null,
): BackgroundProviderAvailability {
  if (!selection) return { status: "not_configured" };
  if (!["codex", "copilot", "claude", "opencode"].includes(selection.providerId)) return { status: "unavailable", code: "BACKGROUND_PROVIDER_UNSUPPORTED",
    reason: "The selected provider is not supported. Select a provider for this purpose again." };
  if (!catalog || catalog.discovery?.[selection.providerId]?.status === "error") {
    return { status: "failed", code: "BACKGROUND_CATALOG_UNAVAILABLE", reason: "Models could not be retrieved. Check the provider connection settings." };
  }
  const provider = catalog.providers.find((entry) => entry.id === selection.providerId);
  if (!provider?.models.some((model) => model.id === selection.modelId)) return { status: "unavailable",
    code: "BACKGROUND_MODEL_UNAVAILABLE", reason: "The selected model is not in the model list. Select a model for this purpose again." };
  return { status: "available", providerId: selection.providerId, modelId: selection.modelId };
}
