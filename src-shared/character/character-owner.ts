/** 保存値から所有者を復元できない場合に割り当てる予約ID。 */
export const UNKNOWN_CHARACTER_OWNER_ID = "withmate:unresolved-character-owner";
/** 所有者不明とは別の、Characterなしの中立実行で使う予約ID。 */
export const NEUTRAL_CHARACTER_ID = "withmate-neutral-character";

/** 文字列の前後の空白を除き、空や文字列以外は有効なIDとして扱わない。 */
export function normalizeCharacterOwnerId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

/** 保存用の所有者を要求し、空や復元不能を表す予約IDなら例外を投げる。 */
export function requireCharacterOwnerId(value: unknown): string {
  const normalized = normalizeCharacterOwnerId(value);
  if (!normalized || normalized === UNKNOWN_CHARACTER_OWNER_ID) {
    throw new Error("characterId cannot be empty.");
  }
  return normalized;
}

/** 空白を除いた値が、復元不能を表す予約IDと一致するか調べる。 */
export function isUnknownCharacterOwnerId(value: unknown): boolean {
  return normalizeCharacterOwnerId(value) === UNKNOWN_CHARACTER_OWNER_ID;
}

/** 既存のIDは正規化して残し、有効な文字列がない保存データだけ予約IDで補う。 */
export function recoverStoredCharacterOwnerId(value: unknown): string {
  return normalizeCharacterOwnerId(value) ?? UNKNOWN_CHARACTER_OWNER_ID;
}
