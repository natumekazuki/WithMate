import {
  type CharacterCatalogState,
  type CreateCharacterInput,
  DEFAULT_CHARACTER_THEME,
  type CharacterDetail,
  type CharacterTheme,
} from "../../src-shared/character/character-catalog.js";
import {
  parseCharacterDefinitionMarkdown,
  validateCharacterDefinitionMarkdown,
  validateCharacterNotesMarkdown,
  type CharacterDefinitionValidationIssue,
} from "../../src-shared/character/character-definition.js";
import {
  CHARACTER_ICON_FORMAT_ERROR,
  CHARACTER_ICON_LOCAL_PATH_ERROR,
  areCharacterIconPathReferencesEquivalent,
  validateCharacterIconRegistrationPath,
} from "../../src-shared/character/character-icon.js";
import {
  buildDefaultCharacterDefinition,
  buildDefaultCharacterNotes,
} from "../../src-shared/character/character-definition-template.js";

export {
  buildDefaultCharacterDefinition,
  buildDefaultCharacterNotes,
} from "../../src-shared/character/character-definition-template.js";

/** プロフィール、定義・ノートの本文、実行時のプレビューを切り替えるタブ。 */
export type CharacterEditorTab = "profile" | "definition" | "notes" | "preview";

/** 保存前のプロフィールと本文。新規作成と既存 ID の編集を別のモードで扱う。 */
export type CharacterEditorDraft = {
  characterId: string | null;
  mode: "create" | "edit";
  state: CharacterCatalogState;
  name: string;
  description: string;
  iconFilePath: string;
  theme: CharacterTheme;
  definitionMarkdown: string;
  notesMarkdown: string;
};

/** 本文ごとの検証指摘と、保存を止める指摘の合算。 */
export type CharacterEditorValidationSummary = {
  definitionIssues: CharacterDefinitionValidationIssue[];
  notesIssues: CharacterDefinitionValidationIssue[];
  blockingIssues: CharacterDefinitionValidationIssue[];
};

/** 保存先 ID を持たない有効な新規下書きを、既定テーマと本文テンプレートで初期化する。 */
export function createNewCharacterEditorDraft(
  name = "New Character",
): CharacterEditorDraft {
  return {
    characterId: null,
    mode: "create",
    state: "active",
    name,
    description: "",
    iconFilePath: "",
    theme: { ...DEFAULT_CHARACTER_THEME },
    definitionMarkdown: buildDefaultCharacterDefinition(name),
    notesMarkdown: buildDefaultCharacterNotes(),
  };
}

/** 保存済みの状態を編集用に写し、定義を解析できる場合はその名前と説明をカタログ値より優先する。 */
export function createCharacterEditorDraftFromDetail(
  detail: CharacterDetail,
): CharacterEditorDraft {
  const metadata = resolveCharacterDefinitionMetadata(
    detail.definitionMarkdown,
  );
  return {
    characterId: detail.id,
    mode: "edit",
    state: detail.state,
    name: metadata?.name || detail.name,
    description: metadata?.description ?? detail.description,
    iconFilePath: detail.iconFilePath,
    theme: { ...detail.theme },
    definitionMarkdown: detail.definitionMarkdown,
    notesMarkdown: detail.notesMarkdown,
  };
}

/** 妥当な定義の frontmatter から名前と説明を取り出し、解析不能なら null を返す。 */
export function resolveCharacterDefinitionMetadata(
  definitionMarkdown: string,
): { name: string; description: string } | null {
  const parsed = parseCharacterDefinitionMarkdown(definitionMarkdown);
  if (!parsed.ok) {
    return null;
  }

  return {
    name: parsed.value.frontmatter.name,
    description: parsed.value.frontmatter.description,
  };
}

/** 新規・比較元不明・別 ID は未保存とみなし、同じ ID なら保存値との差を調べる。 */
export function isCharacterEditorDraftDirty(
  draft: CharacterEditorDraft,
  persistedDetail: CharacterDetail | null,
): boolean {
  if (draft.mode === "create") {
    return true;
  }
  if (!persistedDetail || draft.characterId !== persistedDetail.id) {
    return true;
  }

  return (
    draft.name !== persistedDetail.name ||
    draft.description !== persistedDetail.description ||
    draft.iconFilePath !== persistedDetail.iconFilePath ||
    draft.state !== persistedDetail.state ||
    draft.theme.main !== persistedDetail.theme.main ||
    draft.theme.sub !== persistedDetail.theme.sub ||
    draft.definitionMarkdown !== persistedDetail.definitionMarkdown ||
    draft.notesMarkdown !== persistedDetail.notesMarkdown
  );
}

/** オブジェクトの参照ではなく、主色と副色の保存値で等価性を判定する。 */
function areCharacterThemesEqual(
  left: CharacterTheme,
  right: CharacterTheme,
): boolean {
  return left.main === right.main && left.sub === right.sub;
}

/** 保存や再読み込みの途中に編集が進んだかを調べるため、ID・モードを含め下書き全体を比較する。 */
export function areCharacterEditorDraftsEqual(
  left: CharacterEditorDraft,
  right: CharacterEditorDraft,
): boolean {
  return (
    left.characterId === right.characterId &&
    left.mode === right.mode &&
    left.state === right.state &&
    left.name === right.name &&
    left.description === right.description &&
    left.iconFilePath === right.iconFilePath &&
    areCharacterThemesEqual(left.theme, right.theme) &&
    left.definitionMarkdown === right.definitionMarkdown &&
    left.notesMarkdown === right.notesMarkdown
  );
}

/**
 * 保存リクエストの処理中に加えた編集を保持する。作成リクエストでは
 * 新しく割り当てられた character ID が必要なので、保存済みの下書きを基にし、
 * 保存開始後に変わったフィールドの値だけを引き継ぐ。
 */
export function reconcileCharacterEditorDraftAfterSave(
  savedDraft: CharacterEditorDraft,
  draftAtSave: CharacterEditorDraft,
  currentDraft: CharacterEditorDraft,
): CharacterEditorDraft {
  if (areCharacterEditorDraftsEqual(draftAtSave, currentDraft)) {
    return savedDraft;
  }

  if (draftAtSave.mode !== "create" || savedDraft.mode !== "edit") {
    return currentDraft;
  }

  return {
    ...savedDraft,
    name: currentDraft.name,
    description: currentDraft.description,
    iconFilePath: currentDraft.iconFilePath,
    theme: { ...currentDraft.theme },
    definitionMarkdown: currentDraft.definitionMarkdown,
    notesMarkdown: currentDraft.notesMarkdown,
  };
}

/** 未保存かつ保存中でない下書きに対し、破棄が未確認の場合だけ閉じる操作を止める。 */
export function shouldBlockCharacterEditorBeforeUnload(args: {
  dirty: boolean;
  saving: boolean;
  confirmedClose: boolean;
}): boolean {
  return args.dirty && !args.saving && !args.confirmedClose;
}

/** 保存済みアイコンと同じ参照は許可し、新規・置換する参照だけ登録条件に照らして案内を返す。 */
export function getCharacterIconDraftValidationMessage(
  draftIconFilePath: string,
  persistedIconFilePath: string | null | undefined,
): string | null {
  if (
    persistedIconFilePath !== null &&
    persistedIconFilePath !== undefined &&
    areCharacterIconPathReferencesEquivalent(
      draftIconFilePath,
      persistedIconFilePath,
    )
  ) {
    return null;
  }

  const validationMessage =
    validateCharacterIconRegistrationPath(draftIconFilePath);
  if (!validationMessage) {
    return null;
  }

  if (validationMessage === CHARACTER_ICON_LOCAL_PATH_ERROR) {
    return "Character icon must use a local file path.";
  }
  if (validationMessage === CHARACTER_ICON_FORMAT_ERROR) {
    return "Character icon must be a PNG, JPG, or JPEG image file.";
  }

  return validationMessage;
}

/** 前後の空白を除いた6桁の16進カラーを小文字にし、それ以外なら以前の値を使う。 */
export function normalizeThemeColorDraft(
  value: string,
  fallback: string,
): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

/** 下書きの差分と妥当な色を適用し、名前の変更で本文を作り直すのは未編集の新規定義だけに限る。 */
export function updateCharacterEditorDraft(
  current: CharacterEditorDraft,
  patch: Partial<CharacterEditorDraft>,
): CharacterEditorDraft {
  const shouldRegenerateDefinition =
    patch.name !== undefined &&
    patch.definitionMarkdown === undefined &&
    current.mode === "create" &&
    current.definitionMarkdown ===
      buildDefaultCharacterDefinition(current.name);
  const nextTheme = patch.theme
    ? {
        main: normalizeThemeColorDraft(patch.theme.main, current.theme.main),
        sub: normalizeThemeColorDraft(patch.theme.sub, current.theme.sub),
      }
    : current.theme;

  return {
    ...current,
    ...patch,
    theme: nextTheme,
    definitionMarkdown: shouldRegenerateDefinition
      ? buildDefaultCharacterDefinition(patch.name ?? current.name)
      : (patch.definitionMarkdown ?? current.definitionMarkdown),
  };
}

/** 新規作成 API の入力へ変換し、解析できる定義の frontmatter を名前と説明の正本にする。 */
export function buildCreateCharacterInputFromDraft(
  draft: CharacterEditorDraft,
): CreateCharacterInput {
  const metadata = resolveCharacterDefinitionMetadata(draft.definitionMarkdown);
  return {
    name: metadata?.name || draft.name,
    description: metadata?.description ?? draft.description,
    iconFilePath: draft.iconFilePath,
    theme: draft.theme,
    definitionMarkdown: draft.definitionMarkdown,
    notesMarkdown: draft.notesMarkdown,
  };
}

/** 定義本文を下書きで置き換え、渡された名前・説明だけをプロフィールにも反映する。 */
export function replaceCharacterDefinitionDraft(
  current: CharacterEditorDraft,
  definitionMarkdown: string,
  metadata?: { name?: string; description?: string },
): CharacterEditorDraft {
  return updateCharacterEditorDraft(current, {
    definitionMarkdown,
    name: metadata?.name ?? current.name,
    description: metadata?.description ?? current.description,
  });
}

/** 定義とノートをそれぞれ検証し、タブごとの指摘と保存前に解決すべき全件を返す。 */
export function buildCharacterEditorValidationSummary(
  draft: CharacterEditorDraft,
): CharacterEditorValidationSummary {
  const definitionIssues = validateCharacterDefinitionMarkdown(
    draft.definitionMarkdown,
  );
  const notesIssues = validateCharacterNotesMarkdown(draft.notesMarkdown);

  return {
    definitionIssues,
    notesIssues,
    blockingIssues: [...definitionIssues, ...notesIssues],
  };
}

/** Error の場合はそのメッセージを使い、それ以外は操作に応じた代替文言を使う。 */
export function formatCharacterEditorError(
  error: unknown,
  fallback: string,
): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  return error.message;
}
