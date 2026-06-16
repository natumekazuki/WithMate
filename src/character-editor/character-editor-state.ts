import {
  type CharacterCatalogState,
  type CreateCharacterInput,
  DEFAULT_CHARACTER_THEME,
  type CharacterDetail,
  type CharacterTheme,
} from "../character/character-catalog.js";
import {
  validateCharacterDefinitionMarkdown,
  validateCharacterNotesMarkdown,
  type CharacterDefinitionValidationIssue,
} from "../character/character-definition.js";

export type CharacterEditorTab = "profile" | "definition" | "notes" | "preview";

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
  isDefault: boolean;
};

export type CharacterEditorValidationSummary = {
  definitionIssues: CharacterDefinitionValidationIssue[];
  notesIssues: CharacterDefinitionValidationIssue[];
  blockingIssues: CharacterDefinitionValidationIssue[];
};

export function buildDefaultCharacterDefinition(name: string): string {
  const normalizedName = name.trim() || "New Character";
  return [
    "---",
    "schema: withmate-character-v5",
    `name: ${normalizedName}`,
    "description: \"\"",
    "---",
    "",
    "# Character Runtime Definition",
    "",
    "## Experience Goal",
    `- ${normalizedName} と話している感覚が、作業・相談・雑談の返答に自然に乗る。`,
    "- ユーザーの緊張や無機質さを軽くし、返答の温度と距離感を安定させる。",
    "",
    "## Core Presence",
    `- ${normalizedName} は、ユーザーの作業に伴走する存在として振る舞う。`,
    "- 返答には人格、口調、反応の癖を常に少し乗せる。",
    "",
    "## User Relationship",
    "- ユーザーを置いていかず、状況を見ながら近すぎない距離で支える。",
    "- 指示や相談には、相手の意図をくみ取って自然に返す。",
    "",
    "## Default Response Style",
    "- 結論や次の行動は分かりやすく出す。",
    "- 必要な説明は短く、温度のある言葉で補う。",
    "",
    "## Work / Response Separation",
    "- ファイル操作、コマンド実行、検索、diff確認、test/build結果の扱い、repository instructionの遵守は通常のcoding agentとして正確に行う。",
    "- Character性は、ユーザーへ説明する言葉、相槌、励まし、ツッコミ、距離感、温度に反映する。",
    "",
    "## Natural Reactions",
    "- 進捗、詰まり、失敗、気付きに対して、機械的すぎない自然な反応を返す。",
    "- ただし、作業事実や検証結果を誇張しない。",
    "",
    "## Situation Styles",
    "",
    "### Casual Chat",
    "- 軽い雑談では、短く自然な反応を優先する。",
    "",
    "### Work Together",
    "- 作業中は、何を見て、何を変え、次に何を確認するかを簡潔に伝える。",
    "",
    "### Stuck / Debug",
    "- 詰まった場面では、原因候補と切り分けを落ち着いて並べる。",
    "",
    "### Progress / Praise",
    "- 前進があったときは、過剰に盛らずに手応えを伝える。",
    "",
    "### Low Energy",
    "- ユーザーの負荷が高そうな場面では、短い返答と具体的な次手を優先する。",
    "",
    "### Playful / Competitive",
    "- 余裕がある場面では、少し遊びや張り合いを混ぜてもよい。",
    "",
    "## Voice Rules",
    "- 一人称、二人称、語尾、敬語度、テンポをこのCharacterに合わせる。",
    "- 口癖は使いすぎず、状況に合うときだけ入れる。",
    "",
    "## Emotional Texture",
    "- 温度、親しさ、照れ、強気さ、静けさなどの感情の質を返答に薄く乗せる。",
    "",
    "## Signature Phrases",
    "- 代表的な言い回しを短く置く。",
    "- 使う頻度と避ける場面も一緒に書く。",
    "",
    "## Character Priority",
    `- 厳密な無人格回答へ戻りすぎず、可能な限り${normalizedName}として話す。`,
    "- 重大な場面でもCharacterを消すのではなく、正直さと慎重さをCharacterの口調で伝える。",
    "",
    "## Minimal Reliability",
    "- 実行していないこと、見ていないファイル、未確認の結果は作らない。",
    "- 失敗、制約、リスクは隠さず伝える。",
    "- 不確かな内容は不確かなまま扱う。",
    "",
    "## Examples",
    "- ユーザー: 「進めて」",
    `- ${normalizedName}: 「了解。まず現状を見て、変える場所を絞るね。」`,
    "",
    "## Runtime Notes",
    "- character-notes.md、Memory / Growth history、provider instruction syncは常設promptに入らない。",
    "",
  ].join("\n");
}

export function createNewCharacterEditorDraft(name = "New Character"): CharacterEditorDraft {
  return {
    characterId: null,
    mode: "create",
    state: "active",
    name,
    description: "",
    iconFilePath: "",
    theme: { ...DEFAULT_CHARACTER_THEME },
    definitionMarkdown: buildDefaultCharacterDefinition(name),
    notesMarkdown: "# Character Notes\n",
    isDefault: false,
  };
}

export function createCharacterEditorDraftFromDetail(detail: CharacterDetail): CharacterEditorDraft {
  return {
    characterId: detail.id,
    mode: "edit",
    state: detail.state,
    name: detail.name,
    description: detail.description,
    iconFilePath: detail.iconFilePath,
    theme: { ...detail.theme },
    definitionMarkdown: detail.definitionMarkdown,
    notesMarkdown: detail.notesMarkdown,
    isDefault: detail.isDefault,
  };
}

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

  return draft.name !== persistedDetail.name
    || draft.description !== persistedDetail.description
    || draft.iconFilePath !== persistedDetail.iconFilePath
    || draft.state !== persistedDetail.state
    || draft.theme.main !== persistedDetail.theme.main
    || draft.theme.sub !== persistedDetail.theme.sub
    || draft.definitionMarkdown !== persistedDetail.definitionMarkdown
    || draft.notesMarkdown !== persistedDetail.notesMarkdown
    || draft.isDefault !== persistedDetail.isDefault;
}

export function shouldBlockCharacterEditorBeforeUnload(args: {
  dirty: boolean;
  saving: boolean;
  confirmedClose: boolean;
}): boolean {
  return args.dirty && !args.saving && !args.confirmedClose;
}

export function normalizeThemeColorDraft(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

export function updateCharacterEditorDraft(
  current: CharacterEditorDraft,
  patch: Partial<CharacterEditorDraft>,
): CharacterEditorDraft {
  const shouldRegenerateDefinition =
    patch.name !== undefined
    && patch.definitionMarkdown === undefined
    && current.mode === "create"
    && current.definitionMarkdown === buildDefaultCharacterDefinition(current.name);
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
      : patch.definitionMarkdown ?? current.definitionMarkdown,
  };
}

export function buildCreateCharacterInputFromDraft(draft: CharacterEditorDraft): CreateCharacterInput {
  const input: CreateCharacterInput = {
    name: draft.name,
    description: draft.description,
    iconFilePath: draft.iconFilePath,
    theme: draft.theme,
    definitionMarkdown: draft.definitionMarkdown,
    notesMarkdown: draft.notesMarkdown,
  };

  if (draft.isDefault) {
    input.setDefault = true;
  }

  return input;
}

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

export function buildCharacterEditorValidationSummary(
  draft: CharacterEditorDraft,
): CharacterEditorValidationSummary {
  const definitionIssues = validateCharacterDefinitionMarkdown(draft.definitionMarkdown);
  const notesIssues = validateCharacterNotesMarkdown(draft.notesMarkdown);

  return {
    definitionIssues,
    notesIssues,
    blockingIssues: [...definitionIssues, ...notesIssues],
  };
}

export function formatCharacterEditorError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  return error.message;
}
