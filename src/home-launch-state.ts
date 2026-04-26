import type { ApprovalMode } from "./approval-mode.js";
import type { CharacterProfile, CreateSessionInput, SessionSummary } from "./app-state.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { CreateCompanionSessionInput } from "./companion-state.js";
import { inferWorkspaceFromPath, type LaunchWorkspace } from "./home-launch-projection.js";

type LastUsedSessionSelectionSource = Pick<
  SessionSummary,
  "provider" | "model" | "reasoningEffort" | "customAgentName"
>;

export type HomeLaunchDraft = {
  open: boolean;
  mode: "agent" | "companion";
  title: string;
  workspace: LaunchWorkspace | null;
  providerId: string;
  characterId: string;
  characterSearchText: string;
};

export function createClosedLaunchDraft(characterId = ""): HomeLaunchDraft {
  return {
    open: false,
    mode: "agent",
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
    mode: "agent",
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
    mode: "agent",
    title: "",
    workspace: null,
    providerId: "",
    characterSearchText: "",
  };
}

export function buildCreateCompanionSessionInputFromLaunchDraft({
  draft,
  selectedCharacter,
  selectedProviderId,
  approvalMode,
  codexSandboxMode,
  lastUsedSelection,
}: {
  draft: HomeLaunchDraft;
  selectedCharacter: CharacterProfile | null;
  selectedProviderId: string | null;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  lastUsedSelection?: Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null;
}): CreateCompanionSessionInput | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !selectedCharacter || !selectedProviderId) {
    return null;
  }

  return {
    provider: selectedProviderId,
    taskTitle: normalizedTitle,
    workspacePath: draft.workspace.path,
    characterId: selectedCharacter.id,
    character: selectedCharacter.name,
    characterRoleMarkdown: selectedCharacter.roleMarkdown,
    characterIconPath: selectedCharacter.iconPath,
    characterThemeColors: selectedCharacter.themeColors,
    approvalMode,
    codexSandboxMode,
    model: lastUsedSelection?.model,
    reasoningEffort: lastUsedSelection?.reasoningEffort,
    customAgentName: lastUsedSelection?.customAgentName,
  };
}

export function setLaunchWorkspaceFromPath(draft: HomeLaunchDraft, selectedPath: string): HomeLaunchDraft {
  return {
    ...draft,
    workspace: inferWorkspaceFromPath(selectedPath),
  };
}

export function resolveLastUsedSessionSelection(
  sessions: readonly LastUsedSessionSelectionSource[],
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
