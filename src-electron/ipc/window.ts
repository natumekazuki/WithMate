import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";

import {
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
  WITHMATE_OPEN_MEMORY_V6_REVIEW_WINDOW_CHANNEL,
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

import type { IpcHandleRegistrar, MainIpcWindowDeps } from "./contracts.js";
import { resolveWindowAuxiliarySessionId } from "./shared.js";
import {
  resolveTargetWindow,
  assertHomeWindowSender,
  assertSessionMonitorContextMenuSender,
} from "./shared.js";

export function registerWindowHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcWindowDeps,
): void {
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
  ipcMain.handle(WITHMATE_OPEN_MEMORY_V6_REVIEW_WINDOW_CHANNEL, async () => {
    await deps.openMemoryV6ReviewWindow();
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
