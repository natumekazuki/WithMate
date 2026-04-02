import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import type {
  AuditLogEntry,
  CharacterProfile,
  LiveApprovalDecision,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  RunSessionTurnRequest,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
} from "../src/app-state.js";
import type { CreateCharacterInput } from "../src/character-state.js";
import type { CharacterUpdateMemoryExtract, CharacterUpdateWorkspace } from "../src/character-update-state.js";
import type { MemoryManagementSnapshot } from "../src/memory-management-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../src/runtime-state.js";
import type { CreateSessionInput, DiffPreviewPayload, Session } from "../src/session-state.js";
import {
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_CHARACTER_UPDATE_SESSION_CHANNEL,
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
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
  WITHMATE_LIST_SESSIONS_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
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
} from "../src/withmate-ipc-channels.js";
import type { OpenPathOptions, ResetAppDatabaseRequest } from "../src/withmate-window-types.js";

type MaybeWindow = BrowserWindow | null | undefined;

export type MainIpcRegistrationDeps = {
  resolveEventWindow(event: IpcMainInvokeEvent): MaybeWindow;
  resolveHomeWindow(): MaybeWindow;
  openSessionWindow(sessionId: string): Promise<void>;
  openHomeWindow(): Promise<void>;
  openSessionMonitorWindow(): Promise<void>;
  openSettingsWindow(): Promise<void>;
  openCharacterEditorWindow(characterId?: string | null): Promise<void>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
  listSessions(): Session[];
  listSessionAuditLogs(sessionId: string): AuditLogEntry[];
  listSessionSkills(sessionId: string): DiscoveredSkill[];
  listSessionCustomAgents(sessionId: string): DiscoveredCustomAgent[];
  listOpenSessionWindowIds(): string[];
  getAppSettings(): AppSettings;
  updateAppSettings(settings: AppSettings): AppSettings;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
  getMemoryManagementSnapshot(): MemoryManagementSnapshot;
  deleteSessionMemory(sessionId: string): void;
  deleteProjectMemoryEntry(entryId: string): void;
  deleteCharacterMemoryEntry(entryId: string): void;
  listCharacters(): Promise<CharacterProfile[]>;
  getModelCatalog(revision: number | null): ModelCatalogSnapshot | null;
  importModelCatalogDocument(document: ModelCatalogDocument): ModelCatalogSnapshot;
  importModelCatalogFromFile(targetWindow?: MaybeWindow): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogDocument(revision: number | null): ModelCatalogDocument | null;
  exportModelCatalogToFile(revision: number | null, targetWindow?: MaybeWindow): Promise<string | null>;
  getSession(sessionId: string): Session | null;
  getDiffPreview(token: string): DiffPreviewPayload | null;
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  getProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null;
  getSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
  ): SessionBackgroundActivityState | null;
  resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void;
  resolveLiveElicitation(sessionId: string, requestId: string, response: LiveElicitationResponse): void;
  getCharacter(characterId: string): Promise<CharacterProfile | null>;
  getCharacterUpdateWorkspace(characterId: string): Promise<CharacterUpdateWorkspace | null>;
  extractCharacterUpdateMemory(characterId: string): Promise<CharacterUpdateMemoryExtract>;
  createCharacterUpdateSession(characterId: string, providerId: string): Promise<Session>;
  createSession(input: CreateSessionInput): Session;
  updateSession(session: Session): Session;
  deleteSession(sessionId: string): void;
  previewComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  runSessionMemoryExtraction(sessionId: string): void;
  cancelSessionRun(sessionId: string): void;
  createCharacter(input: CreateCharacterInput): Promise<CharacterProfile>;
  updateCharacter(character: CharacterProfile): Promise<CharacterProfile>;
  deleteCharacter(characterId: string): Promise<void>;
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickImageFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  openPathTarget(target: string, options?: OpenPathOptions): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
};

type MainIpcWindowDeps = Pick<
  MainIpcRegistrationDeps,
  | "resolveEventWindow"
  | "resolveHomeWindow"
  | "openSessionWindow"
  | "openHomeWindow"
  | "openSessionMonitorWindow"
  | "openSettingsWindow"
  | "openCharacterEditorWindow"
  | "openDiffWindow"
  | "openPathTarget"
  | "openSessionTerminal"
  | "pickDirectory"
  | "pickFile"
  | "pickImageFile"
>;

type MainIpcCatalogDeps = Pick<
  MainIpcRegistrationDeps,
  | "resolveEventWindow"
  | "resolveHomeWindow"
  | "getModelCatalog"
  | "importModelCatalogDocument"
  | "importModelCatalogFromFile"
  | "exportModelCatalogDocument"
  | "exportModelCatalogToFile"
>;

type MainIpcSettingsDeps = Pick<
  MainIpcRegistrationDeps,
  | "getAppSettings"
  | "updateAppSettings"
  | "resetAppDatabase"
  | "getMemoryManagementSnapshot"
  | "deleteSessionMemory"
  | "deleteProjectMemoryEntry"
  | "deleteCharacterMemoryEntry"
>;

type MainIpcSessionQueryDeps = Pick<
  MainIpcRegistrationDeps,
  | "listSessions"
  | "listSessionAuditLogs"
  | "listSessionSkills"
  | "listSessionCustomAgents"
  | "listOpenSessionWindowIds"
  | "getSession"
  | "getDiffPreview"
  | "previewComposerInput"
  | "searchWorkspaceFiles"
>;

type MainIpcSessionRuntimeDeps = Pick<
  MainIpcRegistrationDeps,
  | "getLiveSessionRun"
  | "getProviderQuotaTelemetry"
  | "getSessionContextTelemetry"
  | "getSessionBackgroundActivity"
  | "resolveLiveApproval"
  | "resolveLiveElicitation"
  | "createSession"
  | "updateSession"
  | "deleteSession"
  | "runSessionTurn"
  | "runSessionMemoryExtraction"
  | "cancelSessionRun"
>;

type MainIpcCharacterDeps = Pick<
  MainIpcRegistrationDeps,
  | "listCharacters"
  | "getCharacter"
  | "getCharacterUpdateWorkspace"
  | "extractCharacterUpdateMemory"
  | "createCharacterUpdateSession"
  | "createCharacter"
  | "updateCharacter"
  | "deleteCharacter"
>;

function resolveTargetWindow(
  event: IpcMainInvokeEvent,
  deps: Pick<MainIpcRegistrationDeps, "resolveEventWindow" | "resolveHomeWindow">,
): BrowserWindow | undefined {
  return deps.resolveEventWindow(event) ?? deps.resolveHomeWindow() ?? undefined;
}

function registerWindowHandlers(ipcMain: IpcMain, deps: MainIpcWindowDeps): void {
  ipcMain.handle(WITHMATE_OPEN_SESSION_CHANNEL, async (_event, sessionId: string) => {
    if (!sessionId) {
      return;
    }
    await deps.openSessionWindow(sessionId);
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
  ipcMain.handle(WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL, async (_event, characterId: string | null) => {
    await deps.openCharacterEditorWindow(characterId);
  });
  ipcMain.handle(WITHMATE_OPEN_DIFF_WINDOW_CHANNEL, async (_event, diffPreview: DiffPreviewPayload) => {
    await deps.openDiffWindow(diffPreview);
  });
  ipcMain.handle(WITHMATE_PICK_DIRECTORY_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickDirectory(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(WITHMATE_PICK_FILE_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickFile(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(WITHMATE_PICK_IMAGE_FILE_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickImageFile(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(WITHMATE_OPEN_PATH_CHANNEL, async (_event, target: string, options: OpenPathOptions | null) =>
    deps.openPathTarget(target, options ?? undefined),
  );
  ipcMain.handle(WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL, async (_event, sessionId: string) =>
    deps.openSessionTerminal(sessionId),
  );
}

function registerCatalogHandlers(ipcMain: IpcMain, deps: MainIpcCatalogDeps): void {
  ipcMain.handle(WITHMATE_GET_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) => deps.getModelCatalog(revision));
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL, (_event, document: ModelCatalogDocument) =>
    deps.importModelCatalogDocument(document),
  );
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL, async (event) =>
    deps.importModelCatalogFromFile(resolveTargetWindow(event, deps)),
  );
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) =>
    deps.exportModelCatalogDocument(revision),
  );
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL, async (event, revision: number | null) =>
    deps.exportModelCatalogToFile(revision, resolveTargetWindow(event, deps)),
  );
}

function registerSettingsHandlers(ipcMain: IpcMain, deps: MainIpcSettingsDeps): void {
  ipcMain.handle(WITHMATE_GET_APP_SETTINGS_CHANNEL, () => deps.getAppSettings());
  ipcMain.handle(WITHMATE_UPDATE_APP_SETTINGS_CHANNEL, (_event, settings) => deps.updateAppSettings(settings));
  ipcMain.handle(WITHMATE_RESET_APP_DATABASE_CHANNEL, (_event, request: ResetAppDatabaseRequest | null | undefined) =>
    deps.resetAppDatabase(request),
  );
  ipcMain.handle(WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL, () => deps.getMemoryManagementSnapshot());
  ipcMain.handle(WITHMATE_DELETE_SESSION_MEMORY_CHANNEL, (_event, sessionId: string) => deps.deleteSessionMemory(sessionId));
  ipcMain.handle(WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL, (_event, entryId: string) =>
    deps.deleteProjectMemoryEntry(entryId),
  );
  ipcMain.handle(WITHMATE_DELETE_CHARACTER_MEMORY_ENTRY_CHANNEL, (_event, entryId: string) =>
    deps.deleteCharacterMemoryEntry(entryId),
  );
}

function registerSessionQueryHandlers(ipcMain: IpcMain, deps: MainIpcSessionQueryDeps): void {
  ipcMain.handle(WITHMATE_LIST_SESSIONS_CHANNEL, () => deps.listSessions());
  ipcMain.handle(WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL, (_event, sessionId: string) => deps.listSessionAuditLogs(sessionId));
  ipcMain.handle(WITHMATE_LIST_SESSION_SKILLS_CHANNEL, (_event, sessionId: string) => deps.listSessionSkills(sessionId));
  ipcMain.handle(WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL, (_event, sessionId: string) =>
    deps.listSessionCustomAgents(sessionId),
  );
  ipcMain.handle(WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL, () => deps.listOpenSessionWindowIds());
  ipcMain.handle(WITHMATE_GET_SESSION_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getSession(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, (_event, token: string) => {
    if (!token) {
      return null;
    }
    return deps.getDiffPreview(token);
  });
  ipcMain.handle(WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL, (_event, sessionId: string, userMessage: string) =>
    deps.previewComposerInput(sessionId, userMessage),
  );
  ipcMain.handle(WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL, (_event, sessionId: string, query: string) =>
    deps.searchWorkspaceFiles(sessionId, query),
  );
}

function registerSessionRuntimeHandlers(ipcMain: IpcMain, deps: MainIpcSessionRuntimeDeps): void {
  ipcMain.handle(WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getLiveSessionRun(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL, async (_event, providerId: string) => {
    if (!providerId) {
      return null;
    }
    return deps.getProviderQuotaTelemetry(providerId);
  });
  ipcMain.handle(WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getSessionContextTelemetry(sessionId);
  });
  ipcMain.handle(
    WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
    (_event, sessionId: string, kind: SessionBackgroundActivityKind) => {
      if (!sessionId || !kind) {
        return null;
      }
      return deps.getSessionBackgroundActivity(sessionId, kind);
    },
  );
  ipcMain.handle(
    WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
    (_event, sessionId: string, requestId: string, decision: LiveApprovalDecision) => {
      deps.resolveLiveApproval(sessionId, requestId, decision);
    },
  );
  ipcMain.handle(
    WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
    (_event, sessionId: string, requestId: string, response: LiveElicitationResponse) => {
      deps.resolveLiveElicitation(sessionId, requestId, response);
    },
  );
  ipcMain.handle(WITHMATE_CREATE_SESSION_CHANNEL, (_event, input: CreateSessionInput) => deps.createSession(input));
  ipcMain.handle(WITHMATE_UPDATE_SESSION_CHANNEL, (_event, session: Session) => deps.updateSession(session));
  ipcMain.handle(WITHMATE_DELETE_SESSION_CHANNEL, (_event, sessionId: string) => deps.deleteSession(sessionId));
  ipcMain.handle(WITHMATE_RUN_SESSION_TURN_CHANNEL, async (_event, sessionId: string, request: RunSessionTurnRequest) =>
    deps.runSessionTurn(sessionId, request),
  );
  ipcMain.handle(WITHMATE_RUN_SESSION_MEMORY_EXTRACTION_CHANNEL, (_event, sessionId: string) => {
    deps.runSessionMemoryExtraction(sessionId);
  });
  ipcMain.handle(WITHMATE_CANCEL_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    deps.cancelSessionRun(sessionId);
  });
}

function registerCharacterHandlers(ipcMain: IpcMain, deps: MainIpcCharacterDeps): void {
  ipcMain.handle(WITHMATE_LIST_CHARACTERS_CHANNEL, async () => deps.listCharacters());
  ipcMain.handle(WITHMATE_GET_CHARACTER_CHANNEL, async (_event, characterId: string) => {
    if (!characterId) {
      return null;
    }
    return deps.getCharacter(characterId);
  });
  ipcMain.handle(WITHMATE_GET_CHARACTER_UPDATE_WORKSPACE_CHANNEL, async (_event, characterId: string) => {
    if (!characterId) {
      return null;
    }
    return deps.getCharacterUpdateWorkspace(characterId);
  });
  ipcMain.handle(WITHMATE_EXTRACT_CHARACTER_UPDATE_MEMORY_CHANNEL, async (_event, characterId: string) =>
    deps.extractCharacterUpdateMemory(characterId),
  );
  ipcMain.handle(
    WITHMATE_CREATE_CHARACTER_UPDATE_SESSION_CHANNEL,
    async (_event, characterId: string, providerId: string) => deps.createCharacterUpdateSession(characterId, providerId),
  );
  ipcMain.handle(WITHMATE_CREATE_CHARACTER_CHANNEL, async (_event, input: CreateCharacterInput) => deps.createCharacter(input));
  ipcMain.handle(WITHMATE_UPDATE_CHARACTER_CHANNEL, async (_event, character: CharacterProfile) => deps.updateCharacter(character));
  ipcMain.handle(WITHMATE_DELETE_CHARACTER_CHANNEL, async (_event, characterId: string) => deps.deleteCharacter(characterId));
}

export function registerMainIpcHandlers(ipcMain: IpcMain, deps: MainIpcRegistrationDeps): void {
  registerWindowHandlers(ipcMain, deps);
  registerCatalogHandlers(ipcMain, deps);
  registerSettingsHandlers(ipcMain, deps);
  registerSessionQueryHandlers(ipcMain, deps);
  registerSessionRuntimeHandlers(ipcMain, deps);
  registerCharacterHandlers(ipcMain, deps);
}
