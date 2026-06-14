import {
  DEFAULT_CHARACTER_THEME,
  type CharacterCatalogEntry,
  type CharacterDetail,
  type CharacterTheme,
} from "../character/character-catalog.js";

export type SettingsCharacterEditorDraft = {
  characterId: string | null;
  name: string;
  description: string;
  iconFilePath: string;
  theme: CharacterTheme;
  definitionMarkdown: string;
  notesMarkdown: string;
  mode: "create" | "edit";
};

export function buildDefaultCharacterDefinition(name: string): string {
  const normalizedName = name.trim() || "New Character";
  return `---\nschema: withmate-character-v5\nname: ${normalizedName}\ndescription: \"\"\n---\n\n# Character Runtime Definition\n\n## Identity\n- ${normalizedName}\n`;
}

export function createNewCharacterEditorDraft(name = "New Character"): SettingsCharacterEditorDraft {
  return {
    characterId: null,
    name,
    description: "",
    iconFilePath: "",
    theme: { ...DEFAULT_CHARACTER_THEME },
    definitionMarkdown: buildDefaultCharacterDefinition(name),
    notesMarkdown: "# Character Notes\n",
    mode: "create",
  };
}

export function createCharacterEditorDraftFromDetail(detail: CharacterDetail): SettingsCharacterEditorDraft {
  return {
    characterId: detail.id,
    name: detail.name,
    description: detail.description,
    iconFilePath: detail.iconFilePath,
    theme: { ...detail.theme },
    definitionMarkdown: detail.definitionMarkdown,
    notesMarkdown: detail.notesMarkdown,
    mode: "edit",
  };
}

export function resolveSettingsCharacterSelection(
  entries: readonly CharacterCatalogEntry[],
  currentCharacterId: string | null,
): string | null {
  if (currentCharacterId && entries.some((entry) => entry.id === currentCharacterId)) {
    return currentCharacterId;
  }

  return entries[0]?.id ?? null;
}

export function isSettingsCharacterDraftDirty(
  draft: SettingsCharacterEditorDraft,
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
    || draft.theme.main !== persistedDetail.theme.main
    || draft.theme.sub !== persistedDetail.theme.sub
    || draft.definitionMarkdown !== persistedDetail.definitionMarkdown
    || draft.notesMarkdown !== persistedDetail.notesMarkdown;
}

export function normalizeThemeColorDraft(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

export function formatCharacterEditorError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }

  return error.message;
}
