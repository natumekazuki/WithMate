import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import {
  type AuditLogEntry,
  buildNewSession,
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
  getProviderAppSettings,
  normalizeAppSettings,
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type RunSessionTurnRequest,
  type Session,
  type SessionContextTelemetry,
} from "../src/app-state.js";
import {
  coerceModelSelection,
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  parseModelCatalogDocument,
  resolveModelSelection,
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
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { resolveOpenPathTarget } from "./open-path.js";
import { launchTerminalAtPath } from "./open-terminal.js";
import { SessionStorage } from "./session-storage.js";
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
const sessionWindows = new Map<string, BrowserWindow>();
const characterEditorWindows = new Map<string, BrowserWindow>();
const diffWindows = new Map<string, BrowserWindow>();
const diffPreviewStore = new Map<string, DiffPreviewPayload>();
const inFlightSessionRuns = new Set<string>();
const sessionRunControllers = new Map<string, AbortController>();
const allowCloseSessionWindows = new Set<string>();
const liveSessionRuns = new Map<string, LiveSessionRunState>();
const providerQuotaTelemetryByProvider = new Map<string, ProviderQuotaTelemetry>();
const sessionContextTelemetryBySessionId = new Map<string, SessionContextTelemetry>();
const providerQuotaRefreshPromises = new Map<string, Promise<ProviderQuotaTelemetry | null>>();
const providerQuotaRefreshTimers = new Map<string, NodeJS.Timeout[]>();
const pendingSessionApprovalRequests = new Map<string, { requestId: string; resolve: (decision: LiveApprovalDecision) => void }>();
let sessions: Session[] = [];
let characters: CharacterProfile[] = [];
let sessionStorage: SessionStorage | null = null;
let modelCatalogStorage: ModelCatalogStorage | null = null;
let auditLogStorage: AuditLogStorage | null = null;
let appSettingsStorage: AppSettingsStorage | null = null;
let allowQuitWithInFlightRuns = false;
let dbPath = "";
const PROVIDER_QUOTA_STALE_TTL_MS = 5 * 60 * 1000;

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
  return inFlightSessionRuns.size > 0;
}

function isSessionRunInFlight(sessionId: string): boolean {
  return inFlightSessionRuns.has(sessionId);
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

async function initializePersistentStores(): Promise<ModelCatalogSnapshot> {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  closePersistentStores();

  modelCatalogStorage = new ModelCatalogStorage(dbPath, bundledModelCatalogPath);
  const activeModelCatalog = modelCatalogStorage.ensureSeeded();
  sessionStorage = new SessionStorage(dbPath);
  auditLogStorage = new AuditLogStorage(dbPath);
  appSettingsStorage = new AppSettingsStorage(dbPath);
  sessions = sessionStorage.listSessions();

  return activeModelCatalog;
}

function closePersistentStores(): void {
  modelCatalogStorage?.close();
  sessionStorage?.close();
  auditLogStorage?.close();
  appSettingsStorage?.close();
  modelCatalogStorage = null;
  sessionStorage = null;
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

function listOpenSessionWindowIds(): string[] {
  const openSessionIds: string[] = [];
  for (const [sessionId, window] of sessionWindows.entries()) {
    if (window.isDestroyed()) {
      continue;
    }

    openSessionIds.push(sessionId);
  }

  return openSessionIds;
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
  for (const [sessionId, window] of sessionWindows.entries()) {
    if (!window.isDestroyed()) {
      allowCloseSessionWindows.add(sessionId);
      window.close();
    }
  }
  sessionWindows.clear();
  allowCloseSessionWindows.clear();
  broadcastOpenSessionWindowIds();

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
      requireSessionStorage().clearSessions();
      sessions = [];
      liveSessionRuns.clear();
      sessionRunControllers.clear();
      inFlightSessionRuns.clear();
      clearAllSessionContextTelemetry();
      invalidateAllProviderSessionThreads();
    }
    if (appliedTargets.has("appSettings")) {
      requireAppSettingsStorage().resetSettings();
      clearAllProviderQuotaTelemetry();
    }
    if (appliedTargets.has("modelCatalog")) {
      requireModelCatalogStorage().resetToBundled();
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
  const pendingApprovalRequest = pendingSessionApprovalRequests.get(sessionId);
  if (pendingApprovalRequest) {
    pendingApprovalRequest.resolve("deny");
  }

  const controller = sessionRunControllers.get(sessionId);
  if (!controller) {
    return;
  }

  controller.abort();
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
  const appSettings = requireAppSettingsStorage().getSettings();
  const snapshot = getModelCatalog(null) ?? requireModelCatalogStorage().ensureSeeded();
  const provider = resolveEnabledProviderCatalog(snapshot, appSettings, input.provider);
  const selection = resolveModelSelection(
    provider,
    input.model ?? provider.defaultModelId,
    input.reasoningEffort ?? provider.defaultReasoningEffort,
  );
  const created = buildNewSession({
    ...input,
    provider: provider.id,
    catalogRevision: snapshot.revision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
    allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
      input.workspacePath,
      input.allowedAdditionalDirectories ?? [],
    ),
  });
  return upsertSession(created);
}

function resolveEnabledProviderCatalog(
  snapshot: ModelCatalogSnapshot,
  appSettings = requireAppSettingsStorage().getSettings(),
  requestedProviderId?: string | null,
): ModelCatalogProvider {
  const requestedProvider = requestedProviderId ? getProviderCatalog(snapshot.providers, requestedProviderId) : null;
  if (requestedProvider && getProviderAppSettings(appSettings, requestedProvider.id).enabled) {
    return requestedProvider;
  }

  const defaultProvider = snapshot.providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? null;
  if (defaultProvider && getProviderAppSettings(appSettings, defaultProvider.id).enabled) {
    return defaultProvider;
  }

  const firstEnabledProvider = snapshot.providers.find((provider) => getProviderAppSettings(appSettings, provider.id).enabled);
  if (firstEnabledProvider) {
    return firstEnabledProvider;
  }

  throw new Error("有効な provider が Settings に見つからないよ。");
}

function updateSession(nextSession: Session): Session {
  const currentSession = getSession(nextSession.id);
  if (!currentSession) {
    throw new Error("対象セッションが見つからないよ。");
  }

  if (isSessionRunInFlight(nextSession.id) || isRunningSession(currentSession)) {
    throw new Error("実行中のセッションは更新できないよ。");
  }

  const updatedSession = upsertSession({
    ...nextSession,
    allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
      nextSession.workspacePath,
      nextSession.allowedAdditionalDirectories,
    ),
  });

  if (currentSession.provider !== updatedSession.provider) {
    clearSessionContextTelemetry(updatedSession.id);
  }

  return updatedSession;
}

function deleteSession(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  if (isSessionRunInFlight(sessionId) || isRunningSession(session)) {
    throw new Error("実行中のセッションは削除できないよ。");
  }

  requireSessionStorage().deleteSession(sessionId);
  sessions = requireSessionStorage().listSessions();
  clearSessionContextTelemetry(sessionId);

  const window = sessionWindows.get(sessionId);
  if (window && !window.isDestroyed()) {
    allowCloseSessionWindows.add(sessionId);
    window.close();
  }

  sessionWindows.delete(sessionId);
  broadcastOpenSessionWindowIds();
  broadcastSessions();
}

function upsertSession(nextSession: Session): Session {
  const storage = requireSessionStorage();
  const stored = storage.upsertSession({
    ...nextSession,
    allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
      nextSession.workspacePath,
      nextSession.allowedAdditionalDirectories,
    ),
  });
  sessions = storage.listSessions();
  broadcastSessions();
  return cloneSessions([stored])[0];
}

function replaceAllSessions(
  nextSessions: Session[],
  options?: {
    broadcast?: boolean;
    invalidateSessionIds?: Iterable<string>;
  },
): Session[] {
  const storage = requireSessionStorage();
  const previousSessions = sessions;
  storage.replaceSessions(nextSessions);
  sessions = storage.listSessions();

  const nextSessionsById = new Map(sessions.map((session) => [session.id, session] as const));
  for (const previousSession of previousSessions) {
    const nextSession = nextSessionsById.get(previousSession.id);
    if (!nextSession || nextSession.provider !== previousSession.provider) {
      clearSessionContextTelemetry(previousSession.id);
    }
  }

  for (const sessionId of options?.invalidateSessionIds ?? []) {
    const sessionProvider =
      nextSessions.find((session) => session.id === sessionId)?.provider
      ?? sessions.find((session) => session.id === sessionId)?.provider
      ?? null;
    invalidateProviderSessionThread(sessionProvider, sessionId);
  }

  if (options?.broadcast ?? true) {
    broadcastSessions();
  }

  return listSessions();
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
  if (!session) {
    throw new Error("対象セッションが見つからないよ。");
  }

  if (session.runState === "running") {
    throw new Error("このセッションはまだ実行中だよ。");
  }

  const nextMessage = request.userMessage.trim();
  if (!nextMessage) {
    throw new Error("送信するメッセージが空だよ。");
  }

  const composerPreview = await resolveComposerPreview(session, request.userMessage);
  if (composerPreview.errors.length > 0) {
    throw new Error(composerPreview.errors[0] ?? "添付の解決に失敗したよ。");
  }

  const character = await resolveSessionCharacter(session);
  if (!character) {
    throw new Error("キャラクター定義が見つからないよ。");
  }

  const appSettings = requireAppSettingsStorage().getSettings();
  if (!getProviderAppSettings(appSettings, session.provider).enabled) {
    throw new Error("この provider は Settings で無効になっているよ。");
  }

  const { provider } = resolveProviderCatalog(session.provider, session.catalogRevision);
  const providerAdapter = getProviderAdapter(provider.id);
  const promptForAudit = providerAdapter.composePrompt({
    session,
    character,
    providerCatalog: provider,
    userMessage: nextMessage,
    appSettings,
    attachments: composerPreview.attachments,
  });

  const runningSession: Session = {
    ...session,
    updatedAt: currentTimestampLabel(),
    status: "running",
    runState: "running",
    messages: [...session.messages, { role: "user", text: nextMessage }],
  };

  upsertSession(runningSession);
  inFlightSessionRuns.add(sessionId);
  const runAbortController = new AbortController();
  sessionRunControllers.set(sessionId, runAbortController);
  setLiveSessionRun(sessionId, {
    sessionId,
    threadId: runningSession.threadId,
    assistantText: "",
    steps: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
  });

  const runningAuditLog = requireAuditLogStorage().createAuditLog({
    sessionId,
    createdAt: new Date().toISOString(),
    phase: "running",
    provider: runningSession.provider,
    model: runningSession.model,
    reasoningEffort: runningSession.reasoningEffort,
    approvalMode: runningSession.approvalMode,
    threadId: runningSession.threadId,
    logicalPrompt: promptForAudit.logicalPrompt,
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    errorMessage: "",
  });

  try {
    if (runningSession.provider === "copilot" && isProviderQuotaTelemetryStale(getProviderQuotaTelemetry(runningSession.provider))) {
      void refreshProviderQuotaTelemetry(runningSession.provider).catch(() => undefined);
    }

    const result = await providerAdapter.runSessionTurn({
      session: runningSession,
      character,
      providerCatalog: provider,
      userMessage: nextMessage,
      appSettings,
      attachments: composerPreview.attachments,
      signal: runAbortController.signal,
      onApprovalRequest: (request) => waitForLiveApprovalDecision(sessionId, request, runAbortController.signal),
      onProviderQuotaTelemetry: (telemetry) => {
        setProviderQuotaTelemetry(telemetry.provider, telemetry);
      },
      onSessionContextTelemetry: (telemetry) => {
        setSessionContextTelemetry(telemetry.sessionId, telemetry);
      },
    }, (state) => {
      setLiveSessionRun(sessionId, {
        ...state,
        approvalRequest: getLiveSessionRun(sessionId)?.approvalRequest ?? null,
      });
    });

    requireAuditLogStorage().updateAuditLog(runningAuditLog.id, {
      sessionId,
      createdAt: runningAuditLog.createdAt,
      phase: "completed",
      provider: runningSession.provider,
      model: runningSession.model,
      reasoningEffort: runningSession.reasoningEffort,
      approvalMode: runningSession.approvalMode,
      threadId: result.threadId ?? runningSession.threadId,
      logicalPrompt: result.logicalPrompt,
      transportPayload: result.transportPayload,
      assistantText: result.assistantText,
      operations: result.operations,
      rawItemsJson: result.rawItemsJson,
      usage: result.usage,
      errorMessage: "",
    });

    const completedSession: Session = {
      ...runningSession,
      updatedAt: currentTimestampLabel(),
      status: "idle",
      runState: "idle",
      threadId: result.threadId ?? runningSession.threadId,
      messages: [
        ...runningSession.messages,
        {
          role: "assistant",
          text: result.assistantText,
          artifact: result.artifact,
        },
      ],
    };

    return upsertSession(completedSession);
  } catch (error: unknown) {
    const providerTurnError = error instanceof ProviderTurnError ? error : null;
    const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
    const message = error instanceof Error ? error.message : String(error);
    const partialResult = providerTurnError?.partialResult;
    if (canceled) {
      invalidateProviderSessionThread(runningSession.provider, sessionId);
    }
    requireAuditLogStorage().updateAuditLog(runningAuditLog.id, {
      sessionId,
      createdAt: runningAuditLog.createdAt,
      phase: canceled ? "canceled" : "failed",
      provider: runningSession.provider,
      model: runningSession.model,
      reasoningEffort: runningSession.reasoningEffort,
      approvalMode: runningSession.approvalMode,
      threadId: partialResult?.threadId ?? runningSession.threadId,
      logicalPrompt: partialResult?.logicalPrompt ?? promptForAudit.logicalPrompt,
      transportPayload: partialResult?.transportPayload ?? null,
      assistantText: partialResult?.assistantText ?? "",
      operations: partialResult?.operations ?? [],
      rawItemsJson: partialResult?.rawItemsJson ?? "[]",
      usage: partialResult?.usage ?? null,
      errorMessage: canceled ? "ユーザーがキャンセルしたよ。" : message,
    });
    const fallbackNotice = canceled ? "実行をキャンセルしたよ。" : `実行に失敗したよ。\n${message}`;
    const assistantText = partialResult?.assistantText.trim()
      ? `${partialResult.assistantText}\n\n${fallbackNotice}`
      : fallbackNotice;
    const failedSession: Session = {
      ...runningSession,
      updatedAt: currentTimestampLabel(),
      status: "idle",
      runState: canceled ? "idle" : "error",
      threadId: partialResult?.threadId ?? runningSession.threadId,
      messages: [
        ...runningSession.messages,
        {
          role: "assistant",
          text: assistantText,
          artifact: partialResult?.artifact,
          accent: true,
        },
      ],
    };

    return upsertSession(failedSession);
  } finally {
    if (runningSession.provider === "copilot") {
      scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
    }
    const pendingApprovalRequest = pendingSessionApprovalRequests.get(sessionId);
    if (pendingApprovalRequest) {
      pendingApprovalRequest.resolve("deny");
    }
    inFlightSessionRuns.delete(sessionId);
    sessionRunControllers.delete(sessionId);
    liveSessionRuns.delete(sessionId);
    clearWorkspaceFileIndex(session.workspacePath);
    broadcastLiveSessionRun(sessionId);
  }
}

async function loadHomeEntry(window: BrowserWindow, mode: "home" | "monitor" = "home"): Promise<void> {
  const search = mode === "monitor" ? "?mode=monitor" : "";

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

async function openSessionWindow(sessionId: string): Promise<BrowserWindow> {
  const existingWindow = sessionWindows.get(sessionId);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }

    existingWindow.focus();
    return existingWindow;
  }

  const window = createBaseWindow({
    width: 1520,
    height: 940,
    minWidth: 1120,
    minHeight: 760,
    title: `WithMate Session - ${sessionId}`,
  });

  sessionWindows.set(sessionId, window);
  broadcastOpenSessionWindowIds();
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (allowQuitWithInFlightRuns) {
      return;
    }

    if (allowCloseSessionWindows.has(sessionId)) {
      allowCloseSessionWindows.delete(sessionId);
      return;
    }

    if (!isSessionRunInFlight(sessionId)) {
      return;
    }

    event.preventDefault();

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

    if (choice !== 1) {
      return;
    }

    allowCloseSessionWindows.add(sessionId);
    window.close();
  });
  window.on("closed", () => {
    allowCloseSessionWindows.delete(sessionId);
    sessionWindows.delete(sessionId);
    broadcastOpenSessionWindowIds();
  });

  await loadSessionEntry(window, sessionId);
  return window;
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
  auditLogStorage?.close();
  auditLogStorage = null;
  appSettingsStorage?.close();
  appSettingsStorage = null;
  modelCatalogStorage?.close();
  modelCatalogStorage = null;
});




