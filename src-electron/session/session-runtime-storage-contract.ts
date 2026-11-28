import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import type {
  Message,
  Session,
  SessionSummary,
  TurnInputMetadata,
  TurnInputDeliveryState,
} from "../../src-shared/session/session-state.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";

/** 履歴本体を読まずに取得する要約・キャラクター設定・メッセージ件数。 */
export type SessionMetadataResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  messageCount: number;
};

/** 保存されたメッセージを Session の世代と表示側の位置で指定する。 */
export type SessionMessageIdentityInput = {
  sessionId: string;
  incarnationId: string;
  messageIndex: number;
};

/** メッセージの役割・本文と、保管されている履歴上の位置を対応付ける。 */
export type SessionMessageIdentity = Pick<Message, "role" | "text"> & {
  historyIndex: number;
};

/** 保存先の Session と世代、および履歴を更新できる条件となる読み取り時のメッセージ件数。 */
type SessionAppendOwner = {
  sessionId: string;
  incarnationId: string;
  expectedMessageCount: number;
};

/** 実行中の Turn に入力を追記する情報。キュー経由なら受付と入力先の Turn も関連付ける。 */
export type SessionSteerAppendInput = SessionAppendOwner & {
  turnId: number;
  userMessage: Message;
  updatedAt: string;
  queuedInput?: { queueId: string; inputTurnId: string };
};

/** 配信が未確定の入力を保存する際に、ネイティブ側の対象 Turn と添付情報を渡す。 */
export type SessionSteerBeginInput = SessionSteerAppendInput &
  Pick<TurnInputMetadata, "nativeTurnId" | "attachments">;
/** 保存済みの追加入力を指定し、保留以外の配信結果で確定する。 */
export type SessionSteerSettleInput = SessionAppendOwner & {
  turnId: number;
  messageSeq: number;
  state: Exclude<TurnInputDeliveryState, "pending">;
  updatedAt: string;
};

/** 最終のアシスタントメッセージ、Session の実行メタデータ、Turn の終了情報を同じ保存操作に渡す。 */
export type SessionTerminalAppendInput = SessionAppendOwner & {
  assistantMessage: Message;
  metadata: Pick<Session, "status" | "runState" | "threadId" | "updatedAt">;
  terminalCommit: SessionTurnTerminalCommit;
};

/** 読み取り時のランタイム状態に一致する場合だけ更新する、履歴を伴わないチェックポイント。 */
export type SessionRunMetadataCheckpointInput = {
  sessionId: string;
  incarnationId: string;
  expected: Pick<Session, "status" | "runState" | "threadId">;
  next: Pick<Session, "status" | "runState" | "threadId" | "updatedAt">;
};
