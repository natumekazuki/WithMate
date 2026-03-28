import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import {
  type AuditLogEntry,
  type CharacterMemoryDelta,
  type CharacterMemoryEntry,
  type CharacterReflectionMonologue,
  cloneCharacterProfiles,
  cloneSessions,
  type CharacterProfile,
  currentTimestampLabel,
  type CreateCharacterInput,
  type CreateSessionInput,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  type DiffPreviewPayload,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  mergeSessionMemory,
  getProviderAppSettings,
  normalizeAppSettings,
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type RunSessionTurnRequest,
  type Session,
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionMemory,
  type SessionMemoryDelta,
  type SessionContextTelemetry,
} from "../src/app-state.js";
import {
  coerceModelSelection,
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  parseModelCatalogDocument,
  type ModelCatalogDocument,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import {
  createStoredCharacter,
  deleteStoredCharacter,
  getStoredCharacter,
  listStoredCharacters,
  updateStoredCharacter,
} from "./character-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CopilotAdapter } from "./copilot-adapter.js";
import { ProviderTurnError, type ProviderTurnAdapter } from "./provider-runtime.js";
import { resolveComposerPreview } from "./composer-attachments.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { resolveOpenPathTarget } from "./open-path.js";
import { launchTerminalAtPath } from "./open-terminal.js";
import { SessionStorage } from "./session-storage.js";
import { SessionMemoryStorage } from "./session-memory-storage.js";
import { ProjectMemoryStorage } from "./project-memory-storage.js";
import { CharacterMemoryStorage } from "./character-memory-storage.js";
import { SessionRuntimeService } from "./session-runtime-service.js";
import { SessionPersistenceService } from "./session-persistence-service.js";
import { SessionWindowBridge } from "./session-window-bridge.js";
import { buildProjectMemoryPromotionEntries } from "./project-memory-promotion.js";
import { retrieveProjectMemoryEntries } from "./project-memory-retrieval.js";
import {
  buildCharacterReflectionContextSnapshot,
  buildCharacterReflectionLogicalPrompt,
  buildCharacterReflectionPrompt,
  buildCharacterReflectionTransportPayload,
  getCharacterReflectionSettings,
  hasCharacterMemoryDeltaContent,
  shouldTriggerCharacterReflection,
  type CharacterReflectionCheckpoint,
  type CharacterReflectionTriggerReason,
} from "./character-reflection.js";
import { retrieveCharacterMemoryEntries } from "./character-memory-retrieval.js";
import {
  buildSessionMemoryExtractionLogicalPrompt,
  buildSessionMemoryExtractionPrompt,
  buildSessionMemoryExtractionTransportPayload,
  getSessionMemoryExtractionSettings,
  shouldTriggerSessionMemoryExtraction,
  type SessionMemoryExtractionTriggerReason,
} from "./session-memory-extraction.js";
import { resolveProjectScope } from "./project-scope.js";
import { discoverSessionSkills } from "./skill-discovery.js";
import { discoverSessionCustomAgents } from "./custom-agent-discovery.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";
import { clearWorkspaceFileIndex, searchWorkspaceFilePaths } from "./workspace-file-search.js";
import {
  areAllResetAppDatabaseTargetsSelected,
  WITHMATE_CHARACTERS_CHANGED_EVENT,
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_CHARACTER_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
  WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
  WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
  WITHMATE_LIST_SESSIONS_CHANNEL,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_LIVE_SESSION_RUN_EVENT,
  WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
  WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
  WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT,
  WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
  WITHMATE_APP_SETTINGS_CHANGED_EVENT,
  normalizeResetAppDatabaseTargets,
  type OpenPathOptions,
  type ResetAppDatabaseRequest,
  type ResetAppDatabaseResult,
  type ResetAppDatabaseTarget,
} from "../src/withmate-window.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "preload.js");
const rendererDistPath = path.resolve(currentDir, "../../dist");
const appDataPath = app.getPath("appData");
const fixedUserDataPath = path.join(appDataPath, "WithMate");
app.setPath("userData", fixedUserDataPath);
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const bundledModelCatalogPath = devServerUrl
  ? path.resolve(currentDir, "../../public/model-catalog.json")
  : path.resolve(rendererDistPath, "model-catalog.json");
const codexAdapter = new CodexAdapter();
const copilotAdapter = new CopilotAdapter();

let homeWindow: BrowserWindow | null = null;
let sessionMonitorWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
const characterEditorWindows = new Map<string, BrowserWindow>();
const diffWindows = new Map<string, BrowserWindow>();
const diffPreviewStore = new Map<string, DiffPreviewPayload>();
const liveSessionRuns = new Map<string, LiveSessionRunState>();
const characterReflectionCheckpoints = new Map<string, CharacterReflectionCheckpoint>();
const providerQuotaTelemetryByProvider = new Map<string, ProviderQuotaTelemetry>();
const sessionContextTelemetryBySessionId = new Map<string, SessionContextTelemetry>();
const sessionBackgroundActivities = new Map<string, SessionBackgroundActivityState>();
const providerQuotaRefreshPromises = new Map<string, Promise<ProviderQuotaTelemetry | null>>();
const providerQuotaRefreshTimers = new Map<string, NodeJS.Timeout[]>();
const pendingSessionApprovalRequests = new Map<string, { requestId: string; resolve: (decision: LiveApprovalDecision) => void }>();
const inFlightSessionMemoryExtractions = new Set<string>();
const inFlightCharacterReflections = new Set<string>();
let sessions: Session[] = [];
let characters: CharacterProfile[] = [];
let sessionStorage: SessionStorage | null = null;
let sessionMemoryStorage: SessionMemoryStorage | null = null;
let projectMemoryStorage: ProjectMemoryStorage | null = null;
let characterMemoryStorage: CharacterMemoryStorage | null = null;
let modelCatalogStorage: ModelCatalogStorage | null = null;
let auditLogStorage: AuditLogStorage | null = null;
let appSettingsStorage: AppSettingsStorage | null = null;
let allowQuitWithInFlightRuns = false;
let dbPath = "";
const PROVIDER_QUOTA_STALE_TTL_MS = 5 * 60 * 1000;
let sessionRuntimeService: SessionRuntimeService | null = null;
let sessionPersistenceService: SessionPersistenceService | null = null;
let sessionWindowBridge: SessionWindowBridge<BrowserWindow> | null = null;

function createBaseWindow(options: ConstructorParameters<typeof BrowserWindow>[0]): BrowserWindow {
  return new BrowserWindow({
    backgroundColor: "#0e131b",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...options,
  });
}

function listSessions(): Session[] {
  return cloneSessions(sessions);
}

function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

function hasInFlightSessionRuns(): boolean {
  return requireSessionRuntimeService().hasInFlightRuns();
}

function isSessionRunInFlight(sessionId: string): boolean {
  return requireSessionRuntimeService().isRunInFlight(sessionId);
}

function requireSessionStorage(): SessionStorage {
  if (!sessionStorage) {
    throw new Error("session storage が初期化されていないよ。");
  }

  return sessionStorage;
}

function requireModelCatalogStorage(): ModelCatalogStorage {
  if (!modelCatalogStorage) {
    throw new Error("model catalog storage が初期化されていないよ。");
  }

  return modelCatalogStorage;
}

function requireAuditLogStorage(): AuditLogStorage {
  if (!auditLogStorage) {
    throw new Error("audit log storage が初期化されていないよ。");
  }

  return auditLogStorage;
}

function requireAppSettingsStorage(): AppSettingsStorage {
  if (!appSettingsStorage) {
    throw new Error("app settings storage が初期化されていないよ。");
  }

  return appSettingsStorage;
}

function requireSessionRuntimeService(): SessionRuntimeService {
  if (!sessionRuntimeService) {
    sessionRuntimeService = new SessionRuntimeService({
      getSession,
      upsertSession,
      resolveComposerPreview,
      resolveSessionCharacter,
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      resolveProviderCatalog,
      getProviderAdapter,
      getSessionMemory: (session) => requireSessionMemoryStorage().ensureSessionMemory(session),
      resolveProjectMemoryEntriesForPrompt,
      createAuditLog: (entry) => requireAuditLogStorage().createAuditLog(entry),
      updateAuditLog: (id, entry) => requireAuditLogStorage().updateAuditLog(id, entry),
      setLiveSessionRun,
      getLiveSessionRun,
      waitForApprovalDecision: (sessionId, request, signal) =>
        waitForLiveApprovalDecision(sessionId, request, signal),
      setProviderQuotaTelemetry: (telemetry) => {
        setProviderQuotaTelemetry(telemetry.provider, telemetry);
      },
      setSessionContextTelemetry: (telemetry) => {
        setSessionContextTelemetry(telemetry.sessionId, telemetry);
      },
      invalidateProviderSessionThread,
      scheduleProviderQuotaTelemetryRefresh,
      runSessionMemoryExtraction: (session, usage, options) => {
        void runSessionMemoryExtraction(session, usage, options);
      },
      runCharacterReflection: (session, options) => {
        void runCharacterReflection(session, options);
      },
      clearWorkspaceFileIndex,
      broadcastLiveSessionRun,
      resolvePendingApprovalRequest: (sessionId, decision) => {
        const pendingApprovalRequest = pendingSessionApprovalRequests.get(sessionId);
        if (pendingApprovalRequest) {
          pendingApprovalRequest.resolve(decision);
        }
      },
      currentTimestampLabel,
    });
  }

  return sessionRuntimeService;
}

function requireSessionPersistenceService(): SessionPersistenceService {
  if (!sessionPersistenceService) {
    sessionPersistenceService = new SessionPersistenceService({
      getSessions: () => sessions,
      setSessions: (nextSessions) => {
        sessions = nextSessions;
      },
      getSession,
      isSessionRunInFlight,
      upsertStoredSession: (session) => requireSessionStorage().upsertSession(session),
      replaceStoredSessions: (nextSessions) => {
        requireSessionStorage().replaceSessions(nextSessions);
      },
      listStoredSessions: () => requireSessionStorage().listSessions(),
      deleteStoredSession: (sessionId) => requireSessionStorage().deleteSession(sessionId),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getModelCatalogSnapshot: () => getModelCatalog(null) ?? requireModelCatalogStorage().ensureSeeded(),
      ensureSessionMemory: (session) => requireSessionMemoryStorage().ensureSessionMemory(session),
      upsertSessionMemory: (memory) => requireSessionMemoryStorage().upsertSessionMemory(memory),
      ensureProjectScope: (scope) => {
        requireProjectMemoryStorage().ensureProjectScope(scope);
      },
      ensureCharacterScope: ({ characterId, displayName }) => {
        requireCharacterMemoryStorage().ensureCharacterScope({ characterId, displayName });
      },
      clearSessionContextTelemetry,
      clearSessionBackgroundActivities,
      clearCharacterReflectionCheckpoint: (sessionId) => {
        setCharacterReflectionCheckpoint(sessionId, null);
      },
      clearInFlightCharacterReflection: (sessionId) => {
        inFlightCharacterReflections.delete(sessionId);
      },
      invalidateProviderSessionThread,
      closeSessionWindow: (sessionId) => {
        requireSessionWindowBridge().closeSessionWindow(sessionId);
      },
      broadcastSessions,
    });
  }

  return sessionPersistenceService;
}

function requireSessionWindowBridge(): SessionWindowBridge<BrowserWindow> {
  if (!sessionWindowBridge) {
    sessionWindowBridge = new SessionWindowBridge({
      createWindow: (sessionId) =>
        createBaseWindow({
          width: 1520,
          height: 940,
          minWidth: 1120,
          minHeight: 760,
          title: `WithMate Session - ${sessionId}`,
        }),
      loadSessionEntry,
      getSession,
      isRunInFlight: isSessionRunInFlight,
      getAllowQuitWithInFlightRuns: () => allowQuitWithInFlightRuns,
      confirmCloseWhileRunning: (window) => {
        const choice = dialog.showMessageBoxSync(window, {
          type: "warning",
          buttons: ["閉じない", "閉じて続行"],
          defaultId: 0,
          cancelId: 0,
          title: "実行中のセッション",
          message: "このセッションはまだ実行中だよ。",
          detail: "閉じても処理は Main Process 側で続くよ。進捗はあとで開き直して確認してね。",
          noLink: true,
        });
        return choice === 1;
      },
      broadcastOpenSessionWindowIds,
      runSessionMemoryExtraction: (session, usage, options) => {
        void runSessionMemoryExtraction(session, usage, options);
      },
      runCharacterReflection: (session, options) => {
        void runCharacterReflection(session, options);
      },
    });
  }

  return sessionWindowBridge;
}

function requireSessionMemoryStorage(): SessionMemoryStorage {
  if (!sessionMemoryStorage) {
    throw new Error("session memory storage が初期化されていないよ。");
  }

  return sessionMemoryStorage;
}

function requireProjectMemoryStorage(): ProjectMemoryStorage {
  if (!projectMemoryStorage) {
    throw new Error("project memory storage が初期化されていないよ。");
  }

  return projectMemoryStorage;
}

function requireCharacterMemoryStorage(): CharacterMemoryStorage {
  if (!characterMemoryStorage) {
    throw new Error("character memory storage が初期化されていないよ。");
  }

  return characterMemoryStorage;
}

async function initializePersistentStores(): Promise<ModelCatalogSnapshot> {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  closePersistentStores();

  modelCatalogStorage = new ModelCatalogStorage(dbPath, bundledModelCatalogPath);
  const activeModelCatalog = modelCatalogStorage.ensureSeeded();
  sessionStorage = new SessionStorage(dbPath);
  sessionMemoryStorage = new SessionMemoryStorage(dbPath);
  projectMemoryStorage = new ProjectMemoryStorage(dbPath);
  characterMemoryStorage = new CharacterMemoryStorage(dbPath);
  auditLogStorage = new AuditLogStorage(dbPath);
  appSettingsStorage = new AppSettingsStorage(dbPath);
  sessions = sessionStorage.listSessions();
  for (const session of sessions) {
    syncSessionMemoryForSession(session);
    syncProjectScopeForSession(session);
    syncCharacterScopeForSession(session);
  }

  return activeModelCatalog;
}

function closePersistentStores(): void {
  modelCatalogStorage?.close();
  sessionStorage?.close();
  sessionMemoryStorage?.close();
  projectMemoryStorage?.close();
  characterMemoryStorage?.close();
  auditLogStorage?.close();
  appSettingsStorage?.close();
  modelCatalogStorage = null;
  sessionStorage = null;
  sessionMemoryStorage = null;
  projectMemoryStorage = null;
  characterMemoryStorage = null;
  auditLogStorage = null;
  appSettingsStorage = null;
}

async function recreateDatabaseFile(): Promise<ModelCatalogSnapshot> {
  closePersistentStores();
  sessions = [];

  if (dbPath) {
    await Promise.all([
      rm(`${dbPath}-wal`, { force: true }),
      rm(`${dbPath}-shm`, { force: true }),
      rm(dbPath, { force: true }),
    ]);
  }

  return initializePersistentStores();
}

function getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null {
  return requireModelCatalogStorage().getCatalog(revision ?? null);
}

function resolveProviderCatalog(
  providerId: string | null | undefined,
  revision?: number | null,
): { snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider } {
  const snapshot = getModelCatalog(revision) ?? requireModelCatalogStorage().ensureSeeded();
  const provider = getProviderCatalog(snapshot.providers, providerId ?? DEFAULT_PROVIDER_ID);
  if (!provider) {
    throw new Error("利用できる model catalog provider が見つからないよ。");
  }

  return { snapshot, provider };
}

function getProviderAdapter(providerId: string | null | undefined): ProviderTurnAdapter {
  return providerId === "copilot" ? copilotAdapter : codexAdapter;
}

function invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void {
  getProviderAdapter(providerId).invalidateSessionThread(sessionId);
}

function invalidateAllProviderSessionThreads(): void {
  codexAdapter.invalidateAllSessionThreads();
  copilotAdapter.invalidateAllSessionThreads();
}

function listCharacters(): CharacterProfile[] {
  return cloneCharacterProfiles(characters);
}

function listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
  return requireAuditLogStorage().listSessionAuditLogs(sessionId);
}

function listSessionSkills(sessionId: string): DiscoveredSkill[] {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("対象セッションが見つからないよ。");
  }

  const appSettings = requireAppSettingsStorage().getSettings();
  const providerSettings = getProviderAppSettings(appSettings, session.provider);
  return discoverSessionSkills(session.workspacePath, providerSettings.skillRootPath);
}

function listSessionCustomAgents(sessionId: string): DiscoveredCustomAgent[] {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("対象セッションが見つからないよ。");
  }

  if (session.provider !== "copilot") {
    return [];
  }

  return discoverSessionCustomAgents(session.workspacePath);
}

function getSession(sessionId: string): Session | null {
  return cloneSessions(sessions).find((session) => session.id === sessionId) ?? null;
}

async function openSessionTerminal(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("対象セッションが見つからないよ。");
  }

  await launchTerminalAtPath(session.workspacePath);
}

async function refreshCharactersFromStorage(): Promise<CharacterProfile[]> {
  characters = await listStoredCharacters();
  return listCharacters();
}

async function getCharacter(characterId: string): Promise<CharacterProfile | null> {
  const character = await getStoredCharacter(characterId);
  if (!character) {
    return null;
  }

  const nextCharacters = await refreshCharactersFromStorage();
  return cloneCharacterProfiles(nextCharacters).find((entry) => entry.id === character.id) ?? character;
}

function broadcastSessions(): void {
  const payload = listSessions();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_SESSIONS_CHANGED_EVENT, payload);
    }
  }
}

function broadcastCharacters(): void {
  const payload = listCharacters();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_CHARACTERS_CHANGED_EVENT, payload);
    }
  }
}

function broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): void {
  const payload = snapshot ?? getModelCatalog();
  if (!payload) {
    return;
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_MODEL_CATALOG_CHANGED_EVENT, payload);
    }
  }
}

function broadcastAppSettings(settings?: ReturnType<AppSettingsStorage["getSettings"]>): void {
  const payload = settings ?? requireAppSettingsStorage().getSettings();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_APP_SETTINGS_CHANGED_EVENT, payload);
    }
  }
}

function getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
  return providerQuotaTelemetryByProvider.get(providerId) ?? null;
}

function broadcastProviderQuotaTelemetry(providerId: string): void {
  const telemetry = getProviderQuotaTelemetry(providerId);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT, { providerId, telemetry });
    }
  }
}

function setProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
  if (telemetry) {
    providerQuotaTelemetryByProvider.set(providerId, telemetry);
  } else {
    providerQuotaTelemetryByProvider.delete(providerId);
  }

  broadcastProviderQuotaTelemetry(providerId);
}

function clearProviderQuotaTelemetry(providerId: string): void {
  providerQuotaRefreshPromises.delete(providerId);
  const scheduledTimers = providerQuotaRefreshTimers.get(providerId) ?? [];
  for (const timer of scheduledTimers) {
    clearTimeout(timer);
  }
  providerQuotaRefreshTimers.delete(providerId);
  setProviderQuotaTelemetry(providerId, null);
}

function clearAllProviderQuotaTelemetry(): void {
  const providerIds = new Set<string>([
    ...providerQuotaTelemetryByProvider.keys(),
    ...providerQuotaRefreshPromises.keys(),
  ]);
  providerQuotaRefreshPromises.clear();
  providerQuotaTelemetryByProvider.clear();
  for (const providerId of providerIds) {
    broadcastProviderQuotaTelemetry(providerId);
  }
}

function isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean {
  if (!telemetry) {
    return true;
  }

  const updatedAt = Date.parse(telemetry.updatedAt);
  if (Number.isNaN(updatedAt)) {
    return true;
  }

  return Date.now() - updatedAt >= PROVIDER_QUOTA_STALE_TTL_MS;
}

async function refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
  const inFlight = providerQuotaRefreshPromises.get(providerId);
  if (inFlight) {
    return inFlight;
  }

  const refreshPromise = (async () => {
    const appSettings = requireAppSettingsStorage().getSettings();
    const telemetry = await getProviderAdapter(providerId).getProviderQuotaTelemetry({
      providerId,
      appSettings,
    });
    setProviderQuotaTelemetry(providerId, telemetry);
    return telemetry;
  })();

  providerQuotaRefreshPromises.set(providerId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    providerQuotaRefreshPromises.delete(providerId);
  }
}

async function getOrRefreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
  const current = getProviderQuotaTelemetry(providerId);
  if (!isProviderQuotaTelemetryStale(current)) {
    return current;
  }

  return refreshProviderQuotaTelemetry(providerId);
}

function scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void {
  const existingTimers = providerQuotaRefreshTimers.get(providerId) ?? [];
  for (const timer of existingTimers) {
    clearTimeout(timer);
  }

  const timers = delaysMs.map((delayMs) =>
    setTimeout(() => {
      void refreshProviderQuotaTelemetry(providerId).catch(() => undefined);
    }, delayMs),
  );
  providerQuotaRefreshTimers.set(providerId, timers);
}

function getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null {
  return sessionContextTelemetryBySessionId.get(sessionId) ?? null;
}

function broadcastSessionContextTelemetry(sessionId: string): void {
  const telemetry = getSessionContextTelemetry(sessionId);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT, { sessionId, telemetry });
    }
  }
}

function setSessionContextTelemetry(sessionId: string, telemetry: SessionContextTelemetry | null): void {
  if (telemetry) {
    sessionContextTelemetryBySessionId.set(sessionId, telemetry);
  } else {
    sessionContextTelemetryBySessionId.delete(sessionId);
  }

  broadcastSessionContextTelemetry(sessionId);
}

function clearSessionContextTelemetry(sessionId: string): void {
  setSessionContextTelemetry(sessionId, null);
}

function clearAllSessionContextTelemetry(): void {
  const sessionIds = Array.from(sessionContextTelemetryBySessionId.keys());
  sessionContextTelemetryBySessionId.clear();
  for (const sessionId of sessionIds) {
    broadcastSessionContextTelemetry(sessionId);
  }
}

function buildSessionBackgroundActivityKey(sessionId: string, kind: SessionBackgroundActivityKind): string {
  return `${sessionId}\u001f${kind}`;
}

function getSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
): SessionBackgroundActivityState | null {
  return sessionBackgroundActivities.get(buildSessionBackgroundActivityKey(sessionId, kind)) ?? null;
}

function broadcastSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
): void {
  const state = getSessionBackgroundActivity(sessionId, kind);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT, { sessionId, kind, state });
    }
  }
}

function setSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
  state: SessionBackgroundActivityState | null,
): void {
  const key = buildSessionBackgroundActivityKey(sessionId, kind);
  if (state) {
    sessionBackgroundActivities.set(key, state);
  } else {
    sessionBackgroundActivities.delete(key);
  }

  broadcastSessionBackgroundActivity(sessionId, kind);
}

function clearSessionBackgroundActivities(sessionId: string): void {
  setSessionBackgroundActivity(sessionId, "memory-generation", null);
  setSessionBackgroundActivity(sessionId, "monologue", null);
}

function getCharacterReflectionCheckpoint(sessionId: string): CharacterReflectionCheckpoint | null {
  return characterReflectionCheckpoints.get(sessionId) ?? null;
}

function setCharacterReflectionCheckpoint(sessionId: string, checkpoint: CharacterReflectionCheckpoint | null): void {
  if (checkpoint) {
    characterReflectionCheckpoints.set(sessionId, checkpoint);
    return;
  }

  characterReflectionCheckpoints.delete(sessionId);
}

function clearAllSessionBackgroundActivities(): void {
  const activityKeys = Array.from(sessionBackgroundActivities.keys());
  sessionBackgroundActivities.clear();
  for (const key of activityKeys) {
    const [sessionId, kind] = key.split("\u001f") as [string | undefined, SessionBackgroundActivityKind | undefined];
    if (sessionId && kind) {
      broadcastSessionBackgroundActivity(sessionId, kind);
    }
  }
}

function listOpenSessionWindowIds(): string[] {
  return requireSessionWindowBridge().listOpenSessionWindowIds();
}

function broadcastOpenSessionWindowIds(): void {
  const payload = listOpenSessionWindowIds();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT, payload);
    }
  }
}

function hasRunningSessions(): boolean {
  return sessions.some((session) => isRunningSession(session));
}

function closeResetTargetWindows(): void {
  requireSessionWindowBridge().closeAllSessionWindows();

  for (const [token, window] of diffWindows.entries()) {
    if (!window.isDestroyed()) {
      window.close();
    }
    diffPreviewStore.delete(token);
  }
  diffWindows.clear();
}

async function resetAppDatabase(request?: ResetAppDatabaseRequest | null): Promise<ResetAppDatabaseResult> {
  if (hasInFlightSessionRuns() || hasRunningSessions()) {
    throw new Error("実行中の session があるため、DB を初期化できないよ。完了またはキャンセル後に試してね。");
  }

  const resetTargets = normalizeResetAppDatabaseTargets(request?.targets);
  if (resetTargets.length === 0) {
    throw new Error("初期化対象が選ばれていないよ。");
  }

  const shouldResetSessions = resetTargets.includes("sessions");
  if (shouldResetSessions) {
    closeResetTargetWindows();
  }

  let modelCatalog: ModelCatalogSnapshot;
  let appSettings: ReturnType<AppSettingsStorage["getSettings"]>;

  if (areAllResetAppDatabaseTargetsSelected(resetTargets)) {
    modelCatalog = await recreateDatabaseFile();
    clearAllProviderQuotaTelemetry();
    clearAllSessionContextTelemetry();
    appSettings = requireAppSettingsStorage().getSettings();
  } else {
    const appliedTargets = new Set<ResetAppDatabaseTarget>(resetTargets);

    if (appliedTargets.has("auditLogs")) {
      requireAuditLogStorage().clearAuditLogs();
    }
    if (appliedTargets.has("sessions")) {
      replaceAllSessions([], { broadcast: false });
      liveSessionRuns.clear();
      characterReflectionCheckpoints.clear();
      inFlightCharacterReflections.clear();
      clearAllSessionBackgroundActivities();
      requireSessionRuntimeService().reset();
      invalidateAllProviderSessionThreads();
    }
    if (appliedTargets.has("appSettings")) {
      requireAppSettingsStorage().resetSettings();
      clearAllProviderQuotaTelemetry();
    }
    if (appliedTargets.has("modelCatalog")) {
      requireModelCatalogStorage().resetToBundled();
    }
    if (appliedTargets.has("projectMemory")) {
      requireProjectMemoryStorage().clearProjectMemories();
    }
    if (appliedTargets.has("characterMemory")) {
      requireCharacterMemoryStorage().clearCharacterMemories();
    }

    sessions = requireSessionStorage().listSessions();
    modelCatalog = getModelCatalog(null) ?? requireModelCatalogStorage().ensureSeeded();
    appSettings = requireAppSettingsStorage().getSettings();
  }

  broadcastSessions();
  broadcastAppSettings(appSettings);
  broadcastModelCatalog(modelCatalog);

  return {
    resetTargets,
    sessions: listSessions(),
    appSettings,
    modelCatalog,
  };
}

function getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
  return liveSessionRuns.get(sessionId) ?? null;
}

function setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void {
  if (state) {
    liveSessionRuns.set(sessionId, state);
  } else {
    liveSessionRuns.delete(sessionId);
  }

  broadcastLiveSessionRun(sessionId);
}

function updateLiveSessionRun(
  sessionId: string,
  recipe: (current: LiveSessionRunState) => LiveSessionRunState,
): LiveSessionRunState | null {
  const current = getLiveSessionRun(sessionId);
  if (!current) {
    return null;
  }

  const next = recipe(current);
  setLiveSessionRun(sessionId, next);
  return next;
}

function broadcastLiveSessionRun(sessionId: string): void {
  const state = getLiveSessionRun(sessionId);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_LIVE_SESSION_RUN_EVENT, { sessionId, state });
    }
  }
}

function isCanceledRunError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /abort|aborted|cancel|canceled|cancelled/i.test(message);
}

function cancelSessionRun(sessionId: string): void {
  requireSessionRuntimeService().cancelRun(sessionId);
}

function resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void {
  const pendingRequest = pendingSessionApprovalRequests.get(sessionId);
  if (!pendingRequest || pendingRequest.requestId !== requestId) {
    throw new Error("対象の承認要求はもう存在しないよ。");
  }

  pendingRequest.resolve(decision);
}

function waitForLiveApprovalDecision(
  sessionId: string,
  request: LiveApprovalRequest,
  signal: AbortSignal,
): Promise<LiveApprovalDecision> {
  if (signal.aborted) {
    return Promise.resolve("deny");
  }

  return new Promise<LiveApprovalDecision>((resolve) => {
    const handleAbort = () => {
      settle("deny");
    };

    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
      const currentPendingRequest = pendingSessionApprovalRequests.get(sessionId);
      if (currentPendingRequest?.requestId === request.requestId) {
        pendingSessionApprovalRequests.delete(sessionId);
      }

      updateLiveSessionRun(sessionId, (current) =>
        current.approvalRequest?.requestId === request.requestId
          ? { ...current, approvalRequest: null }
          : current,
      );
    };

    const settle = (decision: LiveApprovalDecision) => {
      cleanup();
      resolve(decision);
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    pendingSessionApprovalRequests.set(sessionId, {
      requestId: request.requestId,
      resolve: settle,
    });
    updateLiveSessionRun(sessionId, (current) => ({
      ...current,
      approvalRequest: request,
    }));
  });
}

async function importModelCatalogFromFile(targetWindow?: BrowserWindow | null): Promise<ModelCatalogSnapshot | null> {
  const result = targetWindow
    ? await dialog.showOpenDialog(targetWindow, {
        title: "model catalog を読み込む",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    : await dialog.showOpenDialog({
        title: "model catalog を読み込む",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const raw = await readFile(result.filePaths[0], "utf8");
  const document = JSON.parse(raw) as ModelCatalogDocument;
  return importModelCatalogDocument(document);
}

async function exportModelCatalogToFile(revision: number | null | undefined, targetWindow?: BrowserWindow | null): Promise<string | null> {
  const document = requireModelCatalogStorage().exportCatalogDocument(revision);
  if (!document) {
    return null;
  }

  const result = targetWindow
    ? await dialog.showSaveDialog(targetWindow, {
        title: "model catalog を保存",
        defaultPath: "model-catalog.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    : await dialog.showSaveDialog({
        title: "model catalog を保存",
        defaultPath: "model-catalog.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

  if (result.canceled || !result.filePath) {
    return null;
  }

  await writeFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return result.filePath;
}

function createSession(input: CreateSessionInput): Session {
  return requireSessionPersistenceService().createSession(input);
}

function updateSession(nextSession: Session): Session {
  return requireSessionPersistenceService().updateSession(nextSession);
}

function deleteSession(sessionId: string): void {
  requireSessionPersistenceService().deleteSession(sessionId);
}

function upsertSession(nextSession: Session): Session {
  return requireSessionPersistenceService().upsertSession(nextSession);
}

function syncSessionMemoryForSession(session: Session): void {
  const storage = requireSessionMemoryStorage();
  const existing = storage.ensureSessionMemory(session);
  storage.upsertSessionMemory({
    ...existing,
    workspacePath: session.workspacePath,
    threadId: session.threadId,
    goal: existing.goal.trim() ? existing.goal : session.taskTitle.trim(),
  });
}

function syncProjectScopeForSession(session: Session) {
  return requireProjectMemoryStorage().ensureProjectScope(resolveProjectScope(session.workspacePath));
}

function syncCharacterScopeForSession(session: Session) {
  return requireCharacterMemoryStorage().ensureCharacterScope({
    characterId: session.characterId,
    displayName: session.character,
  });
}

function resolveProjectMemoryEntriesForPrompt(
  session: Session,
  userMessage: string,
  sessionMemory: SessionMemory,
) {
  const projectScope = syncProjectScopeForSession(session);
  const storage = requireProjectMemoryStorage();
  const entries = storage.listProjectMemoryEntries(projectScope.id);
  const resolved = retrieveProjectMemoryEntries(entries, userMessage, sessionMemory);
  storage.markProjectMemoryEntriesUsed(resolved.map((entry) => entry.id));
  return resolved;
}

function promoteSessionMemoryDeltaToProjectMemory(session: Session, delta: SessionMemoryDelta): void {
  const projectScope = syncProjectScopeForSession(session);
  const entries = buildProjectMemoryPromotionEntries(session, projectScope.id, delta);
  if (entries.length === 0) {
    return;
  }

  const storage = requireProjectMemoryStorage();
  for (const entry of entries) {
    storage.upsertProjectMemoryEntry(entry);
  }
}

function resolveCharacterMemoryEntriesForReflection(session: Session): CharacterMemoryEntry[] {
  const characterScope = syncCharacterScopeForSession(session);
  const entries = requireCharacterMemoryStorage().listCharacterMemoryEntries(characterScope.id);
  return retrieveCharacterMemoryEntries(entries, session);
}

function buildMonologueSummary(monologue: CharacterReflectionMonologue | null): string {
  if (!monologue) {
    return "更新はありませんでした。";
  }

  return monologue.text.length > 72 ? `${monologue.text.slice(0, 72)}…` : monologue.text;
}

function applyCharacterMemoryDelta(
  session: Session,
  entries: CharacterMemoryDelta["entries"],
): number {
  if (entries.length === 0) {
    return 0;
  }

  const characterScope = syncCharacterScopeForSession(session);
  const storage = requireCharacterMemoryStorage();
  for (const entry of entries) {
    storage.upsertCharacterMemoryEntry({
      characterScopeId: characterScope.id,
      sourceSessionId: session.id,
      category: entry.category,
      title: entry.title,
      detail: entry.detail,
      keywords: entry.keywords,
      evidence: entry.evidence,
    });
  }

  return entries.length;
}

function appendMonologueToSession(
  session: Session,
  monologue: CharacterReflectionMonologue,
): Session {
  const nextStream = [
    ...session.stream,
    {
      mood: monologue.mood,
      time: currentTimestampLabel(),
      text: monologue.text,
    },
  ].slice(-30);

  return upsertSession({
    ...session,
    updatedAt: currentTimestampLabel(),
    stream: nextStream,
  });
}

async function runCharacterReflection(
  session: Session,
  options: { triggerReason: CharacterReflectionTriggerReason },
): Promise<void> {
  if (inFlightCharacterReflections.has(session.id)) {
    return;
  }

  const latestSession = getSession(session.id) ?? session;
  if (isSessionRunInFlight(latestSession.id) || isRunningSession(latestSession)) {
    return;
  }

  const checkpoint = getCharacterReflectionCheckpoint(latestSession.id);
  const currentSnapshot = buildCharacterReflectionContextSnapshot(latestSession);
  if (!shouldTriggerCharacterReflection(currentSnapshot, checkpoint, options.triggerReason)) {
    return;
  }

  const character = await resolveSessionCharacter(latestSession);
  if (!character) {
    return;
  }

  const appSettings = requireAppSettingsStorage().getSettings();
  if (!getProviderAppSettings(appSettings, latestSession.provider).enabled) {
    return;
  }

  const providerAdapter = getProviderAdapter(latestSession.provider);
  const sessionMemory = requireSessionMemoryStorage().ensureSessionMemory(latestSession);
  const characterMemoryEntries = resolveCharacterMemoryEntriesForReflection(latestSession);
  const reflectionSettings = getCharacterReflectionSettings(appSettings, latestSession.provider);
  const prompt = buildCharacterReflectionPrompt({
    session: latestSession,
    sessionMemory,
    character,
    characterMemoryEntries,
    triggerReason: options.triggerReason,
  });
  const logicalPrompt = buildCharacterReflectionLogicalPrompt(prompt);
  const transportPayload = buildCharacterReflectionTransportPayload(
    latestSession.provider,
    reflectionSettings,
    options.triggerReason,
  );
  const runningAuditLog = requireAuditLogStorage().createAuditLog({
    sessionId: latestSession.id,
    createdAt: new Date().toISOString(),
    phase: "background-running",
    provider: latestSession.provider,
    model: reflectionSettings.model,
    reasoningEffort: reflectionSettings.reasoningEffort,
    approvalMode: latestSession.approvalMode,
    threadId: latestSession.threadId,
    logicalPrompt,
    transportPayload,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    errorMessage: "",
  });

  inFlightCharacterReflections.add(latestSession.id);
  setSessionBackgroundActivity(latestSession.id, "monologue", {
    sessionId: latestSession.id,
    kind: "monologue",
    status: "running",
    title: "Monologue",
    summary: options.triggerReason === "session-start"
      ? "SessionStart の独り言を生成しています。"
      : "独り言と Character Memory を整理しています。",
    details: `trigger: ${options.triggerReason}\nmodel: ${reflectionSettings.model}\nreasoning: ${reflectionSettings.reasoningEffort}`,
    errorMessage: "",
    updatedAt: new Date().toISOString(),
  });

  try {
    const reflectionResult = await providerAdapter.runCharacterReflection({
      session: latestSession,
      sessionMemory,
      character,
      characterMemoryEntries,
      appSettings,
      model: reflectionSettings.model,
      reasoningEffort: reflectionSettings.reasoningEffort,
      triggerReason: options.triggerReason,
      prompt,
    });

    if (!reflectionResult.output) {
      throw new Error("Character reflection の JSON parse に失敗したよ。");
    }

    const memoryEntries = reflectionResult.output.memoryDelta?.entries ?? [];
    const monologue = reflectionResult.output.monologue;
    requireAuditLogStorage().updateAuditLog(runningAuditLog.id, {
      sessionId: latestSession.id,
      createdAt: runningAuditLog.createdAt,
      phase: "background-completed",
      provider: latestSession.provider,
      model: reflectionSettings.model,
      reasoningEffort: reflectionSettings.reasoningEffort,
      approvalMode: latestSession.approvalMode,
      threadId: reflectionResult.threadId ?? latestSession.threadId,
      logicalPrompt,
      transportPayload,
      assistantText: reflectionResult.rawText,
      operations: [],
      rawItemsJson: "[]",
      usage: reflectionResult.usage,
      errorMessage: "",
    });

    if (characterMemoryEntries.length > 0) {
      requireCharacterMemoryStorage().markCharacterMemoryEntriesUsed(characterMemoryEntries.map((entry) => entry.id));
    }

    const savedCount = options.triggerReason === "session-start" || !hasCharacterMemoryDeltaContent(reflectionResult.output.memoryDelta)
      ? 0
      : applyCharacterMemoryDelta(latestSession, memoryEntries);
    let sessionForCheckpoint = getSession(latestSession.id) ?? latestSession;
    if (monologue) {
      sessionForCheckpoint = appendMonologueToSession(sessionForCheckpoint, monologue);
    }

    setCharacterReflectionCheckpoint(latestSession.id, {
      ...currentSnapshot,
      reflectedAt: new Date().toISOString(),
    });
    setSessionBackgroundActivity(latestSession.id, "monologue", {
      sessionId: latestSession.id,
      kind: "monologue",
      status: "completed",
      title: "Monologue",
      summary: monologue ? buildMonologueSummary(monologue) : "更新はありませんでした。",
      details: [
        `trigger: ${options.triggerReason}`,
        `model: ${reflectionSettings.model}`,
        `reasoning: ${reflectionSettings.reasoningEffort}`,
        savedCount > 0 ? `characterMemory: ${savedCount}件更新` : "",
      ].filter((line) => line.length > 0).join("\n"),
      errorMessage: "",
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    requireAuditLogStorage().updateAuditLog(runningAuditLog.id, {
      sessionId: latestSession.id,
      createdAt: runningAuditLog.createdAt,
      phase: isCanceledRunError(error) ? "background-canceled" : "background-failed",
      provider: latestSession.provider,
      model: reflectionSettings.model,
      reasoningEffort: reflectionSettings.reasoningEffort,
      approvalMode: latestSession.approvalMode,
      threadId: latestSession.threadId,
      logicalPrompt,
      transportPayload,
      assistantText: "",
      operations: [],
      rawItemsJson: "[]",
      usage: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    setSessionBackgroundActivity(latestSession.id, "monologue", {
      sessionId: latestSession.id,
      kind: "monologue",
      status: isCanceledRunError(error) ? "canceled" : "failed",
      title: "Monologue",
      summary: isCanceledRunError(error) ? "独り言生成はキャンセルされました。" : "独り言生成に失敗しました。",
      details: `trigger: ${options.triggerReason}\nmodel: ${reflectionSettings.model}\nreasoning: ${reflectionSettings.reasoningEffort}`,
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
    console.error("character reflection failed", {
      sessionId: latestSession.id,
      provider: latestSession.provider,
      error,
    });
  } finally {
    inFlightCharacterReflections.delete(latestSession.id);
  }
}

async function runSessionMemoryExtraction(
  session: Session,
  usage: AuditLogEntry["usage"],
  options?: { force?: boolean; triggerReason?: SessionMemoryExtractionTriggerReason },
): Promise<void> {
  if (inFlightSessionMemoryExtractions.has(session.id)) {
    return;
  }

  const appSettings = requireAppSettingsStorage().getSettings();
  const extractionSettings = getSessionMemoryExtractionSettings(appSettings, session.provider);
  const shouldRun = shouldTriggerSessionMemoryExtraction(
    usage,
    extractionSettings.outputTokensThreshold,
    options?.force ?? false,
  );
  if (!shouldRun) {
    return;
  }

  const sessionMemoryStore = requireSessionMemoryStorage();
  const latestSession = getSession(session.id) ?? session;
  const currentMemory = sessionMemoryStore.ensureSessionMemory(latestSession);
  const prompt = buildSessionMemoryExtractionPrompt(latestSession, currentMemory);
  const logicalPrompt = buildSessionMemoryExtractionLogicalPrompt(prompt);
  const triggerReason = options?.triggerReason ?? (options?.force ? "session-window-close" : "outputTokensThreshold");
  const transportPayload = buildSessionMemoryExtractionTransportPayload(
    latestSession.provider,
    extractionSettings,
    triggerReason,
  );
  const providerAdapter = getProviderAdapter(latestSession.provider);
  const runningAuditLog = requireAuditLogStorage().createAuditLog({
    sessionId: latestSession.id,
    createdAt: new Date().toISOString(),
    phase: "background-running",
    provider: latestSession.provider,
    model: extractionSettings.model,
    reasoningEffort: extractionSettings.reasoningEffort,
    approvalMode: latestSession.approvalMode,
    threadId: latestSession.threadId,
    logicalPrompt,
    transportPayload,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    errorMessage: "",
  });

  inFlightSessionMemoryExtractions.add(session.id);
  setSessionBackgroundActivity(session.id, "memory-generation", {
    sessionId: session.id,
    kind: "memory-generation",
    status: "running",
    title: "Memory生成",
    summary: "Session Memory を整理しています。",
    details: `trigger: ${triggerReason}\nmodel: ${extractionSettings.model}\nreasoning: ${extractionSettings.reasoningEffort}`,
    errorMessage: "",
    updatedAt: new Date().toISOString(),
  });
  try {
    const extractionResult = await providerAdapter.extractSessionMemoryDelta({
      session: latestSession,
      appSettings,
      model: extractionSettings.model,
      reasoningEffort: extractionSettings.reasoningEffort,
      prompt,
    });
    const delta = extractionResult.delta;
    requireAuditLogStorage().updateAuditLog(runningAuditLog.id, {
      sessionId: latestSession.id,
      createdAt: runningAuditLog.createdAt,
      phase: "background-completed",
      provider: latestSession.provider,
      model: extractionSettings.model,
      reasoningEffort: extractionSettings.reasoningEffort,
      approvalMode: latestSession.approvalMode,
      threadId: extractionResult.threadId ?? latestSession.threadId,
      logicalPrompt,
      transportPayload,
      assistantText: extractionResult.rawText,
      operations: [],
      rawItemsJson: "[]",
      usage: extractionResult.usage,
      errorMessage: "",
    });
    const memoryFieldLabels = delta
      ? [
        delta.goal !== undefined ? "goal" : null,
        delta.decisions?.length ? "decisions" : null,
        delta.openQuestions?.length ? "openQuestions" : null,
        delta.nextActions?.length ? "nextActions" : null,
        delta.notes?.length ? "notes" : null,
      ].filter((value): value is string => !!value)
      : [];
    setSessionBackgroundActivity(session.id, "memory-generation", {
      sessionId: session.id,
      kind: "memory-generation",
      status: "completed",
      title: "Memory生成",
      summary: memoryFieldLabels.length > 0
        ? `Session Memory を更新しました: ${memoryFieldLabels.join(", ")}`
        : "更新は不要でした。",
      details: `trigger: ${triggerReason}\nmodel: ${extractionSettings.model}\nreasoning: ${extractionSettings.reasoningEffort}`,
      errorMessage: "",
      updatedAt: new Date().toISOString(),
    });
    if (!delta) {
      return;
    }

    const sessionForSave = getSession(session.id) ?? latestSession;
    const currentForSave = sessionMemoryStore.ensureSessionMemory(sessionForSave);
    sessionMemoryStore.upsertSessionMemory(
      mergeSessionMemory(
        {
          ...currentForSave,
          workspacePath: sessionForSave.workspacePath,
          threadId: sessionForSave.threadId,
        },
        delta,
      ),
    );
    promoteSessionMemoryDeltaToProjectMemory(sessionForSave, delta);
  } catch (error) {
    requireAuditLogStorage().updateAuditLog(runningAuditLog.id, {
      sessionId: latestSession.id,
      createdAt: runningAuditLog.createdAt,
      phase: "background-failed",
      provider: latestSession.provider,
      model: extractionSettings.model,
      reasoningEffort: extractionSettings.reasoningEffort,
      approvalMode: latestSession.approvalMode,
      threadId: latestSession.threadId,
      logicalPrompt,
      transportPayload,
      assistantText: "",
      operations: [],
      rawItemsJson: "[]",
      usage: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    setSessionBackgroundActivity(session.id, "memory-generation", {
      sessionId: session.id,
      kind: "memory-generation",
      status: isCanceledRunError(error) ? "canceled" : "failed",
      title: "Memory生成",
      summary: isCanceledRunError(error)
        ? "Memory 生成はキャンセルされました。"
        : "Memory 生成に失敗しました。",
      details: `trigger: ${triggerReason}\nmodel: ${extractionSettings.model}\nreasoning: ${extractionSettings.reasoningEffort}`,
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    });
    console.error("session memory extraction failed", {
      sessionId: session.id,
      provider: session.provider,
      error,
    });
  } finally {
    inFlightSessionMemoryExtractions.delete(session.id);
  }
}

function replaceAllSessions(
  nextSessions: Session[],
  options?: {
    broadcast?: boolean;
    invalidateSessionIds?: Iterable<string>;
  },
): Session[] {
  return requireSessionPersistenceService().replaceAllSessions(nextSessions, options);
}

function syncSessionsForCharacter(character: CharacterProfile): void {
  const touched = sessions.filter((session) => session.characterId === character.id);
  if (touched.length === 0) {
    return;
  }

  for (const session of touched) {
    requireSessionStorage().upsertSession({
      ...session,
      character: character.name,
      characterIconPath: character.iconPath,
      characterThemeColors: character.themeColors,
    });
  }

  sessions = requireSessionStorage().listSessions();
  broadcastSessions();
}

function buildInterruptedSession(session: Session): Session {
  const interruptedMessage = "前回の実行はアプリ終了で中断された可能性があるよ。必要ならもう一度送ってね。";
  const lastMessage = session.messages.at(-1);
  const nextMessages =
    lastMessage?.role === "assistant" && lastMessage.text === interruptedMessage
      ? session.messages
      : [
          ...session.messages,
          {
            role: "assistant" as const,
            text: interruptedMessage,
            accent: true,
          },
        ];

  return {
    ...session,
    status: "idle",
    runState: "interrupted",
    updatedAt: currentTimestampLabel(),
    messages: nextMessages,
  };
}

function recoverInterruptedSessions(): void {
  const runningSessions = sessions.filter(isRunningSession);
  if (runningSessions.length === 0) {
    return;
  }

  for (const session of runningSessions) {
    upsertSession(buildInterruptedSession(session));
  }

  sessions = requireSessionStorage().listSessions();
}

async function createCharacter(input: CreateCharacterInput): Promise<CharacterProfile> {
  const created = await createStoredCharacter(input);
  await refreshCharactersFromStorage();
  broadcastCharacters();
  return cloneCharacterProfiles([created])[0];
}

async function updateCharacter(nextCharacter: CharacterProfile): Promise<CharacterProfile> {
  const updated = await updateStoredCharacter(nextCharacter);
  await refreshCharactersFromStorage();
  syncSessionsForCharacter(updated);
  broadcastCharacters();
  return cloneCharacterProfiles([updated])[0];
}

async function deleteCharacter(characterId: string): Promise<void> {
  await deleteStoredCharacter(characterId);
  await refreshCharactersFromStorage();
  broadcastCharacters();

  const window = characterEditorWindows.get(characterId);
  if (window && !window.isDestroyed()) {
    window.close();
  }

  characterEditorWindows.delete(characterId);
}

async function resolveSessionCharacter(session: Session): Promise<CharacterProfile | null> {
  if (session.characterId) {
    const matched = await getCharacter(session.characterId);
    if (matched) {
      return matched;
    }
  }
  return null;
}

function migrateSessionToCatalog(session: Session, snapshot: ModelCatalogSnapshot): Session {
  const provider = getProviderCatalog(snapshot.providers, session.provider);
  if (!provider) {
    throw new Error("利用できる model catalog provider が見つからないよ。");
  }

  const selection = coerceModelSelection(provider, session.model, session.reasoningEffort);
  const shouldResetThread =
    session.provider !== provider.id ||
    session.model !== selection.resolvedModel ||
    session.reasoningEffort !== selection.resolvedReasoningEffort;

  return {
    ...session,
    provider: provider.id,
    catalogRevision: snapshot.revision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
    threadId: shouldResetThread ? "" : session.threadId,
    updatedAt: shouldResetThread || session.catalogRevision !== snapshot.revision ? currentTimestampLabel() : session.updatedAt,
  };
}

function migrateSessionsToCatalog(snapshot: ModelCatalogSnapshot): Session[] {
  const migratedSessions = sessions.map((session) => migrateSessionToCatalog(session, snapshot));
  const invalidatedSessionIds = migratedSessions
    .filter((session) => !session.threadId)
    .map((session) => session.id);
  return replaceAllSessions(migratedSessions, {
    broadcast: false,
    invalidateSessionIds: invalidatedSessionIds,
  });
}

function importModelCatalogDocument(document: ModelCatalogDocument): ModelCatalogSnapshot {
  if (hasInFlightSessionRuns()) {
    throw new Error("session 実行中は model catalog を読み込めないよ。");
  }

  const storage = requireModelCatalogStorage();
  const previousSnapshot = getModelCatalog(null) ?? storage.ensureSeeded();
  const previousCatalogDocument = storage.exportCatalogDocument(previousSnapshot.revision);
  if (!previousCatalogDocument) {
    throw new Error("rollback 用の model catalog を取得できなかったよ。");
  }

  const previousSessions = listSessions();
  const normalizedDocument = parseModelCatalogDocument(document);
  for (const session of previousSessions) {
    migrateSessionToCatalog(session, { revision: previousSnapshot.revision, providers: normalizedDocument.providers });
  }

  let importedSnapshot: ModelCatalogSnapshot | null = null;
  try {
    importedSnapshot = storage.importCatalogDocument(normalizedDocument, "imported");
    migrateSessionsToCatalog(importedSnapshot);
    broadcastSessions();
    broadcastModelCatalog(importedSnapshot);
    return importedSnapshot;
  } catch (error) {
    if (!importedSnapshot) {
      throw error;
    }

    try {
      storage.importCatalogDocument(previousCatalogDocument, "rollback");
      replaceAllSessions(previousSessions, { broadcast: false });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "model catalog の import を rollback できなかったよ。",
      );
    }

    throw error;
  }
}

function getProvidersWithApiKeyChange(previousSettings: ReturnType<AppSettingsStorage["getSettings"]>, nextSettings: ReturnType<AppSettingsStorage["getSettings"]>): string[] {
  const providerIds = new Set<string>([
    ...Object.keys(previousSettings.codingProviderSettings),
    ...Object.keys(nextSettings.codingProviderSettings),
  ]);

  return Array.from(providerIds).filter(
    (providerId) =>
      getProviderAppSettings(previousSettings, providerId).apiKey.trim() !==
      getProviderAppSettings(nextSettings, providerId).apiKey.trim(),
  );
}

function updateAppSettings(nextSettingsInput: ReturnType<AppSettingsStorage["getSettings"]>): ReturnType<AppSettingsStorage["getSettings"]> {
  const storage = requireAppSettingsStorage();
  const previousSettings = storage.getSettings();
  const nextSettings = normalizeAppSettings(nextSettingsInput);
  const providersWithApiKeyChange = getProvidersWithApiKeyChange(previousSettings, nextSettings);

  if (providersWithApiKeyChange.length > 0) {
    const blockedSessions = sessions.filter(
      (session) =>
        providersWithApiKeyChange.includes(session.provider) &&
        (isSessionRunInFlight(session.id) || isRunningSession(session)),
    );
    if (blockedSessions.length > 0) {
      throw new Error("Coding Agent credential を変更する provider に実行中の session があるため、完了まで待ってね。");
    }
  }

  const previousSessions = listSessions();
  const providersWithApiKeyChangeSet = new Set(providersWithApiKeyChange);
  const nextSessions = previousSessions.map((session) => {
    if (!providersWithApiKeyChangeSet.has(session.provider) || !session.threadId) {
      return session;
    }

    return {
      ...session,
      threadId: "",
      updatedAt: currentTimestampLabel(),
    };
  });
  const invalidatedSessionIds = previousSessions
    .filter((session) => providersWithApiKeyChangeSet.has(session.provider))
    .map((session) => session.id);
  const hasSessionThreadReset = nextSessions.some((session, index) => session.threadId !== previousSessions[index]?.threadId);

  let savedSettings: ReturnType<AppSettingsStorage["getSettings"]> | null = null;
  try {
    savedSettings = storage.updateSettings(nextSettings);
    for (const providerId of providersWithApiKeyChange) {
      clearProviderQuotaTelemetry(providerId);
    }
    for (const session of previousSessions) {
      if (providersWithApiKeyChangeSet.has(session.provider)) {
        clearSessionContextTelemetry(session.id);
      }
    }
    if (hasSessionThreadReset) {
      replaceAllSessions(nextSessions, {
        broadcast: false,
        invalidateSessionIds: invalidatedSessionIds,
      });
      broadcastSessions();
    } else {
      for (const sessionId of invalidatedSessionIds) {
        const sessionProvider = previousSessions.find((session) => session.id === sessionId)?.provider ?? null;
        invalidateProviderSessionThread(sessionProvider, sessionId);
      }
    }
    broadcastAppSettings(savedSettings);
    return savedSettings;
  } catch (error) {
    if (!savedSettings) {
      throw error;
    }

    try {
      storage.updateSettings(previousSettings);
      replaceAllSessions(previousSessions, { broadcast: false });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "app settings の更新を rollback できなかったよ。",
      );
    }

    throw error;
  }
}

async function previewComposerInput(
  sessionId: string,
  userMessage: string,
) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("対象セッションが見つからないよ。");
  }

  return resolveComposerPreview(session, userMessage);
}

async function searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]> {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("対象セッションが見つからないよ。");
  }

  return searchWorkspaceFilePaths(session.workspacePath, query);
}

async function openPathTarget(target: string, options?: OpenPathOptions): Promise<void> {
  const resolved = resolveOpenPathTarget(target, options);
  if (resolved.type === "external-url") {
    await shell.openExternal(resolved.target);
    return;
  }

  const errorMessage = await shell.openPath(resolved.targetPath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
}

async function runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
  const session = getSession(sessionId);
  if (session?.provider === "copilot" && isProviderQuotaTelemetryStale(getProviderQuotaTelemetry(session.provider))) {
    void refreshProviderQuotaTelemetry(session.provider).catch(() => undefined);
  }

  return requireSessionRuntimeService().runSessionTurn(sessionId, request);
}

async function loadHomeEntry(window: BrowserWindow, mode: "home" | "monitor" | "settings" = "home"): Promise<void> {
  const search = mode === "home" ? "" : `?mode=${mode}`;

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "index.html"), search ? { search } : undefined);
}

async function loadSessionEntry(window: BrowserWindow, sessionId: string): Promise<void> {
  const search = `sessionId=${encodeURIComponent(sessionId)}`;

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}/session.html?${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "session.html"), { search });
}

async function loadCharacterEntry(window: BrowserWindow, characterId?: string | null): Promise<void> {
  const search = characterId
    ? `characterId=${encodeURIComponent(characterId)}`
    : "mode=create";

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}/character.html?${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "character.html"), { search });
}

async function loadDiffEntry(window: BrowserWindow, token: string): Promise<void> {
  const search = `token=${encodeURIComponent(token)}`;

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}/diff.html?${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "diff.html"), { search });
}

async function createHomeWindow(): Promise<BrowserWindow> {
  if (homeWindow && !homeWindow.isDestroyed()) {
    if (homeWindow.isMinimized()) {
      homeWindow.restore();
    }

    homeWindow.focus();
    return homeWindow;
  }

  const window = createBaseWindow({
    ...HOME_WINDOW_DEFAULT_BOUNDS,
    title: "WithMate Home",
  });

  homeWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    homeWindow = null;
  });

  await loadHomeEntry(window, "home");
  return window;
}

async function openSessionMonitorWindow(): Promise<BrowserWindow> {
  if (sessionMonitorWindow && !sessionMonitorWindow.isDestroyed()) {
    if (sessionMonitorWindow.isMinimized()) {
      sessionMonitorWindow.restore();
    }

    sessionMonitorWindow.focus();
    sessionMonitorWindow.setAlwaysOnTop(true, "screen-saver");
    return sessionMonitorWindow;
  }

  const window = createBaseWindow({
    width: 360,
    height: 840,
    minWidth: 300,
    minHeight: 520,
    maxWidth: 460,
    title: "WithMate Monitor",
    alwaysOnTop: true,
  });

  sessionMonitorWindow = window;
  window.setAlwaysOnTop(true, "screen-saver");
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    sessionMonitorWindow = null;
  });

  await loadHomeEntry(window, "monitor");
  return window;
}

async function openSettingsWindow(): Promise<BrowserWindow> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }

    settingsWindow.focus();
    return settingsWindow;
  }

  const window = createBaseWindow({
    width: 920,
    height: 960,
    minWidth: 760,
    minHeight: 720,
    title: "WithMate Settings",
  });

  settingsWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    settingsWindow = null;
  });

  await loadHomeEntry(window, "settings");
  return window;
}

async function openSessionWindow(sessionId: string): Promise<BrowserWindow> {
  return requireSessionWindowBridge().openSessionWindow(sessionId);
}

async function openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
  const key = characterId ?? "__new__";
  const existingWindow = characterEditorWindows.get(key);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }

    existingWindow.focus();
    return existingWindow;
  }

  const window = createBaseWindow({
    width: 980,
    height: 840,
    minWidth: 760,
    minHeight: 680,
    title: characterId ? `Character Editor - ${characterId}` : "Character Editor - New",
  });

  characterEditorWindows.set(key, window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    characterEditorWindows.delete(key);
  });

  await loadCharacterEntry(window, characterId ?? null);
  return window;
}

async function openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
  const token = crypto.randomUUID();
  const window = createBaseWindow({
    width: 1680,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: `Diff - ${diffPreview.file.path}`,
  });

  diffPreviewStore.set(token, diffPreview);
  diffWindows.set(token, window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    diffWindows.delete(token);
    diffPreviewStore.delete(token);
  });

  await loadDiffEntry(window, token);
  return window;
}

app.whenReady().then(async () => {
  dbPath = path.join(app.getPath("userData"), "withmate.db");
  const activeModelCatalog = await initializePersistentStores();
  recoverInterruptedSessions();
  await refreshCharactersFromStorage();

  ipcMain.handle(WITHMATE_OPEN_SESSION_CHANNEL, async (_event, sessionId: string) => {
    if (!sessionId) {
      return;
    }

    await openSessionWindow(sessionId);
  });
  ipcMain.handle(WITHMATE_OPEN_HOME_WINDOW_CHANNEL, async () => {
    await createHomeWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL, async () => {
    await openSessionMonitorWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL, async () => {
    await openSettingsWindow();
  });

  ipcMain.handle(WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL, async (_event, characterId: string | null) => {
    await openCharacterEditorWindow(characterId);
  });
  ipcMain.handle(WITHMATE_OPEN_DIFF_WINDOW_CHANNEL, async (_event, diffPreview: DiffPreviewPayload) => {
    await openDiffWindow(diffPreview);
  });

  ipcMain.handle(WITHMATE_LIST_SESSIONS_CHANNEL, () => listSessions());
  ipcMain.handle(WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL, (_event, sessionId: string) => listSessionAuditLogs(sessionId));
  ipcMain.handle(WITHMATE_LIST_SESSION_SKILLS_CHANNEL, (_event, sessionId: string) => listSessionSkills(sessionId));
  ipcMain.handle(WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL, (_event, sessionId: string) => listSessionCustomAgents(sessionId));
  ipcMain.handle(WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL, () => listOpenSessionWindowIds());
  ipcMain.handle(WITHMATE_GET_APP_SETTINGS_CHANNEL, () => requireAppSettingsStorage().getSettings());
  ipcMain.handle(WITHMATE_UPDATE_APP_SETTINGS_CHANNEL, (_event, settings) => updateAppSettings(settings));
  ipcMain.handle(WITHMATE_RESET_APP_DATABASE_CHANNEL, (_event, request: ResetAppDatabaseRequest | null | undefined) =>
    resetAppDatabase(request),
  );
  ipcMain.handle(WITHMATE_LIST_CHARACTERS_CHANNEL, async () => refreshCharactersFromStorage());
  ipcMain.handle(WITHMATE_GET_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) => getModelCatalog(revision));
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL, (_event, document: ModelCatalogDocument) => importModelCatalogDocument(document));
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL, async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    return importModelCatalogFromFile(targetWindow);
  });
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) =>
    requireModelCatalogStorage().exportCatalogDocument(revision),
  );
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL, async (event, revision: number | null) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    return exportModelCatalogToFile(revision, targetWindow);
  });

  ipcMain.handle(WITHMATE_GET_SESSION_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }

    return getSession(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, (_event, token: string) => {
    if (!token) {
      return null;
    }

    return diffPreviewStore.get(token) ?? null;
  });
  ipcMain.handle(WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }

    return getLiveSessionRun(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL, async (_event, providerId: string) => {
    if (!providerId) {
      return null;
    }

    return getOrRefreshProviderQuotaTelemetry(providerId);
  });
  ipcMain.handle(WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }

    return getSessionContextTelemetry(sessionId);
  });
  ipcMain.handle(
    WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
    (_event, sessionId: string, kind: SessionBackgroundActivityKind) => {
      if (!sessionId || !kind) {
        return null;
      }

      return getSessionBackgroundActivity(sessionId, kind);
    },
  );
  ipcMain.handle(
    WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
    (_event, sessionId: string, requestId: string, decision: LiveApprovalDecision) => {
      resolveLiveApproval(sessionId, requestId, decision);
    },
  );

  ipcMain.handle(WITHMATE_GET_CHARACTER_CHANNEL, async (_event, characterId: string) => {
    if (!characterId) {
      return null;
    }

    return getCharacter(characterId);
  });

  ipcMain.handle(WITHMATE_CREATE_SESSION_CHANNEL, (_event, input: CreateSessionInput) => createSession(input));
  ipcMain.handle(WITHMATE_UPDATE_SESSION_CHANNEL, (_event, session: Session) => updateSession(session));
  ipcMain.handle(WITHMATE_DELETE_SESSION_CHANNEL, (_event, sessionId: string) => deleteSession(sessionId));
  ipcMain.handle(
    WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
    (_event, sessionId: string, userMessage: string) =>
      previewComposerInput(sessionId, userMessage),
  );
  ipcMain.handle(WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL, (_event, sessionId: string, query: string) =>
    searchWorkspaceFiles(sessionId, query),
  );
  ipcMain.handle(WITHMATE_RUN_SESSION_TURN_CHANNEL, async (_event, sessionId: string, request: RunSessionTurnRequest) =>
    runSessionTurn(sessionId, request),
  );
  ipcMain.handle(WITHMATE_CANCEL_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    cancelSessionRun(sessionId);
  });
  ipcMain.handle(WITHMATE_CREATE_CHARACTER_CHANNEL, async (_event, input: CreateCharacterInput) => createCharacter(input));
  ipcMain.handle(WITHMATE_UPDATE_CHARACTER_CHANNEL, async (_event, character: CharacterProfile) => updateCharacter(character));
  ipcMain.handle(WITHMATE_DELETE_CHARACTER_CHANNEL, async (_event, characterId: string) => deleteCharacter(characterId));

  ipcMain.handle(WITHMATE_PICK_DIRECTORY_CHANNEL, async (event, initialPath: string | null) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, {
          properties: ["openDirectory"],
          title: "作業ディレクトリを選択",
          ...(initialPath ? { defaultPath: initialPath } : {}),
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory"],
          title: "作業ディレクトリを選択",
          ...(initialPath ? { defaultPath: initialPath } : {}),
        });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });
  ipcMain.handle(WITHMATE_PICK_FILE_CHANNEL, async (event, initialPath: string | null) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, {
          properties: ["openFile"],
          title: "ファイルを選択",
          ...(initialPath ? { defaultPath: initialPath } : {}),
        })
      : await dialog.showOpenDialog({
          properties: ["openFile"],
          title: "ファイルを選択",
          ...(initialPath ? { defaultPath: initialPath } : {}),
        });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });
  ipcMain.handle(WITHMATE_PICK_IMAGE_FILE_CHANNEL, async (event, initialPath: string | null) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, {
          properties: ["openFile"],
          title: "画像を選択",
          ...(initialPath ? { defaultPath: initialPath } : {}),
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
        })
      : await dialog.showOpenDialog({
          properties: ["openFile"],
          title: "画像を選択",
          ...(initialPath ? { defaultPath: initialPath } : {}),
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
        });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });
  ipcMain.handle(WITHMATE_OPEN_PATH_CHANNEL, async (_event, target: string, options: OpenPathOptions | null) =>
    openPathTarget(target, options ?? undefined),
  );
  ipcMain.handle(WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL, async (_event, sessionId: string) =>
    openSessionTerminal(sessionId),
  );

  await createHomeWindow();
  broadcastModelCatalog(activeModelCatalog);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createHomeWindow();
      return;
    }

    await createHomeWindow();
  });
});

app.on("window-all-closed", () => {
  if (hasInFlightSessionRuns()) {
    void createHomeWindow();
    return;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (hasInFlightSessionRuns() && !allowQuitWithInFlightRuns) {
    event.preventDefault();

    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["戻る", "終了する"],
      defaultId: 0,
      cancelId: 0,
      title: "実行中のセッション",
      message: "実行中のセッションがあるよ。",
      detail: "ここでアプリを終了すると、進行中の処理は中断されるよ。",
      noLink: true,
    });

    if (choice !== 1) {
      return;
    }

    allowQuitWithInFlightRuns = true;
    app.quit();
    return;
  }

  sessionStorage?.close();
  sessionStorage = null;
  sessionMemoryStorage?.close();
  sessionMemoryStorage = null;
  projectMemoryStorage?.close();
  projectMemoryStorage = null;
  characterMemoryStorage?.close();
  characterMemoryStorage = null;
  auditLogStorage?.close();
  auditLogStorage = null;
  appSettingsStorage?.close();
  appSettingsStorage = null;
  modelCatalogStorage?.close();
  modelCatalogStorage = null;
});




