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
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionContextTelemetry,
} from "../src/app-state.js";
import {
  type CharacterProfile,
  type CreateCharacterInput,
} from "../src/character-state.js";
import {
  type DiffPreviewPayload,
  type Session,
} from "../src/session-state.js";
import {
  type ModelCatalogDocument,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import type { OpenPathOptions } from "../src/withmate-window-types.js";
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
import { AppLifecycleService } from "./app-lifecycle-service.js";
import { createAppLifecycleDeps } from "./app-lifecycle-deps.js";
import { createMainBootstrapDeps } from "./main-bootstrap-deps.js";
import { MainInfrastructureRegistry } from "./main-infrastructure-registry.js";
import { MainBootstrapService } from "./main-bootstrap-service.js";
import { MainBroadcastFacade } from "./main-broadcast-facade.js";
import { MainCharacterFacade } from "./main-character-facade.js";
import { MainObservabilityFacade } from "./main-observability-facade.js";
import { MainProviderFacade } from "./main-provider-facade.js";
import { MainSessionCommandFacade } from "./main-session-command-facade.js";
import { MainSessionPersistenceFacade } from "./main-session-persistence-facade.js";
import { MainWindowFacade } from "./main-window-facade.js";
import { MainQueryService } from "./main-query-service.js";
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
let sessionMemorySupportService: SessionMemorySupportService | null = null;
let characterRuntimeService: CharacterRuntimeService | null = null;
let mainBroadcastFacade: MainBroadcastFacade<BrowserWindow> | null = null;
let mainCharacterFacade: MainCharacterFacade | null = null;
let mainObservabilityFacade: MainObservabilityFacade | null = null;
let mainProviderFacade: MainProviderFacade | null = null;
let mainSessionCommandFacade: MainSessionCommandFacade | null = null;
let mainSessionPersistenceFacade: MainSessionPersistenceFacade | null = null;
let mainWindowFacade: MainWindowFacade | null = null;
let mainQueryService: MainQueryService | null = null;
let mainInfrastructureRegistry:
  | MainInfrastructureRegistry<
      WindowBroadcastService<BrowserWindow>,
      WindowDialogService,
      WindowEntryLoader,
      AuxWindowService<BrowserWindow>,
      PersistentStoreLifecycleService,
      AppLifecycleService,
      MainBootstrapService
    >
  | null = null;

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
  return requireMainQueryService().listSessions();
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

function requireMainInfrastructureRegistry(): MainInfrastructureRegistry<
  WindowBroadcastService<BrowserWindow>,
  WindowDialogService,
  WindowEntryLoader,
  AuxWindowService<BrowserWindow>,
  PersistentStoreLifecycleService,
  AppLifecycleService,
  MainBootstrapService
> {
  if (!mainInfrastructureRegistry) {
    mainInfrastructureRegistry = new MainInfrastructureRegistry({
      createWindowBroadcastService: () =>
        new WindowBroadcastService({
          getWindows: () => BrowserWindow.getAllWindows(),
        }),
      createWindowDialogService: () =>
        new WindowDialogService({
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
        }),
      createWindowEntryLoader: () =>
        new WindowEntryLoader({
          devServerUrl,
          rendererDistPath,
        }),
      createAuxWindowService: () =>
        new AuxWindowService({
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
          loadCharacterEntry: (window, characterId) =>
            requireWindowEntryLoader().loadCharacterEntry(window, characterId),
          loadDiffEntry: (window, token) => requireWindowEntryLoader().loadDiffEntry(window, token),
          generateDiffToken: () => crypto.randomUUID(),
        }),
      createPersistentStoreLifecycleService: () =>
        new PersistentStoreLifecycleService({
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
        }),
      createAppLifecycleService: () =>
        new AppLifecycleService(
          createAppLifecycleDeps({
            hasInFlightSessionRuns,
            getAllowQuitWithInFlightRuns: () => allowQuitWithInFlightRuns,
            setAllowQuitWithInFlightRuns: (value) => {
              allowQuitWithInFlightRuns = value;
            },
            createHomeWindow: async () => {
              await createHomeWindow();
            },
            quitApp: () => {
              app.quit();
            },
            shouldQuitWhenAllWindowsClosed: () => process.platform !== "darwin",
            confirmQuitWhileRunning: () => {
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
              return choice === 1;
            },
            closePersistentStores,
          }),
        ),
      createMainBootstrapService: () =>
        new MainBootstrapService(
          createMainBootstrapDeps({
            ipcMain,
            registerMainIpcHandlers,
            initializePersistentStores,
            recoverInterruptedSessions: () => requireMainSessionPersistenceFacade().recoverInterruptedSessions(),
            refreshCharactersFromStorage: async () => {
              await refreshCharactersFromStorage();
            },
            createHomeWindow,
            broadcastModelCatalog,
            ipcRegistration: {
              window: {
                resolveEventWindow: (event) => BrowserWindow.fromWebContents(event.sender) ?? null,
                resolveHomeWindow: () => requireAuxWindowService().getHomeWindow(),
                openSessionWindow,
                openHomeWindow: createHomeWindow,
                openSessionMonitorWindow,
                openSettingsWindow,
                openCharacterEditorWindow,
                openDiffWindow,
                pickDirectory: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickDirectory(targetWindow, initialPath),
                pickFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFile(targetWindow, initialPath),
                pickImageFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickImageFile(targetWindow, initialPath),
                openPathTarget,
                openSessionTerminal,
              },
              catalog: {
                getModelCatalog: (revision) => requireSettingsCatalogService().getModelCatalog(revision),
                importModelCatalogDocument: (document) => requireSettingsCatalogService().importModelCatalogDocument(document),
                importModelCatalogFromFile: async (targetWindow) => importModelCatalogFromFile(targetWindow),
                exportModelCatalogDocument: (revision) => requireSettingsCatalogService().exportModelCatalogDocument(revision),
                exportModelCatalogToFile: async (revision, targetWindow) => exportModelCatalogToFile(revision, targetWindow),
              },
              settings: {
                getAppSettings: () => requireSettingsCatalogService().getAppSettings(),
                updateAppSettings: (settings) => requireSettingsCatalogService().updateAppSettings(settings),
                resetAppDatabase: async (request) => requireSettingsCatalogService().resetAppDatabase(request),
              },
              sessionQuery: {
                listSessions: () => listSessions(),
                listSessionAuditLogs: (sessionId) => listSessionAuditLogs(sessionId),
                listSessionSkills: (sessionId) => listSessionSkills(sessionId),
                listSessionCustomAgents: (sessionId) => listSessionCustomAgents(sessionId),
                listOpenSessionWindowIds: () => listOpenSessionWindowIds(),
                getSession: (sessionId) => getSession(sessionId),
                getDiffPreview: (token) => requireAuxWindowService().getDiffPreview(token),
                previewComposerInput,
                searchWorkspaceFiles,
              },
              sessionRuntime: {
                getLiveSessionRun: (sessionId) => getLiveSessionRun(sessionId),
                getProviderQuotaTelemetry: getOrRefreshProviderQuotaTelemetry,
                getSessionContextTelemetry: (sessionId) => getSessionContextTelemetry(sessionId),
                getSessionBackgroundActivity: (sessionId, kind) => getSessionBackgroundActivity(sessionId, kind),
                resolveLiveApproval,
                createSession: (input) => requireMainSessionCommandFacade().createSession(input),
                updateSession: (session) => requireMainSessionCommandFacade().updateSession(session),
                deleteSession: (sessionId) => requireMainSessionCommandFacade().deleteSession(sessionId),
                runSessionTurn: (sessionId, request) => requireMainSessionCommandFacade().runSessionTurn(sessionId, request),
                cancelSessionRun: (sessionId) => requireMainSessionCommandFacade().cancelSessionRun(sessionId),
              },
              character: {
                listCharacters: async () => refreshCharactersFromStorage(),
                getCharacter,
                createCharacter,
                updateCharacter,
                deleteCharacter,
              },
            },
          }),
        ),
    });
  }

  return mainInfrastructureRegistry;
}

function requireSessionStorage(): SessionStorage {
  if (!sessionStorage) {
    throw new Error("session storage が初期化されていないよ。");
  }

  return sessionStorage;
}

function requireMainQueryService(): MainQueryService {
  if (!mainQueryService) {
    mainQueryService = new MainQueryService({
      getSessions: () => sessions,
      getCharacters: () => characters,
      getAuditLogs: (sessionId) => requireAuditLogService().listSessionAuditLogs(sessionId),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      discoverSessionSkills,
      discoverSessionCustomAgents,
      getStoredCharacter: (characterId) => requireCharacterRuntimeService().getCharacter(characterId),
      refreshCharactersFromStorage: () => requireCharacterRuntimeService().refreshCharactersFromStorage(),
      resolveComposerPreview,
      searchWorkspaceFiles: (workspacePath, query) => searchWorkspaceFilePaths(workspacePath, query),
      launchTerminalAtPath,
    });
  }

  return mainQueryService;
}

function requireMainBroadcastFacade(): MainBroadcastFacade<BrowserWindow> {
  if (!mainBroadcastFacade) {
    mainBroadcastFacade = new MainBroadcastFacade({
      getWindowBroadcastService: () => requireWindowBroadcastService(),
      listSessions: () => listSessions(),
      listCharacters: () => listCharacters(),
      getModelCatalog: () => getModelCatalog(),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      listOpenSessionWindowIds: () => listOpenSessionWindowIds(),
    });
  }

  return mainBroadcastFacade;
}

function requireMainCharacterFacade(): MainCharacterFacade {
  if (!mainCharacterFacade) {
    mainCharacterFacade = new MainCharacterFacade({
      getMainQueryService: () => requireMainQueryService(),
      getCharacterRuntimeService: () => requireCharacterRuntimeService(),
    });
  }

  return mainCharacterFacade;
}

function requireMainWindowFacade(): MainWindowFacade {
  if (!mainWindowFacade) {
    mainWindowFacade = new MainWindowFacade({
      getAuxWindowService: () => requireAuxWindowService(),
      getSessionWindowBridge: () => requireSessionWindowBridge(),
    });
  }

  return mainWindowFacade;
}

function requireMainObservabilityFacade(): MainObservabilityFacade {
  if (!mainObservabilityFacade) {
    mainObservabilityFacade = new MainObservabilityFacade({
      getSessionObservabilityService: () => requireSessionObservabilityService(),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getProviderCodingAdapter: (providerId) => getProviderCodingAdapter(providerId),
      providerQuotaStaleTtlMs: PROVIDER_QUOTA_STALE_TTL_MS,
    });
  }

  return mainObservabilityFacade;
}

function requireMainProviderFacade(): MainProviderFacade {
  if (!mainProviderFacade) {
    mainProviderFacade = new MainProviderFacade({
      getModelCatalog: (revision) => requireModelCatalogStorage().getCatalog(revision ?? null),
      ensureModelCatalogSeeded: () => requireModelCatalogStorage().ensureSeeded(),
      codexAdapter,
      copilotAdapter,
    });
  }

  return mainProviderFacade;
}

function requireMainSessionCommandFacade(): MainSessionCommandFacade {
  if (!mainSessionCommandFacade) {
    mainSessionCommandFacade = new MainSessionCommandFacade({
      getSession,
      getSessionPersistenceService: () => requireSessionPersistenceService(),
      getSessionRuntimeService: () => requireSessionRuntimeService(),
      getProviderQuotaTelemetry: (providerId) => getProviderQuotaTelemetry(providerId),
      isProviderQuotaTelemetryStale: (telemetry) => isProviderQuotaTelemetryStale(telemetry),
      refreshProviderQuotaTelemetry: (providerId) => refreshProviderQuotaTelemetry(providerId),
    });
  }

  return mainSessionCommandFacade;
}

function requireMainSessionPersistenceFacade(): MainSessionPersistenceFacade {
  if (!mainSessionPersistenceFacade) {
    mainSessionPersistenceFacade = new MainSessionPersistenceFacade({
      getSessions: () => sessions,
      setSessions: (nextSessions) => {
        sessions = nextSessions;
      },
      getSessionPersistenceService: () => requireSessionPersistenceService(),
      getSessionStorage: () => requireSessionStorage(),
    });
  }

  return mainSessionPersistenceFacade;
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
  return requireMainInfrastructureRegistry().getWindowBroadcastService();
}

function requireWindowDialogService(): WindowDialogService {
  return requireMainInfrastructureRegistry().getWindowDialogService();
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
      upsertSession: (session) => requireMainSessionPersistenceFacade().upsertSession(session),
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
  return requireMainInfrastructureRegistry().getWindowEntryLoader();
}

function requireAuxWindowService(): AuxWindowService<BrowserWindow> {
  return requireMainInfrastructureRegistry().getAuxWindowService();
}

function requireSessionRuntimeService(): SessionRuntimeService {
  if (!sessionRuntimeService) {
    sessionRuntimeService = new SessionRuntimeService({
      getSession,
        upsertSession: (session) => requireMainSessionPersistenceFacade().upsertSession(session),
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
      getProviderBackgroundAdapter,
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
      replaceAllSessions: (nextSessions, options) =>
        requireMainSessionPersistenceFacade().replaceAllSessions(nextSessions, options),
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
  return requireMainInfrastructureRegistry().getPersistentStoreLifecycleService();
}

function requireAppLifecycleService(): AppLifecycleService {
  return requireMainInfrastructureRegistry().getAppLifecycleService();
}

function requireMainBootstrapService(): MainBootstrapService {
  return requireMainInfrastructureRegistry().getMainBootstrapService();
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
  sessionMemorySupportService = null;
  characterRuntimeService = null;
  mainBroadcastFacade = null;
  mainCharacterFacade = null;
  mainObservabilityFacade = null;
  mainProviderFacade = null;
  mainSessionCommandFacade = null;
  mainSessionPersistenceFacade = null;
  mainWindowFacade = null;
  mainQueryService = null;
  mainInfrastructureRegistry?.reset();
  mainInfrastructureRegistry = null;
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
  sessionMemorySupportService = null;
  characterRuntimeService = null;
  mainBroadcastFacade = null;
  mainCharacterFacade = null;
  mainObservabilityFacade = null;
  mainProviderFacade = null;
  mainSessionCommandFacade = null;
  mainSessionPersistenceFacade = null;
  mainWindowFacade = null;
  mainQueryService = null;
  mainInfrastructureRegistry?.reset();
  mainInfrastructureRegistry = null;
  sessions = [];

  return applyPersistentStoreBundle(bundle);
}

function getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null {
  return requireMainProviderFacade().getModelCatalog(revision);
}

function resolveProviderCatalog(
  providerId: string | null | undefined,
  revision?: number | null,
): { snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider } {
  return requireMainProviderFacade().resolveProviderCatalog(providerId, revision);
}

function getProviderAdapter(providerId: string | null | undefined): ProviderTurnAdapter {
  return requireMainProviderFacade().getProviderAdapter(providerId);
}

function getProviderCodingAdapter(providerId: string | null | undefined) {
  return requireMainProviderFacade().getProviderCodingAdapter(providerId);
}

function getProviderBackgroundAdapter(providerId: string | null | undefined) {
  return requireMainProviderFacade().getProviderBackgroundAdapter(providerId);
}

function invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void {
  requireMainProviderFacade().invalidateProviderSessionThread(providerId, sessionId);
}

function invalidateAllProviderSessionThreads(): void {
  requireMainProviderFacade().invalidateAllProviderSessionThreads();
}

function listCharacters(): CharacterProfile[] {
  return requireMainCharacterFacade().listCharacters();
}

function listSessionAuditLogs(sessionId: string): AuditLogEntry[] {
  return requireMainQueryService().listSessionAuditLogs(sessionId);
}

function listSessionSkills(sessionId: string): DiscoveredSkill[] {
  return requireMainQueryService().listSessionSkills(sessionId);
}

function listSessionCustomAgents(sessionId: string): DiscoveredCustomAgent[] {
  return requireMainQueryService().listSessionCustomAgents(sessionId);
}

function getSession(sessionId: string): Session | null {
  return requireMainQueryService().getSession(sessionId);
}

async function openSessionTerminal(sessionId: string): Promise<void> {
  await requireMainQueryService().openSessionTerminal(sessionId);
}

async function refreshCharactersFromStorage(): Promise<CharacterProfile[]> {
  return requireMainCharacterFacade().refreshCharactersFromStorage();
}

async function getCharacter(characterId: string): Promise<CharacterProfile | null> {
  return requireMainCharacterFacade().getCharacter(characterId);
}

function broadcastSessions(): void {
  requireMainBroadcastFacade().broadcastSessions();
}

function broadcastCharacters(): void {
  requireMainBroadcastFacade().broadcastCharacters();
}

function broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): void {
  requireMainBroadcastFacade().broadcastModelCatalog(snapshot);
}

function broadcastAppSettings(settings?: ReturnType<AppSettingsStorage["getSettings"]>): void {
  requireMainBroadcastFacade().broadcastAppSettings(settings);
}

function getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null {
  return requireMainObservabilityFacade().getProviderQuotaTelemetry(providerId);
}

function setProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
  requireMainObservabilityFacade().setProviderQuotaTelemetry(providerId, telemetry);
}

function clearProviderQuotaTelemetry(providerId: string): void {
  requireMainObservabilityFacade().clearProviderQuotaTelemetry(providerId);
}

function clearAllProviderQuotaTelemetry(): void {
  requireMainObservabilityFacade().clearAllProviderQuotaTelemetry();
}

function isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean {
  return requireMainObservabilityFacade().isProviderQuotaTelemetryStale(telemetry);
}

async function refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
  return requireMainObservabilityFacade().refreshProviderQuotaTelemetry(providerId);
}

async function getOrRefreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null> {
  return requireMainObservabilityFacade().getOrRefreshProviderQuotaTelemetry(providerId);
}

function scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void {
  requireMainObservabilityFacade().scheduleProviderQuotaTelemetryRefresh(providerId, delaysMs);
}

function getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null {
  return requireMainObservabilityFacade().getSessionContextTelemetry(sessionId);
}

function setSessionContextTelemetry(sessionId: string, telemetry: SessionContextTelemetry | null): void {
  requireMainObservabilityFacade().setSessionContextTelemetry(sessionId, telemetry);
}

function clearSessionContextTelemetry(sessionId: string): void {
  requireMainObservabilityFacade().clearSessionContextTelemetry(sessionId);
}

function clearAllSessionContextTelemetry(): void {
  requireMainObservabilityFacade().clearAllSessionContextTelemetry();
}

function getSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
): SessionBackgroundActivityState | null {
  return requireMainObservabilityFacade().getSessionBackgroundActivity(sessionId, kind);
}

function setSessionBackgroundActivity(
  sessionId: string,
  kind: SessionBackgroundActivityKind,
  state: SessionBackgroundActivityState | null,
): void {
  requireMainObservabilityFacade().setSessionBackgroundActivity(sessionId, kind, state);
}

function clearSessionBackgroundActivities(sessionId: string): void {
  requireMainObservabilityFacade().clearSessionBackgroundActivities(sessionId);
}

function clearAllSessionBackgroundActivities(): void {
  requireMainObservabilityFacade().clearAllSessionBackgroundActivities();
}

function listOpenSessionWindowIds(): string[] {
  return requireMainWindowFacade().listOpenSessionWindowIds();
}

function broadcastOpenSessionWindowIds(): void {
  requireMainBroadcastFacade().broadcastOpenSessionWindowIds();
}

function hasRunningSessions(): boolean {
  return sessions.some((session) => isRunningSession(session));
}

function closeResetTargetWindows(): void {
  requireMainWindowFacade().closeResetTargetWindows();
}

function getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
  return requireMainObservabilityFacade().getLiveSessionRun(sessionId);
}

function setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void {
  requireMainObservabilityFacade().setLiveSessionRun(sessionId, state);
}

function updateLiveSessionRun(
  sessionId: string,
  recipe: (current: LiveSessionRunState) => LiveSessionRunState,
): LiveSessionRunState | null {
  return requireMainObservabilityFacade().updateLiveSessionRun(sessionId, recipe);
}

function broadcastLiveSessionRun(sessionId: string): void {
  requireMainObservabilityFacade().setLiveSessionRun(sessionId, getLiveSessionRun(sessionId));
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

function upsertSession(nextSession: Session): Session {
  return requireMainSessionPersistenceFacade().upsertSession(nextSession);
}

function replaceAllSessions(
  nextSessions: Session[],
  options?: {
    broadcast?: boolean;
    invalidateSessionIds?: Iterable<string>;
  },
): Session[] {
  return requireMainSessionPersistenceFacade().replaceAllSessions(nextSessions, options);
}

function recoverInterruptedSessions(): void {
  requireMainSessionPersistenceFacade().recoverInterruptedSessions();
}

async function createCharacter(input: CreateCharacterInput): Promise<CharacterProfile> {
  return requireMainCharacterFacade().createCharacter(input);
}

async function updateCharacter(nextCharacter: CharacterProfile): Promise<CharacterProfile> {
  return requireMainCharacterFacade().updateCharacter(nextCharacter);
}

async function deleteCharacter(characterId: string): Promise<void> {
  await requireMainCharacterFacade().deleteCharacter(characterId);
}

async function resolveSessionCharacter(session: Session): Promise<CharacterProfile | null> {
  return requireMainCharacterFacade().resolveSessionCharacter(session);
}

async function previewComposerInput(
  sessionId: string,
  userMessage: string,
) {
  return requireMainQueryService().previewComposerInput(sessionId, userMessage);
}

async function searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]> {
  return requireMainQueryService().searchWorkspaceFiles(sessionId, query);
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

async function createHomeWindow(): Promise<BrowserWindow> {
  return requireMainWindowFacade().openHomeWindow();
}

async function openSessionMonitorWindow(): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSessionMonitorWindow();
}

async function openSettingsWindow(): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSettingsWindow();
}

async function openSessionWindow(sessionId: string): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSessionWindow(sessionId);
}

async function openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
  return requireMainWindowFacade().openCharacterEditorWindow(characterId);
}

async function openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
  return requireMainWindowFacade().openDiffWindow(diffPreview);
}

app.whenReady().then(async () => {
  dbPath = path.join(app.getPath("userData"), "withmate.db");
  await requireMainBootstrapService().handleReady();

  app.on("activate", async () => {
    await requireAppLifecycleService().handleActivate();
  });
});

app.on("window-all-closed", () => {
  requireAppLifecycleService().handleWindowAllClosed();
});

app.on("before-quit", (event) => {
  requireAppLifecycleService().handleBeforeQuit(event);
});




