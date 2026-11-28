import type {
  ComposerAttachment,
  RunSessionTurnRequest,
} from "./runtime-state.js";
import type { Session } from "./session-state.js";
import {
  LOCAL_USER_ID,
  type ConversationParticipant,
} from "../character/character-participant.js";
import {
  isUnknownCharacterOwnerId,
  NEUTRAL_CHARACTER_ID,
} from "../character/character-owner.js";

/** キューを所有する Session の識別子。同じ ID の世代違いを区別するため、世代 ID も必須とする。 */
export type SessionTurnQueueOwner = {
  sessionId: string;
  incarnationId: string;
};
/** 失敗した実行について、元の受付・ターンを指定し、新しい要求 ID と実行設定で再試行する。 */
export type RetryFailedSessionTurnRequest = {
  target: import("./session-target.js").SessionTarget;
  receiptId: string;
  turnId: string;
  clientRequestId: string;
  executionOptions: import("./session-execution-options.js").SessionExecutionOptions;
};
/** 入力をすぐ配送候補にするか、送信元ターンの終了後まで保留するかを指定する。 */
export type SessionMessageDeliveryTiming = "immediate" | "after_source_turn";
/** 遅延配送の可否を判断するために観測した送信元ターンの状態。終了状態を確認できない場合は unknown。 */
export type SessionMessageSourceTurnPhase =
  "running" | "completed" | "failed" | "canceled" | "unknown";
/** 配送来歴の表示に使う、その時点の Session タイトルと Character 情報。 */
export type SessionTurnQueueDisplaySnapshot = {
  sessionTitle: string;
  character: {
    id: string;
    name: string;
    iconPath: string;
    description?: string;
  };
};
/** 配送時の表示情報を切り出す。名前と説明は Character スナップショットを優先し、アイコンは Session のパスを優先する。 */
export function captureSessionTurnQueueDisplay(
  session: Session,
): SessionTurnQueueDisplaySnapshot {
  return {
    sessionTitle: session.taskTitle,
    character: {
      id: session.characterId,
      name: session.characterRuntimeSnapshot?.name ?? session.character,
      description: session.characterRuntimeSnapshot?.description ?? "",
      iconPath:
        session.characterIconPath ||
        session.characterRuntimeSnapshot?.iconFilePath ||
        "",
    },
  };
}
/** キューに送った入力の来歴。GUI 操作と Session からの配送を区別し、送信先の世代と必要に応じて送信元を記録する。 */
export type SessionTurnQueueOrigin = {
  kind: "gui" | "session";
  actorSessionId?: string;
  actorKind?: "main" | "auxiliary";
  actorIncarnationId?: string;
  actorTurnId?: string;
  deliveryTiming?: SessionMessageDeliveryTiming;
  requestedExecutionOptions?: import("./session-execution-options.js").SessionMessageExecutionOptions;
  sourceTurnPhase?: Exclude<
    SessionMessageSourceTurnPhase,
    "running" | "unknown"
  >;
  actorMainSessionId?: string;
  actorSnapshot?: SessionTurnQueueDisplaySnapshot;
  operation: "send";
  targetSessionId: string;
  targetIncarnationId: string;
  targetSnapshot?: SessionTurnQueueDisplaySnapshot;
};
/** キューで実行に引き渡す入力。本文と実行設定に加え、解決済み添付、作業先、元の配送や再試行の来歴を持つ。 */
export type SessionTurnQueueCapturedInput = {
  /** 一時的な観測値。冪等な受付のペイロードには含めない。 */
  sourceDisplayPosition?: number;
  /** 送信元の Turn が確定するまで、メモリ上にのみ保持する。 */
  sourceDisplayText?: string;
  coordination?: {
    id: string;
    operation: string;
    actor: import("../coordination/coordination-contract.js").CoordinationActor;
    targetKind?: "main" | "auxiliary";
    answerId?: string;
    answerRevision?: number;
    notification?: import("../coordination/coordination-delivery.js").CoordinationNotification;
  };
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

/** Main Session の実行中ターンから別のターンへ追加入力した来歴。入力元のターンと両 Session の世代を特定する。 */
export type SessionSteerOrigin = Pick<
  SessionTurnQueueOrigin,
  "actorSnapshot" | "targetSessionId" | "targetIncarnationId" | "targetSnapshot"
> & {
  kind: "session";
  actorKind: "main";
  actorSessionId: string;
  actorIncarnationId: string;
  actorTurnId: string;
  operation: "steer";
};

/** 入力が完全に同じと確認できた再実行では、表示上の作成者と GUI での受付主体を区別する。 */
export function projectRetryInputAuthor(
  origin: SessionTurnQueueOrigin | SessionSteerOrigin | null | undefined,
  source: SessionTurnQueueCapturedInput["retrySource"] | null,
  unchanged: boolean | null | undefined,
) {
  return origin?.kind === "gui" &&
    source?.changedSinceAcceptance === false &&
    unchanged === true &&
    source.origin.targetSessionId === origin.targetSessionId &&
    source.origin.targetIncarnationId === origin.targetIncarnationId
    ? source.origin
    : origin;
}

/** 追加入力の適用結果。適用・未適用・確認不能を分け、保存したメッセージの連番がなければ null とする。 */
export type SessionSteerResult = {
  outcome: "applied" | "not-applied" | "unknown";
  turnId: string;
  messageSeq: number | null;
  reason?: string;
};

/** 送信者の帰属はアプリケーションが付与し、メッセージ本文中の自己申告は使わない。 */
export function projectSessionInputSender(
  origin: SessionTurnQueueOrigin | SessionSteerOrigin | null | undefined,
): {
  kind: "user" | "agent" | "unknown";
  participant: ConversationParticipant | null;
  session?: { id: string; incarnationId?: string; kind?: "main" | "auxiliary" };
  character?: { id: string; name: string; description?: string };
} {
  if (!origin) return { kind: "unknown", participant: null };
  if (origin.kind === "gui")
    return { kind: "user", participant: { type: "user", id: LOCAL_USER_ID } };
  const character = origin.actorSnapshot?.character;
  const known =
    character?.id &&
    !isUnknownCharacterOwnerId(character.id) &&
    character.id !== NEUTRAL_CHARACTER_ID;
  return {
    kind: "agent",
    participant: known ? { type: "character", id: character.id } : null,
    ...(origin.actorSessionId
      ? {
          session: {
            id: origin.actorSessionId,
            incarnationId: origin.actorIncarnationId,
            kind: origin.actorKind,
          },
        }
      : {}),
    ...(known
      ? {
          character: {
            id: character.id,
            name: character.name,
            ...(character.description === undefined
              ? {}
              : { description: character.description }),
          },
        }
      : {}),
  };
}
/** キュー受付の状態。未取得・引き渡し準備中・実行中を分け、終端では成否、取り消し、中断を区別する。 */
export type SessionTurnQueueState =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";
/** 受付の識別子・順序・実行状態と、受け付けた入力から実行へ引き渡した入力までの記録。 */
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
/** 受付履歴の1ページ。受付の連番を基準に読み進め、続きがなければ nextCursor は null。 */
export type SessionTurnQueueReceiptPage = {
  receipts: SessionTurnQueueReceipt[];
  nextCursor: number | null;
};
/** 待機中の受付だけを並べ替える要求。変更前の順序も渡し、他の操作で順序や対象が変わっていれば競合として扱う。 */
export type ReorderQueuedSessionTurnsRequest = {
  incarnationId: string;
  expectedQueuedIds: string[];
  queuedIds: string[];
};
/** 待機中の入力を編集・取り消しする際に指定する、キュー所有者の世代と受付 ID。 */
export type QueuedSessionTurnEditRequest = {
  incarnationId: string;
  id: string;
};
/** 待機中の受付について、元の受付を保持したまま実行予定の本文を差し替える要求。 */
export type UpdateQueuedSessionTurnRequest = QueuedSessionTurnEditRequest & {
  userMessage: string;
};
/** 並べ替えの成否と、その時点の受付一覧。競合時にも現在の順序を返す。 */
export type SessionTurnQueueReorderResult = {
  outcome: "reordered" | "conflict";
  receipts: SessionTurnQueueReceipt[];
};
/** キュー登録が受け付けられた場合の受付情報、または実行に進めなかった場合の拒否理由。 */
export type SessionTurnQueueAcceptanceResult =
  | SessionTurnQueueReceipt
  | {
      state: "rejected";
      reason: string;
    };
/** 入力をキューで受け付けた結果と、同じ操作で配送用に取得した受付情報。 */
export type SessionTurnQueueAdmission = {
  receipt: SessionTurnQueueReceipt;
  /** 引き渡し対象として今回新たに取得した 1 件。以前受け付けた受付情報ではない。 */
  claimed: SessionTurnQueueReceipt | null;
};
/** Session の世代ごとに、実行待ち入力の受付、配送への引き渡し、実行結果の記録を担うストレージ境界。 */
export type SessionTurnQueueStore = {
  /** 入力を登録し、指定時は同じ処理内で配送候補も取得する。同じ要求 ID と同一内容の再送は元の受付を返す。 */
  admit(
    owner: SessionTurnQueueOwner,
    captured: SessionTurnQueueCapturedInput,
    claim?: { unreleasedSourceTurnIds: readonly string[] },
  ): Promise<SessionTurnQueueAdmission>;
  /** 指定した世代のキューからクライアントの要求 ID で検索し、該当しなければ null を返す。 */
  getReceipt(
    owner: SessionTurnQueueOwner,
    requestId: string,
  ): Promise<SessionTurnQueueReceipt | null>;
  /** 指定した世代のキューからキュー側で割り当てた受付 ID で検索し、該当しなければ null を返す。 */
  getReceiptById(
    owner: SessionTurnQueueOwner,
    id: string,
  ): Promise<SessionTurnQueueReceipt | null>;
  /** 待機・準備・実行中に加え、失敗・中断した受付も、キュー上の位置順に返す。 */
  listActive(owner: SessionTurnQueueOwner): Promise<SessionTurnQueueReceipt[]>;
  /** 受付履歴を連番昇順で返す。カーソルを指定すると、その連番より後から再開する。 */
  listReceipts(
    owner: SessionTurnQueueOwner,
    options?: { cursor?: number; limit?: number },
  ): Promise<SessionTurnQueueReceiptPage>;
  /** 未処理の受付を持つキューの所有者を列挙する。送信元を指定した場合は、その Main からの終了待ち配送だけを対象とする。 */
  listPendingOwners(sourceSessionId?: string): Promise<SessionTurnQueueOwner[]>;
  /** 配送可能な先頭の受付を準備中に移し、引き渡す内容を固定する。実行中・準備中の受付があるか、候補がなければ null。 */
  claimNext(
    owner: SessionTurnQueueOwner,
    unreleasedSourceTurnIds?: readonly string[],
  ): Promise<SessionTurnQueueReceipt | null>;
  /** 待機中の受付を、新規ターンではなく指定の実行中ターンへの入力として取得する。配送保留中や対象不一致の場合は拒否する。 */
  claimForInput(
    owner: SessionTurnQueueOwner,
    id: string,
    expectedTurnId: string,
    unreleasedSourceTurnIds?: readonly string[],
  ): Promise<SessionTurnQueueReceipt>;
  /** 追加入力用に取得した受付を、対応するユーザーメッセージが保存されていない場合に限り待機状態へ戻す。 */
  restoreQueuedInput(
    owner: SessionTurnQueueOwner,
    id: string,
    expectedTurnId: string,
  ): Promise<SessionTurnQueueReceipt>;
  /** 新規ターンとして準備中の受付を実行中へ進め、保存されたターン ID とユーザーメッセージの連番を関連付ける。 */
  markStarted(
    owner: SessionTurnQueueOwner,
    id: string,
    input: { turnId: string; userMessageSeq: number },
  ): Promise<SessionTurnQueueReceipt>;
  /** 準備中または実行中の受付を指定の終端状態に移し、必要ならその理由を記録する。 */
  settle(
    owner: SessionTurnQueueOwner,
    id: string,
    state: Extract<
      SessionTurnQueueState,
      "completed" | "failed" | "canceled" | "interrupted"
    >,
    reason?: string,
  ): Promise<SessionTurnQueueReceipt>;
  /** 待機中の受付だけを取り消す。すでに配送された場合は受付を変更せず、ターンも停止しない。 */
  cancelQueued(
    owner: SessionTurnQueueOwner,
    id: string,
  ): Promise<SessionTurnQueueReceipt>;
  /** 待機中の通常入力に限って実行予定の本文・添付を更新し、受付時の入力は保持する。 */
  updateQueued(
    owner: SessionTurnQueueOwner,
    id: string,
    input: { userMessage: string; attachments: ComposerAttachment[] },
  ): Promise<SessionTurnQueueReceipt>;
  /** 待機中の受付の順序が呼び出し側の想定と一致するときだけ、同じ受付の並び順を更新する。 */
  reorderQueued(
    owner: SessionTurnQueueOwner,
    expectedQueuedIds: string[],
    queuedIds: string[],
  ): Promise<SessionTurnQueueReorderResult>;
  /** 再起動後の中断を一括復旧するか、指定された引き渡し済み受付だけを復旧し、変更した件数を返す。 */
  recoverInterrupted(
    target?: SessionTurnQueueOwner & { receiptId: string },
  ): Promise<number>;
};
