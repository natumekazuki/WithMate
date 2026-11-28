import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionNavigationPayload } from "../../src-shared/window/withmate-window-types.js";
import type { ChatEntryMode } from "./window-entry-loader.js";
import {
  DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS,
  DraftFlushCoordinator,
  type DraftFlushReason,
  type DraftFlushRequest,
  type DraftFlushResult,
} from "../platform/draft-flush-coordinator.js";

export type SessionWindowCloseEvent = {
  preventDefault(): void;
};

export type SessionWindowLike = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  minimize(): void;
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
  observeRendererState?(window: TWindow, changed: (state: SessionWindowRendererState) => void): void;
  onDraftFlushSettled?(result: DraftFlushResult): void;
  loadChatEntry(window: TWindow, mode: ChatEntryMode): Promise<void>;
  sendAuxiliarySessionNavigation?(
    window: TWindow,
    payload: AuxiliarySessionNavigationPayload,
  ): void;
  getSession(sessionId: string): Session | null;
  getStorageGeneration?(): object | string | null;
  isRunInFlight(sessionId: string): boolean;
  getTerminalCloseConfirmationCount?(window: TWindow): number;
  confirmCloseWhileRunning(window: TWindow, sessionId: string, signal: AbortSignal): boolean | Promise<boolean>;
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

export type SessionWindowRendererState = "responsive" | "unresponsive" | "gone";

type SessionWindowPresentation<TWindow> = {
  window?: TWindow;
  foreground: boolean;
  presented: boolean;
};

export class SessionWindowBridge<TWindow extends SessionWindowLike> {
  private readonly sessionWindows = new Map<string, TWindow>();
  private readonly windowIdentities = new WeakMap<TWindow, { incarnationId: string; generation: object | string | null }>();
  private readonly homeCrewCloseAttempts = new Map<TWindow, { validate(): boolean; committed: boolean }>();
  private readonly retainedMonitorSessionIds = new Set<string>();
  private readonly retainMonitorOnClose = new Map<TWindow, boolean>();
  private readonly openingSessionWindows = new Map<string, Promise<TWindow>>();
  private readonly windowPresentations = new Map<string, SessionWindowPresentation<TWindow>>();
  private readonly rendererStates = new Map<TWindow, SessionWindowRendererState>();
  private readonly allowCloseSessionWindows = new Set<TWindow>();
  private readonly pendingCloseConfirmations = new Map<TWindow, AbortController>();
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
  private readonly draftFlushCoordinator = new DraftFlushCoordinator<TWindow>(
    (window, request) => this.deps.sendDraftFlushRequest?.(window, request),
    undefined,
    (result) => this.reportDraftFlushResult(result),
  );
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

  listMonitorSessionIds(): string[] {
    return [...new Set([...this.listOpenSessionWindowIds(), ...this.retainedMonitorSessionIds])];
  }

  retainSessionForMonitor(sessionId: string): void {
    this.retainedMonitorSessionIds.add(sessionId);
    const window = this.sessionWindows.get(sessionId);
    // 停止中として閉じる手続きの最中に処理が始まった場合も、後から明示的な終了操作が必要になる。
    if (window && this.retainMonitorOnClose.has(window)) this.retainMonitorOnClose.set(window, true);
  }

  forgetSessionForMonitor(sessionId: string): void {
    this.retainedMonitorSessionIds.delete(sessionId);
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

  getWindowIncarnation(window: TWindow): string | undefined {
    return this.windowIdentities.get(window)?.incarnationId;
  }

  getWindowStorageGeneration(window: TWindow): object | string | null | undefined {
    return this.windowIdentities.get(window)?.generation;
  }

  listOpenSessionWindowIdentities(): { sessionId: string; incarnationId: string }[] {
    return this.listOpenSessionWindowIds().flatMap((sessionId) => {
      const window = this.getWindow(sessionId);
      const incarnationId = window && this.getWindowIncarnation(window);
      return incarnationId ? [{ sessionId, incarnationId }] : [];
    });
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
    const foreground = options.presentation !== "minimized";
    const openingWindow = this.openingSessionWindows.get(sessionId);
    if (openingWindow) {
      const presentation = this.windowPresentations.get(sessionId);
      if (foreground && presentation) {
        presentation.foreground = true;
        if (presentation.presented && presentation.window && !presentation.window.isDestroyed()) {
          this.activateWindow(presentation.window);
        }
      }
      const window = await openingWindow;
      if (auxiliarySessionId) {
        this.sendAuxiliarySessionNavigation(sessionId, auxiliarySessionId, window);
      }
      return window;
    }

    const existingWindow = this.getWindow(sessionId);
    if (existingWindow && (!foreground || this.rendererState(existingWindow) === "responsive")) {
      if (foreground) {
        const presentation = this.windowPresentations.get(sessionId);
        if (presentation) {
          presentation.foreground = true;
          presentation.presented = true;
        }
        this.activateWindow(existingWindow);
      }
      if (auxiliarySessionId) {
        this.sendAuxiliarySessionNavigation(sessionId, auxiliarySessionId, existingWindow);
      }
      return existingWindow;
    }

    const presentation: SessionWindowPresentation<TWindow> = { foreground, presented: false };
    this.windowPresentations.set(sessionId, presentation);
    const openingPromise = existingWindow
      ? this.reopenSessionWindow(sessionId, existingWindow, auxiliarySessionId, presentation)
      : this.createSessionWindow(sessionId, auxiliarySessionId, presentation);
    this.openingSessionWindows.set(sessionId, openingPromise);

    try {
      return await openingPromise;
    } finally {
      if (this.openingSessionWindows.get(sessionId) === openingPromise) {
        this.openingSessionWindows.delete(sessionId);
      }
      if (!presentation.window && this.windowPresentations.get(sessionId) === presentation) {
        this.windowPresentations.delete(sessionId);
      }
    }
  }

  private async createSessionWindow(
    sessionId: string,
    auxiliarySessionId: string | null,
    presentation: SessionWindowPresentation<TWindow>,
  ): Promise<TWindow> {
    const window = this.deps.createWindow(sessionId);
    const session = this.deps.getSession(sessionId);
    if (session) this.windowIdentities.set(window, {
      incarnationId: getSessionIncarnationId(session),
      generation: this.deps.getStorageGeneration?.() ?? null,
    });
    presentation.window = window;
    this.sessionWindows.set(sessionId, window);
    this.broadcast();
    window.once("ready-to-show", () => {
      if (window.isDestroyed() || presentation.presented) return;
      presentation.presented = true;
      if (presentation.foreground) this.activateWindow(window);
      else window.minimize();
    });
    window.on("close", (event) => this.handleWindowClose(sessionId, window, event));
    window.on("closed", () => this.releaseWindowClaim(sessionId, window));
    this.deps.observeRendererState?.(window, (state) => {
      if (this.sessionWindows.get(sessionId) !== window || window.isDestroyed()) return;
      this.rendererStates.set(window, state);
      if (state === "gone") this.draftFlushCoordinator.forgetWindow(window, "renderer-gone");
    });
    const openedWindow = await this.loadSessionWindow(sessionId, window, auxiliarySessionId);
    if (this.sessionWindows.get(sessionId) === window && !window.isDestroyed()) {
      this.snapshotEligibleWindows.add(window);
      void this.persistSnapshotBestEffort();
    }
    return openedWindow;
  }

  private async reopenSessionWindow(
    sessionId: string,
    window: TWindow,
    auxiliarySessionId: string | null,
    presentation: SessionWindowPresentation<TWindow>,
  ): Promise<TWindow> {
    if (this.rendererState(window) === "gone") {
      const closed = new Promise<void>((resolve) => window.on("closed", resolve));
      window.destroy();
      await closed;
    } else if (!(await this.requestCloseSessionWindow(sessionId))) {
      return window;
    }
    if (this.draftFlushGateActive) throw new Error("Session Window open is suspended while drafts are flushing.");
    if (!this.deps.getSession(sessionId)) throw new Error("The session is no longer available.");
    return this.createSessionWindow(sessionId, auxiliarySessionId, presentation);
  }

  private activateWindow(window: TWindow): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private rendererState(window: TWindow): SessionWindowRendererState {
    return this.rendererStates.get(window) ?? "responsive";
  }

  async openAuxiliarySessionWindow(parentSessionId: string, auxiliarySessionId: string): Promise<TWindow> {
    return this.openSessionWindow(parentSessionId, { auxiliarySessionId });
  }

  closeSessionWindow(sessionId: string): void {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) {
      this.sessionWindows.delete(sessionId);
      if (this.windowPresentations.get(sessionId)?.window === window) this.windowPresentations.delete(sessionId);
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
    this.forgetSessionForMonitor(sessionId);
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) return;
    this.retainMonitorOnClose.set(window, false);
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
      for (const window of windows) {
        this.cancelCloseConfirmation(window);
        this.resolveCloseRequest(window, false);
      }
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
      this.cancelCloseConfirmation(candidate);
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

  /** 範囲と影響の同期確認を指定できるのは、Home の Crew 子孫に対する操作だけ。 */
  async closeHomeCrewDescendantWindow(sessionId: string, window: TWindow, validateBatch: () => boolean): Promise<"closed" | "already-closed" | "blocked"> {
    if (this.getWindow(sessionId) !== window || this.draftFlushGateActive
      || this.pendingCloseConfirmations.has(window) || this.pendingCloseRequests.has(window)
      || this.pendingDraftFlushWindows.has(window)) return window.isDestroyed() ? "already-closed" : "blocked";
    const attempt = { validate: validateBatch, committed: false };
    this.homeCrewCloseAttempts.set(window, attempt);
    try {
      const closed = await this.requestCloseSessionWindow(sessionId);
      if (!window.isDestroyed()) return "blocked";
      return closed && attempt.committed ? "closed" : "already-closed";
    } finally {
      this.homeCrewCloseAttempts.delete(window);
    }
  }

  closeAllSessionWindows(): void {
    // DB リセットは Session を明示的に破棄する。通常のウィンドウ終了では先に下書きの保存を試みる。
    this.retainedMonitorSessionIds.clear();
    for (const sessionId of Array.from(this.sessionWindows.keys())) {
      this.discardSessionWindow(sessionId);
    }
  }

  async prepareSnapshotForQuit(): Promise<void> {
    this.snapshotUpdatesSuspended = true;
    void this.persistSnapshotBestEffort(true);
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

    if (this.pendingCloseConfirmations.has(window) || this.pendingDraftFlushWindows.has(window)) {
      event.preventDefault();
      return;
    }

    const hasRunningSession = this.deps.isRunInFlight(sessionId);
    const crewClose = this.homeCrewCloseAttempts.get(window);
    if (crewClose && !crewClose.validate()) {
      event.preventDefault();
      this.resolveCloseRequest(window, false);
      return;
    }
    // 確認や保存の前に実行状態を捕捉する。実行が完了しても、
    // 実行中として始めたウィンドウ終了を停止中の終了に切り替え、監視を打ち切ってはならない。
    this.retainMonitorOnClose.set(window, hasRunningSession);
    const hasTerminalsRequiringConfirmation = (this.deps.getTerminalCloseConfirmationCount?.(window) ?? 0) > 0;
    if (!crewClose && (hasRunningSession || hasTerminalsRequiringConfirmation)) {
      event.preventDefault();
      const confirmation = new AbortController();
      this.pendingCloseConfirmations.set(window, confirmation);
      void this.confirmWindowClose(sessionId, window, confirmation);
      return;
    }

    if (!this.deps.sendDraftFlushRequest || !this.deps.getWindowSender) {
      if (crewClose) crewClose.committed = true;
      return;
    }
    event.preventDefault();
    this.startCloseDraftFlush(sessionId, window);
  }

  private async confirmWindowClose(sessionId: string, window: TWindow, confirmation: AbortController): Promise<void> {
    let approved = false;
    try {
      approved = await this.deps.confirmCloseWhileRunning(window, sessionId, confirmation.signal);
    } catch (error) {
      if (!confirmation.signal.aborted) console.error("Session Window close confirmation failed:", error);
    }
    if (this.pendingCloseConfirmations.get(window) !== confirmation) return;
    this.pendingCloseConfirmations.delete(window);
    if (this.sessionWindows.get(sessionId) !== window || window.isDestroyed() || this.draftFlushGateActive) return;
    if (!approved) {
      this.retainMonitorOnClose.delete(window);
      this.resolveCloseRequest(window, false);
      return;
    }
    if (!this.deps.sendDraftFlushRequest || !this.deps.getWindowSender) {
      this.allowCloseSessionWindows.add(window);
      try { window.close(); }
      catch (error) {
        this.allowCloseSessionWindows.delete(window);
        this.retainMonitorOnClose.delete(window);
        this.resolveCloseRequest(window, false);
        console.error("Session Window close failed after confirmation:", error);
      }
      return;
    }
    this.startCloseDraftFlush(sessionId, window);
  }

  private startCloseDraftFlush(sessionId: string, window: TWindow): void {
    const crewClose = this.homeCrewCloseAttempts.get(window);
    this.pendingDraftFlushWindows.add(window);
    const closeFlush = this.flushDrafts(window, sessionId, "close");
    void closeFlush.then((flushed) => {
      if (this.draftFlushes.get(window)?.promise !== closeFlush) {
        // より優先度の高いアプリ終了要求が、このウィンドウ終了要求に取って代わった。
        // 遅れて届く ACK でウィンドウを閉じたり、後続の再試行に影響を与えたりしてはならない。
        return;
      }
      this.pendingDraftFlushWindows.delete(window);
      if (window.isDestroyed()) {
        // 並行するアプリ終了処理が、そのすべてのウィンドウの処理が確定するまで凍結を管理する。
        if (!this.draftFlushGateActive) this.releaseDraftFlush(window, false);
        this.resolveCloseRequest(window, false);
        return;
      }
      if (this.draftFlushGateActive) {
        // renderer の凍結はアプリ終了処理が管理する。より強いアプリ終了の待機条件が確定するまでは、
        // 通常のウィンドウ終了の ACK で renderer を破棄してはならない。
        return;
      }
      try {
        if (crewClose && !crewClose.validate()) {
          this.retainMonitorOnClose.delete(window);
          this.releaseDraftFlush(window, false);
          this.resolveCloseRequest(window, false);
          return;
        }
        if (crewClose) crewClose.committed = true;
        if (!flushed || this.rendererState(window) !== "responsive") {
          // 破棄するのは入力画面だけ。プロバイダーの実行と永続化は Main が担う。
          window.destroy();
        } else {
          this.allowCloseSessionWindows.add(window);
          window.close();
        }
      } catch {
        this.allowCloseSessionWindows.delete(window);
        this.retainMonitorOnClose.delete(window);
        this.releaseDraftFlush(window, false);
        this.resolveCloseRequest(window, false);
      }
    });
  }

  private releaseWindowClaim(sessionId: string, window: TWindow): void {
    // closed イベントは BrowserWindow の破棄後に発生するため、webContents を参照しない。
    this.draftFlushCoordinator.forgetWindow(window);
    this.draftFlushes.delete(window);
    this.rendererStates.delete(window);
    this.resolveCloseRequest(window, true);
    this.allowCloseSessionWindows.delete(window);
    this.cancelCloseConfirmation(window);
    this.pendingDraftFlushWindows.delete(window);
    const retainOnClose = this.retainMonitorOnClose.get(window);
    this.retainMonitorOnClose.delete(window);
    if (this.sessionWindows.get(sessionId) !== window) {
      return;
    }

    this.sessionWindows.delete(sessionId);
    if (this.windowPresentations.get(sessionId)?.window === window) this.windowPresentations.delete(sessionId);
    if (retainOnClose || this.deps.isRunInFlight(sessionId)) {
      this.retainedMonitorSessionIds.add(sessionId);
    } else if (retainOnClose === false) {
      this.retainedMonitorSessionIds.delete(sessionId);
    }
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
    let request: Promise<boolean>;
    if (this.rendererState(window) === "gone") {
      this.reportDraftFlushResult({ reason, outcome: "renderer-gone", elapsedMs: 0 });
      request = Promise.resolve(false);
    } else {
      try {
        request = this.draftFlushCoordinator.request(window, sessionId, this.deps.getWindowSender(window), reason);
      } catch {
        this.reportDraftFlushResult({ reason, outcome: "send-failed", elapsedMs: 0 });
        request = Promise.resolve(false);
      }
    }
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

  private reportDraftFlushResult(result: DraftFlushResult): void {
    try {
      this.deps.onDraftFlushSettled?.(result);
    } catch {
      // 診断が下書きの保存結果を変えたり、ウィンドウの終了を妨げたりしてはならない。
    }
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
      // 破棄された renderer では、凍結を制御するチャネルは既に失われている。
    }
  }

  private cancelCloseConfirmation(window: TWindow): void {
    const confirmation = this.pendingCloseConfirmations.get(window);
    if (!confirmation) return;
    this.pendingCloseConfirmations.delete(window);
    confirmation.abort();
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
  presentation?: "minimized";
};
