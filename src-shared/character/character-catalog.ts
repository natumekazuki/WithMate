import type { CharacterDefinitionValidationIssue } from "./character-definition.js";

/** 起動候補になれる有効なCharacterと、保管だけするアーカイブを区別する。 */
export type CharacterCatalogState = "active" | "archived";

/** Characterの主色と副色を組として保持する。 */
export type CharacterTheme = {
  main: string;
  sub: string;
};

/** 一覧や起動で参照する保存ID・公開情報と、状態の変更日時。 */
export type CharacterCatalogEntry = {
  id: string;
  name: string;
  description: string;
  iconFilePath: string;
  theme: CharacterTheme;
  state: CharacterCatalogState;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

/** カタログの公開情報に、編集用の定義と補助メモを加えた詳細。 */
export type CharacterDetail = CharacterCatalogEntry & {
  definitionMarkdown: string;
  notesMarkdown: string;
};

/** 新規Characterの名前と任意の公開情報・配色・定義本文。 */
export type CreateCharacterInput = {
  name: string;
  description?: string;
  iconFilePath?: string;
  theme?: Partial<CharacterTheme>;
  definitionMarkdown?: string;
  notesMarkdown?: string;
};

/** 指定したCharacterの表示情報や配色を部分的に更新する入力。 */
export type UpdateCharacterMetadataInput = {
  characterId: string;
  name?: string;
  description?: string;
  iconFilePath?: string;
  theme?: Partial<CharacterTheme>;
};

/** 指定したCharacterの実行用定義を置き換え、必要なら補助メモも更新する。 */
export type UpdateCharacterDefinitionInput = {
  characterId: string;
  definitionMarkdown: string;
  notesMarkdown?: string;
};

/** 起動で使用するCharacterを明示する場合のID。 */
export type ResolveLaunchCharacterInput = {
  characterId?: string | null;
};

/** Session開始時の定義、公開情報、配色、内容を照合する識別情報を固定する。 */
export type CharacterRuntimeSnapshot = {
  characterId: string;
  name: string;
  description: string;
  iconFilePath: string;
  theme: CharacterTheme;
  definitionMarkdown: string;
  definitionSha256: string;
  definitionByteSize: number;
  snapshotAt: string;
};

/** 定義の更新を受け付けられない理由を、概要と個別の指摘で返す。 */
export type CharacterValidationError = {
  message: string;
  issues: CharacterDefinitionValidationIssue[];
};

/** カタログの新規作成や色の指定がない場合に使う既定の配色。 */
export const DEFAULT_CHARACTER_THEME: CharacterTheme = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

/** 表示側で元の配色を変更しないよう、主色と副色を別オブジェクトへ写す。 */
export function cloneCharacterTheme(theme: CharacterTheme): CharacterTheme {
  return {
    main: theme.main,
    sub: theme.sub,
  };
}

/** 一覧項目を複製し、入れ子の配色も元とは別に保持する。 */
export function cloneCharacterCatalogEntry(
  entry: CharacterCatalogEntry,
): CharacterCatalogEntry {
  return {
    ...entry,
    theme: cloneCharacterTheme(entry.theme),
  };
}

/** 編集に使う定義とメモを保ったまま、詳細項目と配色を複製する。 */
export function cloneCharacterDetail(detail: CharacterDetail): CharacterDetail {
  return {
    ...detail,
    theme: cloneCharacterTheme(detail.theme),
  };
}

/** 保存済みの定義本文・取得日時はそのままに、スナップショットと配色を複製する。 */
export function cloneCharacterRuntimeSnapshot(
  snapshot: CharacterRuntimeSnapshot,
): CharacterRuntimeSnapshot {
  return {
    ...snapshot,
    theme: cloneCharacterTheme(snapshot.theme),
  };
}
