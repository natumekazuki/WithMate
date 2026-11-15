
import { parseSessionFolderCleanupRequest, parseSessionFolderCleanupRunRequest } from "../../src-shared/session/session-folder-cleanup.js";
import { WITHMATE_SCAN_SESSION_FOLDER_CLEANUP_CHANNEL, WITHMATE_RUN_SESSION_FOLDER_CLEANUP_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";

import { isChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";

import {
  WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import { type ResetAppDatabaseRequest } from "../../src-shared/window/withmate-window-types.js";

import type {
  IpcHandleRegistrar,
  MainIpcEventWindowDeps,
  MainIpcHomeWindowDeps,
  MainIpcSettingsDeps,
  MainIpcSettingsWindowDeps,
} from "./contracts.js";
import {
  assertSettingsWindowSender,
} from "./shared.js";

export type MainIpcSettingsServiceDeps = Omit<
  MainIpcSettingsDeps,
  keyof MainIpcEventWindowDeps | keyof MainIpcHomeWindowDeps |
    keyof MainIpcSettingsWindowDeps
>;

export function createSettingsIpcDeps(
  services: MainIpcSettingsServiceDeps,
  context: MainIpcEventWindowDeps &
    MainIpcHomeWindowDeps &
    MainIpcSettingsWindowDeps,
): MainIpcSettingsDeps {
  return { ...context, ...services };
}

export function registerSettingsHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcSettingsDeps,
): void {
  ipcMain.handle(WITHMATE_SCAN_SESSION_FOLDER_CLEANUP_CHANNEL, (event, request: unknown) => {
    assertSettingsWindowSender(event, deps);
    return deps.scanSessionFolderCleanup(parseSessionFolderCleanupRequest(request));
  });
  ipcMain.handle(WITHMATE_RUN_SESSION_FOLDER_CLEANUP_CHANNEL, (event, request: unknown) => {
    assertSettingsWindowSender(event, deps);
    return deps.runSessionFolderCleanup(parseSessionFolderCleanupRunRequest(request));
  });
  ipcMain.handle(WITHMATE_GET_APP_SETTINGS_CHANNEL, () =>
    deps.getAppSettings(),
  );
  ipcMain.handle(WITHMATE_UPDATE_APP_SETTINGS_CHANNEL, (_event, settings) =>
    deps.updateAppSettings(settings),
  );
  ipcMain.handle(
    WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL,
    (_event, update) => {
      if (!isChatLayoutPreferenceUpdate(update)) {
        throw new TypeError("Invalid chat layout preference update.");
      }
      return deps.updateChatLayoutPreference(update);
    },
  );
  ipcMain.handle(WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL, () =>
    deps.getAppDatabaseDiagnostics(),
  );
  ipcMain.handle(
    WITHMATE_RESET_APP_DATABASE_CHANNEL,
    (event, request: ResetAppDatabaseRequest | null | undefined) => {
      assertSettingsWindowSender(event, deps);
      return deps.resetAppDatabase(request);
    },
  );
}
