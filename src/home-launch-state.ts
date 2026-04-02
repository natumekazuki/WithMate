import type { ApprovalMode } from "./approval-mode.js";
import type { CharacterProfile, CreateSessionInput, Session } from "./app-state.js";
import { inferWorkspaceFromPath, type LaunchWorkspace } from "./home-launch-projection.js";

export type HomeLaunchDraft = {
  open: boolean;
  title: string;
  workspace: LaunchWorkspace | null;
  providerId: string;
  characterId: string;
  characterSearchText: string;
};

export function createClosedLaunchDraft(characterId = ""): HomeLaunchDraft {
  return {
    open: false,
    title: "",
    workspace: null,
    providerId: "",
    characterId,
    characterSearchText: "",
  };
}

export function syncLaunchDraftCharacter(
  draft: HomeLaunchDraft,
  characters: readonly CharacterProfile[],
): HomeLaunchDraft {
  if (characters.some((character) => character.id === draft.characterId)) {
    return draft;
  }

  return {
    ...draft,
    characterId: characters[0]?.id ?? "",
  };
}

export function openLaunchDraft(draft: HomeLaunchDraft, defaultProviderId: string): HomeLaunchDraft {
  return {
    ...draft,
    open: true,
    title: "",
    workspace: null,
    providerId: defaultProviderId,
    characterSearchText: "",
  };
}

export function closeLaunchDraft(draft: HomeLaunchDraft): HomeLaunchDraft {
  return {
    ...draft,
    open: false,
    title: "",
    workspace: null,
    providerId: "",
    characterSearchText: "",
  };
}

export function setLaunchWorkspaceFromPath(draft: HomeLaunchDraft, selectedPath: string): HomeLaunchDraft {
  return {
    ...draft,
    workspace: inferWorkspaceFromPath(selectedPath),
  };
}

export function resolveLastUsedSessionSelection(
  sessions: readonly Session[],
  providerId: string | null,
): Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null {
  const normalizedProviderId = providerId?.trim();
  if (!normalizedProviderId) {
    return null;
  }

  const matchedSession = sessions.find((session) => session.provider === normalizedProviderId) ?? null;
  if (!matchedSession) {
    return null;
  }

  return {
    model: matchedSession.model,
    reasoningEffort: matchedSession.reasoningEffort,
    customAgentName: matchedSession.customAgentName,
  };
}

export function buildCreateSessionInputFromLaunchDraft({
  draft,
  selectedCharacter,
  selectedProviderId,
  approvalMode,
  lastUsedSelection,
}: {
  draft: HomeLaunchDraft;
  selectedCharacter: CharacterProfile | null;
  selectedProviderId: string | null;
  approvalMode: ApprovalMode;
  lastUsedSelection?: Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null;
}): CreateSessionInput | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !selectedCharacter || !selectedProviderId) {
    return null;
  }

  return {
    provider: selectedProviderId,
    taskTitle: normalizedTitle,
    workspaceLabel: draft.workspace.label,
    workspacePath: draft.workspace.path,
    branch: draft.workspace.branch,
    characterId: selectedCharacter.id,
    character: selectedCharacter.name,
    characterIconPath: selectedCharacter.iconPath,
    characterThemeColors: selectedCharacter.themeColors,
    approvalMode,
    model: lastUsedSelection?.model,
    reasoningEffort: lastUsedSelection?.reasoningEffort,
    customAgentName: lastUsedSelection?.customAgentName,
  };
}
