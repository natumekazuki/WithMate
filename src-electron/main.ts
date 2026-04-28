import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, crashReporter, dialog, ipcMain, screen, shell } from "electron";

import type { RendererLogInput } from "../src/app-log-types.js";
import {
  type AuditLogDetail,
  type AuditLogEntry,
  type AuditLogSummary,
  currentTimestampLabel,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveElicitationRequest,
  type LiveElicitationResponse,
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
  type SessionSummary,
} from "../src/session-state.js";
import {
  type ModelCatalogDocument,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import type { OpenPathOptions } from "../src/withmate-window-types.js";
import type { WorkspacePathCandidate } from "../src/workspace-path-candidate.js";
import {
  createStoredCharacter,
  deleteStoredCharacter,
  getStoredCharacterDirectoryPath,
  getStoredCharacter,
  listStoredCharacters,
  updateStoredCharacter,
} from "./character-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogService } from "./audit-log-service.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CopilotAdapter } from "./copilot-adapter.js";
import { ProviderTurnError } from "./provider-runtime.js";
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
import { SessionElicitationService } from "./session-elicitation-service.js";
import { WindowBroadcastService } from "./window-broadcast-service.js";
import { WindowDialogService } from "./window-dialog-service.js";
import { SessionMemorySupportService } from "./session-memory-support-service.js";
import { MemoryManagementService } from "./memory-management-service.js";
import { CharacterRuntimeService } from "./character-runtime-service.js";
import { CharacterUpdateWorkspaceService } from "./character-update-workspace-service.js";
import { WindowEntryLoader } from "./window-entry-loader.js";
import { AuxWindowService } from "./aux-window-service.js";
import { registerMainIpcHandlers } from "./main-ipc-registration.js";
import {
  PersistentStoreLifecycleService,
  type AuditLogStorageRead,
  type CharacterMemoryStorageAccess,
  type PersistentStoreBundle,
  type ProjectMemoryStorageAccess,
  type SessionMemoryStorageAccess,
  type SessionStorageRead,
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
import { hydrateSessionsFromSummaries } from "./session-summary-adapter.js";
import {
  type CharacterReflectionTriggerReason,
} from "./character-reflection.js";
import {
  type SessionMemoryExtractionTriggerReason,
} from "./session-memory-extraction.js";
import { discoverSessionSkills } from "./skill-discovery.js";
import { discoverSessionCustomAgents } from "./custom-agent-discovery.js";
import { HOME_WINDOW_DEFAULT_BOUNDS, SESSION_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";
import { resolveCursorAnchoredPosition } from "./window-placement.js";
import { clearWorkspaceFileIndex, searchWorkspacePathCandidates } from "./workspace-file-search.js";
import { AppLogService } from "./app-log-service.js";
import { resolveAppDatabasePath } from "./app-database-path.js";
import {
  SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
  truncateAppDatabaseWal,
  truncateAppDatabaseWalIfLargerThan,
} from "./sqlite-connection.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "preload.js");
const rendererDistPath = path.resolve(currentDir, "../../dist");
const appDataPath = app.getPath("appData");
const fixedUserDataPath = path.join(appDataPath, "WithMate");
app.setAppUserModelId("com.natumekazuki.withmate");
app.setPath("userData", fixedUserDataPath);
const appLogsPath = path.join(fixedUserDataPath, "logs");
const appLogService = new AppLogService({
  logsPath: appLogsPath,
  runtimeInfo: {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "",
    chromeVersion: process.versions.chrome ?? "",
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
  },
});
const crashDumpsPath = resolveCrashDumpsPath();
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const bundledModelCatalogPath = devServerUrl
  ? path.resolve(currentDir, "../../public/model-catalog.json")
  : path.resolve(rendererDistPath, "model-catalog.json");
const codexAdapter = new CodexAdapter();
const copilotAdapter = new CopilotAdapter();
const WAL_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

let sessions: Session[] = [];
let characters: CharacterProfile[] = [];
let sessionStorage: SessionStorageRead | null = null;
let sessionMemoryStorage: SessionMemoryStorageAccess | null = null;
let projectMemoryStorage: ProjectMemoryStorageAccess | null = null;
let characterMemoryStorage: CharacterMemoryStorageAccess | null = null;
let modelCatalogStorage: ModelCatalogStorage | null = null;
let auditLogStorage: AuditLogStorageRead | null = null;
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
let sessionElicitationService: SessionElicitationService | null = null;
let auditLogService: AuditLogService | null = null;
let sessionMemorySupportService: SessionMemorySupportService | null = null;
let memoryManagementService: MemoryManagementService | null = null;
let characterRuntimeService: CharacterRuntimeService | null = null;
let characterUpdateWorkspaceService: CharacterUpdateWorkspaceService | null = null;
let mainBroadcastFacade: MainBroadcastFacade<BrowserWindow> | null = null;
let mainCharacterFacade: MainCharacterFacade | null = null;
let mainObservabilityFacade: MainObservabilityFacade | null = null;
let mainProviderFacade: MainProviderFacade | null = null;
let mainSessionCommandFacade: MainSessionCommandFacade | null = null;
let mainSessionPersistenceFacade: MainSessionPersistenceFacade | null = null;
let mainWindowFacade: MainWindowFacade | null = null;
let mainQueryService: MainQueryService | null = null;
let walMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
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

startCrashReporter();
registerProcessLogHandlers();
writeAppLog({
  level: "info",
  kind: "app.started",
  process: "main",
  message: "App process started",
  data: {
    userDataPath: app.getPath("userData"),
    logsPath: appLogsPath,
    crashDumpsPath,
  },
});

function writeAppLog(input: Parameters<AppLogService["write"]>[0]): void {
  try {
    appLogService.write(input);
  } catch (error) {
    console.warn("App log write failed", error);
  }
}

function resolveCrashDumpsPath(): string {
  try {
    return app.getPath("crashDumps");
  } catch {
    return path.join(app.getPath("userData"), "Crashpad");
  }
}

function startCrashReporter(): void {
  try {
    crashReporter.start({ uploadToServer: false });
    writeAppLog({
      level: "info",
      kind: "crash-reporter.started",
      process: "main",
      message: "Crash reporter started",
      data: {
        uploadToServer: false,
        crashDumpsPath,
      },
    });
  } catch (error) {
    writeAppLog({
      level: "error",
      kind: "crash-reporter.start-failed",
      process: "main",
      message: "Crash reporter failed to start",
      error: appLogService.errorToLogError(error),
      data: {
        crashDumpsPath,
      },
    });
  }
}

function registerProcessLogHandlers(): void {
  process.on("uncaughtExceptionMonitor", (error) => {
    writeAppLog({
      level: "fatal",
      kind: "main.uncaught-exception",
      process: "main",
      message: error.message,
      error: appLogService.errorToLogError(error),
    });
  });
  process.on("unhandledRejection", (reason) => {
    writeAppLog({
      level: "fatal",
      kind: "main.unhandled-rejection",
      process: "main",
      message: reason instanceof Error ? reason.message : "Unhandled rejection",
      error: appLogService.errorToLogError(reason),
      data: reason instanceof Error ? undefined : { reason },
    });
  });
  app.on("child-process-gone", (_event, details) => {
    writeAppLog({
      level: details.reason === "clean-exit" ? "info" : "error",
      kind: "child-process.gone",
      process: "main",
      message: `Child process gone: ${details.type}`,
      data: {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: "serviceName" in details ? details.serviceName : undefined,
        name: "name" in details ? details.name : undefined,
      },
    });
  });
}

function attachWindowLogHandlers(window: BrowserWindow): void {
  writeAppLog({
    level: "info",
    kind: "app.window.created",
    process: "main",
    message: "Window created",
    windowId: window.id,
    data: {
      title: readWindowTitle(window),
    },
  });

  window.on("closed", () => {
    writeAppLog({
      level: "info",
      kind: "app.window.closed",
      process: "main",
      message: "Window closed",
      windowId: window.id,
      data: {
        title: readWindowTitle(window),
      },
    });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    writeAppLog({
      level: details.reason === "clean-exit" ? "info" : "error",
      kind: "renderer.process-gone",
      process: "main",
      message: `Renderer process gone: ${details.reason}`,
      windowId: window.id,
      data: {
        reason: details.reason,
        exitCode: details.exitCode,
        url: readWindowUrl(window),
        windowTitle: readWindowTitle(window),
        isDestroyed: window.isDestroyed(),
      },
    });
  });
  window.webContents.on("unresponsive", () => {
    writeAppLog({
      level: "warn",
      kind: "webcontents.unresponsive",
      process: "main",
      message: "Window webContents became unresponsive",
      windowId: window.id,
      data: {
        url: readWindowUrl(window),
        windowTitle: readWindowTitle(window),
      },
    });
  });
  window.webContents.on("responsive", () => {
    writeAppLog({
      level: "info",
      kind: "webcontents.responsive",
      process: "main",
      message: "Window webContents became responsive",
      windowId: window.id,
      data: {
        url: readWindowUrl(window),
        windowTitle: readWindowTitle(window),
      },
    });
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    writeAppLog({
      level: "error",
      kind: "renderer.did-fail-load",
      process: "main",
      message: errorDescription,
      windowId: window.id,
      data: {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
        url: readWindowUrl(window),
      },
    });
  });
}

function readWindowTitle(window: BrowserWindow): string {
  try {
    return window.isDestroyed() ? "" : window.getTitle();
  } catch {
    return "";
  }
}

function readWindowUrl(window: BrowserWindow): string {
  try {
    return window.webContents.isDestroyed() ? "" : window.webContents.getURL();
  } catch {
    return "";
  }
}

function writeIpcErrorLog(input: { channel: string; durationMs: number; error: unknown }): void {
  writeAppLog({
    level: "error",
    kind: "ipc.error",
    process: "main",
    message: `IPC failed: ${input.channel}`,
    data: {
      channel: input.channel,
      durationMs: input.durationMs,
      success: false,
    },
    error: appLogService.errorToLogError(input.error),
  });
}

const VALID_RENDERER_LOG_LEVELS = new Set(["debug", "info", "warn", "error", "fatal"]);
const MAX_RENDERER_LOG_KIND_LENGTH = 128;
const MAX_RENDERER_LOG_MESSAGE_LENGTH = 4096;
const MAX_RENDERER_LOG_URL_LENGTH = 2048;
const MAX_RENDERER_LOG_STRING_LENGTH = 2048;
const MAX_RENDERER_LOG_OBJECT_KEYS = 50;
const MAX_RENDERER_LOG_ARRAY_ITEMS = 50;
const MAX_RENDERER_LOG_DEPTH = 4;

type SanitizedRendererLogInput = {
  level: RendererLogInput["level"];
  kind: string;
  message: string;
  url?: string;
  data?: unknown;
  error?: RendererLogInput["error"];
};

function truncateRendererLogString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sanitizeRendererLogPayload(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "string") {
    return truncateRendererLogString(value, MAX_RENDERER_LOG_STRING_LENGTH);
  }

  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return truncateRendererLogString(String(value), MAX_RENDERER_LOG_STRING_LENGTH);
  }

  if (depth >= MAX_RENDERER_LOG_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RENDERER_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeRendererLogPayload(item, depth + 1));
  }

  const sanitizedEntries = Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_RENDERER_LOG_OBJECT_KEYS)
    .map(([key, entryValue]) => [
      truncateRendererLogString(key, MAX_RENDERER_LOG_KIND_LENGTH),
      sanitizeRendererLogPayload(entryValue, depth + 1),
    ]);
  return Object.fromEntries(sanitizedEntries);
}

function sanitizeRendererLogError(value: unknown): RendererLogInput["error"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const message = candidate.message;
  if (typeof message !== "string") {
    return undefined;
  }

  return {
    name: typeof candidate.name === "string"
      ? truncateRendererLogString(candidate.name, MAX_RENDERER_LOG_STRING_LENGTH)
      : undefined,
    message: truncateRendererLogString(message, MAX_RENDERER_LOG_MESSAGE_LENGTH),
    stack: typeof candidate.stack === "string"
      ? truncateRendererLogString(candidate.stack, MAX_RENDERER_LOG_MESSAGE_LENGTH)
      : undefined,
  };
}

function sanitizeRendererLogInput(input: RendererLogInput): SanitizedRendererLogInput | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const rawInput = input as Record<string, unknown>;
  const level = rawInput.level;
  if (typeof level !== "string" || !VALID_RENDERER_LOG_LEVELS.has(level)) {
    return null;
  }

  const kind = rawInput.kind;
  if (typeof kind !== "string" || kind.trim().length === 0) {
    return null;
  }

  const message = rawInput.message;
  if (typeof message !== "string") {
    return null;
  }

  return {
    level: level as RendererLogInput["level"],
    kind: truncateRendererLogString(kind, MAX_RENDERER_LOG_KIND_LENGTH),
    message: truncateRendererLogString(message, MAX_RENDERER_LOG_MESSAGE_LENGTH),
    url: typeof rawInput.url === "string"
      ? truncateRendererLogString(rawInput.url, MAX_RENDERER_LOG_URL_LENGTH)
      : undefined,
    data: rawInput.data === undefined ? undefined : sanitizeRendererLogPayload(rawInput.data),
    error: sanitizeRendererLogError(rawInput.error),
  };
}

function writeRendererLog(input: RendererLogInput, windowId?: number): void {
  const sanitizedInput = sanitizeRendererLogInput(input);
  if (!sanitizedInput) {
    return;
  }

  writeAppLog({
    level: sanitizedInput.level,
    kind: sanitizedInput.kind,
    process: "renderer",
    message: sanitizedInput.message,
    windowId,
    data: {
      url: sanitizedInput.url,
      detail: sanitizedInput.data,
    },
    error: sanitizedInput.error,
  });
}

async function openDirectory(directoryPath: string): Promise<void> {
  mkdirSync(directoryPath, { recursive: true });
  const errorMessage = await shell.openPath(directoryPath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
}

function createBaseWindow(options: ConstructorParameters<typeof BrowserWindow>[0]): BrowserWindow {
  const window = new BrowserWindow({
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
  attachWindowLogHandlers(window);
  return window;
}

function createCursorPlacedWindow(
  options: ConstructorParameters<typeof BrowserWindow>[0] & { width: number; height: number },
): BrowserWindow {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y } = resolveCursorAnchoredPosition({
    cursor,
    workArea: display.workArea,
    width: options.width,
    height: options.height,
  });

  return createBaseWindow({
    ...options,
    x,
    y,
  });
}

function listSessions(): Session[] {
  return sessions;
}

function listSessionSummaries(): SessionSummary[] {
  return requireMainQueryService().listSessionSummaries();
}

function listFullStoredSessions(): Session[] {
  return hydrateSessionsFromSummaries(requireSessionStorage());
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
          getAllWindows: () => BrowserWindow.getAllWindows(),
          getHomeWindows: () => requireAuxWindowService().listHomeWindows(),
          getSessionWindows: () => requireSessionWindowBridge().listWindows(),
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
          createWindow: (options) => {
            if (options.homeBounds) {
              return createBaseWindow({
                ...HOME_WINDOW_DEFAULT_BOUNDS,
                minWidth: options.minWidth,
                minHeight: options.minHeight,
                maxWidth: options.maxWidth,
                title: options.title,
                alwaysOnTop: options.alwaysOnTop,
              });
            }

            return createCursorPlacedWindow({
              width: options.width,
              height: options.height,
              minWidth: options.minWidth,
              minHeight: options.minHeight,
              maxWidth: options.maxWidth,
              title: options.title,
              alwaysOnTop: options.alwaysOnTop,
            });
          },
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
          onBeforeClose: () => {
            sessionApprovalService?.reset();
            sessionElicitationService?.reset();
            sessionObservabilityService?.dispose();
          },
          truncateWal: truncateAppDatabaseWal,
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
                openMemoryManagementWindow,
                openCharacterEditorWindow,
                openDiffWindow,
                pickDirectory: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickDirectory(targetWindow, initialPath),
                pickFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFile(targetWindow, initialPath),
                pickImageFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickImageFile(targetWindow, initialPath),
                openPathTarget,
                openAppLogFolder: () => openDirectory(appLogsPath),
                openCrashDumpFolder: () => openDirectory(crashDumpsPath),
                openSessionTerminal,
                logIpcError: writeIpcErrorLog,
                reportRendererLog: writeRendererLog,
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
                getMemoryManagementSnapshot: () => requireMemoryManagementService().getSnapshot(),
                getMemoryManagementPage: (request) => requireMemoryManagementService().getPage(request),
                deleteSessionMemory: (sessionId) => requireMemoryManagementService().deleteSessionMemory(sessionId),
                deleteProjectMemoryEntry: (entryId) => requireMemoryManagementService().deleteProjectMemoryEntry(entryId),
                deleteCharacterMemoryEntry: (entryId) =>
                  requireMemoryManagementService().deleteCharacterMemoryEntry(entryId),
              },
              sessionQuery: {
                listSessionSummaries: () => listSessionSummaries(),
                listSessionAuditLogs: (sessionId) => listSessionAuditLogs(sessionId),
                listSessionAuditLogSummaries: (sessionId) => listSessionAuditLogSummaries(sessionId),
                getSessionAuditLogDetail: (sessionId, auditLogId) => getSessionAuditLogDetail(sessionId, auditLogId),
                listSessionSkills: async (sessionId) => listSessionSkills(sessionId),
                listSessionCustomAgents: async (sessionId) => listSessionCustomAgents(sessionId),
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
                resolveLiveElicitation,
                createSession: (input) => requireMainSessionCommandFacade().createSession(input),
                updateSession: (session) => requireMainSessionCommandFacade().updateSession(session),
                deleteSession: (sessionId) => requireMainSessionCommandFacade().deleteSession(sessionId),
                runSessionTurn: (sessionId, request) => requireMainSessionCommandFacade().runSessionTurn(sessionId, request),
                cancelSessionRun: (sessionId) => requireMainSessionCommandFacade().cancelSessionRun(sessionId),
              },
              character: {
                listCharacters: async () => refreshCharactersFromStorage(),
                getCharacter,
                getCharacterUpdateWorkspace: (characterId) =>
                  requireMainCharacterFacade().getCharacterUpdateWorkspace(characterId),
                extractCharacterUpdateMemory: (characterId) =>
                  requireMainCharacterFacade().extractCharacterUpdateMemory(characterId),
                createCharacterUpdateSession: (characterId, providerId) =>
                  requireMainCharacterFacade().createCharacterUpdateSession(characterId, providerId),
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

function requireSessionStorage(): SessionStorageRead {
  if (!sessionStorage) {
    throw new Error("session storage が初期化されていないよ。");
  }

  return sessionStorage;
}

function requireSessionStorageForWrite(): SessionStorage {
  const storage = requireSessionStorage();
  if (isSessionStorageWritable(storage)) {
    return storage;
  }

  throw new Error("session storage は V2 DB の読み取り専用のため書き込み不可です。");
}

function isSessionStorageWritable(storage: SessionStorageRead): storage is SessionStorage {
  const candidate = storage as Partial<SessionStorage>;
  return (
    typeof candidate.upsertSession === "function" &&
    typeof candidate.replaceSessions === "function" &&
    typeof candidate.deleteSession === "function" &&
    typeof candidate.clearSessions === "function"
  );
}

function requireMainQueryService(): MainQueryService {
  if (!mainQueryService) {
    mainQueryService = new MainQueryService({
      getSessionSummaries: () => requireSessionStorage().listSessionSummaries(),
      getSession: (sessionId) => requireSessionStorage().getSession(sessionId),
      getCharacters: () => characters,
      getAuditLogs: (sessionId) => requireAuditLogStorage().listSessionAuditLogs(sessionId),
      getAuditLogSummaries: (sessionId) => requireAuditLogStorage().listSessionAuditLogSummaries(sessionId),
      getAuditLogDetail: (sessionId, auditLogId) => requireAuditLogStorage().getSessionAuditLogDetail(sessionId, auditLogId),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      discoverSessionSkills,
      discoverSessionCustomAgents,
      getStoredCharacter: (characterId) => requireCharacterRuntimeService().getCharacter(characterId),
      refreshCharactersFromStorage: () => requireCharacterRuntimeService().refreshCharactersFromStorage(),
      resolveComposerPreview,
      searchWorkspaceFiles: (workspacePath, query) => searchWorkspacePathCandidates(workspacePath, query),
      launchTerminalAtPath,
    });
  }

  return mainQueryService;
}

function requireMainBroadcastFacade(): MainBroadcastFacade<BrowserWindow> {
  if (!mainBroadcastFacade) {
    mainBroadcastFacade = new MainBroadcastFacade({
      getWindowBroadcastService: () => requireWindowBroadcastService(),
      listSessionSummaries: () => listSessionSummaries(),
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
      getCharacterUpdateWorkspaceService: () => requireCharacterUpdateWorkspaceService(),
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

function requireAuditLogStorage(): AuditLogStorageRead {
  if (!auditLogStorage) {
    throw new Error("audit log storage が初期化されていないよ。");
  }

  return auditLogStorage;
}

function requireAuditLogStorageForWrite(): AuditLogStorage {
  const storage = requireAuditLogStorage();
  if (isAuditLogStorageWritable(storage)) {
    return storage;
  }

  throw new Error("audit log storage は V2 DB の読み取り専用のため書き込み不可です。");
}

function isAuditLogStorageWritable(storage: AuditLogStorageRead): storage is AuditLogStorage {
  const candidate = storage as Partial<AuditLogStorage>;
  return (
    typeof candidate.createAuditLog === "function" &&
    typeof candidate.updateAuditLog === "function" &&
    typeof candidate.clearAuditLogs === "function"
  );
}

function requireAuditLogService(): AuditLogService {
  if (!auditLogService) {
    auditLogService = new AuditLogService(requireAuditLogStorageForWrite());
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
      getSessionMemory: (sessionId) => requireSessionMemoryStorage().getSessionMemory(sessionId),
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

function requireMemoryManagementService(): MemoryManagementService {
  if (!memoryManagementService) {
    memoryManagementService = new MemoryManagementService({
      listSessionSummaries: () => listSessionSummaries(),
      listSessionMemories: () => requireSessionMemoryStorage().listSessionMemories(),
      listSessionMemoryPage: (request) => requireSessionMemoryStorage().listSessionMemoryPage(request),
      deleteSessionMemory: (sessionId) => requireSessionMemoryStorage().deleteSessionMemory(sessionId),
      listProjectScopes: () => requireProjectMemoryStorage().listProjectScopes(),
      listProjectMemoryEntries: (projectScopeId) => requireProjectMemoryStorage().listProjectMemoryEntries(projectScopeId),
      listProjectMemoryPage: (request) => requireProjectMemoryStorage().listProjectMemoryPage(request),
      deleteProjectMemoryEntry: (entryId) => requireProjectMemoryStorage().deleteProjectMemoryEntry(entryId),
      listCharacterScopes: () => requireCharacterMemoryStorage().listCharacterScopes(),
      listCharacterMemoryEntries: (characterScopeId) =>
        requireCharacterMemoryStorage().listCharacterMemoryEntries(characterScopeId),
      listCharacterMemoryPage: (request) => requireCharacterMemoryStorage().listCharacterMemoryPage(request),
      deleteCharacterMemoryEntry: (entryId) => requireCharacterMemoryStorage().deleteCharacterMemoryEntry(entryId),
    });
  }

  return memoryManagementService;
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
      upsertStoredSession: (session) => requireSessionStorageForWrite().upsertSession(session),
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

function requireCharacterUpdateWorkspaceService(): CharacterUpdateWorkspaceService {
  if (!characterUpdateWorkspaceService) {
    characterUpdateWorkspaceService = new CharacterUpdateWorkspaceService({
      getCharacter: (characterId) => requireCharacterRuntimeService().getCharacter(characterId),
      getCharacterDirectoryPath: (characterId) => getStoredCharacterDirectoryPath(characterId),
      getCharacterScopeByCharacterId: (characterId) =>
        requireCharacterMemoryStorage().getCharacterScopeByCharacterId(characterId),
      listCharacterMemoryEntries: (characterScopeId) =>
        requireCharacterMemoryStorage().listCharacterMemoryEntries(characterScopeId),
      writeTextFile: async (filePath, content) => {
        await writeFile(filePath, content, "utf8");
      },
      createSession: (input) => requireMainSessionCommandFacade().createSession(input),
    });
  }

  return characterUpdateWorkspaceService;
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
      getProviderCodingAdapter,
      getSessionMemory: (session) => requireSessionMemoryStorage().ensureSessionMemory(session),
      resolveProjectMemoryEntriesForPrompt: (session, userMessage, sessionMemory) =>
        requireSessionMemorySupportService().resolveProjectMemoryEntriesForPrompt(session, userMessage, sessionMemory),
      createAuditLog: (entry) => requireAuditLogService().createAuditLog(entry),
      updateAuditLog: (id, entry) => requireAuditLogService().updateAuditLog(id, entry),
      setLiveSessionRun,
      getLiveSessionRun,
      waitForApprovalDecision: (sessionId, request, signal) =>
        waitForLiveApprovalDecision(sessionId, request, signal),
      waitForElicitationResponse: (sessionId, request, signal) =>
        waitForLiveElicitationResponse(sessionId, request, signal),
      setProviderQuotaTelemetry: (telemetry) => {
        setProviderQuotaTelemetry(telemetry.provider, telemetry);
      },
      setSessionContextTelemetry: (telemetry) => {
        setSessionContextTelemetry(telemetry.sessionId, telemetry);
      },
      invalidateProviderSessionThread,
      scheduleProviderQuotaTelemetryRefresh,
      clearWorkspaceFileIndex,
      broadcastLiveSessionRun,
      resolvePendingApprovalRequest: (sessionId, decision) => {
        const liveRun = getLiveSessionRun(sessionId);
        const requestId = liveRun?.approvalRequest?.requestId;
        if (requestId) {
          requireSessionApprovalService().resolveLiveApproval(sessionId, requestId, decision);
        }
      },
      resolvePendingElicitationRequest: (sessionId, response) => {
        const liveRun = getLiveSessionRun(sessionId);
        const requestId = liveRun?.elicitationRequest?.requestId;
        if (requestId) {
          requireSessionElicitationService().resolveLiveElicitation(sessionId, requestId, response);
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
      upsertStoredSession: (session) => requireSessionStorageForWrite().upsertSession(session),
      replaceStoredSessions: (nextSessions) => {
        requireSessionStorageForWrite().replaceSessions(nextSessions);
      },
      listStoredSessions: () => requireSessionStorage().listSessions(),
      deleteStoredSession: (sessionId) => requireSessionStorageForWrite().deleteSession(sessionId),
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
        createCursorPlacedWindow({
          ...SESSION_WINDOW_DEFAULT_BOUNDS,
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
      listSessions: listFullStoredSessions,
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
    copilotAdapter.setBackgroundTasksObserver((sessionId, tasks) => {
      const current = sessionObservabilityService?.getLiveSessionRun(sessionId) ?? null;
      if (current) {
        sessionObservabilityService?.setLiveSessionRun(sessionId, {
          ...current,
          backgroundTasks: tasks,
        });
        return;
      }

      if (tasks.length === 0) {
        return;
      }

      const threadId = sessions.find((session) => session.id === sessionId)?.threadId ?? "";
      sessionObservabilityService?.setLiveSessionRun(sessionId, {
        sessionId,
        threadId,
        assistantText: "",
        steps: [],
        backgroundTasks: tasks,
        usage: null,
        errorMessage: "",
        approvalRequest: null,
        elicitationRequest: null,
      });
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

function requireSessionElicitationService(): SessionElicitationService {
  if (!sessionElicitationService) {
    sessionElicitationService = new SessionElicitationService({
      updateLiveSessionRun: (sessionId, recipe) =>
        requireSessionObservabilityService().updateLiveSessionRun(sessionId, recipe),
    });
  }

  return sessionElicitationService;
}

function requireSessionMemoryStorage(): SessionMemoryStorageAccess {
  if (!sessionMemoryStorage) {
    throw new Error("session memory storage が初期化されていないよ。");
  }

  return sessionMemoryStorage;
}

function requireProjectMemoryStorage(): ProjectMemoryStorageAccess {
  if (!projectMemoryStorage) {
    throw new Error("project memory storage が初期化されていないよ。");
  }

  return projectMemoryStorage;
}

function requireCharacterMemoryStorage(): CharacterMemoryStorageAccess {
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
  for (const session of sessions) {
    requireSessionMemorySupportService().syncSessionDependencies(session);
  }
  return bundle.activeModelCatalog;
}

function startWalMaintenance(): void {
  stopWalMaintenance();
  walMaintenanceTimer = setInterval(() => {
    if (!dbPath) {
      return;
    }

    try {
      truncateAppDatabaseWalIfLargerThan(dbPath, undefined, {
        busyTimeoutMs: SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn("SQLite WAL maintenance failed", error);
    }
  }, WAL_MAINTENANCE_INTERVAL_MS);
  walMaintenanceTimer.unref?.();
}

function stopWalMaintenance(): void {
  if (!walMaintenanceTimer) {
    return;
  }

  clearInterval(walMaintenanceTimer);
  walMaintenanceTimer = null;
}

async function initializePersistentStores(): Promise<ModelCatalogSnapshot> {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  closePersistentStores();
  const bundle = await requirePersistentStoreLifecycleService().initialize(dbPath, bundledModelCatalogPath);
  const activeModelCatalog = applyPersistentStoreBundle(bundle);
  startWalMaintenance();
  return activeModelCatalog;
}

function closePersistentStores(): void {
  stopWalMaintenance();
  requirePersistentStoreLifecycleService().close({
    modelCatalogStorage,
    sessionStorage,
    sessionMemoryStorage,
    projectMemoryStorage,
    characterMemoryStorage,
    auditLogStorage,
    appSettingsStorage,
  }, dbPath);
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
  sessionElicitationService = null;
  sessionMemorySupportService = null;
  characterRuntimeService = null;
  characterUpdateWorkspaceService = null;
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

  stopWalMaintenance();
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
  sessionElicitationService = null;
  sessionMemorySupportService = null;
  characterRuntimeService = null;
  characterUpdateWorkspaceService = null;
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

  const activeModelCatalog = applyPersistentStoreBundle(bundle);
  startWalMaintenance();
  return activeModelCatalog;
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

function listSessionAuditLogSummaries(sessionId: string): AuditLogSummary[] {
  return requireMainQueryService().listSessionAuditLogSummaries(sessionId);
}

function getSessionAuditLogDetail(sessionId: string, auditLogId: number): AuditLogDetail | null {
  return requireMainQueryService().getSessionAuditLogDetail(sessionId, auditLogId);
}

async function listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]> {
  return requireMainQueryService().listSessionSkills(sessionId);
}

async function listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]> {
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

function broadcastSessions(sessionIds?: Iterable<string>): void {
  requireMainBroadcastFacade().broadcastSessions(sessionIds);
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

function resolveLiveElicitation(
  sessionId: string,
  requestId: string,
  response: LiveElicitationResponse,
): void {
  requireSessionElicitationService().resolveLiveElicitation(sessionId, requestId, response);
}

function waitForLiveElicitationResponse(
  sessionId: string,
  request: LiveElicitationRequest,
  signal: AbortSignal,
): Promise<LiveElicitationResponse> {
  return requireSessionElicitationService().waitForLiveElicitationResponse(sessionId, request, signal);
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

async function searchWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]> {
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

async function openMemoryManagementWindow(): Promise<BrowserWindow> {
  return requireMainWindowFacade().openMemoryManagementWindow();
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
  dbPath = resolveAppDatabasePath(app.getPath("userData"));
  writeAppLog({
    level: "info",
    kind: "app.ready",
    process: "main",
    message: "App ready",
    data: {
      userDataPath: app.getPath("userData"),
      logsPath: appLogsPath,
      crashDumpsPath,
    },
  });
  await requireMainBootstrapService().handleReady();

  if (process.env.WITHMATE_DEBUG_OPEN_SESSION_ID) {
    await openSessionWindow(process.env.WITHMATE_DEBUG_OPEN_SESSION_ID);
  }

  app.on("activate", async () => {
    await requireAppLifecycleService().handleActivate();
  });
});

app.on("window-all-closed", () => {
  requireAppLifecycleService().handleWindowAllClosed();
});

app.on("before-quit", (event) => {
  writeAppLog({
    level: "info",
    kind: "app.before-quit",
    process: "main",
    message: "App before quit",
  });
  requireAppLifecycleService().handleBeforeQuit(event);
});

app.on("will-quit", () => {
  writeAppLog({
    level: "info",
    kind: "app.will-quit",
    process: "main",
    message: "App will quit",
  });
});

