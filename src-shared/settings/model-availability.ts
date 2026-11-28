/** 一つの Provider について、サービス単位とモデル単位で無効にする ID を保持する。 */
export type ProviderModelAvailability = {
  disabledServiceIds: string[];
  disabledModelIds: string[];
};

/** Provider ID ごとに無効なサービスとモデルを引ける設定。 */
export type ModelAvailabilitySettings = Record<
  string,
  ProviderModelAvailability
>;

/** 空白だけの ID を含む不正な配列を拒否し、値の表記を保って複製する。 */
function normalizeDisabledIds(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error(
      `Model availability ${field} must be an array of non-empty IDs`,
    );
  }
  return [...value];
}

/** 省略された設定は空として扱い、指定された場合は Provider ごとの無効化リストを検証して複製する。 */
export function normalizeModelAvailability(
  value: unknown,
): ModelAvailabilitySettings {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model availability must be a provider settings object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([providerId, settings]) => {
      if (
        !providerId.trim() ||
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings)
      ) {
        throw new Error(
          "Model availability must contain valid provider settings",
        );
      }
      const candidate = settings as Record<string, unknown>;
      return [
        providerId,
        {
          disabledServiceIds: normalizeDisabledIds(
            candidate.disabledServiceIds,
            "disabledServiceIds",
          ),
          disabledModelIds: normalizeDisabledIds(
            candidate.disabledModelIds,
            "disabledModelIds",
          ),
        },
      ];
    }),
  );
}

/** OpenCode のモデル ID だけを対象に、最初のスラッシュより前のサービス ID を取り出す。 */
export function getModelServiceId(
  providerId: string,
  modelId: string,
): string | null {
  if (providerId !== "opencode") {
    return null;
  }
  const separator = modelId.indexOf("/");
  return separator > 0 ? modelId.slice(0, separator) : null;
}

/** 指定モデルの無効化理由を返す。サービス単位とモデル単位の両方に該当すればサービスを優先する。 */
export function getModelDisabledReason(
  settings: ModelAvailabilitySettings,
  providerId: string,
  modelId: string,
): "service" | "model" | null {
  const availability = Object.hasOwn(settings, providerId)
    ? settings[providerId]
    : undefined;
  if (!availability) {
    return null;
  }
  const serviceId = getModelServiceId(providerId, modelId);
  if (
    serviceId !== null &&
    availability.disabledServiceIds.includes(serviceId)
  ) {
    return "service";
  }
  return availability.disabledModelIds.includes(modelId) ? "model" : null;
}

/** 無効化されたモデルの利用を、Provider とモデルおよび無効化理由を示すエラーで拒否する。 */
export function assertModelEnabled(
  settings: ModelAvailabilitySettings,
  providerId: string,
  modelId: string,
): void {
  const reason = getModelDisabledReason(settings, providerId, modelId);
  if (reason !== null) {
    throw new Error(
      `Model ${providerId}/${modelId} is disabled by ${reason} settings`,
    );
  }
}
