import {
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionNavigationPayload } from "../../src-shared/window/withmate-window-types.js";
import type { ChatEntryMode } from "./window-entry-loader.js";
import {
  DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS,
  DraftFlushCoordinator,
  type DraftFlushReason,
  type DraftFlushRequest,
  type DraftFlushResult,
} from "../platform/draft-flush-coordinator.js";

/** Session ウィンドウの閉鎖を保留できるネイティブイベントの部分契約。 */
export type SessionWindowCloseEvent = {
  /** 下書き保存やユーザー確認へ進む間、その閉鎖イベントでの破棄を止める。 */
  preventDefault(): void;
};

/** Session の表示・非表示と終了の所有権を追跡するために必要なウィンドウ操作。 */
export type SessionWindowLike = {
  /** 既に破棄されたウィンドウを再利用や保存から外すための状態。 */
  isDestroyed(): boolean;
  /** 前面表示の前に最小化を解除する必要があるか確認する。 */
  isMinimized(): boolean;
  /** 復元時に既存の前面作業を奪わず最小化して表示する。 */
  minimize(): void;
  /** 最小化状態を解除し、明示的に開く要求に応じられるようにする。 */
  restore(): void;
  /** 表示中の会話ウィンドウへ入力フォーカスを移す。 */
  focus(): void;
  /** 会話ウィンドウを可視にする。フォーカスは別に指定する。 */
  show(): void;
  /** 確認・下書き保存の対象となる通常の閉鎖イベントを起こす。 */
  close(): void;
  /** 通常の閉鎖手順を続けられないウィンドウを破棄する。 */
  destroy(): void;
  /** 初回表示可能になったときの処理を一回だけ登録する。 */
  once(event: "ready-to-show", listener: () => void): void;
  /** 実行中の確認や下書き保存のために閉鎖イベントを受け取る。 */
  on(event: "close", listener: (event: SessionWindowCloseEvent) => void): void;
  /** 実際の破棄後に、Session とウィンドウの関連を解放する処理を登録する。 */
  on(event: "closed", listener: () => void): void;
};

/** ウィンドウの生成・読込、永続化、実行状況と終了前の調停をつなぐ操作。 */
export type SessionWindowBridgeDeps<TWindow extends SessionWindowLike> = {
  /** 指定 Session の会話を表示する新しいウィンドウを作る。 */
  createWindow(sessionId: string): TWindow;
  /** 下書き保存を継続できるか判断するため、renderer の応答状態の変化を受け取る。 */
  observeRendererState?(
    window: TWindow,
    changed: (state: SessionWindowRendererState) => void,
  ): void;
  /** 下書き保存要求の結果を診断に渡す。保存の成否はこの通知に依存しない。 */
  onDraftFlushSettled?(result: DraftFlushResult): void;
  /** Main と、指定されていれば選択中の Auxiliary を含む会話エントリを読み込む。 */
  loadChatEntry(window: TWindow, mode: ChatEntryMode): Promise<void>;
  /** 親の会話を開き直さず、renderer 内で選択中の Auxiliary を変更するよう送る。 */
  sendAuxiliarySessionNavigation?(
    window: TWindow,
    payload: AuxiliarySessionNavigationPayload,
  ): void;
  /** 表示・再作成の対象となる現在の Session を取得する。 */
  getSession(sessionId: string): Session | null;
  /** ウィンドウ生成時点で所属するストレージ世代を識別できる値を取得する。 */
  getStorageGeneration?(): object | string | null;
  /** 閉鎖確認と閉鎖後の監視保持に使う実行状態を取得する。 */
  isRunInFlight(sessionId: string): boolean;
  /** 閉鎖前の確認が必要な端末の数を対象ウィンドウから取得する。 */
  getTerminalCloseConfirmationCount?(window: TWindow): number;
  /** 実行や端末を伴う閉鎖の確認結果を返す。閉鎖試行が失効した場合は signal で中止できる。 */
  confirmCloseWhileRunning(
    window: TWindow,
    sessionId: string,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  /** 現在開いている Session の ID を通知する。初回読み込み中のウィンドウも含む。 */
  broadcastOpenSessionWindowIds(openSessionIds: string[]): void;
  /** 初回読み込み済みの ID を、次回起動の復元候補として保存する。 */
  persistOpenSessionWindowIds?(
    openSessionIds: readonly string[],
  ): Promise<void>;
  /** 復元候補の保存失敗を、表示や閉鎖の結果とは別に通知する。 */
  onSnapshotPersistenceError?(error: unknown): void;
  /** 対象 Session の現在のウィンドウが閉じられ、登録が解除されたことを通知する。 */
  onSessionWindowClosed?(sessionId: string): void;
  /** 会話ウィンドウに、閉鎖または終了前の下書き保存を要求する。 */
  sendDraftFlushRequest?(window: TWindow, request: DraftFlushRequest): void;
  /** 閉鎖や終了を中止した場合などに、renderer の入力制限を解除する。 */
  sendDraftFlushRelease?(window: TWindow, payload: { success: boolean }): void;
  /** 下書き保存の応答を照合するため、要求先ウィンドウの送信主体を返す。 */
  getWindowSender?(window: TWindow): unknown;
  /** renderer の保存確認後、送信中の下書き処理の確定を待つ。 */
  waitForPendingDraftSends?(): Promise<boolean>;
  /** アプリ終了時に、プロバイダーで実行中の Session へ停止を要求する。 */
  cancelInFlightSessionRuns?(): void;
};

/** 復元時に、初回読み込み済みのウィンドウと生成中のウィンドウを区別する状態。 */
export type SessionWindowRestoreState =
  { kind: "settled-open" } | { kind: "opening" };

/** 下書き保存や再表示を続けられるか判断するための renderer の応答状態。 */
export type SessionWindowRendererState = "responsive" | "unresponsive" | "gone";

/** 生成中のウィンドウに対する表示方法の希望と、初回表示を実行したかの記録。 */
type SessionWindowPresentation<TWindow> = {
  window?: TWindow;
  foreground: boolean;
  presented: boolean;
};

/** Session とウィンドウの対応を所有し、表示、監視、通常の閉鎖とアプリ終了を調停する。 */
export class SessionWindowBridge<TWindow extends SessionWindowLike> {
  private readonly sessionWindows = new Map<string, TWindow>();
  private readonly windowIdentities = new WeakMap<
    TWindow,
    { incarnationId: string; generation: object | string | null }
  >();
  private readonly homeCrewCloseAttempts = new Map<
    TWindow,
    {
      /** 一括閉鎖の範囲と影響が、実際の閉鎖を許可する時点でも同じか判定する。 */ validate(): boolean;
      committed: boolean;
    }
  >();
  private readonly retainedMonitorSessionIds = new Set<string>();
  private readonly retainMonitorOnClose = new Map<TWindow, boolean>();
  private readonly openingSessionWindows = new Map<string, Promise<TWindow>>();
  private readonly windowPresentations = new Map<
    string,
    SessionWindowPresentation<TWindow>
  >();
  private readonly rendererStates = new Map<
    TWindow,
    SessionWindowRendererState
  >();
  private readonly allowCloseSessionWindows = new Set<TWindow>();
  private readonly pendingCloseConfirmations = new Map<
    TWindow,
    AbortController
  >();
  private readonly snapshotEligibleWindows = new Set<TWindow>();
  private readonly pendingCloseRequests = new Map<
    TWindow,
    {
      promise: Promise<boolean>;
      resolve: (closed: boolean) => void;
    }
  >();
  private readonly pendingDraftFlushWindows = new Set<TWindow>();
  private readonly draftFlushes = new Map<
    TWindow,
    {
      promise: Promise<boolean>;
      pending: boolean;
      reason: DraftFlushReason;
    }
  >();
  private draftFlushGateActive = false;
  private readonly draftFlushCoordinator = new DraftFlushCoordinator<TWindow>(
    (window, request) => this.deps.sendDraftFlushRequest?.(window, request),
    undefined,
    (result) => this.reportDraftFlushResult(result),
  );
  private snapshotUpdatesSuspended = false;

  /** ウィンドウ操作と Session 状態への接続を受け取り、ウィンドウは要求を受けるまで作らない。 */
  constructor(private readonly deps: SessionWindowBridgeDeps<TWindow>) {}

  /** アプリ終了処理が新規ウィンドウ作成と通常閉鎖を止めているかを返す。 */
  isQuitPending(): boolean {
    return this.draftFlushGateActive;
  }

  /** 現在登録され、破棄されていないウィンドウの Session ID を列挙する。読み込みの完了は条件にしない。 */
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

  /** 開いている Session に、閉鎖後も監視を保持する Session を重複なく加える。 */
  listMonitorSessionIds(): string[] {
    return [
      ...new Set([
        ...this.listOpenSessionWindowIds(),
        ...this.retainedMonitorSessionIds,
      ]),
    ];
  }

  /** Session を監視に残し、閉鎖手続き中に開始した実行も見失わないようにする。 */
  retainSessionForMonitor(sessionId: string): void {
    this.retainedMonitorSessionIds.add(sessionId);
    const window = this.sessionWindows.get(sessionId);
    // 停止中として閉じる手続きの最中に処理が始まった場合も、後から明示的な終了操作が必要になる。
    if (window && this.retainMonitorOnClose.has(window))
      this.retainMonitorOnClose.set(window, true);
  }

  /** 閉鎖後も残していた監視対象から指定 Session を外す。ウィンドウ自体は操作しない。 */
  forgetSessionForMonitor(sessionId: string): void {
    this.retainedMonitorSessionIds.delete(sessionId);
  }

  /** 破棄されておらず、初回読み込みが完了した復元保存対象だけを列挙する。 */
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

  /** 復元開始時に既存ウィンドウを再利用するため、生成中と読み込み済みの状態を投影する。 */
  getSessionWindowRestoreStates(): ReadonlyMap<
    string,
    SessionWindowRestoreState
  > {
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

  /** 指定 Session に現在紐付いていて、まだ破棄されていないウィンドウだけを返す。 */
  getWindow(sessionId: string): TWindow | null {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) {
      return null;
    }

    return window;
  }

  /** ウィンドウの生成時に捕捉した incarnation を返す。識別情報がなければ undefined を返す。 */
  getWindowIncarnation(window: TWindow): string | undefined {
    return this.windowIdentities.get(window)?.incarnationId;
  }

  /** ウィンドウの生成時点のストレージ世代を返す。未登録のウィンドウは undefined。 */
  getWindowStorageGeneration(
    window: TWindow,
  ): object | string | null | undefined {
    return this.windowIdentities.get(window)?.generation;
  }

  /** 開いている Session のうち、incarnation まで照合可能なものだけを列挙する。 */
  listOpenSessionWindowIdentities(): {
    sessionId: string;
    incarnationId: string;
  }[] {
    return this.listOpenSessionWindowIds().flatMap((sessionId) => {
      const window = this.getWindow(sessionId);
      const incarnationId = window && this.getWindowIncarnation(window);
      return incarnationId ? [{ sessionId, incarnationId }] : [];
    });
  }

  /** 現在登録されていて破棄されていない会話ウィンドウを取得する。 */
  listWindows(): TWindow[] {
    return Array.from(this.sessionWindows.values()).filter(
      (window) => !window.isDestroyed(),
    );
  }

  /** Session ごとに生成中の処理へ合流するか既存ウィンドウを再利用し、明示的な前面表示を最小化より優先する。 */
  async openSessionWindow(
    sessionId: string,
    options: SessionWindowOpenOptions = {},
  ): Promise<TWindow> {
    if (this.draftFlushGateActive) {
      throw new Error(
        "Session Window open is suspended while drafts are flushing.",
      );
    }
    const auxiliarySessionId = options.auxiliarySessionId?.trim() || null;
    const foreground = options.presentation !== "minimized";
    const openingWindow = this.openingSessionWindows.get(sessionId);
    if (openingWindow) {
      const presentation = this.windowPresentations.get(sessionId);
      if (foreground && presentation) {
        presentation.foreground = true;
        if (
          presentation.presented &&
          presentation.window &&
          !presentation.window.isDestroyed()
        ) {
          this.activateWindow(presentation.window);
        }
      }
      const window = await openingWindow;
      if (auxiliarySessionId) {
        this.sendAuxiliarySessionNavigation(
          sessionId,
          auxiliarySessionId,
          window,
        );
      }
      return window;
    }

    const existingWindow = this.getWindow(sessionId);
    if (
      existingWindow &&
      (!foreground || this.rendererState(existingWindow) === "responsive")
    ) {
      if (foreground) {
        const presentation = this.windowPresentations.get(sessionId);
        if (presentation) {
          presentation.foreground = true;
          presentation.presented = true;
        }
        this.activateWindow(existingWindow);
      }
      if (auxiliarySessionId) {
        this.sendAuxiliarySessionNavigation(
          sessionId,
          auxiliarySessionId,
          existingWindow,
        );
      }
      return existingWindow;
    }

    const presentation: SessionWindowPresentation<TWindow> = {
      foreground,
      presented: false,
    };
    this.windowPresentations.set(sessionId, presentation);
    const openingPromise = existingWindow
      ? this.reopenSessionWindow(
          sessionId,
          existingWindow,
          auxiliarySessionId,
          presentation,
        )
      : this.createSessionWindow(sessionId, auxiliarySessionId, presentation);
    this.openingSessionWindows.set(sessionId, openingPromise);

    try {
      return await openingPromise;
    } finally {
      if (this.openingSessionWindows.get(sessionId) === openingPromise) {
        this.openingSessionWindows.delete(sessionId);
      }
      if (
        !presentation.window &&
        this.windowPresentations.get(sessionId) === presentation
      ) {
        this.windowPresentations.delete(sessionId);
      }
    }
  }

  /** Session の識別情報を捕捉してウィンドウを登録し、初回読み込みに成功したものだけを復元保存の対象にする。 */
  private async createSessionWindow(
    sessionId: string,
    auxiliarySessionId: string | null,
    presentation: SessionWindowPresentation<TWindow>,
  ): Promise<TWindow> {
    const window = this.deps.createWindow(sessionId);
    const session = this.deps.getSession(sessionId);
    if (session)
      this.windowIdentities.set(window, {
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
    window.on("close", (event) =>
      this.handleWindowClose(sessionId, window, event),
    );
    window.on("closed", () => this.releaseWindowClaim(sessionId, window));
    this.deps.observeRendererState?.(window, (state) => {
      if (this.sessionWindows.get(sessionId) !== window || window.isDestroyed())
        return;
      this.rendererStates.set(window, state);
      if (state === "gone")
        this.draftFlushCoordinator.forgetWindow(window, "renderer-gone");
    });
    const openedWindow = await this.loadSessionWindow(
      sessionId,
      window,
      auxiliarySessionId,
    );
    if (
      this.sessionWindows.get(sessionId) === window &&
      !window.isDestroyed()
    ) {
      this.snapshotEligibleWindows.add(window);
      void this.persistSnapshotBestEffort();
    }
    return openedWindow;
  }

  /** 応答不能なウィンドウの閉鎖・破棄を待って再作成する。通常の閉鎖を取り消した場合は現在のウィンドウを維持する。 */
  private async reopenSessionWindow(
    sessionId: string,
    window: TWindow,
    auxiliarySessionId: string | null,
    presentation: SessionWindowPresentation<TWindow>,
  ): Promise<TWindow> {
    if (this.rendererState(window) === "gone") {
      const closed = new Promise<void>((resolve) =>
        window.on("closed", resolve),
      );
      window.destroy();
      await closed;
    } else if (!(await this.requestCloseSessionWindow(sessionId))) {
      return window;
    }
    if (this.draftFlushGateActive)
      throw new Error(
        "Session Window open is suspended while drafts are flushing.",
      );
    if (!this.deps.getSession(sessionId))
      throw new Error("The session is no longer available.");
    return this.createSessionWindow(
      sessionId,
      auxiliarySessionId,
      presentation,
    );
  }

  /** 最小化を解除し、会話ウィンドウを表示してフォーカスを移す。 */
  private activateWindow(window: TWindow): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /** 最後に観測した renderer の状態を返す。まだ観測していない場合は応答可能として扱う。 */
  private rendererState(window: TWindow): SessionWindowRendererState {
    return this.rendererStates.get(window) ?? "responsive";
  }

  /** Auxiliary 専用ウィンドウは作らず、親 Session の会話を対象の Auxiliary 選択で開く。 */
  async openAuxiliarySessionWindow(
    parentSessionId: string,
    auxiliarySessionId: string,
  ): Promise<TWindow> {
    return this.openSessionWindow(parentSessionId, { auxiliarySessionId });
  }

  /** 生きているウィンドウに通常の閉鎖を要求する。既にない場合は古い登録を整理して開閉集合を通知する。 */
  closeSessionWindow(sessionId: string): void {
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) {
      this.sessionWindows.delete(sessionId);
      if (this.windowPresentations.get(sessionId)?.window === window)
        this.windowPresentations.delete(sessionId);
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

  /** 通常の下書き保存・終了確認を通さず、破棄が許可された Session のウィンドウを閉じる。 */
  discardSessionWindow(sessionId: string): void {
    this.forgetSessionForMonitor(sessionId);
    const window = this.sessionWindows.get(sessionId);
    if (!window || window.isDestroyed()) return;
    this.retainMonitorOnClose.set(window, false);
    this.allowCloseSessionWindows.add(window);
    window.close();
  }

  /** アプリ終了のために全会話ウィンドウの下書き保存と送信確定を待つ。失敗時は入力を解放して終了を継続しない。 */
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
      return sessionId
        ? this.flushDrafts(window, sessionId, "quit")
        : Promise.resolve(false);
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

  /** renderer の応答を要求 ID と送信元で照合し、同じ要求の結果を確定する。 */
  acknowledgeDraftFlush(
    requestId: string,
    sender: unknown,
    success: boolean,
  ): boolean {
    return this.draftFlushCoordinator.acknowledge(requestId, sender, success);
  }

  /** 通常の閉鎖手順を起動し、同じウィンドウへの重複要求は一つの完了結果を共有する。 */
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
  async closeHomeCrewDescendantWindow(
    sessionId: string,
    window: TWindow,
    validateBatch: () => boolean,
  ): Promise<"closed" | "already-closed" | "blocked"> {
    if (
      this.getWindow(sessionId) !== window ||
      this.draftFlushGateActive ||
      this.pendingCloseConfirmations.has(window) ||
      this.pendingCloseRequests.has(window) ||
      this.pendingDraftFlushWindows.has(window)
    )
      return window.isDestroyed() ? "already-closed" : "blocked";
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

  /** ストレージリセットなどで、全 Session ウィンドウと監視保持を通常の保存手順なしで破棄する。 */
  closeAllSessionWindows(): void {
    // DB リセットは Session を明示的に破棄する。通常のウィンドウ終了では先に下書きの保存を試みる。
    this.retainedMonitorSessionIds.clear();
    for (const sessionId of Array.from(this.sessionWindows.keys())) {
      this.discardSessionWindow(sessionId);
    }
  }

  /** 終了直前の復元候補の保存を開始し、終了でウィンドウが閉じても候補を書き換えない。 */
  async prepareSnapshotForQuit(): Promise<void> {
    this.snapshotUpdatesSuspended = true;
    void this.persistSnapshotBestEffort(true);
  }

  /** 指定の会話を読み込む。失敗時は登録を解放してウィンドウを破棄し、読み込み失敗を呼び出し元へ返す。 */
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

  /** 既に許可された閉鎖を通し、それ以外は終了ゲート、実行・端末の確認と下書き保存の順に判定する。 */
  private handleWindowClose(
    sessionId: string,
    window: TWindow,
    event: SessionWindowCloseEvent,
  ): void {
    if (this.allowCloseSessionWindows.has(window)) {
      this.allowCloseSessionWindows.delete(window);
      return;
    }

    if (this.draftFlushGateActive) {
      event.preventDefault();
      return;
    }

    if (
      this.pendingCloseConfirmations.has(window) ||
      this.pendingDraftFlushWindows.has(window)
    ) {
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
    const hasTerminalsRequiringConfirmation =
      (this.deps.getTerminalCloseConfirmationCount?.(window) ?? 0) > 0;
    if (
      !crewClose &&
      (hasRunningSession || hasTerminalsRequiringConfirmation)
    ) {
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

  /** 同じ確認試行が現在も有効な場合だけ承認を適用し、次の下書き保存または閉鎖へ進む。 */
  private async confirmWindowClose(
    sessionId: string,
    window: TWindow,
    confirmation: AbortController,
  ): Promise<void> {
    let approved = false;
    try {
      approved = await this.deps.confirmCloseWhileRunning(
        window,
        sessionId,
        confirmation.signal,
      );
    } catch (error) {
      if (!confirmation.signal.aborted)
        console.error("Session Window close confirmation failed:", error);
    }
    if (this.pendingCloseConfirmations.get(window) !== confirmation) return;
    this.pendingCloseConfirmations.delete(window);
    if (
      this.sessionWindows.get(sessionId) !== window ||
      window.isDestroyed() ||
      this.draftFlushGateActive
    )
      return;
    if (!approved) {
      this.retainMonitorOnClose.delete(window);
      this.resolveCloseRequest(window, false);
      return;
    }
    if (!this.deps.sendDraftFlushRequest || !this.deps.getWindowSender) {
      this.allowCloseSessionWindows.add(window);
      try {
        window.close();
      } catch (error) {
        this.allowCloseSessionWindows.delete(window);
        this.retainMonitorOnClose.delete(window);
        this.resolveCloseRequest(window, false);
        console.error("Session Window close failed after confirmation:", error);
      }
      return;
    }
    this.startCloseDraftFlush(sessionId, window);
  }

  /** 個別ウィンドウの下書き保存応答を待つ。より優先される終了処理や一括閉鎖条件の変化があれば、古い応答では閉じない。 */
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

  /** 破棄されたウィンドウの待機処理と登録を片付ける。置き換えられたウィンドウの登録には触れない。 */
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
    if (this.windowPresentations.get(sessionId)?.window === window)
      this.windowPresentations.delete(sessionId);
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

  /** ウィンドウの現在の登録を照合し、所有する Session ID を返す。 */
  private sessionIdForWindow(window: TWindow): string | null {
    for (const [sessionId, candidate] of this.sessionWindows) {
      if (candidate === window) {
        return sessionId;
      }
    }
    return null;
  }

  /** 下書き保存待ちを再利用する。個別閉鎖にアプリ終了が重なった場合は終了用の要求を優先する。 */
  private flushDrafts(
    window: TWindow,
    sessionId: string,
    reason: DraftFlushReason,
  ): Promise<boolean> {
    const pending = this.draftFlushes.get(window);
    if (pending?.pending && (pending.reason === "quit" || reason === "close"))
      return pending.promise;
    if (!this.deps.sendDraftFlushRequest || !this.deps.getWindowSender) {
      return Promise.resolve(true);
    }
    let request: Promise<boolean>;
    if (this.rendererState(window) === "gone") {
      this.reportDraftFlushResult({
        reason,
        outcome: "renderer-gone",
        elapsedMs: 0,
      });
      request = Promise.resolve(false);
    } else {
      try {
        request = this.draftFlushCoordinator.request(
          window,
          sessionId,
          this.deps.getWindowSender(window),
          reason,
        );
      } catch {
        this.reportDraftFlushResult({
          reason,
          outcome: "send-failed",
          elapsedMs: 0,
        });
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

  /** 下書き保存の分類と時間を診断先へ渡し、診断の例外を保存手順に伝えない。 */
  private reportDraftFlushResult(result: DraftFlushResult): void {
    try {
      this.deps.onDraftFlushSettled?.(result);
    } catch {
      // 診断が下書きの保存結果を変えたり、ウィンドウの終了を妨げたりしてはならない。
    }
  }

  /** 保留中の下書き送信を終了用の期限まで待ち、例外・期限超過を false にまとめる。 */
  private async waitForPendingDraftSends(): Promise<boolean> {
    if (!this.deps.waitForPendingDraftSends) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeout = setTimeout(
        () => resolve(false),
        DEFAULT_QUIT_DRAFT_FLUSH_TIMEOUT_MS,
      );
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

  /** 保存待ちの登録を解除し、まだ生きている対象に入力制限の解除を通知する。 */
  private releaseDraftFlush(window: TWindow, success: boolean): void {
    if (!this.draftFlushes.delete(window) || window.isDestroyed()) return;
    try {
      this.deps.sendDraftFlushRelease?.(window, { success });
    } catch {
      // 破棄された renderer では、凍結を制御するチャネルは既に失われている。
    }
  }

  /** 現在の閉鎖確認を登録から外してから中止し、遅い確認結果を適用させない。 */
  private cancelCloseConfirmation(window: TWindow): void {
    const confirmation = this.pendingCloseConfirmations.get(window);
    if (!confirmation) return;
    this.pendingCloseConfirmations.delete(window);
    confirmation.abort();
  }

  /** 保留中の閉鎖要求があれば、登録を除いて結果を一度だけ返す。 */
  private resolveCloseRequest(window: TWindow, closed: boolean): void {
    const pending = this.pendingCloseRequests.get(window);
    if (!pending) {
      return;
    }
    this.pendingCloseRequests.delete(window);
    pending.resolve(closed);
  }

  /** 初回読み込み中を含む現在の開閉集合を購読側に通知する。 */
  private broadcast(): void {
    this.deps.broadcastOpenSessionWindowIds(this.listOpenSessionWindowIds());
  }

  /** 完全に開いたウィンドウの復元候補を保存する。通常更新の停止中は終了時の明示保存だけを許す。 */
  private async persistSnapshotBestEffort(force = false): Promise<void> {
    if (this.snapshotUpdatesSuspended && !force) {
      return;
    }
    if (!this.deps.persistOpenSessionWindowIds) {
      return;
    }
    try {
      await this.deps.persistOpenSessionWindowIds(
        this.listSnapshotSessionWindowIds(),
      );
    } catch (error) {
      this.deps.onSnapshotPersistenceError?.(error);
    }
  }

  /** 復元用スナップショットに載せる、読み込みが確定した Session ID を返す。 */
  private listSnapshotSessionWindowIds(): string[] {
    return this.listSettledOpenSessionWindowIds();
  }

  /** 既存の親ウィンドウに Auxiliary の選択を通知する。配送経路が未設定ならエラーとする。 */
  private sendAuxiliarySessionNavigation(
    parentSessionId: string,
    auxiliarySessionId: string,
    window: TWindow,
  ): void {
    if (!this.deps.sendAuxiliarySessionNavigation) {
      throw new Error("Auxiliary Session navigation is not wired.");
    }
    this.deps.sendAuxiliarySessionNavigation(window, {
      parentSessionId,
      auxiliarySessionId,
    });
  }
}

/** 開く Session の表示先となる Auxiliary と、復元時の最小化指定。 */
export type SessionWindowOpenOptions = {
  auxiliarySessionId?: string | null;
  presentation?: "minimized";
};
