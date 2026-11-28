import { createContext, useContext } from "react";
import type {
  RetryFailedSessionTurnRequest,
  SessionTurnQueueReceipt,
} from "../../../src-shared/session/session-turn-queue.js";

/** 失敗ターンの再送を、表示行からセッションの実行機能へ委ねる窓口。 */
export type FailedTurnRetryContext = {
  /** 実行設定の解決を実行機能に任せ、失敗ターンの再送を受け付ける。 */
  submit(
    request: Omit<RetryFailedSessionTurnRequest, "executionOptions">,
  ): Promise<SessionTurnQueueReceipt>;
  /** 指定セッションで再送操作を受け付けられないかを調べる。 */
  blocked(sessionId: string): boolean;
  /** 失敗した操作のセッションと対象を添えて、表示側にエラーを伝える。 */
  onError?(sessionId: string, message: string, target: string): void;
};

/** 失敗ターン再送を扱わない会話表示では null になるコンテキスト。 */
export const FailedTurnRetryContext =
  createContext<FailedTurnRetryContext | null>(null);
/** 現在の会話に失敗ターン再送の窓口が提供されていれば取得する。 */
export const useFailedTurnRetry = () => useContext(FailedTurnRetryContext);
