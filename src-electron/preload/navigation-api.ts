import type {
  WithMateWindowCatalogApi,
  WithMateWindowNavigationApi,
} from "../../src-shared/ipc/withmate-window-api.js";
import {
  normalizeSessionWindowRestoreIds,
  normalizeSessionWindowRestoreResult,
} from "../../src-shared/window/session-window-restore.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

export function createWindowApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowNavigationApi {
  return {
    openSession(sessionId, auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_CHANNEL,
        sessionId,
        auxiliarySessionId ?? null,
      );
    },
    showSessionMonitorContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_SESSION_MONITOR_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    async getSessionWindowRestoreSet() {
      const sessionIds = normalizeSessionWindowRestoreIds(
        await ipcRenderer.invoke(
          channels.WITHMATE_GET_SESSION_WINDOW_RESTORE_SET_CHANNEL,
        ),
      );
      if (!sessionIds)
        throw new Error("Invalid Session Window restore set response.");
      return sessionIds;
    },
    async restoreSessionWindows() {
      const result = normalizeSessionWindowRestoreResult(
        await ipcRenderer.invoke(
          channels.WITHMATE_RESTORE_SESSION_WINDOWS_CHANNEL,
        ),
      );
      if (!result)
        throw new Error("Invalid Session Window restore result.");
      return result;
    },
    openHomeWindow() {
      return ipcRenderer.invoke(channels.WITHMATE_OPEN_HOME_WINDOW_CHANNEL);
    },
    openSessionMonitorWindow() {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
      );
    },
    openSettingsWindow() {
      return ipcRenderer.invoke(channels.WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL);
    },
    openMemoryV6ReviewWindow() {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_MEMORY_V6_REVIEW_WINDOW_CHANNEL,
      );
    },
    openCharacterEditorWindow(characterId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
        characterId ?? null,
      );
    },
    openDiffWindow(diffPreview) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
        diffPreview,
      );
    },
    openSessionFilePreviewWindow(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
        request,
      );
    },
    openPath(target, options) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_PATH_CHANNEL,
        target,
        options ?? null,
      );
    },
    showMarkdownLinkContextMenu(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SHOW_MARKDOWN_LINK_CONTEXT_MENU_CHANNEL,
        request,
      );
    },
    openAppLogFolder() {
      return ipcRenderer.invoke(channels.WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL);
    },
    openCrashDumpFolder() {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
      );
    },
    openSessionTerminal(sessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
        sessionId,
      );
    },
    openTerminalAtPath(target) {
      return ipcRenderer.invoke(
        channels.WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
        target,
      );
    },
  };
}

export function createCatalogApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowCatalogApi {
  return {
    getModelCatalog(revision) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_MODEL_CATALOG_CHANNEL,
        revision ?? null,
      );
    },
    importModelCatalog(document) {
      return ipcRenderer.invoke(
        channels.WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
        document,
      );
    },
    exportModelCatalog(revision) {
      return ipcRenderer.invoke(
        channels.WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
        revision ?? null,
      );
    },
    importModelCatalogFile() {
      return ipcRenderer.invoke(
        channels.WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
      );
    },
    exportModelCatalogFile(revision) {
      return ipcRenderer.invoke(
        channels.WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
        revision ?? null,
      );
    },
    getDiffPreview(token) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
        token,
      );
    },
  };
}
