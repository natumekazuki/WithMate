import type { CharacterDefinitionValidationIssue } from "./character-definition.js";

export type CharacterCatalogState = "active" | "archived";

export type CharacterTheme = {
  main: string;
  sub: string;
};

export type CharacterCatalogEntry = {
  id: string;
  name: string;
  description: string;
  iconFilePath: string;
  theme: CharacterTheme;
  state: CharacterCatalogState;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CharacterDetail = CharacterCatalogEntry & {
  definitionMarkdown: string;
  notesMarkdown: string;
};

export type CreateCharacterInput = {
  name: string;
  description?: string;
  iconFilePath?: string;
  theme?: Partial<CharacterTheme>;
  definitionMarkdown?: string;
  notesMarkdown?: string;
  setDefault?: boolean;
};

export type ImportCharacterPackFileResult = {
  character: CharacterDetail;
  importedFiles: string[];
};

export type UpdateCharacterMetadataInput = {
  characterId: string;
  name?: string;
  description?: string;
  iconFilePath?: string;
  theme?: Partial<CharacterTheme>;
};

export type UpdateCharacterDefinitionInput = {
  characterId: string;
  definitionMarkdown: string;
  notesMarkdown?: string;
};

export type ResolveLaunchCharacterInput = {
  characterId?: string | null;
};

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

export type CharacterValidationError = {
  message: string;
  issues: CharacterDefinitionValidationIssue[];
};

export const DEFAULT_CHARACTER_THEME: CharacterTheme = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

export function cloneCharacterTheme(theme: CharacterTheme): CharacterTheme {
  return {
    main: theme.main,
    sub: theme.sub,
  };
}

export function cloneCharacterCatalogEntry(entry: CharacterCatalogEntry): CharacterCatalogEntry {
  return {
    ...entry,
    theme: cloneCharacterTheme(entry.theme),
  };
}

export function cloneCharacterDetail(detail: CharacterDetail): CharacterDetail {
  return {
    ...detail,
    theme: cloneCharacterTheme(detail.theme),
  };
}

export function cloneCharacterRuntimeSnapshot(snapshot: CharacterRuntimeSnapshot): CharacterRuntimeSnapshot {
  return {
    ...snapshot,
    theme: cloneCharacterTheme(snapshot.theme),
  };
}
