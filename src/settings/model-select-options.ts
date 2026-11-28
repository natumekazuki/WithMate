import type {
  ModelCatalogItem,
  ModelCatalogProvider,
  ModelReasoningEffort,
} from "../../src-shared/settings/model-catalog.js";
import {
  modelDisplayLabel,
  modelOptionLabel,
  reasoningDepthLabel,
} from "../ui/ui-utils.js";

/** 選択値と表示名およびカタログ項目。保存済み ID がカタログにない場合は項目が null。 */
export type ModelSelectOption = {
  value: string;
  label: string;
  sourceLabel?: string;
  model: ModelCatalogItem | null;
};

/** 推論の深さの設定値と、選択欄に表示するラベル。 */
export type ReasoningEffortSelectOption = {
  value: ModelReasoningEffort;
  label: string;
};

/** カタログを選択候補にし、現在の選択が欠けている場合だけ ID を代替候補として先頭に残す。 */
export function buildModelSelectOptions(
  models: readonly ModelCatalogItem[],
  selectedModelId = "",
): ModelSelectOption[] {
  const options: ModelSelectOption[] = models.map((model) => ({
    value: model.id,
    label: modelOptionLabel(model),
    model,
    ...(model.sourceLabel ? { sourceLabel: model.sourceLabel } : {}),
  }));
  if (
    selectedModelId &&
    !options.some((option) => option.value === selectedModelId)
  ) {
    options.unshift({
      value: selectedModelId,
      label: selectedModelId,
      model: null,
    });
  }

  return options;
}

/** 選択中の ID に対応する表示名を引き、取得できない場合に使うラベルも決める。 */
export function resolveModelFallbackLabel(
  providerCatalog: ModelCatalogProvider | null | undefined,
  modelId: string,
): string {
  return modelDisplayLabel(providerCatalog ?? null, modelId);
}

/** 対応する深さだけを選択肢にし、空の値を既定値のラベルで示す。 */
export function buildReasoningEffortSelectOptions(
  reasoningEfforts: readonly ModelReasoningEffort[],
): ReasoningEffortSelectOption[] {
  return reasoningEfforts.map((reasoningEffort) => ({
    value: reasoningEffort,
    label: reasoningEffort ? reasoningDepthLabel(reasoningEffort) : "Default",
  }));
}
