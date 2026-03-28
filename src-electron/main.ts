import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import {
  type AuditLogEntry,
  currentTimestampLabel,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type RunSessionTurnRequest,
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionContextTelemetry,
} from "../src/app-state.js";
import {
  cloneCharacterProfiles,
  type CharacterProfile,
  type CreateCharacterInput,
} from "../src/character-state.js";
import {
  cloneSessions,
  type CreateSessionInput,
  type DiffPreviewPayload,
  type Session,
} from "../src/session-state.js";
import { getProviderAppSettings } from "../src/provider-settings-state.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  type ModelCatalogDocument,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import type { OpenPathOptions } from "../src/withmate-window.js";
import {
  createStoredCharacter,
  deleteStoredCharacter,
  getStoredCharacter,
  listStoredCharacters,
  updateStoredCharacter,
} from "./character-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogService } from "./audit-log-service.js";
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
import { MemoryOrchestrationService } from "./memory-orchestration-service.js";
import { SettingsCatalogService } from "./settings-catalog-service.js";
import { SessionObservabilityService } from "./session-observability-service.js";
import { SessionApprovalService } from "./session-approval-service.js";
import { WindowBroadcastService } from "./window-broadcast-service.js";
import { WindowDialogService } from "./window-dialog-service.js";
import { SessionMemorySupportService } from "./session-memory-support-service.js";
import { CharacterRuntimeService } from "./character-runtime-service.js";
import { WindowEntryLoader } from "./window-entry-loader.js";
import { AuxWindowService } from "./aux-window-service.js";
import { registerMainIpcHandlers } from "./main-ipc-registration.js";
import {
  PersistentStoreLifecycleService,
  type PersistentStoreBundle,
} from "./persistent-store-lifecycle-service.js";
import {
  type CharacterReflectionTriggerReason,
} from "./character-reflection.js";
import {
  type SessionMemoryExtractionTriggerReason,
} from "./session-memory-extraction.js";
import { discoverSessionSkills } from "./skill-discovery.js";
import { discoverSessionCustomAgents } from "./custom-agent-discovery.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";
import { clearWorkspaceFileIndex, searchWorkspaceFilePaths } from "./workspace-file-search.js";

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
let memoryOrchestrationService: MemoryOrchestrationService | null = null;
let settingsCatalogService: SettingsCatalogService | null = null;
let sessionObservabilityService: SessionObservabilityService | null = null;
let sessionApprovalService: SessionApprovalService | null = null;
let auditLogService: AuditLogService | null = null;
let windowBroadcastService: WindowBroadcastService<BrowserWindow> | null = null;
let windowDialogService: WindowDialogService | null = null;
let sessionMemorySupportService: SessionMemorySupportService | null = null;
let characterRuntimeService: CharacterRuntimeService | null = null;
let windowEntryLoader: WindowEntryLoader | null = null;
let auxWindowService: AuxWindowService<BrowserWindow> | null = null;
let persistentStoreLifecycleService: PersistentStoreLifecycleService | null = null;

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

function requireAuditLogService(): AuditLogService {
  if (!auditLogService) {
    auditLogService = new AuditLogService(requireAuditLogStorage());
  }

  return auditLogService;
}

function requireWindowBroadcastService(): WindowBroadcastService<BrowserWindow> {
  if (!windowBroadcastService) {
    windowBroadcastService = new WindowBroadcastService({
      getWindows: () => BrowserWindow.getAllWindows(),
    });
  }

  return windowBroadcastService;
}

function requireWindowDialogService(): WindowDialogService {
  if (!windowDialogService) {
    windowDialogService = new WindowDialogService({
      async showOpenDialog(targetWindow, options) {
        return targetWindow
          ? dialog.showOpenDialog(targetWindow, options)
          : dialog.showOpenDialog(options);
      },
      async showSaveDialog(targetWindow, options) {
        return targetWindow
          ? dialog.showSaveDialog(targetWindow, options)
          : dialog.showSaveDialog(options);
      },
      async readTextFile(filePath) {
        return readFile(filePath, "utf8");
      },
      async writeTextFile(filePath, content) {
        await writeFile(filePath, content, "utf8");
      },
      importModelCatalogDocument(document) {
        return requireSettingsCatalogService().importModelCatalogDocument(document);
      },
      exportModelCatalogDocument(revision) {
        return requireSettingsCatalogService().exportModelCatalogDocument(revision);
      },
    });
  }

  return windowDialogService;
}

function requireAppSettingsStorage(): AppSettingsStorage {
  if (!appSettingsStorage) {
    throw new Error("app settings storage が初期化されていないよ。");
  }

  return appSettingsStorage;
}

function requireSessionMemorySupportService(): SessionMemorySupportService {
  if (!sessionMemorySupportService) {
    sessionMemorySupportService = new SessionMemorySupportService({
      ensureSessionMemory: (session) => requireSessionMemoryStorage().ensureSessionMemory(session),
      upsertSessionMemory: (memory) => requireSessionMemoryStorage().upsertSessionMemory(memory),
      ensureProjectScope: (scope) => requireProjectMemoryStorage().ensureProjectScope(scope),
      listProjectMemoryEntries: (projectScopeId) =>
        requireProjectMemoryStorage().listProjectMemoryEntries(projectScopeId),
      upsertProjectMemoryEntry: (entry) => requireProjectMemoryStorage().upsertProjectMemoryEntry(entry),
      markProjectMemoryEntriesUsed: (entryIds) => requireProjectMemoryStorage().markProjectMemoryEntriesUsed(entryIds),
      ensureCharacterScope: ({ characterId, displayName }) =>
        requireCharacterMemoryStorage().ensureCharacterScope({ characterId, displayName }),
      listCharacterMemoryEntries: (characterScopeId) =>
        requireCharacterMemoryStorage().listCharacterMemoryEntries(characterScopeId),
      upsertCharacterMemoryEntry: (entry) => requireCharacterMemoryStorage().upsertCharacterMemoryEntry(entry),
      markCharacterMemoryEntriesUsed: (entryIds) => requireCharacterMemoryStorage().markCharacterMemoryEntriesUsed(entryIds),
      upsertSession,
    });
  }

  return sessionMemorySupportService;
}

function requireCharacterRuntimeService(): CharacterRuntimeService {
  if (!characterRuntimeService) {
    characterRuntimeService = new CharacterRuntimeService({
      getCharacters: () => characters,
      setCharacters: (nextCharacters) => {
        characters = nextCharacters;
      },
      listStoredCharacters,
      getStoredCharacter,
      createStoredCharacter,
      updateStoredCharacter,
      deleteStoredCharacter,
      listSessions: () => sessions,
      upsertStoredSession: (session) => requireSessionStorage().upsertSession(session),
      reloadStoredSessions: () => requireSessionStorage().listSessions(),
      setSessions: (nextSessions) => {
        sessions = nextSessions;
      },
      closeCharacterEditor: (characterId) => {
        requireAuxWindowService().closeCharacterEditor(characterId);
      },
      broadcastCharacters,
      broadcastSessions,
    });
  }

  return characterRuntimeService;
}

function requireWindowEntryLoader(): WindowEntryLoader {
  if (!windowEntryLoader) {
    windowEntryLoader = new WindowEntryLoader({
      devServerUrl,
      rendererDistPath,
    });
  }

  return windowEntryLoader;
}

function requireAuxWindowService(): AuxWindowService<BrowserWindow> {
  if (!auxWindowService) {
    auxWindowService = new AuxWindowService({
      createWindow: (options) =>
        createBaseWindow({
          ...(options.homeBounds ? HOME_WINDOW_DEFAULT_BOUNDS : {}),
          width: options.homeBounds ? undefined : options.width,
          height: options.homeBounds ? undefined : options.height,
          minWidth: options.minWidth,
          minHeight: options.minHeight,
          maxWidth: options.maxWidth,
          title: options.title,
          alwaysOnTop: options.alwaysOnTop,
        }),
      loadHomeEntry: (window, mode) => requireWindowEntryLoader().loadHomeEntry(window, mode),
      loadCharacterEntry: (window, characterId) => requireWindowEntryLoader().loadCharacterEntry(window, characterId),
      loadDiffEntry: (window, token) => requireWindowEntryLoader().loadDiffEntry(window, token),
      generateDiffToken: () => crypto.randomUUID(),
    });
  }

  return auxWindowService;
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
      resolveProjectMemoryEntriesForPrompt: (session, userMessage, sessionMemory) =>
        requireSessionMemorySupportService().resolveProjectMemoryEntriesForPrompt(session, userMessage, sessionMemory),
      createAuditLog: (entry) => requireAuditLogService().createAuditLog(entry),
      updateAuditLog: (id, entry) => requireAuditLogService().updateAuditLog(id, entry),
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
        void requireMemoryOrchestrationService().runSessionMemoryExtraction(session, usage, options);
      },
      runCharacterReflection: (session, options) => {
        void requireMemoryOrchestrationService().runCharacterReflection(session, options);
      },
      clearWorkspaceFileIndex,
      broadcastLiveSessionRun,
      resolvePendingApprovalRequest: (sessionId, decision) => {
        const liveRun = getLiveSessionRun(sessionId);
        const requestId = liveRun?.approvalRequest?.requestId;
        if (requestId) {
          requireSessionApprovalService().resolveLiveApproval(sessionId, requestId, decision);
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
      syncSessionDependencies: (session) => requireSessionMemorySupportService().syncSessionDependencies(session),
      clearSessionContextTelemetry,
      clearSessionBackgroundActivities,
      clearCharacterReflectionCheckpoint: (sessionId) => {
        requireMemoryOrchestrationService().clearCharacterReflectionCheckpoint(sessionId);
      },
      clearInFlightCharacterReflection: (sessionId) => {
        requireMemoryOrchestrationService().clearInFlightCharacterReflection(sessionId);
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
      loadSessionEntry: (window, sessionId) => requireWindowEntryLoader().loadSessionEntry(window, sessionId),
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
        void requireMemoryOrchestrationService().runSessionMemoryExtraction(session, usage, options);
      },
      runCharacterReflection: (session, options) => {
        void requireMemoryOrchestrationService().runCharacterReflection(session, options);
      },
    });
  }

  return sessionWindowBridge;
}

function requireMemoryOrchestrationService(): MemoryOrchestrationService {
  if (!memoryOrchestrationService) {
    memoryOrchestrationService = new MemoryOrchestrationService({
      getSession,
      isSessionRunInFlight,
      isRunningSession,
      resolveSessionCharacter: (session) => requireCharacterRuntimeService().resolveSessionCharacter(session),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getProviderAdapter,
      ensureSessionMemory: (session) => requireSessionMemoryStorage().ensureSessionMemory(session),
      upsertSessionMemory: (memory) => requireSessionMemoryStorage().upsertSessionMemory(memory),
      promoteSessionMemoryDeltaToProjectMemory: (session, delta) =>
        requireSessionMemorySupportService().promoteSessionMemoryDeltaToProjectMemory(session, delta),
      resolveCharacterMemoryEntriesForReflection: (session) =>
        requireSessionMemorySupportService().resolveCharacterMemoryEntriesForReflection(session),
      markCharacterMemoryEntriesUsed: (entryIds) =>
        requireSessionMemorySupportService().markCharacterMemoryEntriesUsed(entryIds),
      saveCharacterMemoryDelta: (session, entries) =>
        requireSessionMemorySupportService().saveCharacterMemoryDelta(session, entries),
      appendMonologueToSession: (session, monologue) =>
        requireSessionMemorySupportService().appendMonologueToSession(session, monologue),
      createAuditLog: (entry) => requireAuditLogService().createAuditLog(entry),
      updateAuditLog: (id, entry) => requireAuditLogService().updateAuditLog(id, entry),
      setSessionBackgroundActivity,
    });
  }

  return memoryOrchestrationService;
}

function requireSettingsCatalogService(): SettingsCatalogService {
  if (!settingsCatalogService) {
    settingsCatalogService = new SettingsCatalogService({
      hasInFlightSessionRuns,
      isSessionRunInFlight,
      isRunningSession,
      listSessions,
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      updateAppSettings: (settings) => requireAppSettingsStorage().updateSettings(settings),
      getModelCatalog,
      ensureModelCatalogSeeded: () => requireModelCatalogStorage().ensureSeeded(),
      importModelCatalogDocument: (document, source) => requireModelCatalogStorage().importCatalogDocument(document, source),
      exportModelCatalogDocument: (revision) => requireModelCatalogStorage().exportCatalogDocument(revision),
      replaceAllSessions,
      clearProviderQuotaTelemetry,
      clearSessionContextTelemetry,
      invalidateProviderSessionThread,
      clearAuditLogs: () => requireAuditLogService().clearAuditLogs(),
      resetAppSettings: () => requireAppSettingsStorage().resetSettings(),
      resetModelCatalogToBundled: () => requireModelCatalogStorage().resetToBundled(),
      clearProjectMemories: () => requireProjectMemoryStorage().clearProjectMemories(),
      clearCharacterMemories: () => requireCharacterMemoryStorage().clearCharacterMemories(),
      resetSessionRuntime: () => requireSessionRuntimeService().reset(),
      resetMemoryOrchestration: () => requireMemoryOrchestrationService().reset(),
      clearAllProviderQuotaTelemetry,
      clearAllSessionContextTelemetry,
      clearAllSessionBackgroundActivities,
      invalidateAllProviderSessionThreads,
      closeResetTargetWindows,
      recreateDatabaseFile,
      broadcastSessions,
      broadcastAppSettings,
      broadcastModelCatalog,
    });
  }

  return settingsCatalogService;
}

function requireSessionObservabilityService(): SessionObservabilityService {
  if (!sessionObservabilityService) {
    sessionObservabilityService = new SessionObservabilityService({
      onProviderQuotaTelemetryChanged: (providerId, telemetry) => {
        requireWindowBroadcastService().broadcastProviderQuotaTelemetry(providerId, telemetry);
      },
      onSessionContextTelemetryChanged: (sessionId, telemetry) => {
        requireWindowBroadcastService().broadcastSessionContextTelemetry(sessionId, telemetry);
      },
      onSessionBackgroundActivityChanged: (sessionId, kind, state) => {
        requireWindowBroadcastService().broadcastSessionBackgroundActivity(sessionId, kind, state);
      },
      onLiveSessionRunChanged: (sessionId, state) => {
        requireWindowBroadcastService().broadcastLiveSessionRun(sessionId, state);
      },
    });
  }

  return sessionObservabilityService;
}

function requireSessionApprovalService(): SessionApprovalService {
  if (!sessionApprovalService) {
    sessionApprovalService = new SessionApprovalService({
      updateLiveSessionRun: (sessionId, recipe) =>
        requireSessionObservabilityService().updateLiveSessionRun(sessionId, recipe),
    });
  }

  return sessionApprovalService;
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

function requirePersistentStoreLifecycleService(): PersistentStoreLifecycleService {
  if (!persistentStoreLifecycleService) {
    persistentStoreLifecycleService = new PersistentStoreLifecycleService({
      createModelCatalogStorage: (nextDbPath, nextBundledModelCatalogPath) =>
        new ModelCatalogStorage(nextDbPath, nextBundledModelCatalogPath),
      createSessionStorage: (nextDbPath) => new SessionStorage(nextDbPath),
      createSessionMemoryStorage: (nextDbPath) => new SessionMemoryStorage(nextDbPath),
      createProjectMemoryStorage: (nextDbPath) => new ProjectMemoryStorage(nextDbPath),
      createCharacterMemoryStorage: (nextDbPath) => new CharacterMemoryStorage(nextDbPath),
      createAuditLogStorage: (nextDbPath) => new AuditLogStorage(nextDbPath),
      createAppSettingsStorage: (nextDbPath) => new AppSettingsStorage(nextDbPath),
      syncSessionDependencies: (session) => requireSessionMemorySupportService().syncSessionDependencies(session),
      onBeforeClose: () => {
        sessionApprovalService?.reset();
        sessionObservabilityService?.dispose();
      },
      async removeFile(filePath) {
        await rm(filePath, { force: true });
      },
    });
  }

  return persistentStoreLifecycleService;
}

function applyPersistentStoreBundle(bundle: PersistentStoreBundle): ModelCatalogSnapshot {
  modelCatalogStorage = bundle.modelCatalogStorage;
  sessionStorage = bundle.sessionStorage;
  sessionMemoryStorage = bundle.sessionMemoryStorage;
  projectMemoryStorage = bundle.projectMemoryStorage;
  characterMemoryStorage = bundle.characterMemoryStorage;
  auditLogStorage = bundle.auditLogStorage;
  appSettingsStorage = bundle.appSettingsStorage;
  sessions = bundle.sessions;
  return bundle.activeModelCatalog;
}

async function initializePersistentStores(): Promise<ModelCatalogSnapshot> {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  closePersistentStores();
  const bundle = await requirePersistentStoreLifecycleService().initialize(dbPath, bundledModelCatalogPath);
  return applyPersistentStoreBundle(bundle);
}

function closePersistentStores(): void {
  requirePersistentStoreLifecycleService().close({
    modelCatalogStorage,
    sessionStorage,
    sessionMemoryStorage,
    projectMemoryStorage,
    characterMemoryStorage,
    auditLogStorage,
    appSettingsStorage,
  });
  modelCatalogStorage = null;
  sessionStorage = null;
  sessionMemoryStorage = null;
  projectMemoryStorage = null;
  characterMemoryStorage = null;
  auditLogStorage = null;
  auditLogService = null;
  appSettingsStorage = null;
  settingsCatalogService = null;
  sessionObservabilityService = null;
  sessionApprovalService = null;
  windowBroadcastService = null;
  windowDialogService = null;
  sessionMemorySupportService = null;
  characterRuntimeService = null;
  windowEntryLoader = null;
  auxWindowService = null;
  persistentStoreLifecycleService = null;
}

async function recreateDatabaseFile(): Promise<ModelCatalogSnapshot> {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  const bundle = await requirePersistentStoreLifecycleService().recreate(dbPath, bundledModelCatalogPath, {
    modelCatalogStorage,
    sessionStorage,
    sessionMemoryStorage,
    projectMemoryStorage,
    characterMemoryStorage,
    auditLogStorage,
    appSettingsStorage,
  });

  auditLogService = null;
  settingsCatalogService = null;
  sessionObservabilityService = null;
  sessionApprovalService = null;
  windowBroadcastService = null;
  windowDialogService = null;
  sessionMemorySupportService = null;
  characterRuntimeService = null;
  windowEntryLoader = null;
  auxWindowService = null;
  sessions = [];

  return applyPersistentStoreBundle(bundle);
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
  return requireAuditLogService().listSessionAuditLogs(sessionId);
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
  return requireCharacterRuntimeService().refreshCharactersFromStorage();
}

async function getCharacter(characterId: string): Promise<CharacterProfile | null> {
  return requireCharacterRuntimeService().getCharacter(characterId);
}

function broadcastSessions(): void {
  requireWindowBroadcastService().broadcastSessions(listSessions());
}

function broadcastCharacters(): void {
  requireWindowBroadcastService().broadcastCharacters(listCharacters());
}

function broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): void {
  const payload = snapshot ?? getModelCatalog();
  if (!payload) {
    return;
  }

  requireWindowBroadcastService().broadcastModelCatalog(payload);
}

function broadcastAppSettings(settings?: ReturnType<AppSettingsStorage["getSettings"]>): void {
  const payload = settings ?? requireAppSettingsStorage().getSettings();
  requireWindowBroadcastService().broadcastAppSettings(payload);
}

function getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
  return requireSessionObservabilityService().getProviderQuotaTelemetry(providerId);
}

function broadcastProviderQuotaTelemetry(providerId: string): void {
  requireSessionObservabilityService().setProviderQuotaTelemetry(providerId, getProviderQuotaTelemetry(providerId));
}

function setProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
  requireSessionObservabilityService().setProviderQuotaTelemetry(providerId, telemetry);
}

function clearProviderQuotaTelemetry(providerId: string): void {
  requireSessionObservabilityService().clearProviderQuotaTelemetry(providerId);
}

function clearAllProviderQuotaTelemetry(): void {
  requireSessionObservabilityService().clearAllProviderQuotaTelemetry();
}

function isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean {
  return telemetry ? requireSessionObservabilityService().isProviderQuotaTelemetryStale(telemetry.provider, PROVIDER_QUOTA_STALE_TTL_MS) : true;
}

async function refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
  return requireSessionObservabilityService().refreshProviderQuotaTelemetry(providerId, async () => {
    const appSettings = requireAppSettingsStorage().getSettings();
    return getProviderAdapter(providerId).getProviderQuotaTelemetry({
      providerId,
      appSettings,
    });
  });
}

async function getOrRefreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
  return requireSessionObservabilityService().getOrRefreshProviderQuotaTelemetry(
    providerId,
    PROVIDER_QUOTA_STALE_TTL_MS,
    async () => {
      const appSettings = requireAppSettingsStorage().getSettings();
      return getProviderAdapter(providerId).getProviderQuotaTelemetry({
        providerId,
        appSettings,
      });
    },
  );
}

function scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void {
  requireSessionObservabilityService().scheduleProviderQuotaTelemetryRefresh(providerId, delaysMs, async () => {
    const appSettings = requireAppSettingsStorage().getSettings();
    return getProviderAdapter(providerId).getProviderQuotaTelemetry({
      providerId,
      appSettings,
    });
  });
}

function getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null {
  return requireSessionObservabilityService().getSessionContextTelemetry(sessionId);
}

function broadcastSessionContextTelemetry(sessionId: string): void {
  requireSessionObservabilityService().setSessionContextTelemetry(sessionId, getSessionContextTelemetry(sessionId));
}

function setSessionContextTelemetry(sessionId: string, telemetry: SessionContextTelemetry | null): void {
  requireSessionObservabilityService().setSessionContextTelemetry(sessionId, telemetry);
}

function clearSessionContextTelemetry(sessionId: string): void {
  requireSessionObservabilityService().clearSessionContextTelemetry(sessionId);
}

function clearAllSessionContextTelemetry(): void {
  requireSessionObservabilityService().clearAllSessionContextTelemetry();
}

function getSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
): SessionBackgroundActivityState | null {
  return requireSessionObservabilityService().getSessionBackgroundActivity(sessionId, kind);
}

function broadcastSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
): void {
  requireSessionObservabilityService().setSessionBackgroundActivity(
    sessionId,
    kind,
    getSessionBackgroundActivity(sessionId, kind),
  );
}

function setSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
  state: SessionBackgroundActivityState | null,
): void {
  requireSessionObservabilityService().setSessionBackgroundActivity(sessionId, kind, state);
}

function clearSessionBackgroundActivities(sessionId: string): void {
  requireSessionObservabilityService().clearSessionBackgroundActivities(sessionId);
}

function clearAllSessionBackgroundActivities(): void {
  requireSessionObservabilityService().clearAllSessionBackgroundActivities();
}

function listOpenSessionWindowIds(): string[] {
  return requireSessionWindowBridge().listOpenSessionWindowIds();
}

function broadcastOpenSessionWindowIds(): void {
  requireWindowBroadcastService().broadcastOpenSessionWindowIds(listOpenSessionWindowIds());
}

function hasRunningSessions(): boolean {
  return sessions.some((session) => isRunningSession(session));
}

function closeResetTargetWindows(): void {
  requireSessionWindowBridge().closeAllSessionWindows();
  requireAuxWindowService().closeResetTargetWindows();
}

function getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
  return requireSessionObservabilityService().getLiveSessionRun(sessionId);
}

function setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void {
  requireSessionObservabilityService().setLiveSessionRun(sessionId, state);
}

function updateLiveSessionRun(
  sessionId: string,
  recipe: (current: LiveSessionRunState) => LiveSessionRunState,
): LiveSessionRunState | null {
  return requireSessionObservabilityService().updateLiveSessionRun(sessionId, recipe);
}

function broadcastLiveSessionRun(sessionId: string): void {
  requireSessionObservabilityService().setLiveSessionRun(sessionId, getLiveSessionRun(sessionId));
}

function cancelSessionRun(sessionId: string): void {
  requireSessionRuntimeService().cancelRun(sessionId);
}

function resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void {
  requireSessionApprovalService().resolveLiveApproval(sessionId, requestId, decision);
}

function waitForLiveApprovalDecision(
  sessionId: string,
  request: LiveApprovalRequest,
  signal: AbortSignal,
): Promise<LiveApprovalDecision> {
  return requireSessionApprovalService().waitForLiveApprovalDecision(sessionId, request, signal);
}

async function importModelCatalogFromFile(targetWindow?: BrowserWindow | null): Promise<ModelCatalogSnapshot | null> {
  return requireWindowDialogService().importModelCatalogFromFile(targetWindow);
}

async function exportModelCatalogToFile(revision: number | null | undefined, targetWindow?: BrowserWindow | null): Promise<string | null> {
  return requireWindowDialogService().exportModelCatalogToFile(revision, targetWindow);
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

function replaceAllSessions(
  nextSessions: Session[],
  options?: {
    broadcast?: boolean;
    invalidateSessionIds?: Iterable<string>;
  },
): Session[] {
  return requireSessionPersistenceService().replaceAllSessions(nextSessions, options);
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
  return requireCharacterRuntimeService().createCharacter(input);
}

async function updateCharacter(nextCharacter: CharacterProfile): Promise<CharacterProfile> {
  return requireCharacterRuntimeService().updateCharacter(nextCharacter);
}

async function deleteCharacter(characterId: string): Promise<void> {
  await requireCharacterRuntimeService().deleteCharacter(characterId);
}

async function resolveSessionCharacter(session: Session): Promise<CharacterProfile | null> {
  return requireCharacterRuntimeService().resolveSessionCharacter(session);
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

async function createHomeWindow(): Promise<BrowserWindow> {
  return requireAuxWindowService().openHomeWindow();
}

async function openSessionMonitorWindow(): Promise<BrowserWindow> {
  return requireAuxWindowService().openSessionMonitorWindow();
}

async function openSettingsWindow(): Promise<BrowserWindow> {
  return requireAuxWindowService().openSettingsWindow();
}

async function openSessionWindow(sessionId: string): Promise<BrowserWindow> {
  return requireSessionWindowBridge().openSessionWindow(sessionId);
}

async function openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
  return requireAuxWindowService().openCharacterEditorWindow(characterId);
}

async function openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
  return requireAuxWindowService().openDiffWindow(diffPreview);
}

app.whenReady().then(async () => {
  dbPath = path.join(app.getPath("userData"), "withmate.db");
  const activeModelCatalog = await initializePersistentStores();
  recoverInterruptedSessions();
  await refreshCharactersFromStorage();

  registerMainIpcHandlers(ipcMain, {
    resolveEventWindow: (event) => BrowserWindow.fromWebContents(event.sender) ?? null,
    resolveHomeWindow: () => requireAuxWindowService().getHomeWindow(),
    openSessionWindow: async (sessionId) => {
      await openSessionWindow(sessionId);
    },
    openHomeWindow: async () => {
      await createHomeWindow();
    },
    openSessionMonitorWindow: async () => {
      await openSessionMonitorWindow();
    },
    openSettingsWindow: async () => {
      await openSettingsWindow();
    },
    openCharacterEditorWindow: async (characterId) => {
      await openCharacterEditorWindow(characterId);
    },
    openDiffWindow: async (diffPreview) => {
      await openDiffWindow(diffPreview);
    },
    listSessions: () => listSessions(),
    listSessionAuditLogs: (sessionId) => listSessionAuditLogs(sessionId),
    listSessionSkills: (sessionId) => listSessionSkills(sessionId),
    listSessionCustomAgents: (sessionId) => listSessionCustomAgents(sessionId),
    listOpenSessionWindowIds: () => listOpenSessionWindowIds(),
    getAppSettings: () => requireSettingsCatalogService().getAppSettings(),
    updateAppSettings: (settings) => requireSettingsCatalogService().updateAppSettings(settings),
    resetAppDatabase: async (request) => requireSettingsCatalogService().resetAppDatabase(request),
    listCharacters: async () => refreshCharactersFromStorage(),
    getModelCatalog: (revision) => requireSettingsCatalogService().getModelCatalog(revision),
    importModelCatalogDocument: (document) => requireSettingsCatalogService().importModelCatalogDocument(document),
    importModelCatalogFromFile: async (targetWindow) => importModelCatalogFromFile(targetWindow),
    exportModelCatalogDocument: (revision) => requireSettingsCatalogService().exportModelCatalogDocument(revision),
    exportModelCatalogToFile: async (revision, targetWindow) => exportModelCatalogToFile(revision, targetWindow),
    getSession: (sessionId) => getSession(sessionId),
    getDiffPreview: (token) => requireAuxWindowService().getDiffPreview(token),
    getLiveSessionRun: (sessionId) => getLiveSessionRun(sessionId),
    getProviderQuotaTelemetry: async (providerId) => getOrRefreshProviderQuotaTelemetry(providerId),
    getSessionContextTelemetry: (sessionId) => getSessionContextTelemetry(sessionId),
    getSessionBackgroundActivity: (sessionId, kind) => getSessionBackgroundActivity(sessionId, kind),
    resolveLiveApproval: (sessionId, requestId, decision) => {
      resolveLiveApproval(sessionId, requestId, decision);
    },
    getCharacter: async (characterId) => getCharacter(characterId),
    createSession: (input) => createSession(input),
    updateSession: (session) => updateSession(session),
    deleteSession: (sessionId) => deleteSession(sessionId),
    previewComposerInput: async (sessionId, userMessage) => previewComposerInput(sessionId, userMessage),
    searchWorkspaceFiles: async (sessionId, query) => searchWorkspaceFiles(sessionId, query),
    runSessionTurn: async (sessionId, request) => runSessionTurn(sessionId, request),
    cancelSessionRun: (sessionId) => {
      cancelSessionRun(sessionId);
    },
    createCharacter: async (input) => createCharacter(input),
    updateCharacter: async (character) => updateCharacter(character),
    deleteCharacter: async (characterId) => deleteCharacter(characterId),
    pickDirectory: async (targetWindow, initialPath) =>
      requireWindowDialogService().pickDirectory(targetWindow, initialPath),
    pickFile: async (targetWindow, initialPath) =>
      requireWindowDialogService().pickFile(targetWindow, initialPath),
    pickImageFile: async (targetWindow, initialPath) =>
      requireWindowDialogService().pickImageFile(targetWindow, initialPath),
    openPathTarget: async (target, options) => openPathTarget(target, options),
    openSessionTerminal: async (sessionId) => openSessionTerminal(sessionId),
  });

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
  settingsCatalogService = null;
});




