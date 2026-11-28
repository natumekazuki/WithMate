import type { ComposerAttachment, RunSessionTurnRequest } from "./runtime-state.js";
import type { Session } from "./session-state.js";
import { LOCAL_USER_ID, type ConversationParticipant } from "../character/character-participant.js";
import { isUnknownCharacterOwnerId, NEUTRAL_CHARACTER_ID } from "../character/character-owner.js";

export type SessionTurnQueueOwner = { sessionId: string; incarnationId: string };
export type RetryFailedSessionTurnRequest = {
  target: import("./session-target.js").SessionTarget;
  receiptId: string;
  turnId: string;
  clientRequestId: string;
  executionOptions: import("./session-execution-options.js").SessionExecutionOptions;
};
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
  /** 一時的な観測値。冪等な受付のペイロードには含めない。 */
  sourceDisplayPosition?: number;
  /** 送信元の Turn が確定するまで、メモリ上にのみ保持する。 */
  sourceDisplayText?: string;
  coordination?: { id: string; operation: string; actor: import("../coordination/coordination-contract.js").CoordinationActor; targetKind?: "main" | "auxiliary"; answerId?: string; answerRevision?: number; notification?: import("../coordination/coordination-delivery.js").CoordinationNotification };
  request: RunSessionTurnRequest & { clientRequestId: string };
  attachments: ComposerAttachment[];
  provider: string;
  workspacePath: string;
  origin?: SessionTurnQueueOrigin;
  /** GUI から要求された新しい実行の元の配送来歴。実行主体を示すものではない。 */
  retrySource?: {
    receiptId: string;
    turnId: string;
    origin: SessionTurnQueueOrigin;
    changedSinceAcceptance: boolean;
  };
};

export type SessionSteerOrigin = Pick<SessionTurnQueueOrigin, "actorSnapshot" | "targetSessionId" | "targetIncarnationId" | "targetSnapshot"> & {
  kind: "session";
  actorKind: "main";
  actorSessionId: string;
  actorIncarnationId: string;
  actorTurnId: string;
  operation: "steer";
};

/** 入力が完全に同じと確認できた再実行では、表示上の作成者と GUI での受付主体を区別する。 */
export function projectRetryInputAuthor(origin: SessionTurnQueueOrigin | SessionSteerOrigin | null | undefined,
  source: SessionTurnQueueCapturedInput["retrySource"] | null, unchanged: boolean | null | undefined) {
  return origin?.kind === "gui" && source?.changedSinceAcceptance === false && unchanged === true
    && source.origin.targetSessionId === origin.targetSessionId
    && source.origin.targetIncarnationId === origin.targetIncarnationId ? source.origin : origin;
}

export type SessionSteerResult = {
  outcome: "applied" | "not-applied" | "unknown";
  turnId: string;
  messageSeq: number | null;
  reason?: string;
};

/** 送信者の帰属はアプリケーションが付与し、メッセージ本文中の自己申告は使わない。 */
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
  /** 変更できない受付時の入力。省略または null は元の入力が記録されていないことを示す。 */
  accepted?: SessionTurnQueueCapturedInput | null;
  /** 配送の取得時に固定した入力であり、Provider に届いた証拠ではない。 */
  dispatched?: SessionTurnQueueCapturedInput | null;
  turnId: string | null;
  inputTurnId?: string | null;
  userMessageSeq: number | null;
  reason: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** キュー投入の内部結果。受付済みリクエストには含まれない。 */
  sourceDisplayInserted?: boolean;
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
export type SessionTurnQueueAdmission = {
  receipt: SessionTurnQueueReceipt;
  /** 引き渡し対象として今回新たに取得した 1 件。以前受け付けた受付情報ではない。 */
  claimed: SessionTurnQueueReceipt | null;
};
export type SessionTurnQueueStore = {
  admit(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput, claim?: { unreleasedSourceTurnIds: readonly string[] }): Promise<SessionTurnQueueAdmission>;
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
  recoverInterrupted(target?: SessionTurnQueueOwner & { receiptId: string }): Promise<number>;
};
