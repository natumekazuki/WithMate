/** Provider 固有の推論強度 ID。共通のラベル一覧にない値も文字列として保持する。 */
export type ModelReasoningEffort = string;

/** モデルの表示情報と、そのモデルがサポートする推論強度および既定値。 */
export type ModelCatalogItem = {
  id: string;
  label: string;
  sourceLabel?: string;
  reasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort?: ModelReasoningEffort;
};

/** 一つの Provider で見つかったモデル一覧と Provider レベルの既定値。 */
export type ModelCatalogProvider = {
  id: string;
  label: string;
  defaultModelId: string;
  defaultReasoningEffort: ModelReasoningEffort;
  models: ModelCatalogItem[];
};

/** ワークスペースに対して取得したモデル一覧と、Provider ごとの探索状態。 */
export type ModelCatalogSnapshot = {
  workspacePath?: string;
  providers: ModelCatalogProvider[];
  discovery?: Record<
    string,
    {
      status: "idle" | "loading" | "ready" | "error";
      fetchedAt?: string;
      error?: string;
    }
  >;
};

/** モデル探索で対象の Provider やワークスペースを限定するときの指定。 */
export type ModelCatalogRequest = {
  providerId?: string;
  workspacePath?: string;
};

/** 選択時の要求値と、実際に使うモデル・推論強度を区別した解決結果。 */
export type ResolvedModelSelection = {
  requestedModel: string;
  resolvedModel: string;
  requestedReasoningEffort: ModelReasoningEffort;
  resolvedReasoningEffort: ModelReasoningEffort;
};

/** Provider ID がないときに選ぶ Codex の正規 ID。 */
export const DEFAULT_PROVIDER_ID = "codex";
/** まだモデルが選択されていないことを表す初期値。 */
export const DEFAULT_MODEL_ID = "";
/** 推論強度を指定していないことを表す初期値。 */
export const DEFAULT_REASONING_EFFORT: ModelReasoningEffort = "";

/** 既知の推論強度 ID の表示ラベル。Provider ごとの対応値は各モデルが持つ。 */
export const reasoningEffortOptions = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
] as const;

/** Provider 固有の値を制限しないよう、列挙値ではなく文字列かどうかを判定する。 */
export function isModelReasoningEffort(
  value: unknown,
): value is ModelReasoningEffort {
  return typeof value === "string";
}

/** ID の前後の空白を除き、空値や旧表記の Codex は既定の ID に揃える。 */
export function normalizeProviderId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim() === "Codex") {
    return DEFAULT_PROVIDER_ID;
  }
  return value.trim();
}

/** モデル配列や探索状態を呼び出し元と共有しないよう、スナップショットを深くコピーする。 */
export function cloneModelCatalogSnapshot(
  snapshot: ModelCatalogSnapshot,
): ModelCatalogSnapshot {
  return structuredClone(snapshot);
}

/** 一覧から既定 Provider の情報だけを取得し、不在なら別の Provider に切り替えず null を返す。 */
export function getDefaultProviderCatalog(
  providers: readonly ModelCatalogProvider[],
): ModelCatalogProvider | null {
  return (
    providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? null
  );
}

/** 入力した Provider ID を正規化して照合し、一覧になければ null を返す。 */
export function getProviderCatalog(
  providers: readonly ModelCatalogProvider[],
  providerId: string | null | undefined,
): ModelCatalogProvider | null {
  return (
    providers.find(
      (provider) => provider.id === normalizeProviderId(providerId),
    ) ?? null
  );
}

/** 指定の Provider 内でモデル ID を完全一致で検索する。 */
export function getModelCatalogItem(
  providerCatalog: ModelCatalogProvider,
  model: string,
): ModelCatalogItem | null {
  return providerCatalog.models.find((entry) => entry.id === model) ?? null;
}

/** 指定モデルが公開した推論強度を返し、モデルを取得できない場合は空にする。 */
export function getReasoningEffortOptionsForModel(
  providerCatalog: ModelCatalogProvider,
  model: string,
): readonly ModelReasoningEffort[] {
  return getModelCatalogItem(providerCatalog, model)?.reasoningEfforts ?? [];
}

/** 既知の推論強度は表示ラベルにし、未知の Provider 固有値はそのまま表示できるようにする。 */
export function reasoningEffortLabel(
  reasoningEffort: ModelReasoningEffort,
): string {
  return (
    reasoningEffortOptions.find((option) => option.id === reasoningEffort)
      ?.label ?? reasoningEffort
  );
}

/** 保存済みの選択をカタログで置き換えず、要求値を解決値にも用いる。 */
export function coerceModelSelection(
  _providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  return {
    requestedModel,
    resolvedModel: requestedModel,
    requestedReasoningEffort,
    resolvedReasoningEffort: requestedReasoningEffort,
  };
}

/** 明示的に変更するモデルが探索済みの一覧にあることを確認し、そのモデル向けに推論強度を解決する。 */
export function resolveModelChangeSelection(
  providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  const model = getModelCatalogItem(providerCatalog, requestedModel);
  if (!model) {
    throw new Error("The selected model is not in the discovered model list.");
  }
  return resolveModelItemChangeSelection(model, requestedReasoningEffort);
}

/** 明示的なモデル変更で、対応する推論強度は維持し、非対応なら既定値、候補がなければ空値にする。 */
export function resolveModelItemChangeSelection(
  model: ModelCatalogItem,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  return {
    requestedModel: model.id,
    resolvedModel: model.id,
    requestedReasoningEffort,
    resolvedReasoningEffort:
      model.reasoningEfforts.length === 0
        ? ""
        : model.reasoningEfforts.includes(requestedReasoningEffort)
          ? requestedReasoningEffort
          : (model.defaultReasoningEffort ?? ""),
  };
}

/** 実行前にモデルの選択を必須とし、空白でなければ保存されたモデルと推論強度をそのまま引き渡す。 */
export function resolveModelSelection(
  providerCatalog: ModelCatalogProvider,
  requestedModel: string,
  requestedReasoningEffort: ModelReasoningEffort,
): ResolvedModelSelection {
  if (!requestedModel.trim()) {
    throw new Error("A model must be selected before running.");
  }
  return coerceModelSelection(
    providerCatalog,
    requestedModel,
    requestedReasoningEffort,
  );
}
