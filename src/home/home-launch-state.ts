import { DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../approval-mode.js";
import type { CreateSessionInput, SessionSummary } from "../app-state.js";
import { DEFAULT_CHARACTER_THEME_COLORS, type CharacterThemeColors } from "../character-state.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import { DEFAULT_CODEX_SANDBOX_MODE, type CodexSandboxMode } from "../codex-sandbox-mode.js";
import type { CreateCompanionSessionInput } from "../companion-state.js";
import { inferWorkspaceFromPath, type LaunchWorkspace } from "./home-launch-projection.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_REASONING_EFFORT,
  type ModelCatalogProvider,
  type ModelReasoningEffort,
} from "../model-catalog.js";
import { LAUNCH_NO_PROVIDER_SELECTED_MESSAGE } from "../launch/launch-feedback.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";

const NEUTRAL_CHARACTER_ID = "withmate-neutral-character";
const NEUTRAL_CHARACTER_NAME = "WithMate";

type LaunchCharacterSnapshot = {
  characterId: string;
  character: string;
  characterRoleMarkdown: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
};

type LastUsedSessionSelectionSource = Pick<
  SessionSummary,
  "provider" | "model" | "reasoningEffort" | "customAgentName"
>;

type CharacterUsageSessionSource = Pick<SessionSummary, "characterId" | "sessionKind">;

export type LaunchCharacterSelectionMode = "specific" | "random";

export type HomeLaunchDraft = {
  open: boolean;
  mode: "session" | "companion";
  title: string;
  workspace: LaunchWorkspace | null;
  providerId: string;
  characterSelectionMode: LaunchCharacterSelectionMode;
  characterId: string;
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
    characterSelectionMode: "specific",
    characterId: "",
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
  defaultCharacterId = "",
): HomeLaunchDraft {
  return {
    ...draft,
    open: true,
    mode,
    title: "",
    workspace: null,
    providerId: defaultProviderId,
    characterSelectionMode: "specific",
    characterId: defaultCharacterId,
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
  characterEntries = [],
  sessions = [],
  random = Math.random,
}: {
  draft: HomeLaunchDraft;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
  lastUsedSelection?: Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null;
  characterEntries?: readonly CharacterCatalogEntry[];
  sessions?: readonly CharacterUsageSessionSource[];
  random?: () => number;
}): CreateCompanionSessionInput | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !selectedProviderId) {
    return null;
  }
  const characterSnapshot = buildLaunchCharacterSnapshot(characterEntries, draft, sessions, random);

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
    characterId: characterSnapshot.characterId,
    character: characterSnapshot.character,
    characterRoleMarkdown: characterSnapshot.characterRoleMarkdown,
    characterIconPath: characterSnapshot.characterIconPath,
    characterThemeColors: characterSnapshot.characterThemeColors,
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
    characterSelectionMode: "specific",
    characterId: "",
  };
}

export function setLaunchWorkspaceFromPath(draft: HomeLaunchDraft, selectedPath: string): HomeLaunchDraft {
  return {
    ...draft,
    workspace: inferWorkspaceFromPath(selectedPath),
  };
}

export function updateLaunchDraftForProviderSelection(
  draft: HomeLaunchDraft,
  providerId: string,
  enabledLaunchProviders: readonly ModelCatalogProvider[],
): HomeLaunchDraft {
  const provider = enabledLaunchProviders.find((candidate) => candidate.id === providerId) ?? null;
  const model =
    provider?.models.find((candidate) => candidate.id === provider.defaultModelId) ??
    provider?.models[0] ??
    null;

  return {
    ...draft,
    providerId,
    model: model?.id ?? draft.model,
    reasoningEffort: model?.reasoningEfforts[0] ?? provider?.defaultReasoningEffort ?? draft.reasoningEffort,
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
  characterEntries = [],
  sessions = [],
  random = Math.random,
}: {
  draft: HomeLaunchDraft;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
  approvalMode: ApprovalMode;
  lastUsedSelection?: Pick<CreateSessionInput, "model" | "reasoningEffort" | "customAgentName"> | null;
  characterEntries?: readonly CharacterCatalogEntry[];
  sessions?: readonly CharacterUsageSessionSource[];
  random?: () => number;
}): CreateSessionInput | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !selectedProviderId) {
    return null;
  }
  const characterSnapshot = buildLaunchCharacterSnapshot(characterEntries, draft, sessions, random);

  return {
    provider: selectedProviderId,
    taskTitle: normalizedTitle,
    workspaceLabel: draft.workspace.label,
    workspacePath: draft.workspace.path,
    branch: draft.workspace.branch,
    characterId: characterSnapshot.characterId,
    character: characterSnapshot.character,
    characterIconPath: characterSnapshot.characterIconPath,
    characterThemeColors: characterSnapshot.characterThemeColors,
    approvalMode,
    model: lastUsedSelection?.model,
    reasoningEffort: lastUsedSelection?.reasoningEffort,
    customAgentName: lastUsedSelection?.customAgentName,
  };
}

export function resolveLaunchCharacterId(
  entries: readonly CharacterCatalogEntry[],
  currentCharacterId: string | null | undefined,
): string {
  const activeEntries = entries.filter((entry) => entry.state === "active");
  if (currentCharacterId && activeEntries.some((entry) => entry.id === currentCharacterId)) {
    return currentCharacterId;
  }

  return activeEntries[0]?.id ?? "";
}

export function selectWeightedRandomLaunchCharacterId(
  entries: readonly CharacterCatalogEntry[],
  sessionsByLastActiveDesc: readonly CharacterUsageSessionSource[],
  random: () => number = Math.random,
): string {
  const activeEntries = entries.filter((entry) => entry.state === "active");
  if (activeEntries.length === 0) {
    return "";
  }

  const activeCharacterIds = new Set(activeEntries.map((entry) => entry.id));
  const recencyRanks = new Map<string, number>();
  for (const session of sessionsByLastActiveDesc) {
    if (
      session.sessionKind !== "default" ||
      !activeCharacterIds.has(session.characterId) ||
      recencyRanks.has(session.characterId)
    ) {
      continue;
    }
    recencyRanks.set(session.characterId, recencyRanks.size);
  }

  const weightedEntries = activeEntries.map((entry) => ({
    entry,
    weight: (recencyRanks.get(entry.id) ?? recencyRanks.size) + 1,
  }));
  const totalWeight = weightedEntries.reduce((total, candidate) => total + candidate.weight, 0);
  const randomValue = random();
  const normalizedRandomValue = Number.isFinite(randomValue)
    ? Math.min(Math.max(randomValue, 0), 1 - Number.EPSILON)
    : 0;
  let remainingWeight = normalizedRandomValue * totalWeight;

  for (const candidate of weightedEntries) {
    remainingWeight -= candidate.weight;
    if (remainingWeight < 0) {
      return candidate.entry.id;
    }
  }

  return weightedEntries.at(-1)?.entry.id ?? "";
}

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
  random: () => number,
): LaunchCharacterSnapshot {
  const characterId = draft.characterSelectionMode === "random"
    ? selectWeightedRandomLaunchCharacterId(entries, sessions, random)
    : draft.characterId;
  const character = resolveLaunchCharacterEntry(entries, characterId);
  if (!character) {
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
