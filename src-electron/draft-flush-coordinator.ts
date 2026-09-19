export type DraftFlushRequest = Readonly<{ requestId: string; sessionId: string }>;
type Pending = { sender: unknown; resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> };
export class DraftFlushCoordinator<TWindow> {
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly send: (window: TWindow, request: DraftFlushRequest) => void, private readonly timeoutMs = 10_000) {}
  request(window: TWindow, sessionId: string, sender: unknown): Promise<boolean> {
    const requestId = `draft-flush-${++this.sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.resolve(false);
      }, this.timeoutMs);
      this.pending.set(requestId, { sender, resolve, timer });
      try {
        this.send(window, { requestId, sessionId });
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

  forgetWindow(sender: unknown): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sender !== sender) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
  }
}
