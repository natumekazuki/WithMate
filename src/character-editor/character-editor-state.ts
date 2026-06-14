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
  return `---\nschema: withmate-character-v5\nname: ${normalizedName}\ndescription: \"\"\n---\n\n# Character Runtime Definition\n\n## Identity\n- ${normalizedName}\n`;
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
): CharacterEditorDraft {
  return updateCharacterEditorDraft(current, { definitionMarkdown });
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
