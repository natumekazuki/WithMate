import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../session/session-run-timeouts.js";

/** 下書き保存を要求する契機。ウィンドウの閉鎖とアプリの終了で待機期限を分ける。 */
export type DraftFlushReason = "close" | "quit";
/** renderer へ渡す、要求の照合 ID、対象 Session、保存の契機。 */
export type DraftFlushRequest = Readonly<{
  requestId: string;
  sessionId: string;
  reason: DraftFlushReason;
}>;
/** 通常のウィンドウ閉鎖で下書き保存の確認を待つ既定時間。 */
export const DEFAULT_DRAFT_FLUSH_TIMEOUT_MS = 10_000;
/** アプリ終了時は通常の保存待機にプロバイダーの停止猶予を加える。 */
export const DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS =
  DEFAULT_DRAFT_FLUSH_TIMEOUT_MS + DEFAULT_PROVIDER_CANCEL_GRACE_MS;
/** 保存成功、renderer による拒否、応答不能・配送失敗などの終端状態。 */
export type DraftFlushOutcome =
  | "saved"
  | "rejected"
  | "timeout"
  | "send-failed"
  | "window-closed"
  | "renderer-gone";
/** 終端時の診断向けに、保存の契機、結果、経過時間だけを伝える。 */
export type DraftFlushResult = Readonly<{
  reason: DraftFlushReason;
  outcome: DraftFlushOutcome;
  elapsedMs: number;
}>;
/** 応答元の照合と、待機中の要求を一度だけ終端させるための状態。 */
type Pending<TWindow> = {
  window: TWindow;
  sender: unknown;
  reason: DraftFlushReason;
  startedAt: number;
  resolve: (value: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};
/** ウィンドウごとの下書き保存要求を追跡し、正しい応答元からの保存確認だけを成功とする。 */
export class DraftFlushCoordinator<TWindow> {
  private sequence = 0;
  private readonly pending = new Map<string, Pending<TWindow>>();
  /** 配送処理を受け取り、必要に応じて待機時間の上書きと診断通知を設定する。 */
  constructor(
    private readonly send: (
      window: TWindow,
      request: DraftFlushRequest,
    ) => void,
    private readonly timeoutMs?: number,
    private readonly onSettled?: (result: DraftFlushResult) => void,
  ) {}
  /** 応答待ちを登録してから要求を送り、保存確認以外は false に収束させる。 */
  request(
    window: TWindow,
    sessionId: string,
    sender: unknown,
    reason: DraftFlushReason,
  ): Promise<boolean> {
    const requestId = `draft-flush-${++this.sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.settle(requestId, "timeout");
        },
        this.timeoutMs ??
          (reason === "quit"
            ? DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS
            : DEFAULT_DRAFT_FLUSH_TIMEOUT_MS),
      );
      this.pending.set(requestId, {
        window,
        sender,
        reason,
        startedAt: Date.now(),
        resolve,
        timer,
      });
      try {
        this.send(window, { requestId, sessionId, reason });
      } catch {
        this.settle(requestId, "send-failed");
      }
    });
  }
  /** 保留中の要求と送信元が一致する応答だけを受理し、保存結果を確定する。 */
  acknowledge(requestId: string, sender: unknown, success: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sender !== sender) return false;
    this.settle(requestId, success ? "saved" : "rejected");
    return true;
  }

  /** 閉じたウィンドウか失われた renderer に属する要求を、応答待ちのまま残さず終端させる。 */
  forgetWindow(
    window: TWindow,
    outcome: "window-closed" | "renderer-gone" = "window-closed",
  ): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.window !== window) continue;
      this.settle(requestId, outcome);
    }
  }

  /** 要求とタイマーを取り除き、診断の成否にかかわらず呼び出し元に結果を返す。 */
  private settle(requestId: string, outcome: DraftFlushOutcome): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    try {
      this.onSettled?.({
        reason: pending.reason,
        outcome,
        elapsedMs: Math.max(0, Date.now() - pending.startedAt),
      });
    } catch {
      // 診断が下書きの保存結果を変えてはならない。
    }
    pending.resolve(outcome === "saved");
  }
}
