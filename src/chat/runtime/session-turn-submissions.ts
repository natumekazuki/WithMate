import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { MainSessionTarget } from "../../../src-shared/session/session-target.js";

/** 永続履歴に合流する前の送信を、受付や不確実な失敗とともに表示する行データ。 */
export type SessionTurnSubmission = {
  sessionId: string;
  incarnationId: string;
  requestId: string;
  userMessage: string;
  mainConversationFrame?: MainSessionTarget | null;
  historyMessageCount: number;
  queuedBehindRun: boolean;
  error: string;
  uncertain?: boolean;
  receipt?: SessionTurnQueueReceipt;
};

/** Window 内の表示専用。受付情報と実行時状態が引き続き正本となる。 */
export class SessionTurnSubmissions {
  private snapshot: readonly SessionTurnSubmission[] = [];
  private readonly listeners = new Set<() => void>();
  /** ストアの変更があるまでは同じ表示用スナップショットを返す。 */
  readonly getSnapshot = () => this.snapshot;
  /** 表示用スナップショットの変更を購読し、解除関数を返す。 */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** 最新の表示用スナップショットを置いてから購読者へ通知する。 */
  private publish(next: readonly SessionTurnSubmission[]) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  /** 同じセッション世代で受付を持たない古いエラー行を除いて、新しい送信を加える。 */
  start(submission: SessionTurnSubmission) {
    this.publish([
      ...this.snapshot.filter(
        (current) =>
          current.sessionId !== submission.sessionId ||
          current.incarnationId !== submission.incarnationId ||
          !current.error ||
          current.receipt,
      ),
      submission,
    ]);
  }
  /** 該当する送信にエラーを反映し、受付の成否が不明な場合はその状態を記録する。 */
  fail(requestId: string, error: string, uncertain = false) {
    this.publish(
      this.snapshot.map((current) =>
        current.requestId === requestId
          ? { ...current, error, uncertain }
          : current,
      ),
    );
  }
  /** 依頼IDとセッション世代が一致する行に受付を結び、エラーと不明状態を解除する。 */
  accept(receipt: SessionTurnQueueReceipt) {
    this.publish(
      this.snapshot.map((current) =>
        current.requestId === receipt.requestId &&
        current.sessionId === receipt.sessionId &&
        current.incarnationId === receipt.incarnationId
          ? { ...current, receipt, error: "", uncertain: false }
          : current,
      ),
    );
  }
  /** 指定された依頼の表示行を除き、変化があった場合だけ購読者へ通知する。 */
  forget(requestIds: readonly string[]) {
    const next = this.snapshot.filter(
      (current) => !requestIds.includes(current.requestId),
    );
    if (next.length !== this.snapshot.length) this.publish(next);
  }
}
