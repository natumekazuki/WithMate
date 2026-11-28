import type { RuntimeSelectOption } from "./provider-runtime-options.js";

/** 実行速度として共有設定に保存できる値。 */
export const CODEX_SPEED_VALUES = ["standard", "fast"] as const;
/** 標準・高速を区別する設定値。Codex のサービスティア表記とは別に扱う。 */
export type CodexSpeed = (typeof CODEX_SPEED_VALUES)[number];

/** 高速が明示されていないときに使用する標準速度。 */
export const DEFAULT_CODEX_SPEED: CodexSpeed = "standard";

/** 標準と高速を選ぶときに各 Provider で共用する選択肢。 */
export const codexSpeedOptions = [
  { value: "standard", label: "Standard" },
  { value: "fast", label: "Fast" },
] as const satisfies readonly RuntimeSelectOption<CodexSpeed>[];

/** Codex へのリクエストに指定するサービスティア。 */
export type CodexServiceTier = "default" | "fast";

/** 高速の ID に一致する入力だけを高速として受理し、それ以外を標準に戻す。 */
export function normalizeCodexSpeed(value: unknown): CodexSpeed {
  return value === "fast" ? "fast" : DEFAULT_CODEX_SPEED;
}

/** 標準速度を Codex の default ティア、高速を fast ティアに対応付ける。 */
export function mapCodexSpeedToServiceTier(
  speed: CodexSpeed,
): CodexServiceTier {
  return speed === "fast" ? "fast" : "default";
}

/** 速度設定を扱う Codex と Claude にだけ、共有の選択肢のコピーを返す。 */
export function getCodexSpeedOptions(
  providerId: string | null | undefined,
): RuntimeSelectOption<CodexSpeed>[] {
  return providerId === "codex" || providerId === "claude"
    ? codexSpeedOptions.map((option) => ({ ...option }))
    : [];
}
