import assert from "node:assert/strict";
import test from "node:test";

import type { IpcMain } from "electron";

import { registerMainIpcHandlers } from "../../src-electron/main-ipc-registration.js";
import {
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_CHARACTER_UPDATE_SESSION_CHANNEL,
  WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_DELETE_CHARACTER_CHANNEL,
  WITHMATE_DELETE_CHARACTER_MEMORY_ENTRY_CHANNEL,
  WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL,
  WITHMATE_DELETE_SESSION_MEMORY_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_EXTRACT_CHARACTER_UPDATE_MEMORY_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_CHARACTER_UPDATE_WORKSPACE_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
  WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
  WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
  WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
  WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_MEMORY_MANAGEMENT_WINDOW_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_RUN_SESSION_MEMORY_EXTRACTION_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
} from "../../src/withmate-ipc-channels.js";

type Handler = (...args: unknown[]) => unknown;

function createIpcMainStub() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
    on() {
      return ipcMain;
    },
  } as unknown as IpcMain;

  return { ipcMain, handlers };
}

test("registerMainIpcHandlers は主要 channel を登録して delegate を呼ぶ", async () => {
  const { ipcMain, handlers } = createIpcMainStub();
  const calls: string[] = [];

  registerMainIpcHandlers(ipcMain, {
    resolveEventWindow: () => null,
    resolveHomeWindow: () => null,
    async openSessionWindow(sessionId) {
      calls.push(`openSession:${sessionId}`);
    },
    async openHomeWindow() {
      calls.push("openHome");
    },
    async openSessionMonitorWindow() {
      calls.push("openMonitor");
    },
    async openSettingsWindow() {
      calls.push("openSettings");
    },
    async openMemoryManagementWindow() {
      calls.push("openMemory");
    },
    async openCharacterEditorWindow(characterId) {
      calls.push(`openCharacter:${characterId ?? ""}`);
    },
    async openDiffWindow() {
      calls.push("openDiff");
    },
    listSessionSummaries: () => [],
    listSessionAuditLogs: () => [],
    async listSessionSkills() { return []; },
    async listSessionCustomAgents() { return []; },
    listOpenSessionWindowIds: () => ["session-1"],
    getAppSettings: () => ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {}, characterReflectionProviderSettings: {} } as never),
    updateAppSettings: (settings) => settings,
    async resetAppDatabase() {
      return null;
    },
    getMemoryManagementSnapshot: () => ({ sessionMemories: [], projectMemories: [], characterMemories: [] }),
    deleteSessionMemory: () => {
      calls.push("deleteSessionMemory");
    },
    deleteProjectMemoryEntry: () => {
      calls.push("deleteProjectMemoryEntry");
    },
    deleteCharacterMemoryEntry: () => {
      calls.push("deleteCharacterMemoryEntry");
    },
    async listCharacters() {
      return [];
    },
    getModelCatalog: () => null,
    importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
    async importModelCatalogFromFile() {
      return null;
    },
    exportModelCatalogDocument: () => null,
    async exportModelCatalogToFile() {
      return null;
    },
    getSession: () => null,
    getDiffPreview: () => null,
    getLiveSessionRun: () => null,
    async getProviderQuotaTelemetry() {
      return null;
    },
    getSessionContextTelemetry: () => null,
    getSessionBackgroundActivity: () => null,
    resolveLiveApproval: () => {
      calls.push("resolveApproval");
    },
    resolveLiveElicitation: () => {
      calls.push("resolveElicitation");
    },
    async getCharacter() {
      return null;
    },
    async getCharacterUpdateWorkspace() {
      return null;
    },
    async extractCharacterUpdateMemory() {
      return { characterId: "c-1", generatedAt: "", entryCount: 0, text: "" };
    },
    async createCharacterUpdateSession() {
      return {} as never;
    },
    createSession: () => ({}) as never,
    updateSession: () => ({}) as never,
    deleteSession: () => {
      calls.push("deleteSession");
    },
    async previewComposerInput() {
      return null;
    },
    async searchWorkspaceFiles() {
      return [];
    },
    async runSessionTurn() {
      return {} as never;
    },
    runSessionMemoryExtraction: () => {
      calls.push("runSessionMemoryExtraction");
    },
    cancelSessionRun: () => {
      calls.push("cancelRun");
    },
    async createCharacter() {
      return {} as never;
    },
    async updateCharacter() {
      return {} as never;
    },
    async deleteCharacter() {
      calls.push("deleteCharacter");
    },
    async pickDirectory() {
      return "dir";
    },
    async pickFile() {
      return "file";
    },
    async pickImageFile() {
      return "image";
    },
    async openPathTarget() {
      calls.push("openPath");
    },
    async openAppLogFolder() {
      calls.push("openLogs");
    },
    async openCrashDumpFolder() {
      calls.push("openCrashDumps");
    },
    async openSessionTerminal() {
      calls.push("openTerminal");
    },
    listCompanionSessionSummaries: () => [],
    async createCompanionSession() {
      calls.push("createCompanion");
      return {} as never;
    },
  });

    assert.ok(handlers.has("withmate:open-session"));
    assert.ok(handlers.has("withmate:list-session-summaries"));
    assert.ok(handlers.has("withmate:get-app-settings"));
  assert.ok(handlers.has("withmate:run-session-turn"));
  assert.ok(handlers.has("withmate:create-companion-session"));

  await handlers.get("withmate:open-session")?.({}, "session-1");
  await handlers.get("withmate:open-memory-management-window")?.({});
  handlers.get("withmate:run-session-memory-extraction")?.({}, "session-1");
  handlers.get("withmate:cancel-session-run")?.({}, "session-1");
  await handlers.get("withmate:open-path")?.({}, "target", null);
  await handlers.get(WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL)?.({});

  assert.deepEqual(calls, [
    "openSession:session-1",
    "openMemory",
    "runSessionMemoryExtraction",
    "cancelRun",
    "openPath",
    "openLogs",
  ]);
});

test("registerMainIpcHandlers は current invoke channel を domain ごとにすべて登録する", () => {
  const { ipcMain, handlers } = createIpcMainStub();

  registerMainIpcHandlers(ipcMain, {
    resolveEventWindow: () => null,
    resolveHomeWindow: () => null,
    async openSessionWindow() {},
    async openHomeWindow() {},
    async openSessionMonitorWindow() {},
    async openSettingsWindow() {},
    async openMemoryManagementWindow() {},
    async openCharacterEditorWindow() {},
    async openDiffWindow() {},
     listSessionSummaries: () => [],
    listSessionAuditLogs: () => [],
    async listSessionSkills() { return []; },
    async listSessionCustomAgents() { return []; },
    listOpenSessionWindowIds: () => [],
    getAppSettings: () => ({ providers: {}, codingProviderSettings: {}, memoryExtractionProviderSettings: {}, characterReflectionProviderSettings: {} } as never),
    updateAppSettings: (settings) => settings,
    async resetAppDatabase() { return null; },
    getMemoryManagementSnapshot: () => ({ sessionMemories: [], projectMemories: [], characterMemories: [] }),
    deleteSessionMemory() {},
    deleteProjectMemoryEntry() {},
    deleteCharacterMemoryEntry() {},
    async listCharacters() { return []; },
    getModelCatalog: () => null,
    importModelCatalogDocument: () => ({ revision: 1, providers: [] }),
    async importModelCatalogFromFile() { return null; },
    exportModelCatalogDocument: () => null,
    async exportModelCatalogToFile() { return null; },
    getSession: () => null,
    getDiffPreview: () => null,
    getLiveSessionRun: () => null,
    async getProviderQuotaTelemetry() { return null; },
    getSessionContextTelemetry: () => null,
    getSessionBackgroundActivity: () => null,
    resolveLiveApproval() {},
    resolveLiveElicitation() {},
    async getCharacter() { return null; },
    async getCharacterUpdateWorkspace() { return null; },
    async extractCharacterUpdateMemory() { return { characterId: "c-1", generatedAt: "", entryCount: 0, text: "" }; },
    async createCharacterUpdateSession() { return {} as never; },
    createSession: () => ({}) as never,
    updateSession: () => ({}) as never,
    deleteSession() {},
    async previewComposerInput() { return null; },
    async searchWorkspaceFiles() { return []; },
    async runSessionTurn() { return {} as never; },
    runSessionMemoryExtraction() {},
    cancelSessionRun() {},
    async createCharacter() { return {} as never; },
    async updateCharacter() { return {} as never; },
    async deleteCharacter() {},
    async pickDirectory() { return null; },
    async pickFile() { return null; },
    async pickImageFile() { return null; },
    async openPathTarget() {},
    async openAppLogFolder() {},
    async openCrashDumpFolder() {},
    async openSessionTerminal() {},
    listCompanionSessionSummaries: () => [],
    async createCompanionSession() { return {} as never; },
  });

  const expectedChannels = [
    WITHMATE_OPEN_SESSION_CHANNEL,
    WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
    WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
    WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
    WITHMATE_OPEN_MEMORY_MANAGEMENT_WINDOW_CHANNEL,
    WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
    WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
    WITHMATE_PICK_DIRECTORY_CHANNEL,
    WITHMATE_PICK_FILE_CHANNEL,
    WITHMATE_PICK_IMAGE_FILE_CHANNEL,
    WITHMATE_OPEN_PATH_CHANNEL,
    WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
    WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
    WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
    WITHMATE_GET_MODEL_CATALOG_CHANNEL,
    WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
    WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
    WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
    WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
    WITHMATE_GET_APP_SETTINGS_CHANNEL,
    WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
    WITHMATE_RESET_APP_DATABASE_CHANNEL,
    WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL,
    WITHMATE_DELETE_SESSION_MEMORY_CHANNEL,
    WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL,
     WITHMATE_DELETE_CHARACTER_MEMORY_ENTRY_CHANNEL,
     WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
    WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL,
    WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
    WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
    WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
    WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
    WITHMATE_GET_SESSION_CHANNEL,
    WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
    WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
    WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL,
    WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
    WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
    WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
    WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
    WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
    WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
    WITHMATE_CREATE_SESSION_CHANNEL,
    WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
    WITHMATE_UPDATE_SESSION_CHANNEL,
    WITHMATE_DELETE_SESSION_CHANNEL,
    WITHMATE_RUN_SESSION_TURN_CHANNEL,
    WITHMATE_RUN_SESSION_MEMORY_EXTRACTION_CHANNEL,
    WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
    WITHMATE_LIST_CHARACTERS_CHANNEL,
    WITHMATE_GET_CHARACTER_CHANNEL,
    WITHMATE_GET_CHARACTER_UPDATE_WORKSPACE_CHANNEL,
    WITHMATE_EXTRACT_CHARACTER_UPDATE_MEMORY_CHANNEL,
    WITHMATE_CREATE_CHARACTER_UPDATE_SESSION_CHANNEL,
    WITHMATE_CREATE_CHARACTER_CHANNEL,
    WITHMATE_UPDATE_CHARACTER_CHANNEL,
    WITHMATE_DELETE_CHARACTER_CHANNEL,
  ];

  assert.deepEqual([...handlers.keys()].sort(), [...expectedChannels].sort());
});
