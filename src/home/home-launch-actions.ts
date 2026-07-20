import { DEFAULT_APPROVAL_MODE } from "../approval-mode.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import type { CompanionSession, CompanionSessionSummary, CreateCompanionSessionInput } from "../companion-state.js";
import { createCompanionSessionSummary } from "../companion-state.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type { CreateSessionInput, SessionSummary } from "../session-state.js";
import type { SessionSummariesLoadStatus } from "../session-summary-subscription.js";
import { projectSessionSummary } from "../session-state.js";
import {
  buildCreateCompanionSessionInputFromLaunchDraft,
  buildCreateSessionInputFromLaunchDraft,
  resolveLastUsedSessionSelection,
  resolveLaunchValidationMessage,
  type HomeLaunchDraft,
} from "./home-launch-state.js";

export type HomeLaunchSessionCreator = (input: CreateSessionInput) => Promise<SessionSummary | null>;

export type HomeLaunchCompanionSessionCreator = (input: CreateCompanionSessionInput) => Promise<CompanionSession | null>;

export type StartHomeLaunchInput = {
  draft: HomeLaunchDraft;
  requestedMode?: HomeLaunchDraft["mode"];
  launchStarting: boolean;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  characterEntries: readonly CharacterCatalogEntry[];
  selectedProviderId: string | null;
  sessions: readonly SessionSummary[];
  sessionSummariesLoadStatus: SessionSummariesLoadStatus;
  createSession: HomeLaunchSessionCreator;
  createCompanionSession: HomeLaunchCompanionSessionCreator;
  openSessionWindow: (sessionId: string) => Promise<void>;
  openCompanionReviewWindow: (sessionId: string) => Promise<void>;
  closeLaunchDialog: () => void;
  setLaunchFeedback: (message: string) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  upsertSessionSummary: (summary: SessionSummary) => void;
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

  if (input.draft.characterSelectionMode === "random" && input.sessionSummariesLoadStatus !== "loaded") {
    input.setLaunchFeedback(
      input.sessionSummariesLoadStatus === "loading"
        ? "Session 履歴を読み込んでるよ。完了してからもう一度開始してね。"
        : "Session 履歴を読み込めていないため、ランダム選択を開始できないよ。",
    );
    return;
  }

  input.setLaunchFeedback(requestedMode === "companion" ? "Companion を開始してるよ..." : "Session を開始してるよ...");
  input.setLaunchStarting(true);

  const lastUsedSelection = resolveLastUsedSessionSelection(input.sessions, input.selectedProviderId);
  try {
    if (requestedMode === "companion") {
      const companionInput = buildCreateCompanionSessionInputFromLaunchDraft({
        draft: input.draft,
        mateProfile: input.mateProfile,
        selectedProviderId: input.selectedProviderId,
        characterEntries: input.characterEntries,
        sessions: input.sessions,
        random: input.random,
        lastUsedSelection,
      });
      if (!companionInput) {
        input.setLaunchFeedback("Companion の開始条件が揃ってないよ。");
        return;
      }

      const createdSession = await input.createCompanionSession(companionInput);
      if (!createdSession) {
        input.setLaunchFeedback("Companion を開始できなかったよ。");
        return;
      }

      input.upsertCompanionSessionSummary(createCompanionSessionSummary(createdSession));
      input.closeLaunchDialog();
      await input.openCompanionReviewWindow(createdSession.id);
      return;
    }

    const sessionInput = buildCreateSessionInputFromLaunchDraft({
      draft: input.draft,
      mateProfile: input.mateProfile,
      selectedProviderId: input.selectedProviderId,
      approvalMode: DEFAULT_APPROVAL_MODE,
      characterEntries: input.characterEntries,
      sessions: input.sessions,
      random: input.random,
      lastUsedSelection,
    });
    if (!sessionInput) {
      input.setLaunchFeedback("Session の開始条件が揃ってないよ。");
      return;
    }

    const createdSession = await input.createSession(sessionInput);
    if (!createdSession) {
      input.setLaunchFeedback("Session を開始できなかったよ。");
      return;
    }

    input.upsertSessionSummary(projectSessionSummary(createdSession));
    input.closeLaunchDialog();
    await input.openSessionWindow(createdSession.id);
  } catch (error) {
    input.setLaunchFeedback(error instanceof Error ? error.message : "開始に失敗したよ。");
  } finally {
    input.setLaunchStarting(false);
  }
}
