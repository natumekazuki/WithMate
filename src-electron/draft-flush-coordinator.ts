import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "./session-run-timeouts.js";

export type DraftFlushReason = "close" | "quit";
export type DraftFlushRequest = Readonly<{ requestId: string; sessionId: string; reason: DraftFlushReason }>;
export const DEFAULT_DRAFT_FLUSH_TIMEOUT_MS = 10_000;
export const DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS = DEFAULT_DRAFT_FLUSH_TIMEOUT_MS + DEFAULT_PROVIDER_CANCEL_GRACE_MS;
type Pending<TWindow> = { window: TWindow; sender: unknown; resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> };
export class DraftFlushCoordinator<TWindow> {
  private sequence = 0;
  private readonly pending = new Map<string, Pending<TWindow>>();
  constructor(
    private readonly send: (window: TWindow, request: DraftFlushRequest) => void,
    private readonly timeoutMs?: number,
  ) {}
  request(window: TWindow, sessionId: string, sender: unknown, reason: DraftFlushReason): Promise<boolean> {
    const requestId = `draft-flush-${++this.sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.resolve(false);
      }, this.timeoutMs ?? (reason === "quit" ? DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS : DEFAULT_DRAFT_FLUSH_TIMEOUT_MS));
      this.pending.set(requestId, { window, sender, resolve, timer });
      try {
        this.send(window, { requestId, sessionId, reason });
      } catch {
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve(false);
      }
    });
  }
  acknowledge(requestId: string, sender: unknown, success: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sender !== sender) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(success);
    return true;
  }

  forgetWindow(window: TWindow): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.window !== window) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
  }
}
