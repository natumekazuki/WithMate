import type { Session } from "../src/app-state.js";

type CharacterReflectionTriggerOptions = {
  triggerReason: "session-start" | "context-growth";
};

export type SessionWindowCloseEvent = {
  preventDefault(): void;
};

export type SessionWindowLike = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  show(): void;
  close(): void;
  once(event: "ready-to-show", listener: () => void): void;
  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  on(event: "closed", listener: () => void): void;
};

export type SessionWindowBridgeDeps<TWindow extends SessionWindowLike> = {
  createWindow(sessionId: string): TWindow;
  loadSessionEntry(window: TWindow, sessionId: string): Promise<void>;
  getSession(sessionId: string): Session | null;
  isRunInFlight(sessionId: string): boolean;
  getAllowQuitWithInFlightRuns(): boolean;
  confirmCloseWhileRunning(window: TWindow, sessionId: string): boolean;
  broadcastOpenSessionWindowIds(openSessionIds: string[]): void;
  runCharacterReflection(session: Session, options: CharacterReflectionTriggerOptions): void;
};

export class SessionWindowBridge<TWindow extends SessionWindowLike> {
  private readonly sessionWindows = new Map<string, TWindow>();
  private readonly allowCloseSessionWindows = new Set<string>();

  constructor(private readonly deps: SessionWindowBridgeDeps<TWindow>) {}

  listOpenSessionWindowIds(): string[] {
    const openSessionIds: string[] = [];
    for (const [sessionId, window] of this.sessionWindows.entries()) {
      if (window.isDestroyed()) {
        continue;
      }

      openSessionIds.push(sessionId);
    }

    return openSessionIds;
  }

  getWindow(sessionId: string): TWindow | null {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) {
      return null;
    }

    return window;
  }

  async openSessionWindow(sessionId: string): Promise<TWindow> {
    const existingWindow = this.getWindow(sessionId);
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }

      existingWindow.focus();
      return existingWindow;
    }

    const window = this.deps.createWindow(sessionId);
    this.sessionWindows.set(sessionId, window);
    this.broadcast();
    window.once("ready-to-show", () => window.show());
    window.on("close", (event) => this.handleWindowClose(sessionId, window, event));
    window.on("closed", () => this.handleWindowClosed(sessionId));

    await this.deps.loadSessionEntry(window, sessionId);
    const openedSession = this.deps.getSession(sessionId);
    if (openedSession) {
      this.deps.runCharacterReflection(openedSession, { triggerReason: "session-start" });
    }

    return window;
  }

  closeSessionWindow(sessionId: string): void {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) {
      this.sessionWindows.delete(sessionId);
      this.allowCloseSessionWindows.delete(sessionId);
      this.broadcast();
      return;
    }

    this.allowCloseSessionWindows.add(sessionId);
    window.close();
  }

  closeAllSessionWindows(): void {
    for (const sessionId of Array.from(this.sessionWindows.keys())) {
      this.closeSessionWindow(sessionId);
    }
    this.sessionWindows.clear();
    this.allowCloseSessionWindows.clear();
    this.broadcast();
  }

  private handleWindowClose(sessionId: string, window: TWindow, event: SessionWindowCloseEvent): void {
    if (this.deps.getAllowQuitWithInFlightRuns()) {
      return;
    }

    if (this.allowCloseSessionWindows.has(sessionId)) {
      this.allowCloseSessionWindows.delete(sessionId);
      return;
    }

    if (!this.deps.isRunInFlight(sessionId)) {
      return;
    }

    event.preventDefault();

    if (!this.deps.confirmCloseWhileRunning(window, sessionId)) {
      return;
    }

    this.allowCloseSessionWindows.add(sessionId);
    window.close();
  }

  private handleWindowClosed(sessionId: string): void {
    this.allowCloseSessionWindows.delete(sessionId);
    this.sessionWindows.delete(sessionId);
    this.broadcast();
  }

  private broadcast(): void {
    this.deps.broadcastOpenSessionWindowIds(this.listOpenSessionWindowIds());
  }
}
