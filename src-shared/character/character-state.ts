/** 一覧や会話で使う、Characterの表示名と画像参照。 */
export type CharacterVisual = {
  name: string;
  iconPath: string;
};

/** Character表示に使う主色と副色。 */
export type CharacterThemeColors = {
  main: string;
  sub: string;
};

/** 表示情報に保存済みCharacterの識別子を加えた一覧項目。 */
export type CharacterCatalogItem = CharacterVisual & {
  id: string;
};

/** 表示情報と、編集に使う紹介・定義・補助メモ、更新日時と配色を保持する。 */
export type CharacterProfile = CharacterCatalogItem & {
  description: string;
  roleMarkdown: string;
  notesMarkdown: string;
  updatedAt: string;
  themeColors: CharacterThemeColors;
};

/** IDの採番前に受け取る、Characterの公開情報と編集用本文・配色。 */
export type CreateCharacterInput = {
  name: string;
  iconPath: string;
  description: string;
  roleMarkdown: string;
  notesMarkdown: string;
  themeColors: CharacterThemeColors;
};

/** 配色を指定しない場合と、無効な色を補う場合に使う既定色。 */
export const DEFAULT_CHARACTER_THEME_COLORS: CharacterThemeColors = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

/** 前後の空白を除いた6桁の16進色を小文字に揃え、それ以外は指定した既定色にする。 */
function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return fallback;
  }

  return normalized.toLowerCase();
}

/** 主色と副色を独立に検証して、不正な値だけ既定色で埋める。 */
export function normalizeCharacterThemeColors(
  value: unknown,
): CharacterThemeColors {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CHARACTER_THEME_COLORS };
  }

  const candidate = value as Partial<CharacterThemeColors>;
  return {
    main: normalizeHexColor(
      candidate.main,
      DEFAULT_CHARACTER_THEME_COLORS.main,
    ),
    sub: normalizeHexColor(candidate.sub, DEFAULT_CHARACTER_THEME_COLORS.sub),
  };
}

/** 元の配列や配色を編集側で書き換えないよう、項目と配色を別のオブジェクトへ写す。 */
export function cloneCharacterProfiles(
  characters: CharacterProfile[],
): CharacterProfile[] {
  return characters.map((character) => ({
    ...character,
    themeColors: { ...character.themeColors },
  }));
}

/** 完全一致するIDのプロフィールを複製して返し、不在ならnullとする。 */
export function getCharacterById(
  characters: CharacterProfile[],
  characterId: string,
): CharacterProfile | null {
  return (
    cloneCharacterProfiles(characters).find(
      (character) => character.id === characterId,
    ) ?? null
  );
}
