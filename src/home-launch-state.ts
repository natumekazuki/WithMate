import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "./approval-mode.js";
import type { CharacterProfile, CreateSessionInput, SessionSummary } from "./app-state.js";
import { DEFAULT_CODEX_SANDBOX_MODE, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { CreateCompanionSessionInput } from "./companion-state.js";
import { inferWorkspaceFromPath, type LaunchWorkspace } from "./home-launch-projection.js";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT, type ModelReasoningEffort } from "./model-catalog.js";

type LastUsedSessionSelectionSource = Pick<
  SessionSummary,
  "provider" | "model" | "reasoningEffort" | "customAgentName"
>;

export type HomeLaunchDraft = {
  open: boolean;
  mode: "session" | "companion";
  title: string;
  workspace: LaunchWorkspace | null;
  providerId: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  characterId: string;
  characterSearchText: string;
};

export function createClosedLaunchDraft(characterId = ""): HomeLaunchDraft {
  return {
    open: false,
    mode: "session",
    title: "",
    workspace: null,
    providerId: "",
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
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
    workspace: null,
    providerId: defaultProviderId,
    model: DEFAULT_MODEL_ID,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    approvalMode: draft.approvalMode,
    codexSandboxMode: draft.codexSandboxMode,
    characterSearchText: "",
  };
}

export function buildCreateCompanionSessionInputFromLaunchDraft({
  draft,
  selectedCharacter,
  selectedProviderId,
  lastUsedSelection,
}: {
  draft: HomeLaunchDraft;
  selectedCharacter: CharacterProfile | null;
  selectedProviderId: string | null;
  lastUsedSelection?: Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null;
}): CreateCompanionSessionInput | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !selectedCharacter || !selectedProviderId) {
    return null;
  }

  return {
    taskTitle: normalizedTitle,
    workspacePath: draft.workspace.path,
    provider: selectedProviderId,
    characterId: selectedCharacter.id,
    character: selectedCharacter.name,
    characterRoleMarkdown: selectedCharacter.roleMarkdown,
    characterIconPath: selectedCharacter.iconPath,
    characterThemeColors: selectedCharacter.themeColors,
    approvalMode: draft.approvalMode,
    codexSandboxMode: draft.codexSandboxMode,
    model: draft.model || lastUsedSelection?.model,
    reasoningEffort: draft.reasoningEffort || lastUsedSelection?.reasoningEffort,
    customAgentName: lastUsedSelection?.customAgentName,
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
