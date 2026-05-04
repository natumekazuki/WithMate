import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "./approval-mode.js";
import type { CreateSessionInput, SessionSummary } from "./app-state.js";
import type { CharacterThemeColors } from "./character-state.js";
import { DEFAULT_CODEX_SANDBOX_MODE, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { CreateCompanionSessionInput } from "./companion-state.js";
import { inferWorkspaceFromPath, type LaunchWorkspace } from "./home-launch-projection.js";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT, type ModelReasoningEffort } from "./model-catalog.js";
import type { MateProfile } from "./mate-state.js";

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
};

export function createClosedLaunchDraft(): HomeLaunchDraft {
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
  };
}

export function buildCreateCompanionSessionInputFromLaunchDraft({
  draft,
  mateProfile,
  selectedProviderId,
  lastUsedSelection,
}: {
  draft: HomeLaunchDraft;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
  lastUsedSelection?: Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null;
}): CreateCompanionSessionInput | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !mateProfile || !selectedProviderId) {
    return null;
  }

  const companionModel = draft.mode === "companion"
    ? lastUsedSelection?.model ?? draft.model
    : draft.model || lastUsedSelection?.model;
  const companionReasoningEffort = draft.mode === "companion"
    ? lastUsedSelection?.reasoningEffort ?? draft.reasoningEffort
    : draft.reasoningEffort || lastUsedSelection?.reasoningEffort;

  return {
    taskTitle: normalizedTitle,
    workspacePath: draft.workspace.path,
    provider: selectedProviderId,
    characterId: mateProfile.id,
    character: mateProfile.displayName,
    characterRoleMarkdown: mateProfile.description ?? "",
    characterIconPath: mateProfile.avatarFilePath,
    characterThemeColors: buildCharacterThemeColorsFromMateProfile(mateProfile),
    approvalMode: draft.approvalMode,
    codexSandboxMode: draft.codexSandboxMode,
    model: companionModel,
    reasoningEffort: companionReasoningEffort,
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
  mateProfile,
  selectedProviderId,
  approvalMode,
  lastUsedSelection,
}: {
  draft: HomeLaunchDraft;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
  approvalMode: ApprovalMode;
  lastUsedSelection?: Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null;
}): CreateSessionInput | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !mateProfile || !selectedProviderId) {
    return null;
  }

  return {
    provider: selectedProviderId,
    taskTitle: normalizedTitle,
    workspaceLabel: draft.workspace.label,
    workspacePath: draft.workspace.path,
    branch: draft.workspace.branch,
    characterId: mateProfile.id,
    character: mateProfile.displayName,
    characterIconPath: mateProfile.avatarFilePath,
    characterThemeColors: buildCharacterThemeColorsFromMateProfile(mateProfile),
    approvalMode,
    model: lastUsedSelection?.model,
    reasoningEffort: lastUsedSelection?.reasoningEffort,
    customAgentName: lastUsedSelection?.customAgentName,
  };
}

function buildCharacterThemeColorsFromMateProfile(
  mateProfile: Pick<MateProfile, "themeMain" | "themeSub">,
): CharacterThemeColors {
  return {
    main: mateProfile.themeMain || "#000000",
    sub: mateProfile.themeSub || "#ffffff",
  };
}
