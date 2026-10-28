import type { OpenCodeClient, ModelInfo, ModelRef } from "@opencode/client";
import type { ModelReasoningEffort } from "../../../src-shared/settings/model-catalog.js";
import type { ComposerAttachment } from "../../../src-shared/session/runtime-state.js";

export function resolveOpenCodeModelRef(model: string, reasoningEffort: ModelReasoningEffort): ModelRef {
  const boundary = model.indexOf("/");
  if (boundary <= 0 || !model.slice(boundary + 1) || model.includes("#")) {
    throw new Error(`Invalid OpenCode model reference: ${model}`);
  }
  return { providerID: model.slice(0, boundary), id: model.slice(boundary + 1), ...(reasoningEffort ? { variant: reasoningEffort } : {}) };
}

export async function validateOpenCodeModel(
  client: OpenCodeClient,
  model: ModelRef,
  location: { directory: string },
  attachments: ComposerAttachment[] = [],
  signal?: AbortSignal,
): Promise<ModelInfo> {
  const catalog = await client.model.list({ location }, { signal });
  const info = catalog.data.find((entry) => entry.providerID === model.providerID && entry.id === model.id);
  if (!info?.enabled) throw new Error(`OpenCode model is unavailable: ${model.providerID}/${model.id}`);
  if (model.variant && !info.variants.some((variant) => variant.id === model.variant)) {
    throw new Error(`OpenCode variant is unavailable: ${model.variant}`);
  }
  for (const attachment of attachments) {
    const modality = attachment.kind === "image" ? "image" : attachment.absolutePath.toLowerCase().endsWith(".pdf") ? "pdf" : "text";
    if (!info.capabilities.input.includes(modality)) throw new Error(`OpenCode model does not support ${modality} attachments`);
  }
  return info;
}
