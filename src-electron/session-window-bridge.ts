import type { Session } from "../src/app-state.js";
import type { AuxiliarySessionNavigationPayload } from "../src/withmate-window-types.js";
import type { ChatEntryMode } from "./window-entry-loader.js";
import {
  DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS,
  DraftFlushCoordinator,
  type DraftFlushReason,
  type DraftFlushRequest,
} from "./draft-flush-coordinator.js";

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
  sendAuxiliarySessionNavigation?(
    window: TWindow,
    payload: AuxiliarySessionNavigationPayload,
  ): void;
  getSession(sessionId: string): Session | null;
  isRunInFlight(sessionId: string): boolean;
  confirmCloseWhileRunning(window: TWindow, sessionId: string): boolean;
  broadcastOpenSessionWindowIds(openSessionIds: string[]): void;
  persistOpenSessionWindowIds?(openSessionIds: readonly string[]): Promise<void>;
  onSnapshotPersistenceError?(error: unknown): void;
  onSessionWindowClosed?(sessionId: string): void;
  sendDraftFlushRequest?(window: TWindow, request: DraftFlushRequest): void;
  sendDraftFlushRelease?(window: TWindow, payload: { success: boolean }): void;
  getWindowSender?(window: TWindow): unknown;
  waitForPendingDraftSends?(): Promise<boolean>;
  cancelInFlightSessionRuns?(): void;
};

export type SessionWindowRestoreState =
  | { kind: "settled-open" }
  | { kind: "opening" };

export class SessionWindowBridge<TWindow extends SessionWindowLike> {
  private readonly sessionWindows = new Map<string, TWindow>();
  private readonly openingSessionWindows = new Map<string, Promise<TWindow>>();
  private readonly allowCloseSessionWindows = new Set<TWindow>();
  private readonly snapshotEligibleWindows = new Set<TWindow>();
  private readonly pendingCloseRequests = new Map<TWindow, {
    promise: Promise<boolean>;
    resolve: (closed: boolean) => void;
  }>();
  private readonly pendingDraftFlushWindows = new Set<TWindow>();
  private readonly draftFlushes = new Map<TWindow, {
    promise: Promise<boolean>;
    pending: boolean;
    reason: DraftFlushReason;
  }>();
  private draftFlushGateActive = false;
  private readonly draftFlushCoordinator = new DraftFlushCoordinator<TWindow>((window, request) => {
    this.deps.sendDraftFlushRequest?.(window, request);
  });
  private snapshotUpdatesSuspended = false;

  constructor(private readonly deps: SessionWindowBridgeDeps<TWindow>) {}

  isQuitPending(): boolean {
    return this.draftFlushGateActive;
  }

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

  listSettledOpenSessionWindowIds(): string[] {
    const settledOpenSessionIds: string[] = [];
    for (const [sessionId, window] of this.sessionWindows.entries()) {
      if (window.isDestroyed() || !this.snapshotEligibleWindows.has(window)) {
        continue;
      }

      settledOpenSessionIds.push(sessionId);
    }

    return settledOpenSessionIds;
  }

  getSessionWindowRestoreStates(): ReadonlyMap<string, SessionWindowRestoreState> {
    const states = new Map<string, SessionWindowRestoreState>();
    for (const [sessionId, window] of this.sessionWindows.entries()) {
      if (window.isDestroyed()) {
        continue;
      }

      if (this.snapshotEligibleWindows.has(window)) {
        states.set(sessionId, { kind: "settled-open" });
        continue;
      }

      const openingPromise = this.openingSessionWindows.get(sessionId);
      if (openingPromise) {
        states.set(sessionId, { kind: "opening" });
      }
    }

    return states;
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

  async openSessionWindow(
    sessionId: string,
    options: SessionWindowOpenOptions = {},
  ): Promise<TWindow> {
    if (this.draftFlushGateActive) {
      throw new Error("Session Window open is suspended while drafts are flushing.");
    }
    const auxiliarySessionId = options.auxiliarySessionId?.trim() || null;
    const openingWindow = this.openingSessionWindows.get(sessionId);
    if (openingWindow) {
      const window = await openingWindow;
      if (auxiliarySessionId) {
        this.sendAuxiliarySessionNavigation(sessionId, auxiliarySessionId, window);
      }
      return window;
    }

    const existingWindow = this.getWindow(sessionId);
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }

      existingWindow.show();
      existingWindow.focus();
      if (auxiliarySessionId) {
        this.sendAuxiliarySessionNavigation(sessionId, auxiliarySessionId, existingWindow);
      }
      return existingWindow;
    }

    const window = this.deps.createWindow(sessionId);
    this.sessionWindows.set(sessionId, window);
    this.broadcast();
    window.once("ready-to-show", () => window.show());
    window.on("close", (event) => this.handleWindowClose(sessionId, window, event));
    window.on("closed", () => this.releaseWindowClaim(sessionId, window));

    const openingPromise = this.loadSessionWindow(sessionId, window, auxiliarySessionId);
    this.openingSessionWindows.set(sessionId, openingPromise);

    try {
      const openedWindow = await openingPromise;
      if (this.sessionWindows.get(sessionId) === window && !window.isDestroyed()) {
        this.snapshotEligibleWindows.add(window);
        await this.persistSnapshotBestEffort();
      }
      return openedWindow;
    } finally {
      if (this.openingSessionWindows.get(sessionId) === openingPromise) {
        this.openingSessionWindows.delete(sessionId);
      }
    }
  }

  async openAuxiliarySessionWindow(parentSessionId: string, auxiliarySessionId: string): Promise<TWindow> {
    return this.openSessionWindow(parentSessionId, { auxiliarySessionId });
  }

  closeSessionWindow(sessionId: string): void {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) {
      this.sessionWindows.delete(sessionId);
      if (window) {
        this.allowCloseSessionWindows.delete(window);
        const wasSnapshotEligible = this.snapshotEligibleWindows.delete(window);
        if (wasSnapshotEligible) {
          void this.persistSnapshotBestEffort();
        }
      }
      this.broadcast();
      return;
    }

    window.close();
  }

  discardSessionWindow(sessionId: string): void {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) return;
    this.allowCloseSessionWindows.add(window);
    window.close();
  }

  async flushSessionWindowDrafts(): Promise<boolean> {
    const windows = this.listWindows();
    this.draftFlushGateActive = true;
    try {
      this.deps.cancelInFlightSessionRuns?.();
    } catch {
      this.draftFlushGateActive = false;
      return false;
    }
    const flushing = windows.map((window) => {
      const sessionId = this.sessionIdForWindow(window);
      return sessionId ? this.flushDrafts(window, sessionId, "quit") : Promise.resolve(false);
    });
    let succeeded = (await Promise.all(flushing)).every(Boolean);
    if (succeeded) {
      succeeded = await this.waitForPendingDraftSends();
    }
    if (succeeded) {
      for (const window of windows) {
        if (!window.isDestroyed()) this.allowCloseSessionWindows.add(window);
      }
      return true;
    }
    this.draftFlushGateActive = false;
    for (const candidate of windows) {
      this.releaseDraftFlush(candidate, false);
      this.pendingDraftFlushWindows.delete(candidate);
      this.resolveCloseRequest(candidate, false);
    }
    return false;
  }

  acknowledgeDraftFlush(requestId: string, sender: unknown, success: boolean): boolean {
    return this.draftFlushCoordinator.acknowledge(requestId, sender, success);
  }

  requestCloseSessionWindow(sessionId: string): Promise<boolean> {
    const window = this.sessionWindows.get(sessionId);
    if (!window) {
      return Promise.resolve(false);
    }
    if (window.isDestroyed()) {
      this.releaseWindowClaim(sessionId, window);
      return Promise.resolve(false);
    }

    const pending = this.pendingCloseRequests.get(window);
    if (pending) {
      return pending.promise;
    }
    let resolveRequest!: (closed: boolean) => void;
    let rejectRequest!: (error: unknown) => void;
    const result = new Promise<boolean>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    this.pendingCloseRequests.set(window, {
      promise: result,
      resolve: resolveRequest,
    });
    try {
      window.close();
    } catch (error) {
      this.pendingCloseRequests.delete(window);
      rejectRequest(error);
    }
    return result;
  }

  closeAllSessionWindows(): void {
    // DB reset explicitly discards sessions; ordinary close must still save drafts.
    for (const sessionId of Array.from(this.sessionWindows.keys())) {
      this.discardSessionWindow(sessionId);
    }
  }

  async prepareSnapshotForQuit(): Promise<void> {
    this.snapshotUpdatesSuspended = true;
    await this.persistSnapshotBestEffort(true);
  }

  private async loadSessionWindow(
    sessionId: string,
    window: TWindow,
    auxiliarySessionId: string | null,
  ): Promise<TWindow> {
    try {
      await this.deps.loadChatEntry(window, {
        kind: "agent",
        sessionId,
        ...(auxiliarySessionId ? { auxiliarySessionId } : {}),
      });
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
    if (this.allowCloseSessionWindows.has(window)) {
      this.allowCloseSessionWindows.delete(window);
      return;
    }

    if (this.draftFlushGateActive) {
      event.preventDefault();
      return;
    }

    if (this.deps.isRunInFlight(sessionId)) {
      event.preventDefault();
      if (!this.deps.confirmCloseWhileRunning(window, sessionId)) {
        this.resolveCloseRequest(window, false);
        return;
      }
    }

    if (!this.deps.sendDraftFlushRequest || !this.deps.getWindowSender) {
      if (this.deps.isRunInFlight(sessionId)) {
        this.allowCloseSessionWindows.add(window);
        window.close();
      }
      return;
    }
    if (this.pendingDraftFlushWindows.has(window)) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    this.pendingDraftFlushWindows.add(window);
    const closeFlush = this.flushDrafts(window, sessionId, "close");
    void closeFlush.then((flushed) => {
      if (this.draftFlushes.get(window)?.promise !== closeFlush) {
        // A stronger quit request superseded this close request. Its late ACK
        // must not close the Window or affect a later retry.
        return;
      }
      this.pendingDraftFlushWindows.delete(window);
      if (!flushed || window.isDestroyed()) {
        // A concurrent quit owns the freeze until all its windows have settled.
        if (!this.draftFlushGateActive) this.releaseDraftFlush(window, false);
        this.resolveCloseRequest(window, false);
        return;
      }
      if (this.draftFlushGateActive) {
        // Quit owns the renderer freeze. A normal close ACK must not destroy
        // the renderer while the stronger quit barrier is still settling.
        return;
      }
      this.allowCloseSessionWindows.add(window);
      window.close();
    });
  }

  private releaseWindowClaim(sessionId: string, window: TWindow): void {
    // The closed event runs after BrowserWindow destruction; do not read webContents.
    this.draftFlushCoordinator.forgetWindow(window);
    this.draftFlushes.delete(window);
    this.resolveCloseRequest(window, true);
    this.allowCloseSessionWindows.delete(window);
    this.pendingDraftFlushWindows.delete(window);
    if (this.sessionWindows.get(sessionId) !== window) {
      return;
    }

    this.sessionWindows.delete(sessionId);
    this.deps.onSessionWindowClosed?.(sessionId);
    const wasSnapshotEligible = this.snapshotEligibleWindows.delete(window);
    this.broadcast();
    if (wasSnapshotEligible) {
      void this.persistSnapshotBestEffort();
    }
  }

  private sessionIdForWindow(window: TWindow): string | null {
    for (const [sessionId, candidate] of this.sessionWindows) {
      if (candidate === window) {
        return sessionId;
      }
    }
    return null;
  }

  private flushDrafts(window: TWindow, sessionId: string, reason: DraftFlushReason): Promise<boolean> {
    const pending = this.draftFlushes.get(window);
    if (pending?.pending && (pending.reason === "quit" || reason === "close")) return pending.promise;
    if (!this.deps.sendDraftFlushRequest || !this.deps.getWindowSender) {
      return Promise.resolve(true);
    }
    const request = this.draftFlushCoordinator.request(
      window,
      sessionId,
      this.deps.getWindowSender(window),
      reason,
    );
    const flushing = {
      pending: true,
      reason,
      promise: request.then((success) => {
        flushing.pending = false;
        return success;
      }),
    };
    this.draftFlushes.set(window, flushing);
    return flushing.promise;
  }

  private async waitForPendingDraftSends(): Promise<boolean> {
    if (!this.deps.waitForPendingDraftSends) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => this.deps.waitForPendingDraftSends!())
          .catch(() => false),
        timeoutPromise,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private releaseDraftFlush(window: TWindow, success: boolean): void {
    if (!this.draftFlushes.delete(window) || window.isDestroyed()) return;
    try {
      this.deps.sendDraftFlushRelease?.(window, { success });
    } catch {
      // A destroyed renderer has already lost its freeze channel.
    }
  }

  private resolveCloseRequest(window: TWindow, closed: boolean): void {
    const pending = this.pendingCloseRequests.get(window);
    if (!pending) {
      return;
    }
    this.pendingCloseRequests.delete(window);
    pending.resolve(closed);
  }

  private broadcast(): void {
    this.deps.broadcastOpenSessionWindowIds(this.listOpenSessionWindowIds());
  }

  private async persistSnapshotBestEffort(force = false): Promise<void> {
    if (this.snapshotUpdatesSuspended && !force) {
      return;
    }
    if (!this.deps.persistOpenSessionWindowIds) {
      return;
    }
    try {
      await this.deps.persistOpenSessionWindowIds(this.listSnapshotSessionWindowIds());
    } catch (error) {
      this.deps.onSnapshotPersistenceError?.(error);
    }
  }

  private listSnapshotSessionWindowIds(): string[] {
    return this.listSettledOpenSessionWindowIds();
  }

  private sendAuxiliarySessionNavigation(
    parentSessionId: string,
    auxiliarySessionId: string,
    window: TWindow,
  ): void {
    if (!this.deps.sendAuxiliarySessionNavigation) {
      throw new Error("Auxiliary Session navigation is not wired.");
    }
    this.deps.sendAuxiliarySessionNavigation(window, { parentSessionId, auxiliarySessionId });
  }
}

export type SessionWindowOpenOptions = {
  auxiliarySessionId?: string | null;
};
