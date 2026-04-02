import type { IpcRenderer } from "electron";

import type {
  WithMateWindowApi,
  WithMateWindowCatalogApi,
  WithMateWindowCharacterApi,
  WithMateWindowNavigationApi,
  WithMateWindowObservabilityApi,
  WithMateWindowPickerApi,
  WithMateWindowSessionApi,
  WithMateWindowSettingsApi,
  WithMateWindowSubscriptionApi,
} from "../src/withmate-window-api.js";
import {
  WITHMATE_APP_SETTINGS_CHANGED_EVENT,
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CHARACTERS_CHANGED_EVENT,
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
  WITHMATE_LIVE_SESSION_RUN_EVENT,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_RUN_SESSION_MEMORY_EXTRACTION_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT,
  WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
} from "../src/withmate-ipc-channels.js";

type IpcRendererLike = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;
type ListenerDisposer = () => void;
type ModelCatalogChangedPayload = Awaited<ReturnType<WithMateWindowApi["getModelCatalog"]>>;
type LiveSessionRunPayload = {
  sessionId: string;
  state: Awaited<ReturnType<WithMateWindowApi["getLiveSessionRun"]>>;
};
type ProviderQuotaTelemetryPayload = {
  providerId: string;
  telemetry: Awaited<ReturnType<WithMateWindowApi["getProviderQuotaTelemetry"]>>;
};
type SessionContextTelemetryPayload = {
  sessionId: string;
  telemetry: Awaited<ReturnType<WithMateWindowApi["getSessionContextTelemetry"]>>;
};
type SessionBackgroundActivityPayload = {
  sessionId: string;
  kind: Parameters<WithMateWindowApi["getSessionBackgroundActivity"]>[1];
  state: Awaited<ReturnType<WithMateWindowApi["getSessionBackgroundActivity"]>>;
};

function subscribe<EventArgs extends unknown[]>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  listener: (...args: EventArgs) => void,
): ListenerDisposer {
  const wrapped = (_event: unknown, ...args: EventArgs) => {
    listener(...args);
  };

  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function createWindowApi(ipcRenderer: IpcRendererLike): WithMateWindowNavigationApi {
  return {
    openSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_CHANNEL, sessionId);
    },
    openHomeWindow() {
      return ipcRenderer.invoke(WITHMATE_OPEN_HOME_WINDOW_CHANNEL);
    },
    openSessionMonitorWindow() {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL);
    },
    openSettingsWindow() {
      return ipcRenderer.invoke(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL);
    },
    openCharacterEditor(characterId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL, characterId ?? null);
    },
    openDiffWindow(diffPreview) {
      return ipcRenderer.invoke(WITHMATE_OPEN_DIFF_WINDOW_CHANNEL, diffPreview);
    },
    openPath(target, options) {
      return ipcRenderer.invoke(WITHMATE_OPEN_PATH_CHANNEL, target, options ?? null);
    },
    openSessionTerminal(sessionId) {
      return ipcRenderer.invoke(WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL, sessionId);
    },
  };
}

function createCatalogApi(ipcRenderer: IpcRendererLike): WithMateWindowCatalogApi {
  return {
    getModelCatalog(revision) {
      return ipcRenderer.invoke(WITHMATE_GET_MODEL_CATALOG_CHANNEL, revision ?? null);
    },
    importModelCatalog(document) {
      return ipcRenderer.invoke(WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL, document);
    },
    exportModelCatalog(revision) {
      return ipcRenderer.invoke(WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL, revision ?? null);
    },
    importModelCatalogFile() {
      return ipcRenderer.invoke(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL);
    },
    exportModelCatalogFile(revision) {
      return ipcRenderer.invoke(WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL, revision ?? null);
    },
    getDiffPreview(token) {
      return ipcRenderer.invoke(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, token);
    },
  };
}

function createSessionApi(ipcRenderer: IpcRendererLike): WithMateWindowSessionApi {
  return {
    listSessions() {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSIONS_CHANNEL);
    },
    getSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_CHANNEL, sessionId);
    },
    createSession(input) {
      return ipcRenderer.invoke(WITHMATE_CREATE_SESSION_CHANNEL, input);
    },
    updateSession(session) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_SESSION_CHANNEL, session);
    },
    deleteSession(sessionId) {
      return ipcRenderer.invoke(WITHMATE_DELETE_SESSION_CHANNEL, sessionId);
    },
    previewComposerInput(sessionId, userMessage) {
      return ipcRenderer.invoke(WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL, sessionId, userMessage);
    },
    searchWorkspaceFiles(sessionId, query) {
      return ipcRenderer.invoke(WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL, sessionId, query);
    },
    listSessionSkills(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_SKILLS_CHANNEL, sessionId);
    },
    listSessionCustomAgents(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL, sessionId);
    },
    runSessionTurn(sessionId, request) {
      return ipcRenderer.invoke(WITHMATE_RUN_SESSION_TURN_CHANNEL, sessionId, request);
    },
    runSessionMemoryExtraction(sessionId) {
      return ipcRenderer.invoke(WITHMATE_RUN_SESSION_MEMORY_EXTRACTION_CHANNEL, sessionId);
    },
    cancelSessionRun(sessionId) {
      return ipcRenderer.invoke(WITHMATE_CANCEL_SESSION_RUN_CHANNEL, sessionId);
    },
    listSessionAuditLogs(sessionId) {
      return ipcRenderer.invoke(WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL, sessionId);
    },
    getLiveSessionRun(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL, sessionId);
    },
    resolveLiveApproval(sessionId, requestId, decision) {
      return ipcRenderer.invoke(WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL, sessionId, requestId, decision);
    },
    resolveLiveElicitation(sessionId, requestId, response) {
      return ipcRenderer.invoke(WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL, sessionId, requestId, response);
    },
  };
}

function createObservabilityApi(ipcRenderer: IpcRendererLike): Pick<
  WithMateWindowObservabilityApi,
  | "getProviderQuotaTelemetry"
  | "getSessionContextTelemetry"
  | "getSessionBackgroundActivity"
  | "listOpenSessionWindowIds"
> {
  return {
    getProviderQuotaTelemetry(providerId) {
      return ipcRenderer.invoke(WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL, providerId);
    },
    getSessionContextTelemetry(sessionId) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL, sessionId);
    },
    getSessionBackgroundActivity(sessionId, kind) {
      return ipcRenderer.invoke(WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL, sessionId, kind);
    },
    listOpenSessionWindowIds() {
      return ipcRenderer.invoke(WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL);
    },
  };
}

function createSettingsApi(ipcRenderer: IpcRendererLike): WithMateWindowSettingsApi {
  return {
    getAppSettings() {
      return ipcRenderer.invoke(WITHMATE_GET_APP_SETTINGS_CHANNEL);
    },
    updateAppSettings(settings) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_APP_SETTINGS_CHANNEL, settings);
    },
    resetAppDatabase(request) {
      return ipcRenderer.invoke(WITHMATE_RESET_APP_DATABASE_CHANNEL, request);
    },
    getMemoryManagementSnapshot() {
      return ipcRenderer.invoke(WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL);
    },
    deleteSessionMemory(sessionId) {
      return ipcRenderer.invoke(WITHMATE_DELETE_SESSION_MEMORY_CHANNEL, sessionId);
    },
    deleteProjectMemoryEntry(entryId) {
      return ipcRenderer.invoke(WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL, entryId);
    },
    deleteCharacterMemoryEntry(entryId) {
      return ipcRenderer.invoke(WITHMATE_DELETE_CHARACTER_MEMORY_ENTRY_CHANNEL, entryId);
    },
  };
}

function createCharacterApi(ipcRenderer: IpcRendererLike): WithMateWindowCharacterApi {
  return {
    listCharacters() {
      return ipcRenderer.invoke(WITHMATE_LIST_CHARACTERS_CHANNEL);
    },
    getCharacter(characterId) {
      return ipcRenderer.invoke(WITHMATE_GET_CHARACTER_CHANNEL, characterId);
    },
    getCharacterUpdateWorkspace(characterId) {
      return ipcRenderer.invoke(WITHMATE_GET_CHARACTER_UPDATE_WORKSPACE_CHANNEL, characterId);
    },
    extractCharacterUpdateMemory(characterId) {
      return ipcRenderer.invoke(WITHMATE_EXTRACT_CHARACTER_UPDATE_MEMORY_CHANNEL, characterId);
    },
    createCharacterUpdateSession(characterId, providerId) {
      return ipcRenderer.invoke(WITHMATE_CREATE_CHARACTER_UPDATE_SESSION_CHANNEL, characterId, providerId);
    },
    createCharacter(input) {
      return ipcRenderer.invoke(WITHMATE_CREATE_CHARACTER_CHANNEL, input);
    },
    updateCharacter(character) {
      return ipcRenderer.invoke(WITHMATE_UPDATE_CHARACTER_CHANNEL, character);
    },
    deleteCharacter(characterId) {
      return ipcRenderer.invoke(WITHMATE_DELETE_CHARACTER_CHANNEL, characterId);
    },
  };
}

function createPickerApi(ipcRenderer: IpcRendererLike): WithMateWindowPickerApi {
  return {
    pickDirectory(initialPath) {
      return ipcRenderer.invoke(WITHMATE_PICK_DIRECTORY_CHANNEL, initialPath ?? null);
    },
    pickFile(initialPath) {
      return ipcRenderer.invoke(WITHMATE_PICK_FILE_CHANNEL, initialPath ?? null);
    },
    pickImageFile(initialPath) {
      return ipcRenderer.invoke(WITHMATE_PICK_IMAGE_FILE_CHANNEL, initialPath ?? null);
    },
  };
}

function createSubscriptionApi(ipcRenderer: IpcRendererLike): WithMateWindowSubscriptionApi {
  return {
    subscribeSessions(listener) {
      return subscribe(ipcRenderer, WITHMATE_SESSIONS_CHANGED_EVENT, listener);
    },
    subscribeCharacters(listener) {
      return subscribe(ipcRenderer, WITHMATE_CHARACTERS_CHANGED_EVENT, listener);
    },
    subscribeModelCatalog(listener) {
      return subscribe(ipcRenderer, WITHMATE_MODEL_CATALOG_CHANGED_EVENT, (catalog: ModelCatalogChangedPayload) => {
        if (catalog) {
          listener(catalog);
        }
      });
    },
    subscribeAppSettings(listener) {
      return subscribe(ipcRenderer, WITHMATE_APP_SETTINGS_CHANGED_EVENT, listener);
    },
    subscribeLiveSessionRun(listener) {
      return subscribe(ipcRenderer, WITHMATE_LIVE_SESSION_RUN_EVENT, (payload: LiveSessionRunPayload) => {
        listener(payload.sessionId, payload.state ?? null);
      });
    },
    subscribeProviderQuotaTelemetry(listener) {
      return subscribe(ipcRenderer, WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT, (payload: ProviderQuotaTelemetryPayload) => {
        listener(payload.providerId, payload.telemetry ?? null);
      });
    },
    subscribeSessionContextTelemetry(listener) {
      return subscribe(ipcRenderer, WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT, (payload: SessionContextTelemetryPayload) => {
        listener(payload.sessionId, payload.telemetry ?? null);
      });
    },
    subscribeSessionBackgroundActivity(listener) {
      return subscribe(
        ipcRenderer,
        WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT,
        (payload: SessionBackgroundActivityPayload) => {
        listener(payload.sessionId, payload.kind, payload.state ?? null);
        },
      );
    },
    subscribeOpenSessionWindowIds(listener) {
      return subscribe(ipcRenderer, WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT, listener);
    },
  };
}

export function createWithMateWindowApi(ipcRenderer: IpcRendererLike): WithMateWindowApi {
  return {
    ...createWindowApi(ipcRenderer),
    ...createCatalogApi(ipcRenderer),
    ...createSessionApi(ipcRenderer),
    ...createObservabilityApi(ipcRenderer),
    ...createSettingsApi(ipcRenderer),
    ...createCharacterApi(ipcRenderer),
    ...createPickerApi(ipcRenderer),
    ...createSubscriptionApi(ipcRenderer),
  };
}
