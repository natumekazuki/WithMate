import type { ModelReasoningEffort } from "../../src-shared/settings/model-catalog.js";

/** プロバイダーの選択とネイティブスレッドを、カタログ版・保存時刻とともに示す。 */
export type ProviderRuntimeMetadata = {
  provider: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  threadId: string;
  updatedAt: string;
};

/** 読み取ったランタイム情報と、競合がなければ保存する新しい値の組。 */
export type ProviderRuntimeMetadataPatch = {
  expected: ProviderRuntimeMetadata;
  next: ProviderRuntimeMetadata;
};
