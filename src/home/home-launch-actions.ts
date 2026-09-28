import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { MateProfile, MateStorageState } from "../../src-shared/mate/mate-state.js";
import type { CreateSessionRequest, HomeSessionSummary, Session, SessionCharacterUsage, SessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { OpenSessionWindowIdsLoadStatus } from "../app/open-session-window-subscription.js";
import { projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import {
  buildCreateSessionRequestFromLaunchDraft,
  resolveLaunchValidationMessage,
  type HomeLaunchDraft,
} from "./home-launch-state.js";

export type HomeLaunchSessionCreator = (input: CreateSessionRequest) => Promise<Session | SessionSummary | null>;
export type HomeLaunchFeedbackSource = "launch" | "readiness";
export type HomeLaunchResult = { title: string; message: string };

export function resolveRandomHomeLaunchFeedback(
  characterUsageStatus: SessionSummariesLoadStatus,
  openSessionsStatus: OpenSessionWindowIdsLoadStatus,
): string {
  if (characterUsageStatus !== "loaded") {
    return characterUsageStatus === "loading"
      ? "Session history is not ready yet. Try again when it finishes."
      : "Session history is unavailable, so random selection cannot start.";
  }
  if (openSessionsStatus !== "loaded") {
    return openSessionsStatus === "loading"
      ? "Open session windows are not ready yet. Try again when the check finishes."
      : "Open session windows are unavailable, so random selection cannot start.";
  }
  return "";
}


export type StartHomeLaunchInput = {
  draft: HomeLaunchDraft;
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
  openSessionWindow: (sessionId: string) => Promise<void>;
  closeLaunchDialog: () => void;
  setLaunchFeedback: (message: string, source?: HomeLaunchFeedbackSource) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  isCurrentAttempt: () => boolean;
  onDetachedResult: (result: HomeLaunchResult) => void;
  upsertSessionSummary: (summary: HomeSessionSummary) => void;
  random?: () => number;
};

export async function startHomeLaunch(input: StartHomeLaunchInput): Promise<void> {
  if (input.launchStarting) {
    return;
  }

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

  const readinessFeedback = input.draft.characterSelectionMode === "random"
    ? resolveRandomHomeLaunchFeedback(input.sessionCharacterUsageLoadStatus, input.openSessionWindowIdsLoadStatus)
    : "";
  if (readinessFeedback) {
    input.setLaunchFeedback(readinessFeedback, "readiness");
    return;
  }

  input.setLaunchFeedback("");
  input.setLaunchStarting(true);

  let createdSessionId: string | null = null;
  const reportFailure = (message: string) => {
    if (input.isCurrentAttempt()) {
      input.setLaunchFeedback(message);
    } else {
      input.onDetachedResult({ title: input.draft.title, message });
    }
  };

  try {
    const openSessionWindowIdSet = new Set(input.openSessionWindowIds);
    const openSessionCharacterIds = input.sessions
      .filter((session) => openSessionWindowIdSet.has(session.id))
      .map((session) => session.characterId);

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
      input.setLaunchFeedback("Session requirements are incomplete.");
      return;
    }

    const createdSession = await input.createSession(sessionInput);
    if (!createdSession) {
      reportFailure("Could not confirm session creation. Check Recent Sessions before trying again.");
      return;
    }

    createdSessionId = createdSession.id;
    input.upsertSessionSummary(projectHomeSessionSummary(createdSession));
    if (!input.isCurrentAttempt()) {
      input.onDetachedResult({
        title: input.draft.title,
        message: "Session created. Open it from Recent Sessions.",
      });
      return;
    }
    input.closeLaunchDialog();
    await input.openSessionWindow(createdSession.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Could not start session.";
    reportFailure(createdSessionId
      ? `Session created, but its window could not be opened. Open it from Recent Sessions. ${detail}`
      : `Could not confirm session creation. Check Recent Sessions before trying again. ${detail}`);
  } finally {
    if (input.isCurrentAttempt()) {
      input.setLaunchStarting(false);
    }
  }
}
