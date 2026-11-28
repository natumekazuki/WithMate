import type { BrowserWindow } from "electron";
import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import { parseSessionFilePreviewContextMenuRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";

import {
  WITHMATE_LIST_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL,
  WITHMATE_SHOW_SESSION_FILE_PREVIEW_CONTEXT_MENU_CHANNEL,
  WITHMATE_FOCUS_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
  WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
  WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
  WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL,
  WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL,
  WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_FILES_CHANNEL,
  WITHMATE_PICK_SESSION_FILES_CHANNEL,
  WITHMATE_PICK_SESSION_FOLDER_CHANNEL,
  WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
  WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import {
  parseImageFilePickerPurpose,
  parseSessionMonitorContextMenuRequest,
  type OpenPathOptions,
  type SavePastedSessionFileRequest,
} from "../../src-shared/window/withmate-window-types.js";

import type {
  IpcHandleRegistrar,
  MainIpcHomeCrewDeps,
  MainIpcAuxiliaryLookupDeps,
  MainIpcEventWindowDeps,
  MainIpcHomeWindowDeps,
  MainIpcSessionMonitorWindowDeps,
  MainIpcSessionWindowDeps,
  MainIpcWindowDeps,
  MainIpcWorkspaceValidationDeps,
} from "./contracts.js";
import { resolveWindowAuxiliarySessionId } from "./shared.js";
import {
  resolveTargetWindow,
  assertHomeWindowSender,
  assertSessionMonitorContextMenuSender,
} from "./shared.js";
import { registerHomeCrewHandlers } from "./home-crew.js";

/** ウィンドウ登録に共通の送信元解決、種類別ウィンドウ照合、Workspace 検証、Auxiliary 照会をまとめた依存。 */
export type MainIpcWindowAssemblyContext = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps &
  MainIpcSessionWindowDeps &
  MainIpcSessionMonitorWindowDeps &
  MainIpcWorkspaceValidationDeps &
  MainIpcAuxiliaryLookupDeps;

/** ウィンドウ機能が所有する Main プロセスのウィンドウサービス用ポート。 */
export type MainIpcWindowServiceDeps = MainIpcHomeCrewDeps & {
  showSessionFilePreviewContextMenu: MainIpcWindowDeps["showSessionFilePreviewContextMenu"];
  listSessionFilePreviewWindows: MainIpcWindowDeps["listSessionFilePreviewWindows"];
  focusSessionFilePreviewWindow: MainIpcWindowDeps["focusSessionFilePreviewWindow"];
  closeSessionFilePreviewWindow: MainIpcWindowDeps["closeSessionFilePreviewWindow"];
  closeSessionFilePreviewWindows: MainIpcWindowDeps["closeSessionFilePreviewWindows"];
  /** Session ウィンドウを開き、Auxiliary ID があればその会話へ移動する。 */
  openSessionWindow(
    sessionId: string,
    auxiliarySessionId?: string,
  ): Promise<BrowserWindow>;
  showSessionMonitorContextMenu: MainIpcWindowDeps["showSessionMonitorContextMenu"];
  getSessionWindowRestoreSet: MainIpcWindowDeps["getSessionWindowRestoreSet"];
  restoreSessionWindows: MainIpcWindowDeps["restoreSessionWindows"];
  /** Home ウィンドウを開く。 */
  openHomeWindow(): Promise<BrowserWindow>;
  /** Session Monitor ウィンドウを開く。 */
  openSessionMonitorWindow(): Promise<BrowserWindow>;
  /** Settings ウィンドウを開く。 */
  openSettingsWindow(): Promise<BrowserWindow>;
  /** Character エディターを開く。対象 ID は省略できる。 */
  openCharacterEditorWindow(
    characterId?: string | null,
  ): Promise<BrowserWindow>;
  /** 渡された差分を表示するウィンドウを開く。 */
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow>;
  pickDirectory: MainIpcWindowDeps["pickDirectory"];
  pickFile: MainIpcWindowDeps["pickFile"];
  pickFiles: MainIpcWindowDeps["pickFiles"];
  pickSessionFiles: MainIpcWindowDeps["pickSessionFiles"];
  pickSessionFolder: MainIpcWindowDeps["pickSessionFolder"];
  pickSessionImageFile: MainIpcWindowDeps["pickSessionImageFile"];
  pickImageFile: MainIpcWindowDeps["pickImageFile"];
  copyFilesToSessionFiles: MainIpcWindowDeps["copyFilesToSessionFiles"];
  savePastedSessionFile: MainIpcWindowDeps["savePastedSessionFile"];
  openSessionFilesDirectory: MainIpcWindowDeps["openSessionFilesDirectory"];
  openSessionFilesTerminal: MainIpcWindowDeps["openSessionFilesTerminal"];
  openPathTarget: MainIpcWindowDeps["openPathTarget"];
  openAppLogFolder: MainIpcWindowDeps["openAppLogFolder"];
  openCrashDumpFolder: MainIpcWindowDeps["openCrashDumpFolder"];
  openSessionTerminal: MainIpcWindowDeps["openSessionTerminal"];
  openTerminalAtPath: MainIpcWindowDeps["openTerminalAtPath"];
};

/** ウィンドウサービスと共通コンテキストを束ね、開く操作から返る BrowserWindow を IPC へ渡さない形に変換する。 */
export function createWindowIpcDeps(
  services: MainIpcWindowServiceDeps,
  context: MainIpcWindowAssemblyContext,
): MainIpcWindowDeps {
  return {
    ...context,
    ...services,
    /** Session ウィンドウを開く処理の完了を待つ。必要に応じて Auxiliary を指定する。 */
    openSessionWindow: async (sessionId, auxiliarySessionId) => {
      await services.openSessionWindow(sessionId, auxiliarySessionId);
    },
    /** Home を開く処理の完了を待つ。 */
    openHomeWindow: async () => {
      await services.openHomeWindow();
    },
    /** Session Monitor を開く処理の完了を待つ。 */
    openSessionMonitorWindow: async () => {
      await services.openSessionMonitorWindow();
    },
    /** Settings を開く処理の完了を待つ。 */
    openSettingsWindow: async () => {
      await services.openSettingsWindow();
    },
    /** 対象を指定できる Character エディターの起動を待つ。 */
    openCharacterEditorWindow: async (characterId) => {
      await services.openCharacterEditorWindow(characterId);
    },
    /** 差分表示ウィンドウの起動を待つ。 */
    openDiffWindow: async (diffPreview) => {
      await services.openDiffWindow(diffPreview);
    },
  };
}

/** ウィンドウ操作、ファイル選択、OS への起動要求を登録する。復元や File Preview ウィンドウ管理は Home、Monitor のメニューは Monitor の送信元検証を通す。 */
export function registerWindowHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcWindowDeps,
): void {
  registerHomeCrewHandlers(ipcMain, deps);
  ipcMain.handle(
    WITHMATE_SHOW_SESSION_FILE_PREVIEW_CONTEXT_MENU_CHANNEL,
    (event, input: unknown) => {
      assertHomeWindowSender(event, deps);
      return deps.showSessionFilePreviewContextMenu(
        event,
        parseSessionFilePreviewContextMenuRequest(input),
      );
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL,
    (event) => {
      assertHomeWindowSender(event, deps);
      return deps.listSessionFilePreviewWindows();
    },
  );
  for (const [channel, action] of [
    [
      WITHMATE_FOCUS_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
      deps.focusSessionFilePreviewWindow,
    ],
    [
      WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
      deps.closeSessionFilePreviewWindow,
    ],
    [
      WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL,
      deps.closeSessionFilePreviewWindows,
    ],
  ] as const) {
    ipcMain.handle(channel, (event, value: unknown) => {
      assertHomeWindowSender(event, deps);
      if (typeof value !== "string" || !value.trim())
        throw new Error("Invalid preview window identifier.");
      action(value);
    });
  }
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_CHANNEL,
    async (_event, sessionId: string, auxiliarySessionId?: string | null) => {
      if (!sessionId) {
        return;
      }
      await deps.openSessionWindow(
        sessionId,
        await resolveWindowAuxiliarySessionId(
          deps,
          sessionId,
          auxiliarySessionId,
        ),
      );
    },
  );
  ipcMain.handle(
    WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL,
    (event, input: unknown) => {
      assertSessionMonitorContextMenuSender(event, deps);
      const request = parseSessionMonitorContextMenuRequest(input);
      return deps.showSessionMonitorContextMenu(event, request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL,
    async (event) => {
      assertHomeWindowSender(event, deps);
      return deps.getSessionWindowRestoreSet();
    },
  );
  ipcMain.handle(WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL, async (event) => {
    assertHomeWindowSender(event, deps);
    return deps.restoreSessionWindows();
  });
  ipcMain.handle(WITHMATE_OPEN_HOME_WINDOW_CHANNEL, async () => {
    await deps.openHomeWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL, async () => {
    await deps.openSessionMonitorWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL, async () => {
    await deps.openSettingsWindow();
  });
  ipcMain.handle(
    WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
    async (_event, characterId?: string | null) => {
      await deps.openCharacterEditorWindow(characterId ?? null);
    },
  );
  ipcMain.handle(
    WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
    async (_event, diffPreview: DiffPreviewPayload) => {
      await deps.openDiffWindow(diffPreview);
    },
  );
  ipcMain.handle(
    WITHMATE_PICK_DIRECTORY_CHANNEL,
    async (event, initialPath: string | null) =>
      deps.pickDirectory(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(
    WITHMATE_VALIDATE_WORKSPACE_DIRECTORY_CHANNEL,
    async (event, targetPath: unknown) => {
      assertHomeWindowSender(event, deps);
      return deps.validateWorkspaceDirectory(targetPath);
    },
  );
  ipcMain.handle(
    WITHMATE_PICK_FILE_CHANNEL,
    async (event, initialPath: string | null) =>
      deps.pickFile(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(
    WITHMATE_PICK_FILES_CHANNEL,
    async (event, initialPath: string | null) =>
      deps.pickFiles(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(
    WITHMATE_PICK_SESSION_FILES_CHANNEL,
    async (event, sessionId: string) =>
      deps.pickSessionFiles(resolveTargetWindow(event, deps), sessionId),
  );
  ipcMain.handle(
    WITHMATE_PICK_SESSION_FOLDER_CHANNEL,
    async (event, sessionId: string) =>
      deps.pickSessionFolder(resolveTargetWindow(event, deps), sessionId),
  );
  ipcMain.handle(
    WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL,
    async (event, sessionId: string) =>
      deps.pickSessionImageFile(resolveTargetWindow(event, deps), sessionId),
  );
  ipcMain.handle(
    WITHMATE_PICK_IMAGE_FILE_CHANNEL,
    async (event, initialPath: string | null, rawPurpose: unknown) =>
      deps.pickImageFile(
        resolveTargetWindow(event, deps),
        initialPath,
        parseImageFilePickerPurpose(rawPurpose),
      ),
  );
  ipcMain.handle(
    WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
    async (_event, sessionId: string, sourcePaths: string[]) =>
      deps.copyFilesToSessionFiles(sessionId, sourcePaths),
  );
  ipcMain.handle(
    WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
    async (_event, request: SavePastedSessionFileRequest) =>
      deps.savePastedSessionFile(request),
  );
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
    async (_event, sessionId: string) =>
      deps.openSessionFilesDirectory(sessionId),
  );
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
    async (_event, sessionId: string) =>
      deps.openSessionFilesTerminal(sessionId),
  );
  ipcMain.handle(
    WITHMATE_OPEN_PATH_CHANNEL,
    async (_event, target: string, options: OpenPathOptions | null) =>
      deps.openPathTarget(target, options ?? undefined),
  );
  ipcMain.handle(WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL, async () =>
    deps.openAppLogFolder(),
  );
  ipcMain.handle(WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL, async () =>
    deps.openCrashDumpFolder(),
  );
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
    async (_event, sessionId: string) => deps.openSessionTerminal(sessionId),
  );
  ipcMain.handle(
    WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
    async (_event, target: string) => deps.openTerminalAtPath(target),
  );
}
