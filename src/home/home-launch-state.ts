import type { CreateSessionRequest, SessionSummary } from "../app-state.js";
import { DEFAULT_CHARACTER_THEME_COLORS, type CharacterThemeColors } from "../character-state.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import {
  selectWeightedRandomLaunchCharacterId,
  type CharacterUsageSessionSource,
} from "../character/character-launch-selection.js";
import type { CreateCompanionSessionInput } from "../companion-state.js";
import {
  inferWorkspaceFromPath,
  isSessionFolderLaunchWorkspace,
  resolveLaunchDirectoryWorkspace,
  type LaunchWorkspaceSelection,
} from "./home-launch-workspace.js";
import { LAUNCH_NO_PROVIDER_SELECTED_MESSAGE } from "../launch/launch-feedback.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import {
  resolveWorkspaceDirectoryValidationMessage,
  type WorkspaceDirectoryValidationResult,
} from "../workspace-directory-validation.js";

const NEUTRAL_CHARACTER_ID = "withmate-neutral-character";
const NEUTRAL_CHARACTER_NAME = "WithMate";

type LaunchCharacterSnapshot = {
  characterId: string;
  character: string;
  characterRoleMarkdown: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
};

export type LaunchCharacterSelectionMode = "specific" | "random";
export type HomeLaunchWorkspaceValidationState = "idle" | "debouncing" | "pending" | "valid" | "invalid";

export type HomeLaunchDraft = {
  open: boolean;
  mode: "session" | "companion";
  title: string;
  workspacePathInput: string;
  workspaceValidation: HomeLaunchWorkspaceValidationState;
  workspaceValidationMessage: string;
  workspace: LaunchWorkspaceSelection | null;
  providerId: string;
  characterSelectionMode: LaunchCharacterSelectionMode;
  characterId: string;
};

export function createClosedLaunchDraft(): HomeLaunchDraft {
  return {
    open: false,
    mode: "session",
    title: "",
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: null,
    providerId: "",
    characterSelectionMode: "random",
    characterId: "",
  };
}

export function openLaunchDraft(
  draft: HomeLaunchDraft,
  defaultProviderId: string,
  mode: HomeLaunchDraft["mode"] = "session",
): HomeLaunchDraft {
  return {
    ...draft,
    open: true,
    mode,
    title: "",
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: null,
    providerId: defaultProviderId,
    characterSelectionMode: "random",
    characterId: "",
  };
}

export function buildCreateCompanionSessionInputFromLaunchDraft({
  draft,
  mateProfile,
  selectedProviderId,
  characterEntries = [],
  sessions = [],
  openSessionCharacterIds = [],
  random = Math.random,
}: {
  draft: HomeLaunchDraft;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
  characterEntries?: readonly CharacterCatalogEntry[];
  sessions?: readonly CharacterUsageSessionSource[];
  openSessionCharacterIds?: readonly string[];
  random?: () => number;
}): CreateCompanionSessionInput | null {
  const normalizedTitle = draft.title.trim();
  const workspace = resolveLaunchDirectoryWorkspace(draft.workspace);
  if (!normalizedTitle || !workspace || !selectedProviderId) {
    return null;
  }
  const characterSnapshot = buildLaunchCharacterSnapshot(
    characterEntries,
    draft,
    sessions,
    openSessionCharacterIds,
    random,
  );
  if (!characterSnapshot) {
    return null;
  }

  return {
    taskTitle: normalizedTitle,
    workspacePath: workspace.path,
    provider: selectedProviderId,
    characterId: characterSnapshot.characterId,
    character: characterSnapshot.character,
    characterRoleMarkdown: characterSnapshot.characterRoleMarkdown,
    characterIconPath: characterSnapshot.characterIconPath,
    characterThemeColors: characterSnapshot.characterThemeColors,
  };
}

export function closeLaunchDraft(draft: HomeLaunchDraft): HomeLaunchDraft {
  return {
    ...draft,
    open: false,
    title: "",
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: null,
    providerId: "",
    characterSelectionMode: "random",
    characterId: "",
  };
}

export function setLaunchWorkspaceFromPath(draft: HomeLaunchDraft, selectedPath: string): HomeLaunchDraft {
  return {
    ...draft,
    workspacePathInput: selectedPath,
    workspaceValidation: "valid",
    workspaceValidationMessage: "",
    workspace: inferWorkspaceFromPath(selectedPath),
  };
}

export function beginLaunchWorkspacePathValidation(
  draft: HomeLaunchDraft,
  targetPath: string,
): HomeLaunchDraft {
  return {
    ...draft,
    workspacePathInput: targetPath,
    workspaceValidation: targetPath.length > 0 ? "debouncing" : "idle",
    workspaceValidationMessage: "",
    workspace: null,
  };
}

export function markLaunchWorkspacePathValidationPending(
  draft: HomeLaunchDraft,
  targetPath: string,
): HomeLaunchDraft {
  if (draft.workspacePathInput !== targetPath) {
    return draft;
  }
  return {
    ...draft,
    workspaceValidation: "pending",
  };
}

export function applyLaunchWorkspacePathValidation(
  draft: HomeLaunchDraft,
  targetPath: string,
  result: WorkspaceDirectoryValidationResult,
): HomeLaunchDraft {
  if (draft.workspacePathInput !== targetPath || draft.workspaceValidation !== "pending") {
    return draft;
  }
  if (result.valid) {
    return setLaunchWorkspaceFromPath(draft, targetPath);
  }
  return {
    ...draft,
    workspaceValidation: "invalid",
    workspaceValidationMessage: resolveWorkspaceDirectoryValidationMessage(result),
    workspace: null,
  };
}

export function setLaunchWorkspaceToSessionFolder(draft: HomeLaunchDraft): HomeLaunchDraft {
  return {
    ...draft,
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: { kind: "session-folder" },
  };
}

export function updateLaunchDraftForProviderSelection(
  draft: HomeLaunchDraft,
  providerId: string,
): HomeLaunchDraft {
  return {
    ...draft,
    providerId,
  };
}

export function updateLaunchDraftForCharacterSelection(
  draft: HomeLaunchDraft,
  characterId: string,
): HomeLaunchDraft {
  return {
    ...draft,
    characterSelectionMode: "specific",
    characterId,
  };
}

export function updateLaunchDraftForRandomCharacterSelection(
  draft: HomeLaunchDraft,
): HomeLaunchDraft {
  return {
    ...draft,
    characterSelectionMode: "random",
  };
}

export function resolveLaunchValidationMessage({
  draft,
  mateState: _mateState,
  mateProfile: _mateProfile,
  selectedProviderId,
}: {
  draft: HomeLaunchDraft;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
}): string {
  if (!draft.title.trim()) {
    return "タイトルを入力してね。";
  }
  if (!draft.workspace) {
    return "workspace を選んでね。";
  }
  if (!selectedProviderId) {
    return LAUNCH_NO_PROVIDER_SELECTED_MESSAGE;
  }
  return "";
}

export function buildCreateSessionRequestFromLaunchDraft({
  draft,
  mateProfile,
  selectedProviderId,
  characterEntries = [],
  sessions = [],
  openSessionCharacterIds = [],
  random = Math.random,
}: {
  draft: HomeLaunchDraft;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
  characterEntries?: readonly CharacterCatalogEntry[];
  sessions?: readonly CharacterUsageSessionSource[];
  openSessionCharacterIds?: readonly string[];
  random?: () => number;
}): CreateSessionRequest | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !selectedProviderId) {
    return null;
  }
  const characterSnapshot = buildLaunchCharacterSnapshot(
    characterEntries,
    draft,
    sessions,
    openSessionCharacterIds,
    random,
  );
  if (!characterSnapshot) {
    return null;
  }
  const workspace = isSessionFolderLaunchWorkspace(draft.workspace)
    ? { kind: "session-folder" as const }
    : {
        kind: "directory" as const,
        label: draft.workspace.label,
        path: draft.workspace.path,
        branch: draft.workspace.branch,
      };

  return {
    provider: selectedProviderId,
    taskTitle: normalizedTitle,
    workspace,
    characterId: characterSnapshot.characterId,
    character: characterSnapshot.character,
    characterIconPath: characterSnapshot.characterIconPath,
    characterThemeColors: characterSnapshot.characterThemeColors,
  };
}

export function resolveLaunchCharacterId(
  entries: readonly CharacterCatalogEntry[],
  currentCharacterId: string | null | undefined,
): string {
  if (currentCharacterId && entries.some(
    (entry) => entry.state === "active" && entry.id === currentCharacterId,
  )) {
    return currentCharacterId;
  }

  return "";
}

export { selectWeightedRandomLaunchCharacterId } from "../character/character-launch-selection.js";

function resolveLaunchCharacterEntry(
  entries: readonly CharacterCatalogEntry[],
  characterId: string | null | undefined,
): CharacterCatalogEntry | null {
  const resolvedCharacterId = resolveLaunchCharacterId(entries, characterId);
  return entries.find((entry) => entry.state === "active" && entry.id === resolvedCharacterId) ?? null;
}

function buildLaunchCharacterSnapshot(
  entries: readonly CharacterCatalogEntry[],
  draft: Pick<HomeLaunchDraft, "characterId" | "characterSelectionMode">,
  sessions: readonly CharacterUsageSessionSource[],
  openSessionCharacterIds: readonly string[],
  random: () => number,
): LaunchCharacterSnapshot | null {
  const characterId = draft.characterSelectionMode === "random"
    ? selectWeightedRandomLaunchCharacterId(entries, sessions, openSessionCharacterIds, random)
    : draft.characterId;
  const character = resolveLaunchCharacterEntry(entries, characterId);
  if (!character) {
    if (draft.characterSelectionMode === "specific") {
      return null;
    }
    return {
      characterId: NEUTRAL_CHARACTER_ID,
      character: NEUTRAL_CHARACTER_NAME,
      characterRoleMarkdown: "",
      characterIconPath: "",
      characterThemeColors: { ...DEFAULT_CHARACTER_THEME_COLORS },
    };
  }

  return {
    characterId: character.id,
    character: character.name,
    characterRoleMarkdown: character.description,
    characterIconPath: character.iconFilePath,
    characterThemeColors: {
      main: character.theme.main,
      sub: character.theme.sub,
    },
  };
}
