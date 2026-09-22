import type {
  MemoryForgetReason,
  MemoryV6ReviewSearchRequest,
} from "../../src-shared/memory/memory-contract.js";

import type { MemoryV6ProtectedObjectGcRequest } from "../../src-shared/memory/memory-review-state.js";

import { isChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";

import {
  WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL,
  WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_GET_MEMORY_V6_FILE_USAGE_CHANNEL,
  WITHMATE_EXPORT_MEMORY_V6_ENTRY_FILES_CHANNEL,
  WITHMATE_RUN_MEMORY_V6_PROTECTED_OBJECT_GC_CHANNEL,
  WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL,
  WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_CHAT_LAYOUT_PREFERENCE_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import { type ResetAppDatabaseRequest } from "../../src-shared/window/withmate-window-types.js";

import type { IpcHandleRegistrar, MainIpcSettingsDeps } from "./contracts.js";
import {
  resolveTargetWindow,
  assertSettingsWindowSender,
  assertMemoryV6ReviewSender,
} from "./shared.js";

export function registerSettingsHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcSettingsDeps,
): void {
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
        throw new TypeError("chat layout preference の更新内容が不正です。");
      }
      return deps.updateChatLayoutPreference(update);
    },
  );
  ipcMain.handle(WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL, () =>
    deps.getAppDatabaseDiagnostics(),
  );
  ipcMain.handle(WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL, () =>
    deps.getMemoryV6Diagnostics(),
  );
  ipcMain.handle(WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL, (event) => {
    assertSettingsWindowSender(event, deps);
    return deps.installMemoryV6CliShim();
  });
  ipcMain.handle(WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL, (event) => {
    assertSettingsWindowSender(event, deps);
    return deps.uninstallMemoryV6CliShim();
  });
  ipcMain.handle(WITHMATE_GET_MEMORY_V6_FILE_USAGE_CHANNEL, (event) => {
    assertMemoryV6ReviewSender(event, deps);
    return deps.getMemoryV6FileUsage();
  });
  ipcMain.handle(
    WITHMATE_EXPORT_MEMORY_V6_ENTRY_FILES_CHANNEL,
    (event, entryId: string) => {
      assertMemoryV6ReviewSender(event, deps);
      return deps.exportMemoryV6EntryFiles(
        entryId,
        resolveTargetWindow(event, deps),
      );
    },
  );
  ipcMain.handle(
    WITHMATE_RUN_MEMORY_V6_PROTECTED_OBJECT_GC_CHANNEL,
    (event, request: MemoryV6ProtectedObjectGcRequest) => {
      assertMemoryV6ReviewSender(event, deps);
      return deps.runMemoryV6ProtectedObjectGc(request);
    },
  );
  ipcMain.handle(
    WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL,
    (event, request: MemoryV6ReviewSearchRequest | null | undefined) => {
      assertMemoryV6ReviewSender(event, deps);
      return deps.searchMemoryV6Entries(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL,
    (event, entryId: string) => {
      assertMemoryV6ReviewSender(event, deps);
      return deps.getMemoryV6Entry(entryId);
    },
  );
  ipcMain.handle(
    WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL,
    (event, entryId: string, reason?: MemoryForgetReason | null) => {
      assertMemoryV6ReviewSender(event, deps);
      return deps.forgetMemoryV6Entry(entryId, reason);
    },
  );
  ipcMain.handle(
    WITHMATE_RESET_APP_DATABASE_CHANNEL,
    (event, request: ResetAppDatabaseRequest | null | undefined) => {
      assertSettingsWindowSender(event, deps);
      return deps.resetAppDatabase(request);
    },
  );
}
