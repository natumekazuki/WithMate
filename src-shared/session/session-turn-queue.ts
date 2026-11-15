import type { ComposerAttachment, RunSessionTurnRequest } from "./runtime-state.js";
import type { Session } from "./session-state.js";
import { LOCAL_USER_ID, type ConversationParticipant } from "../character/character-participant.js";
import { isUnknownCharacterOwnerId, NEUTRAL_CHARACTER_ID } from "../character/character-owner.js";

export type SessionTurnQueueOwner = { sessionId: string; incarnationId: string };
export type SessionMessageDeliveryTiming = "immediate" | "after_source_turn";
export type SessionMessageSourceTurnPhase = "running" | "completed" | "failed" | "canceled" | "unknown";
export type SessionTurnQueueDisplaySnapshot = {
  sessionTitle: string;
  character: { id: string; name: string; iconPath: string; description?: string };
};
export function captureSessionTurnQueueDisplay(session: Session): SessionTurnQueueDisplaySnapshot {
  return { sessionTitle: session.taskTitle, character: {
    id: session.characterId, name: session.characterRuntimeSnapshot?.name ?? session.character,
    description: session.characterRuntimeSnapshot?.description ?? "",
    iconPath: session.characterIconPath || session.characterRuntimeSnapshot?.iconFilePath || "",
  } };
}
export type SessionTurnQueueOrigin = {
  kind: "gui" | "session";
  actorSessionId?: string;
  actorKind?: "main" | "auxiliary";
  actorIncarnationId?: string;
  actorTurnId?: string;
  deliveryTiming?: SessionMessageDeliveryTiming;
  requestedExecutionOptions?: import("./session-execution-options.js").SessionMessageExecutionOptions;
  sourceTurnPhase?: Exclude<SessionMessageSourceTurnPhase, "running" | "unknown">;
  actorMainSessionId?: string;
  actorSnapshot?: SessionTurnQueueDisplaySnapshot;
  operation: "send";
  targetSessionId: string;
  targetIncarnationId: string;
  targetSnapshot?: SessionTurnQueueDisplaySnapshot;
};
export type SessionTurnQueueCapturedInput = {
  coordination?: { id: string; operation: string; actor: import("../coordination/coordination-contract.js").CoordinationActor; answerId?: string; answerRevision?: number; notification?: import("../coordination/coordination-delivery.js").CoordinationNotification };
  request: RunSessionTurnRequest & { clientRequestId: string };
  attachments: ComposerAttachment[];
  provider: string;
  workspacePath: string;
  origin?: SessionTurnQueueOrigin;
};

export type SessionSteerOrigin = Pick<SessionTurnQueueOrigin, "actorSnapshot" | "targetSessionId" | "targetIncarnationId" | "targetSnapshot"> & {
  kind: "session";
  actorKind: "main";
  actorSessionId: string;
  actorIncarnationId: string;
  actorTurnId: string;
  operation: "steer";
};

export type SessionSteerResult = {
  outcome: "applied" | "not-applied" | "unknown";
  turnId: string;
  messageSeq: number | null;
  reason?: string;
};

/** Attribution is supplied by the application, not by claims inside the message body. */
export function projectSessionInputSender(origin: SessionTurnQueueOrigin | SessionSteerOrigin | null | undefined): {
  kind: "user" | "agent" | "unknown";
  participant: ConversationParticipant | null;
  session?: { id: string; incarnationId?: string; kind?: "main" | "auxiliary" };
  character?: { id: string; name: string; description?: string };
} {
  if (!origin) return { kind: "unknown", participant: null };
  if (origin.kind === "gui") return { kind: "user", participant: { type: "user", id: LOCAL_USER_ID } };
  const character = origin.actorSnapshot?.character;
  const known = character?.id && !isUnknownCharacterOwnerId(character.id) && character.id !== NEUTRAL_CHARACTER_ID;
  return { kind: "agent", participant: known ? { type: "character", id: character.id } : null,
    ...(origin.actorSessionId ? { session: { id: origin.actorSessionId, incarnationId: origin.actorIncarnationId, kind: origin.actorKind } } : {}),
    ...(known ? { character: { id: character.id, name: character.name,
      ...(character.description === undefined ? {} : { description: character.description }) } } : {}),
  };
}
export type SessionTurnQueueState = "queued" | "starting" | "running" | "completed" | "failed" | "canceled" | "interrupted";
export type SessionTurnQueueReceipt = SessionTurnQueueOwner & {
  id: string;
  requestId: string;
  sequence: number;
  queuePosition: number;
  state: SessionTurnQueueState;
  sourceTurnPhase?: SessionMessageSourceTurnPhase;
  sourceTurnPendingRelease?: boolean;
  captured: SessionTurnQueueCapturedInput;
  /** Immutable acceptance input; absent/null means the original was not recorded. */
  accepted?: SessionTurnQueueCapturedInput | null;
  /** Input frozen by the dispatch claim, not proof of Provider delivery. */
  dispatched?: SessionTurnQueueCapturedInput | null;
  turnId: string | null;
  inputTurnId?: string | null;
  userMessageSeq: number | null;
  reason: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SessionTurnQueueReceiptPage = { receipts: SessionTurnQueueReceipt[]; nextCursor: number | null };
export type ReorderQueuedSessionTurnsRequest = { incarnationId: string; expectedQueuedIds: string[]; queuedIds: string[] };
export type QueuedSessionTurnEditRequest = { incarnationId: string; id: string };
export type UpdateQueuedSessionTurnRequest = QueuedSessionTurnEditRequest & { userMessage: string };
export type SessionTurnQueueReorderResult = { outcome: "reordered" | "conflict"; receipts: SessionTurnQueueReceipt[] };
export type SessionTurnQueueAcceptanceResult = SessionTurnQueueReceipt | {
  state: "rejected";
  reason: string;
};
export type SessionTurnQueueStore = {
  enqueue(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput): Promise<SessionTurnQueueReceipt>;
  getReceipt(owner: SessionTurnQueueOwner, requestId: string): Promise<SessionTurnQueueReceipt | null>;
  getReceiptById(owner: SessionTurnQueueOwner, id: string): Promise<SessionTurnQueueReceipt | null>;
  listActive(owner: SessionTurnQueueOwner): Promise<SessionTurnQueueReceipt[]>;
  listReceipts(owner: SessionTurnQueueOwner, options?: { cursor?: number; limit?: number }): Promise<SessionTurnQueueReceiptPage>;
  listPendingOwners(sourceSessionId?: string): Promise<SessionTurnQueueOwner[]>;
  claimNext(owner: SessionTurnQueueOwner, unreleasedSourceTurnIds?: readonly string[]): Promise<SessionTurnQueueReceipt | null>;
  claimForInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string, unreleasedSourceTurnIds?: readonly string[]): Promise<SessionTurnQueueReceipt>;
  restoreQueuedInput(owner: SessionTurnQueueOwner, id: string, expectedTurnId: string): Promise<SessionTurnQueueReceipt>;
  markStarted(owner: SessionTurnQueueOwner, id: string, input: { turnId: string; userMessageSeq: number }): Promise<SessionTurnQueueReceipt>;
  settle(owner: SessionTurnQueueOwner, id: string, state: Extract<SessionTurnQueueState, "completed" | "failed" | "canceled" | "interrupted">, reason?: string): Promise<SessionTurnQueueReceipt>;
  cancelQueued(owner: SessionTurnQueueOwner, id: string): Promise<SessionTurnQueueReceipt>;
  updateQueued(owner: SessionTurnQueueOwner, id: string, input: { userMessage: string; attachments: ComposerAttachment[] }): Promise<SessionTurnQueueReceipt>;
  reorderQueued(owner: SessionTurnQueueOwner, expectedQueuedIds: string[], queuedIds: string[]): Promise<SessionTurnQueueReorderResult>;
  recoverInterrupted(): Promise<number>;
  releaseInterrupted(owner: SessionTurnQueueOwner, id: string, options?: { runReleased: boolean }): Promise<SessionTurnQueueReceipt>;
};
