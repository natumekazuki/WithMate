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
};

export type CharacterEditorValidationSummary = {
  definitionIssues: CharacterDefinitionValidationIssue[];
  notesIssues: CharacterDefinitionValidationIssue[];
  blockingIssues: CharacterDefinitionValidationIssue[];
};

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
    notesMarkdown: buildDefaultCharacterNotes(),
  };
}

export function createCharacterEditorDraftFromDetail(detail: CharacterDetail): CharacterEditorDraft {
  const metadata = resolveCharacterDefinitionMetadata(detail.definitionMarkdown);
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
    || draft.notesMarkdown !== persistedDetail.notesMarkdown;
}

function areCharacterThemesEqual(left: CharacterTheme, right: CharacterTheme): boolean {
  return left.main === right.main && left.sub === right.sub;
}

export function areCharacterEditorDraftsEqual(
  left: CharacterEditorDraft,
  right: CharacterEditorDraft,
): boolean {
  return left.characterId === right.characterId
    && left.mode === right.mode
    && left.state === right.state
    && left.name === right.name
    && left.description === right.description
    && left.iconFilePath === right.iconFilePath
    && areCharacterThemesEqual(left.theme, right.theme)
    && left.definitionMarkdown === right.definitionMarkdown
    && left.notesMarkdown === right.notesMarkdown;
}

/**
 * Keeps edits made while a save request was in flight. A create request needs
 * the newly assigned character id, so its saved draft is used as the base and
 * only the newer field values are carried across.
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

export function shouldBlockCharacterEditorBeforeUnload(args: {
  dirty: boolean;
  saving: boolean;
  confirmedClose: boolean;
}): boolean {
  return args.dirty && !args.saving && !args.confirmedClose;
}

export function getCharacterIconDraftValidationMessage(
  draftIconFilePath: string,
  persistedIconFilePath: string | null | undefined,
): string | null {
  if (
    persistedIconFilePath !== null
    && persistedIconFilePath !== undefined
    && areCharacterIconPathReferencesEquivalent(draftIconFilePath, persistedIconFilePath)
  ) {
    return null;
  }

  const validationMessage = validateCharacterIconRegistrationPath(draftIconFilePath);
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
