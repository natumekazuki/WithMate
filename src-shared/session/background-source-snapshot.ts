import type { Session } from "./session-state.js";
import type { SessionTurnRecord } from "./session-turn-state.js";
import type { SessionHistoryReadScope, SessionHistorySource } from "./session-history-read-scope.js";

export type BackgroundSourceRef = Omit<Extract<SessionHistorySource, { kind: "main" }>, "ownerIdentity">
  | Omit<Extract<SessionHistorySource, { kind: "auxiliary" }>, "ownerIdentity">;

/** Internal saved conversation source data for app-owned background application. */
export type BackgroundSourceSnapshot = {
  session: Pick<Session, "id" | "incarnationId" | "characterId" | "accessMode" | "sourceSchemaVersion" | "sessionKind">;
  ownerIdentity: string;
  turns: readonly (Pick<SessionTurnRecord, "id" | "phase" | "completedAt" | "assistantMessageSeq"> & {
    /** Saved owner columns are preserved: exactly one conversation owner is populated. */
    sessionId: string | null;
    auxiliarySessionId?: string;
  })[];
};

export type CapturedBackgroundSource = Readonly<{
  history: SessionHistoryReadScope;
  snapshot: BackgroundSourceSnapshot;
}>;
