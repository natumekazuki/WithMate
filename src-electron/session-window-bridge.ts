import type { Session } from "../src/app-state.js";
import type { ChatEntryMode } from "./window-entry-loader.js";

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
  destroy(): void;
  once(event: "ready-to-show", listener: () => void): void;
  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  on(event: "closed", listener: () => void): void;
};

export type SessionWindowBridgeDeps<TWindow extends SessionWindowLike> = {
  createWindow(sessionId: string): TWindow;
  loadChatEntry(window: TWindow, mode: ChatEntryMode): Promise<void>;
  getSession(sessionId: string): Session | null;
  isRunInFlight(sessionId: string): boolean;
  getAllowQuitWithInFlightRuns(): boolean;
  confirmCloseWhileRunning(window: TWindow, sessionId: string): boolean;
  broadcastOpenSessionWindowIds(openSessionIds: string[]): void;
};

export class SessionWindowBridge<TWindow extends SessionWindowLike> {
  private readonly sessionWindows = new Map<string, TWindow>();
  private readonly openingSessionWindows = new Map<string, Promise<TWindow>>();
  private readonly allowCloseSessionWindows = new Set<TWindow>();

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

  listWindows(): TWindow[] {
    return Array.from(this.sessionWindows.values()).filter((window) => !window.isDestroyed());
  }

  async openSessionWindow(sessionId: string): Promise<TWindow> {
    const openingWindow = this.openingSessionWindows.get(sessionId);
    if (openingWindow) {
      return openingWindow;
    }

    const existingWindow = this.getWindow(sessionId);
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }

      existingWindow.show();
      existingWindow.focus();
      return existingWindow;
    }

    const window = this.deps.createWindow(sessionId);
    this.sessionWindows.set(sessionId, window);
    this.broadcast();
    window.once("ready-to-show", () => window.show());
    window.on("close", (event) => this.handleWindowClose(sessionId, window, event));
    window.on("closed", () => this.releaseWindowClaim(sessionId, window));

    const openingPromise = this.loadSessionWindow(sessionId, window);
    this.openingSessionWindows.set(sessionId, openingPromise);

    try {
      return await openingPromise;
    } finally {
      if (this.openingSessionWindows.get(sessionId) === openingPromise) {
        this.openingSessionWindows.delete(sessionId);
      }
    }
  }

  closeSessionWindow(sessionId: string): void {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) {
      this.sessionWindows.delete(sessionId);
      if (window) {
        this.allowCloseSessionWindows.delete(window);
      }
      this.broadcast();
      return;
    }

    this.allowCloseSessionWindows.add(window);
    window.close();
  }

  closeAllSessionWindows(): void {
    for (const sessionId of Array.from(this.sessionWindows.keys())) {
      this.closeSessionWindow(sessionId);
    }
    this.sessionWindows.clear();
    this.openingSessionWindows.clear();
    this.allowCloseSessionWindows.clear();
    this.broadcast();
  }

  private async loadSessionWindow(sessionId: string, window: TWindow): Promise<TWindow> {
    try {
      await this.deps.loadChatEntry(window, { kind: "agent", sessionId });
      return window;
    } catch (error) {
      this.releaseWindowClaim(sessionId, window);
      if (!window.isDestroyed()) {
        window.destroy();
      }
      throw error;
    }
  }

  private handleWindowClose(sessionId: string, window: TWindow, event: SessionWindowCloseEvent): void {
    if (this.deps.getAllowQuitWithInFlightRuns()) {
      return;
    }

    if (this.allowCloseSessionWindows.has(window)) {
      this.allowCloseSessionWindows.delete(window);
      return;
    }

    if (!this.deps.isRunInFlight(sessionId)) {
      return;
    }

    event.preventDefault();

    if (!this.deps.confirmCloseWhileRunning(window, sessionId)) {
      return;
    }

    this.allowCloseSessionWindows.add(window);
    window.close();
  }

  private releaseWindowClaim(sessionId: string, window: TWindow): void {
    this.allowCloseSessionWindows.delete(window);
    if (this.sessionWindows.get(sessionId) !== window) {
      return;
    }

    this.sessionWindows.delete(sessionId);
    this.broadcast();
  }

  private broadcast(): void {
    this.deps.broadcastOpenSessionWindowIds(this.listOpenSessionWindowIds());
  }
}
