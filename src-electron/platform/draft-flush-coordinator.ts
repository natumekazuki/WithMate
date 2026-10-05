import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../session/session-run-timeouts.js";

export type DraftFlushReason = "close" | "quit";
export type DraftFlushRequest = Readonly<{ requestId: string; sessionId: string; reason: DraftFlushReason }>;
export const DEFAULT_DRAFT_FLUSH_TIMEOUT_MS = 10_000;
export const DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS = DEFAULT_DRAFT_FLUSH_TIMEOUT_MS + DEFAULT_PROVIDER_CANCEL_GRACE_MS;
export type DraftFlushOutcome = "saved" | "rejected" | "timeout" | "send-failed" | "window-closed" | "renderer-gone";
export type DraftFlushResult = Readonly<{ reason: DraftFlushReason; outcome: DraftFlushOutcome; elapsedMs: number }>;
type Pending<TWindow> = { window: TWindow; sender: unknown; reason: DraftFlushReason; startedAt: number; resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> };
export class DraftFlushCoordinator<TWindow> {
  private sequence = 0;
  private readonly pending = new Map<string, Pending<TWindow>>();
  constructor(
    private readonly send: (window: TWindow, request: DraftFlushRequest) => void,
    private readonly timeoutMs?: number,
    private readonly onSettled?: (result: DraftFlushResult) => void,
  ) {}
  request(window: TWindow, sessionId: string, sender: unknown, reason: DraftFlushReason): Promise<boolean> {
    const requestId = `draft-flush-${++this.sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(requestId, "timeout");
      }, this.timeoutMs ?? (reason === "quit" ? DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS : DEFAULT_DRAFT_FLUSH_TIMEOUT_MS));
      this.pending.set(requestId, { window, sender, reason, startedAt: Date.now(), resolve, timer });
      try {
        this.send(window, { requestId, sessionId, reason });
      } catch {
        this.settle(requestId, "send-failed");
      }
    });
  }
  acknowledge(requestId: string, sender: unknown, success: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sender !== sender) return false;
    this.settle(requestId, success ? "saved" : "rejected");
    return true;
  }

  forgetWindow(window: TWindow, outcome: "window-closed" | "renderer-gone" = "window-closed"): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.window !== window) continue;
      this.settle(requestId, outcome);
    }
  }

  private settle(requestId: string, outcome: DraftFlushOutcome): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    try {
      this.onSettled?.({ reason: pending.reason, outcome, elapsedMs: Math.max(0, Date.now() - pending.startedAt) });
    } catch {
      // Diagnostics must not change the draft persistence result.
    }
    pending.resolve(outcome === "saved");
  }
}
