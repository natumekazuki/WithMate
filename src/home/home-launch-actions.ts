import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import type { CompanionSession, CompanionSessionSummary, CreateCompanionSessionInput } from "../companion-state.js";
import { createCompanionSessionSummary } from "../companion-state.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type {
  CreateSessionRequest,
  HomeSessionSummary,
  Session,
  SessionCharacterUsage,
  SessionSummary,
} from "../session-state.js";
import type { SessionSummariesLoadStatus } from "../session-summary-subscription.js";
import type { OpenSessionWindowIdsLoadStatus } from "../open-session-window-subscription.js";
import { projectHomeSessionSummary } from "../session-state.js";
import {
  buildCreateCompanionSessionInputFromLaunchDraft,
  buildCreateSessionRequestFromLaunchDraft,
  resolveLaunchValidationMessage,
  type HomeLaunchDraft,
} from "./home-launch-state.js";

export type HomeLaunchSessionCreator = (input: CreateSessionRequest) => Promise<Session | SessionSummary | null>;

export type HomeLaunchCompanionSessionCreator = (input: CreateCompanionSessionInput) => Promise<CompanionSession | null>;

export type StartHomeLaunchInput = {
  draft: HomeLaunchDraft;
  requestedMode?: HomeLaunchDraft["mode"];
  launchStarting: boolean;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  characterEntries: readonly CharacterCatalogEntry[];
  selectedProviderId: string | null;
  sessions: readonly HomeSessionSummary[];
  sessionCharacterUsage: readonly SessionCharacterUsage[];
  openSessionWindowIds: readonly string[];
  openSessionWindowIdsLoadStatus: OpenSessionWindowIdsLoadStatus;
  sessionCharacterUsageLoadStatus: SessionSummariesLoadStatus;
  createSession: HomeLaunchSessionCreator;
  createCompanionSession: HomeLaunchCompanionSessionCreator;
  openSessionWindow: (sessionId: string) => Promise<void>;
  openCompanionReviewWindow: (sessionId: string) => Promise<void>;
  closeLaunchDialog: () => void;
  setLaunchFeedback: (message: string) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  upsertSessionSummary: (summary: HomeSessionSummary) => void;
  upsertCompanionSessionSummary: (summary: CompanionSessionSummary) => void;
  random?: () => number;
};

export async function startHomeLaunch(input: StartHomeLaunchInput): Promise<void> {
  if (input.launchStarting) {
    return;
  }

  const requestedMode = input.requestedMode ?? input.draft.mode;
  const validationMessage = resolveLaunchValidationMessage({
    draft: input.draft,
    mateState: input.mateState,
    mateProfile: input.mateProfile,
    selectedProviderId: input.selectedProviderId,
  });
  if (validationMessage) {
    input.setLaunchFeedback(validationMessage);
    return;
  }

  if (input.draft.characterSelectionMode === "random" && input.sessionCharacterUsageLoadStatus !== "loaded") {
    input.setLaunchFeedback(
      input.sessionCharacterUsageLoadStatus === "loading"
        ? "Loading Session history. Try again when loading is complete."
        : "Random selection is unavailable because Session history could not be loaded.",
    );
    return;
  }

  if (input.draft.characterSelectionMode === "random" && input.openSessionWindowIdsLoadStatus !== "loaded") {
    input.setLaunchFeedback(
      input.openSessionWindowIdsLoadStatus === "loading"
        ? "Checking open Session windows. Try again when loading is complete."
        : "Random selection is unavailable because open Session windows could not be checked.",
    );
    return;
  }

  input.setLaunchFeedback(requestedMode === "companion" ? "Starting Companion..." : "Starting Session...");
  input.setLaunchStarting(true);

  try {
    const openSessionWindowIdSet = new Set(input.openSessionWindowIds);
    const openSessionCharacterIds = input.sessions
      .filter((session) => openSessionWindowIdSet.has(session.id))
      .map((session) => session.characterId);

    if (requestedMode === "companion") {
      const companionInput = buildCreateCompanionSessionInputFromLaunchDraft({
        draft: input.draft,
        mateProfile: input.mateProfile,
        selectedProviderId: input.selectedProviderId,
        characterEntries: input.characterEntries,
        sessions: input.sessionCharacterUsage,
        openSessionCharacterIds,
        random: input.random,
      });
      if (!companionInput) {
        input.setLaunchFeedback("Companion requirements are not satisfied.");
        return;
      }

      const createdSession = await input.createCompanionSession(companionInput);
      if (!createdSession) {
        input.setLaunchFeedback("Failed to start Companion.");
        return;
      }

      input.upsertCompanionSessionSummary(createCompanionSessionSummary(createdSession));
      input.closeLaunchDialog();
      await input.openCompanionReviewWindow(createdSession.id);
      return;
    }

    const sessionInput = buildCreateSessionRequestFromLaunchDraft({
      draft: input.draft,
      mateProfile: input.mateProfile,
      selectedProviderId: input.selectedProviderId,
      characterEntries: input.characterEntries,
      sessions: input.sessionCharacterUsage,
      openSessionCharacterIds,
      random: input.random,
    });
    if (!sessionInput) {
      input.setLaunchFeedback("Session requirements are not satisfied.");
      return;
    }

    const createdSession = await input.createSession(sessionInput);
    if (!createdSession) {
      input.setLaunchFeedback("Failed to start Session.");
      return;
    }

    input.upsertSessionSummary(projectHomeSessionSummary(createdSession));
    input.closeLaunchDialog();
    await input.openSessionWindow(createdSession.id);
  } catch (error) {
    input.setLaunchFeedback(error instanceof Error ? error.message : "Failed to start.");
  } finally {
    input.setLaunchStarting(false);
  }
}
