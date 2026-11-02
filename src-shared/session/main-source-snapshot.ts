import type { Session } from "./session-state.js";
import type { SessionTurnRecord } from "./session-turn-state.js";

/** Internal saved Main source data for app-owned background application. */
export type MainSourceSnapshot = {
  session: Pick<Session, "id" | "incarnationId" | "characterId" | "accessMode" | "sourceSchemaVersion" | "sessionKind">;
  ownerIdentity: string;
  turns: readonly Pick<SessionTurnRecord, "id" | "sessionId" | "phase" | "completedAt" | "assistantMessageSeq">[];
};
