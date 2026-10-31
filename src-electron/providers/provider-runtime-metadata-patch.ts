import type { ModelReasoningEffort } from "../../src-shared/settings/model-catalog.js";

export type ProviderRuntimeMetadata = {
  provider: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  threadId: string;
  updatedAt: string;
};

export type ProviderRuntimeMetadataPatch = {
  expected: ProviderRuntimeMetadata;
  next: ProviderRuntimeMetadata;
};
