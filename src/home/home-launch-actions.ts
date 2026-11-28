import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type {
  MateProfile,
  MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import type {
  CreateSessionRequest,
  HomeSessionSummary,
  Session,
  SessionCharacterUsage,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { OpenSessionWindowIdsLoadStatus } from "../app/open-session-window-subscription.js";
import { projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import {
  buildCreateSessionRequestFromLaunchDraft,
  resolveLaunchValidationMessage,
  type HomeLaunchDraft,
} from "./home-launch-state.js";

/** 作成を要求し、確認できた保存済み Session または要約を返す。結果未確認の場合は null。 */
export type HomeLaunchSessionCreator = (
  input: CreateSessionRequest,
) => Promise<Session | SessionSummary | null>;
/** 通常の起動通知、前提データの準備状態、作成結果に関する失敗を区別する。 */
export type HomeLaunchFeedbackSource =
  "launch" | "readiness" | "creation-error";
/** 元の起動画面を離れていても、どの要求の結果かを示せるタイトルと案内。 */
export type HomeLaunchResult = { title: string; message: string };
/** 結果不明からの同じ試行の再実行に使う、ID を含む確定済みの作成入力。 */
export type HomeLaunchCreationAttempt = { request?: CreateSessionRequest };

/** ランダム選択に必要な利用履歴とウィンドウ一覧が揃ったか調べ、未準備と取得失敗を区別する。 */
export function resolveRandomHomeLaunchReadiness(
  characterUsageStatus: SessionSummariesLoadStatus,
  openSessionsStatus: OpenSessionWindowIdsLoadStatus,
): { kind: "loading" | "error"; message: string } | null {
  if (characterUsageStatus !== "loaded") {
    return characterUsageStatus === "loading"
      ? {
          kind: "loading",
          message: "Loading session history for random character selection",
        }
      : {
          kind: "error",
          message:
            "Session history is unavailable, so random selection cannot start.",
        };
  }
  if (openSessionsStatus !== "loaded") {
    return openSessionsStatus === "loading"
      ? {
          kind: "loading",
          message:
            "Loading open session windows for random character selection",
        }
      : {
          kind: "error",
          message:
            "Open session windows are unavailable, so random selection cannot start.",
        };
  }
  return null;
}

/** 起動時の下書きと Character 選択材料、作成 API、および現在の試行に結果を返す操作。 */
export type StartHomeLaunchInput = {
  creationAttempt?: HomeLaunchCreationAttempt;
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
  setLaunchFeedback: (
    message: string,
    source?: HomeLaunchFeedbackSource,
  ) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  isCurrentAttempt: () => boolean;
  onDetachedResult: (result: HomeLaunchResult) => void;
  upsertSessionSummary: (summary: HomeSessionSummary) => void;
  random?: () => number;
};

/** 起動条件を検査し、同じ試行の作成入力を再利用する。確認済みの作成と Window 表示は別の結果として扱う。 */
export async function startHomeLaunch(
  input: StartHomeLaunchInput,
): Promise<void> {
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

  const readiness =
    input.draft.characterSelectionMode === "random"
      ? resolveRandomHomeLaunchReadiness(
          input.sessionCharacterUsageLoadStatus,
          input.openSessionWindowIdsLoadStatus,
        )
      : null;
  if (readiness) {
    input.setLaunchFeedback(readiness.message, "readiness");
    return;
  }

  input.setLaunchFeedback("");
  input.setLaunchStarting(true);

  let createdSessionId: string | null = null;
  /** 試行が現行なら起動欄に表示し、画面を離れていた場合は元のタイトル付きで別に通知する。 */
  const reportFailure = (message: string) => {
    if (input.isCurrentAttempt()) {
      input.setLaunchFeedback(message, "creation-error");
    } else {
      input.onDetachedResult({ title: input.draft.title, message });
    }
  };

  try {
    const openSessionWindowIdSet = new Set(input.openSessionWindowIds);
    const openSessionCharacterIds = input.sessions
      .filter((session) => openSessionWindowIdSet.has(session.id))
      .map((session) => session.characterId);

    const sessionInput =
      input.creationAttempt?.request ??
      buildCreateSessionRequestFromLaunchDraft({
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

    sessionInput.clientRequestId ??= crypto.randomUUID();
    if (input.creationAttempt) input.creationAttempt.request = sessionInput;

    const createdSession = await input.createSession(sessionInput);
    if (!createdSession) {
      reportFailure(
        "Could not confirm session creation. Check Recent Sessions before trying again.",
      );
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
    const detail =
      error instanceof Error ? error.message : "Could not start session.";
    reportFailure(
      createdSessionId
        ? `Session created, but its window could not be opened. Open it from Recent Sessions. ${detail}`
        : `Could not confirm session creation. Check Recent Sessions before trying again. ${detail}`,
    );
  } finally {
    if (input.isCurrentAttempt()) {
      input.setLaunchStarting(false);
    }
  }
}
