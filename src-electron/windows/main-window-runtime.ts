import { BrowserWindow, dialog } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionFilePreviewWindowPayload } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { WITHMATE_OPEN_AUXILIARY_SESSION_EVENT, WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT, WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT, WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { MainWindowComposition } from "./main-window-composition.js";
import { WindowBroadcastService } from "./window-broadcast-service.js";
import { WindowDialogService } from "./window-dialog-service.js";
import { WindowEntryLoader } from "./window-entry-loader.js";
import { SessionWindowBridge } from "./session-window-bridge.js";
import { SessionWindowRestoreService } from "./session-window-restore-service.js";
import { SessionWindowRestoreStorage } from "./session-window-restore-storage.js";
import { AuxWindowService } from "../auxiliary/aux-window-service.js";
import { HOME_WINDOW_DEFAULT_BOUNDS, SESSION_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";

type SettingsCatalogPort = {
  importModelCatalogDocument(document: ModelCatalogDocument): Promise<ModelCatalogSnapshot>;
  exportModelCatalogDocument(revision?: number | null): Promise<ModelCatalogDocument | null>;
};

export type MainWindowRuntimeDeps = {
  composition: MainWindowComposition;
  devServerUrl?: string;
  rendererDistPath: string;
  userDataPath: string;
  getSession(sessionId: string): Session | null;
  readSession(sessionId: string): Awaitable<Session | null>;
  getSettingsCatalog(): SettingsCatalogPort;
  isSessionRunInFlight(sessionId: string): boolean;
  cancelInFlightSessionRuns(): void;
  waitForPendingDraftSends(): Promise<boolean>;
  onSessionWindowClosed?(sessionId: string): void;
  confirmCloseWhileRunning(window: BrowserWindow, sessionId: string): boolean;
  persistSnapshotError(error: unknown): void;
};

/** Owns the BrowserWindow-backed runtime and keeps window state out of the app registry. */
export class MainWindowRuntime {
  private readonly windowEntryLoader: WindowEntryLoader;
  private readonly windowBroadcastService: WindowBroadcastService<BrowserWindow>;
  private readonly windowDialogService: WindowDialogService;
  private readonly auxWindowService: AuxWindowService<BrowserWindow>;
  private readonly sessionWindowBridge: SessionWindowBridge<BrowserWindow>;
  private readonly sessionWindowRestoreService: SessionWindowRestoreService;

  public constructor(deps: MainWindowRuntimeDeps) {
    this.windowEntryLoader = new WindowEntryLoader({
      devServerUrl: deps.devServerUrl,
      rendererDistPath: deps.rendererDistPath,
    });
    this.windowBroadcastService = new WindowBroadcastService({
      getAllWindows: () => BrowserWindow.getAllWindows(),
      getHomeWindows: () => this.auxWindowService.listHomeWindows(),
      getPrimaryHomeWindow: () => this.auxWindowService.getHomeWindow(),
      getSessionWindows: () => this.sessionWindowBridge.listWindows(),
    });
    this.windowDialogService = new WindowDialogService({
      showOpenDialog: (targetWindow, options) => targetWindow
        ? dialog.showOpenDialog(targetWindow, options)
        : dialog.showOpenDialog(options),
      showSaveDialog: (targetWindow, options) => targetWindow
        ? dialog.showSaveDialog(targetWindow, options)
        : dialog.showSaveDialog(options),
      readTextFile: (filePath) => readFile(filePath, "utf8"),
      writeTextFile: (filePath, content) => writeFile(filePath, content, "utf8"),
      importModelCatalogDocument: (document) => deps.getSettingsCatalog().importModelCatalogDocument(document),
      exportModelCatalogDocument: (revision) => deps.getSettingsCatalog().exportModelCatalogDocument(revision),
    });
    this.auxWindowService = new AuxWindowService({
      createWindow: (options) => options.homeBounds
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
      loadHomeEntry: (window, mode) => this.windowEntryLoader.loadHomeEntry(window, mode),
      loadDiffEntry: (window, token) => this.windowEntryLoader.loadDiffEntry(window, token),
      loadFilePreviewEntry: (window, token) => this.windowEntryLoader.loadFilePreviewEntry(window, token),
      navigateFilePreviewWindow: (window, payload: SessionFilePreviewWindowPayload) => {
        window.webContents.send(WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT, payload);
      },
      loadChatEntry: (window, mode) => this.windowEntryLoader.loadChatEntry(window, mode),
      loadCharacterEditorEntry: (window, characterId) =>
        this.windowEntryLoader.loadCharacterEditorEntry(window, characterId),
      generateDiffToken: () => crypto.randomUUID(),
    });
    this.sessionWindowBridge = new SessionWindowBridge({
      createWindow: (sessionId) => deps.composition.createCursorPlacedWindow({
        ...SESSION_WINDOW_DEFAULT_BOUNDS,
        title: deps.getSession(sessionId)?.taskTitle?.trim() || `WithMate Session - ${sessionId}`,
      }),
      loadChatEntry: (window, mode) => this.windowEntryLoader.loadChatEntry(window, mode),
      sendAuxiliarySessionNavigation: (window, payload) => {
        window.webContents.send(WITHMATE_OPEN_AUXILIARY_SESSION_EVENT, payload);
      },
      sendDraftFlushRequest: (window, request) => {
        window.webContents.send(WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT, request);
      },
      sendDraftFlushRelease: (window, payload) => {
        window.webContents.send(WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT, payload);
      },
      getWindowSender: (window) => window.webContents,
      cancelInFlightSessionRuns: deps.cancelInFlightSessionRuns,
      waitForPendingDraftSends: deps.waitForPendingDraftSends,
      getSession: deps.getSession,
      isRunInFlight: deps.isSessionRunInFlight,
      onSessionWindowClosed: deps.onSessionWindowClosed,
      confirmCloseWhileRunning: deps.confirmCloseWhileRunning,
      broadcastOpenSessionWindowIds: (sessionIds) => this.windowBroadcastService.broadcastOpenSessionWindowIds(sessionIds),
      persistOpenSessionWindowIds: (sessionIds) => this.sessionWindowRestoreService.saveSnapshot(sessionIds),
      onSnapshotPersistenceError: deps.persistSnapshotError,
    });
    this.sessionWindowRestoreService = new SessionWindowRestoreService({
      storage: new SessionWindowRestoreStorage(deps.userDataPath),
      getSession: deps.readSession,
      getSessionWindowRestoreStates: () => this.sessionWindowBridge.getSessionWindowRestoreStates(),
      openSessionWindow: (sessionId) => this.sessionWindowBridge.openSessionWindow(sessionId),
      onRestoreSetChanged: (sessionIds) => this.windowBroadcastService.broadcastSessionWindowRestoreSet(sessionIds),
    });
  }

  getWindowBroadcastService(): WindowBroadcastService<BrowserWindow> { return this.windowBroadcastService; }
  getWindowDialogService(): WindowDialogService { return this.windowDialogService; }
  getWindowEntryLoader(): WindowEntryLoader { return this.windowEntryLoader; }
  getAuxWindowService(): AuxWindowService<BrowserWindow> { return this.auxWindowService; }
  getSessionWindowBridge(): SessionWindowBridge<BrowserWindow> { return this.sessionWindowBridge; }
  getSessionWindowRestoreService(): SessionWindowRestoreService { return this.sessionWindowRestoreService; }
}
