import { BrowserWindow, dialog } from "electron";
import type { Session } from "../../src-shared/session/session-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { DraftFlushResult } from "../platform/draft-flush-coordinator.js";
import type { SessionFilePreviewWindowPayload } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { WITHMATE_SESSION_FILE_PREVIEW_WINDOWS_CHANGED_EVENT } from "../../src-shared/ipc/withmate-ipc-channels.js";
import {
  WITHMATE_OPEN_AUXILIARY_SESSION_EVENT,
  WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT,
  WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT,
  WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { MainWindowComposition } from "./main-window-composition.js";
import { WindowBroadcastService } from "./window-broadcast-service.js";
import { WindowDialogService } from "./window-dialog-service.js";
import { WindowEntryLoader } from "./window-entry-loader.js";
import { SessionWindowBridge } from "./session-window-bridge.js";
import { SessionWindowRestoreService } from "./session-window-restore-service.js";
import { SessionWindowRestoreStorage } from "./session-window-restore-storage.js";
import { AuxWindowService } from "../auxiliary/aux-window-service.js";
import {
  HOME_WINDOW_DEFAULT_BOUNDS,
  SESSION_WINDOW_DEFAULT_BOUNDS,
} from "./window-defaults.js";

/** Electron のウィンドウを、Main の実行状態・永続データ・閉鎖確認に接続する入力。 */
export type MainWindowRuntimeDeps = {
  composition: MainWindowComposition;
  devServerUrl?: string;
  rendererDistPath: string;
  userDataPath: string;
  /** ウィンドウの生成・終了で使う、Main が現在保持する Session を読む。 */
  getSession(sessionId: string): Session | null;
  /** ウィンドウが現在のストレージ世代に属するか照合するための識別値を返す。 */
  getStorageGeneration(): object | null;
  /** 復元対象の Session が保存先に残っているか、必要に応じて非同期に読み取る。 */
  readSession(sessionId: string): Awaitable<Session | null>;
  /** 実行詳細の宛先に使う所有 Main の ID を返す。Auxiliary の実行では親を解決する。 */
  getLiveSessionRunOwnerSessionId(sessionId: string): string | null;
  /** ウィンドウ閉鎖後も監視が必要になる進行中の実行があるか返す。 */
  isSessionRunInFlight(sessionId: string): boolean;
  /** ウィンドウを閉じる前に確認が必要な端末の数を返す。 */
  getTerminalCloseConfirmationCount?(window: BrowserWindow): number;
  /** アプリ終了時に進行中の Session 実行へ停止を要求する。 */
  cancelInFlightSessionRuns(): void;
  /** 送信中の下書き処理を待ち、アプリ終了を継続できるか返す。 */
  waitForPendingDraftSends(): Promise<boolean>;
  /** Session ウィンドウが閉じられたあとのアプリ側の整理処理。 */
  onSessionWindowClosed?(sessionId: string): void;
  /** 実行や端末を伴うウィンドウの閉鎖確認を行う。signal で待機を中止できる。 */
  confirmCloseWhileRunning(
    window: BrowserWindow,
    sessionId: string,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  /** 復元用スナップショットを保存できなかった場合の診断を扱う。 */
  persistSnapshotError(error: unknown): void;
  /** renderer の下書き保存要求が終端した際に結果と所要時間を受け取る。 */
  onDraftFlushSettled?(result: DraftFlushResult): void;
  /** ウィンドウ通知の配送失敗を記録する。 */
  onWindowBroadcastFailed?(): void;
};

/** BrowserWindow を使うランタイムを所有し、ウィンドウの状態をアプリレジストリに持たせない。 */
export class MainWindowRuntime {
  private readonly windowEntryLoader: WindowEntryLoader;
  private readonly windowBroadcastService: WindowBroadcastService<BrowserWindow>;
  private readonly windowDialogService: WindowDialogService;
  private readonly auxWindowService: AuxWindowService<BrowserWindow>;
  private readonly sessionWindowBridge: SessionWindowBridge<BrowserWindow>;
  private readonly sessionWindowRestoreService: SessionWindowRestoreService;

  /** エントリ読み込み、通知、ダイアログと各ウィンドウ所有サービスを同じランタイムに組み立てる。 */
  public constructor(deps: MainWindowRuntimeDeps) {
    this.windowEntryLoader = new WindowEntryLoader({
      devServerUrl: deps.devServerUrl,
      rendererDistPath: deps.rendererDistPath,
    });
    this.windowBroadcastService = new WindowBroadcastService({
      /** 全体通知では Electron が現在管理するウィンドウを列挙する。 */
      getAllWindows: () => BrowserWindow.getAllWindows(),
      /** Session 概要の通知先を、補助ウィンドウサービス側から取得する。 */
      getHomeWindows: () => this.auxWindowService.listHomeWindows(),
      /** 復元候補の通知先には主 Home だけを選ぶ。 */
      getPrimaryHomeWindow: () => this.auxWindowService.getHomeWindow(),
      /** Session 概要の通知を受ける会話ウィンドウをブリッジから取得する。 */
      getSessionWindows: () => this.sessionWindowBridge.listWindows(),
      /** 実行の詳細を持たない状態通知向けのウィンドウだけを取得する。 */
      getLiveSessionRunStatusWindows: () =>
        this.auxWindowService.listLiveSessionRunStatusWindows(),
      /** 実行 ID から所有 Session を解決し、そのウィンドウだけを詳細通知の宛先にする。 */
      getLiveSessionRunWindow: (sessionId) => {
        const ownerSessionId = deps.getLiveSessionRunOwnerSessionId(sessionId);
        return ownerSessionId
          ? this.sessionWindowBridge.getWindow(ownerSessionId)
          : null;
      },
      /** WebContents が破棄済みまたはクラッシュ済みの場合は通知を渡さない。 */
      canSendToWindow: (window) =>
        !window.webContents.isDestroyed() && !window.webContents.isCrashed(),
      onSendFailed: deps.onWindowBroadcastFailed,
    });
    this.windowDialogService = new WindowDialogService({
      /** 所有ウィンドウの指定に応じ、Electron のダイアログ呼び出し形式を切り替える。 */
      showOpenDialog: (targetWindow, options) =>
        targetWindow
          ? dialog.showOpenDialog(targetWindow, options)
          : dialog.showOpenDialog(options),
    });
    this.auxWindowService = new AuxWindowService({
      /** Home 系は共通枠を使い、それ以外は指定寸法でカーソルを基準に配置する。 */
      createWindow: (options) =>
        options.homeBounds
          ? deps.composition.createBaseWindow({
              ...HOME_WINDOW_DEFAULT_BOUNDS,
              minWidth: options.minWidth,
              minHeight: options.minHeight,
              maxWidth: options.maxWidth,
              title: options.title,
              alwaysOnTop: options.alwaysOnTop,
            })
          : deps.composition.createCursorPlacedWindow({
              width: options.width,
              height: options.height,
              minWidth: options.minWidth,
              minHeight: options.minHeight,
              maxWidth: options.maxWidth,
              title: options.title,
              alwaysOnTop: options.alwaysOnTop,
            }),
      /** Home 系ウィンドウの表示モードをエントリローダーへ渡す。 */
      loadHomeEntry: (window, mode) =>
        this.windowEntryLoader.loadHomeEntry(window, mode),
      /** 差分本文を識別するトークンで専用画面を開く。 */
      loadDiffEntry: (window, token) =>
        this.windowEntryLoader.loadDiffEntry(window, token),
      /** ファイルプレビューのトークンを初回読み込みに渡す。 */
      loadFilePreviewEntry: (window, token) =>
        this.windowEntryLoader.loadFilePreviewEntry(window, token),
      /** 既存のプレビューに、renderer 内で切り替える表示先を送る。 */
      navigateFilePreviewWindow: (
        window,
        payload: SessionFilePreviewWindowPayload,
      ) => {
        window.webContents.send(
          WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT,
          payload,
        );
      },
      /** AuxWindowService が開く会話画面にも共通のエントリローダーを使う。 */
      loadChatEntry: (window, mode) =>
        this.windowEntryLoader.loadChatEntry(window, mode),
      /** Character 編集の表示先を専用エントリの初期値として渡す。 */
      loadCharacterEditorEntry: (window, characterId) =>
        this.windowEntryLoader.loadCharacterEditorEntry(window, characterId),
      /** 差分の表示内容をウィンドウの初期参照に結び付ける新しいトークンを発行する。 */
      generateDiffToken: () => crypto.randomUUID(),
      /** プレビュー一覧の変化だけを、応答可能な主 Home に知らせる。 */
      onFilePreviewWindowsChanged: () => {
        const home = this.auxWindowService.getHomeWindow();
        if (
          home &&
          !home.webContents.isDestroyed() &&
          !home.webContents.isCrashed()
        ) {
          home.webContents.send(
            WITHMATE_SESSION_FILE_PREVIEW_WINDOWS_CHANGED_EVENT,
          );
        }
      },
    });
    this.sessionWindowBridge = new SessionWindowBridge({
      /** 保存中の件名を使って会話ウィンドウを生成する。件名が空なら既定のタイトルを使う。 */
      createWindow: (sessionId) =>
        deps.composition.createCursorPlacedWindow({
          ...SESSION_WINDOW_DEFAULT_BOUNDS,
          title: deps.getSession(sessionId)?.taskTitle?.trim() || "Session",
        }),
      /** Electron の終了・応答・ロードイベントを下書き保存で使う renderer 状態へ写す。 */
      observeRendererState: (window, changed) => {
        window.webContents.on("render-process-gone", () => changed("gone"));
        window.webContents.on("unresponsive", () => changed("unresponsive"));
        window.webContents.on("responsive", () => changed("responsive"));
        window.webContents.on("did-finish-load", () => changed("responsive"));
      },
      onDraftFlushSettled: deps.onDraftFlushSettled,
      /** Session ウィンドウの初回読み込みで対象の Main・Auxiliary を渡す。 */
      loadChatEntry: (window, mode) =>
        this.windowEntryLoader.loadChatEntry(window, mode),
      /** 開いている会話ウィンドウに、選択する Auxiliary の切り替えを要求する。 */
      sendAuxiliarySessionNavigation: (window, payload) => {
        window.webContents.send(WITHMATE_OPEN_AUXILIARY_SESSION_EVENT, payload);
      },
      /** 閉鎖前の下書き保存要求を対象の renderer に送る。 */
      sendDraftFlushRequest: (window, request) => {
        window.webContents.send(
          WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT,
          request,
        );
      },
      /** 下書き保存時にかけた入力制限を解除できるよう、同じウィンドウへ通知する。 */
      sendDraftFlushRelease: (window, payload) => {
        window.webContents.send(
          WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT,
          payload,
        );
      },
      /** 下書き保存応答の送信元を、要求時点の WebContents と照合するために取得する。 */
      getWindowSender: (window) => window.webContents,
      cancelInFlightSessionRuns: deps.cancelInFlightSessionRuns,
      waitForPendingDraftSends: deps.waitForPendingDraftSends,
      getSession: deps.getSession,
      getStorageGeneration: deps.getStorageGeneration,
      isRunInFlight: deps.isSessionRunInFlight,
      getTerminalCloseConfirmationCount: deps.getTerminalCloseConfirmationCount,
      onSessionWindowClosed: deps.onSessionWindowClosed,
      confirmCloseWhileRunning: deps.confirmCloseWhileRunning,
      /** 開閉で変わった現在の Session ウィンドウ集合をアプリ側へ知らせる。 */
      broadcastOpenSessionWindowIds: (sessionIds) =>
        this.windowBroadcastService.broadcastOpenSessionWindowIds(sessionIds),
      /** 次回起動時の復元候補に反映できるよう、現在の集合を復元サービスへ渡す。 */
      persistOpenSessionWindowIds: (sessionIds) =>
        this.sessionWindowRestoreService.saveSnapshot(sessionIds),
      onSnapshotPersistenceError: deps.persistSnapshotError,
    });
    this.sessionWindowRestoreService = new SessionWindowRestoreService({
      storage: new SessionWindowRestoreStorage(deps.userDataPath),
      getSession: deps.readSession,
      /** 復元開始時の照合に使う、現在の生成中・生成済みウィンドウの状態。 */
      getSessionWindowRestoreStates: () =>
        this.sessionWindowBridge.getSessionWindowRestoreStates(),
      /** 復元から開く場合も、通常と同じウィンドウ生成・再利用の経路を使う。 */
      openSessionWindow: (sessionId, options) =>
        this.sessionWindowBridge.openSessionWindow(sessionId, options),
      /** 復元候補が変わったら、通知サービスから主 Home に知らせる。 */
      onRestoreSetChanged: (sessionIds) =>
        this.windowBroadcastService.broadcastSessionWindowRestoreSet(
          sessionIds,
        ),
    });
  }

  /** Main の状態変化を既存ウィンドウに配送するサービスを返す。 */
  getWindowBroadcastService(): WindowBroadcastService<BrowserWindow> {
    return this.windowBroadcastService;
  }
  /** 所有ウィンドウ付きでネイティブ選択を行うサービスを返す。 */
  getWindowDialogService(): WindowDialogService {
    return this.windowDialogService;
  }
  /** 開発・配布の読み込み先を共有する renderer エントリローダーを返す。 */
  getWindowEntryLoader(): WindowEntryLoader {
    return this.windowEntryLoader;
  }
  /** Home、設定やプレビューなどの所有サービスを返す。 */
  getAuxWindowService(): AuxWindowService<BrowserWindow> {
    return this.auxWindowService;
  }
  /** 会話ウィンドウの登録とライフサイクルを所有するブリッジを返す。 */
  getSessionWindowBridge(): SessionWindowBridge<BrowserWindow> {
    return this.sessionWindowBridge;
  }
  /** 復元候補の保存と適用を担うサービスを返す。 */
  getSessionWindowRestoreService(): SessionWindowRestoreService {
    return this.sessionWindowRestoreService;
  }
}
