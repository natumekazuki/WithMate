import { spawn } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, screen, shell, Tray } from "electron";

import type { RendererLogInput } from "../src/app-log-types.js";
import { summarizeAuditLogDetailFragment } from "../src/audit-log-detail-metrics.js";
import {
  type AuditLogDetail,
  type AuditLogDetailFragment,
  type AuditLogDetailSection,
  type AuditLogEntry,
  type AuditLogOperationDetailFragment,
  type AuditLogSummary,
  type AuditLogSummaryPageRequest,
  type AuditLogSummaryPageResult,
  currentTimestampLabel,
  createDefaultSessionMemory,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveElicitationRequest,
  type LiveElicitationResponse,
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type RunSessionTurnRequest,
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionContextTelemetry,
} from "../src/app-state.js";
import {
  type DiffPreviewPayload,
  type MessageArtifact,
  projectSessionSummary,
  type Session,
  type SessionSummary,
} from "../src/session-state.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "../src/character/character-authoring.js";
import {
  type ModelCatalogDocument,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import type {
  OpenPathOptions,
  SavePastedSessionFileRequest,
} from "../src/withmate-window-types.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogService } from "./audit-log-service.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { resolveAuxiliaryParentSession } from "./auxiliary-parent-session.js";
import { AuxiliarySessionService } from "./auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "./auxiliary-session-storage.js";
import { CharacterService } from "./character-service.js";
import { CharacterStorage } from "./character-storage.js";
import {
  CharacterAuthoringService,
  CHARACTER_AUTHORING_SKILL_NAME,
} from "./character-authoring-service.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CopilotAdapter } from "./copilot-adapter.js";
import { resolveComposerPreview } from "./composer-attachments.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import {
  buildDirectoryOpenFallbackCommand,
  resolveProtocolRelativeExternalFallback,
  resolveOpenPathTarget,
} from "./open-path.js";
import { launchTerminalAtPath } from "./open-terminal.js";
import { SessionStorage } from "./session-storage.js";
import { SessionMemoryStorage } from "./session-memory-storage.js";
import { ProjectMemoryStorage } from "./project-memory-storage.js";
import { CompanionReviewService } from "./companion-review-service.js";
import { CompanionRuntimeService } from "./companion-runtime-service.js";
import { CompanionSessionService } from "./companion-session-service.js";
import { CompanionAuditLogStorage } from "./companion-audit-log-storage.js";
import { CompanionAuditLogStorageV3 } from "./companion-audit-log-storage-v3.js";
import { CompanionStorage } from "./companion-storage.js";
import { CompanionStorageV3 } from "./companion-storage-v3.js";
import { SessionRuntimeService } from "./session-runtime-service.js";
import { SessionPersistenceService } from "./session-persistence-service.js";
import { SessionWindowBridge } from "./session-window-bridge.js";
import { SettingsCatalogService } from "./settings-catalog-service.js";
import { SessionObservabilityService } from "./session-observability-service.js";
import { SessionApprovalService } from "./session-approval-service.js";
import { SessionElicitationService } from "./session-elicitation-service.js";
import { WindowBroadcastService } from "./window-broadcast-service.js";
import { WindowDialogService } from "./window-dialog-service.js";
import { SessionMemorySupportService } from "./session-memory-support-service.js";
import {
  appendSessionFilesDirectory,
  appendSessionFilesDirectoryForSessionId,
  copyFilesToSessionFiles as copyFilesToSessionFilesStorage,
  deleteSessionFilesDirectory,
  resolveSessionFilesDirectory,
  saveSessionFile,
} from "./session-files.js";
import { MateStorage } from "./mate-storage.js";
import { MateProfileItemStorage } from "./mate-profile-item-storage.js";
import { WindowEntryLoader } from "./window-entry-loader.js";
import { AuxWindowService } from "./aux-window-service.js";
import { registerMainIpcHandlers } from "./main-ipc-registration.js";
import {
  PersistentStoreLifecycleService,
  type AuditLogStorageRead,
  type AuxiliarySessionStorageAccess,
  type CharacterStorageAccess,
  type PersistentStoreBundle,
  type ProjectMemoryStorageAccess,
  type SessionMemoryStorageAccess,
  type SessionStorageRead,
} from "./persistent-store-lifecycle-service.js";
import { AppLifecycleService } from "./app-lifecycle-service.js";
import { createAppLifecycleDeps } from "./app-lifecycle-deps.js";
import { applyLaunchAtLoginSetting, shouldLaunchInBackground } from "./app-login-item.js";
import { AppTrayService } from "./app-tray-service.js";
import { createMainBootstrapDeps } from "./main-bootstrap-deps.js";
import { MainInfrastructureRegistry } from "./main-infrastructure-registry.js";
import { MainBootstrapService } from "./main-bootstrap-service.js";
import { MainBroadcastFacade } from "./main-broadcast-facade.js";
import { MainObservabilityFacade } from "./main-observability-facade.js";
import { MainProviderFacade } from "./main-provider-facade.js";
import { MainSessionCommandFacade } from "./main-session-command-facade.js";
import { MainSessionPersistenceFacade } from "./main-session-persistence-facade.js";
import { MainWindowFacade } from "./main-window-facade.js";
import { MainQueryService } from "./main-query-service.js";
import {
  ManagedMemorySkillService,
  type ManagedMemorySkillSyncResult,
  WITHMATE_MEMORY_SKILL_NAME,
} from "./managed-memory-skill-service.js";
import { MemoryCliShimService } from "./memory-cli-shim-service.js";
import { hydrateSessionsFromSummaries } from "./session-summary-adapter.js";
import {
  resolveProviderSkillRootPath,
  type AppSettings,
} from "../src/provider-settings-state.js";
import { discoverSessionSkills } from "./skill-discovery.js";
import { discoverSessionCustomAgents } from "./custom-agent-discovery.js";
import { HOME_WINDOW_DEFAULT_BOUNDS, SESSION_WINDOW_DEFAULT_BOUNDS } from "./window-defaults.js";
import { resolveCursorAnchoredPosition } from "./window-placement.js";
import { AppLogService } from "./app-log-service.js";
import type { AppBootStatus } from "../src/app-boot-state.js";
import type { AppDatabaseDiagnostics } from "../src/app-database-diagnostics-state.js";
import type {
  MemoryV6DiagnosticEvent,
  MemoryV6Diagnostics,
} from "../src/memory-v6/memory-diagnostics-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest } from "../src/memory-v6/memory-contract.js";
import { inspectAppDatabase } from "./app-database-diagnostics.js";
import { resolveOrMigrateAppDatabasePath } from "./app-database-path.js";
import {
  startMemoryV6RuntimeApi,
  type MemoryV6RuntimeApiHandle,
} from "./memory-v6-runtime.js";
import { MemoryV6ReviewService } from "./memory-v6-review-service.js";
import { getProviderRuntimeCapabilities } from "./provider-support.js";
import {
  WITHMATE_APP_BOOT_STATUS_EVENT,
  WITHMATE_GET_APP_BOOT_STATUS_CHANNEL,
} from "../src/withmate-ipc-channels.js";
import { CREATE_V2_SCHEMA_SQL } from "./database-schema-v2.js";
import { CREATE_V3_SCHEMA_SQL, isValidV3Database } from "./database-schema-v3.js";
import { isValidV4Database } from "./database-schema-v4.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import {
  openAppDatabase,
  SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
  truncateAppDatabaseWal,
  truncateAppDatabaseWalIfLargerThan,
} from "./sqlite-connection.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "preload.js");
const rendererDistPath = path.resolve(currentDir, "../../dist");
const appDataPath = app.getPath("appData");
const userDataPathOverride = process.env.WITHMATE_USER_DATA_PATH?.trim();
const fixedUserDataPath = userDataPathOverride ? path.resolve(userDataPathOverride) : path.join(appDataPath, "WithMate");
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
const bundledCharacterAuthoringSkillPath = app.isPackaged
  ? path.join(process.resourcesPath, "resources", "skills", CHARACTER_AUTHORING_SKILL_NAME)
  : path.resolve(currentDir, "../../resources/skills", CHARACTER_AUTHORING_SKILL_NAME);
const bundledMemorySkillPath = app.isPackaged
  ? path.join(process.resourcesPath, "resources", "skills", WITHMATE_MEMORY_SKILL_NAME)
  : path.resolve(currentDir, "../../resources/skills", WITHMATE_MEMORY_SKILL_NAME);
const trayIconPath = path.resolve(currentDir, "../../build/icon.ico");
const codexAdapter = new CodexAdapter((input) => writeAppLog({
  ...input,
  process: "main",
}));
const copilotAdapter = new CopilotAdapter({
  log: (input) => writeAppLog({
    ...input,
    process: "main",
  }),
});
const WAL_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

let sessions: Session[] = [];
let sessionStorage: SessionStorageRead | null = null;
let sessionMemoryStorage: SessionMemoryStorageAccess | null = null;
let projectMemoryStorage: ProjectMemoryStorageAccess | null = null;
let modelCatalogStorage: ModelCatalogStorage | null = null;
let characterStorage: CharacterStorageAccess | null = null;
let characterService: CharacterService | null = null;
let characterAuthoringService: CharacterAuthoringService | null = null;
let managedMemorySkillService: ManagedMemorySkillService | null = null;
let memoryCliShimService: MemoryCliShimService | null = null;
let auditLogStorage: AuditLogStorageRead | null = null;
let auxiliarySessionStorage: AuxiliarySessionStorageAccess | null = null;
let appSettingsStorage: AppSettingsStorage | null = null;
let mateStorage: MateStorage | null = null;
let mateProfileItemStorage: MateProfileItemStorage | null = null;
type CompanionStorageHandle = CompanionStorage | CompanionStorageV3;

let companionStorage: CompanionStorageHandle | null = null;
let allowQuitWithInFlightRuns = false;
let dbPath = "";
let appDatabaseDiagnostics: AppDatabaseDiagnostics | null = null;
let memoryV6RuntimeApi: MemoryV6RuntimeApiHandle | null = null;
let memoryV6RuntimeStatus: MemoryV6Diagnostics["runtime"]["status"] = "stopped";
const isBackgroundLaunch = shouldLaunchInBackground(process.argv);
let managedMemorySkillSyncResults: ManagedMemorySkillSyncResult[] = [];
let memoryV6DiagnosticErrors: MemoryV6DiagnosticEvent[] = [];
let bootWindow: BrowserWindow | null = null;
let appBootStatus: AppBootStatus = {
  kind: "running",
  stage: "starting",
  title: "WithMate を起動しています",
  detail: "起動状態を確認しています。",
};
const hasSingleInstanceLock = app.requestSingleInstanceLock();

ipcMain.handle(WITHMATE_GET_APP_BOOT_STATUS_CHANNEL, () => appBootStatus);
const PROVIDER_QUOTA_STALE_TTL_MS = 5 * 60 * 1000;
let sessionRuntimeService: SessionRuntimeService | null = null;
let auxiliarySessionService: AuxiliarySessionService | null = null;
let auxiliarySessionRuntimeService: SessionRuntimeService | null = null;
let sessionPersistenceService: SessionPersistenceService | null = null;
let sessionWindowBridge: SessionWindowBridge<BrowserWindow> | null = null;
let settingsCatalogService: SettingsCatalogService | null = null;
let sessionObservabilityService: SessionObservabilityService | null = null;
let sessionApprovalService: SessionApprovalService | null = null;
let sessionElicitationService: SessionElicitationService | null = null;
let auditLogService: AuditLogService | null = null;
let sessionMemorySupportService: SessionMemorySupportService | null = null;
let companionSessionService: CompanionSessionService | null = null;
let companionAuditLogStorage: CompanionAuditLogStorage | CompanionAuditLogStorageV3 | null = null;
let companionAuditLogService: AuditLogService | null = null;
let companionRuntimeService: CompanionRuntimeService | null = null;
let companionReviewService: CompanionReviewService | null = null;
let mainBroadcastFacade: MainBroadcastFacade<BrowserWindow> | null = null;
let mainObservabilityFacade: MainObservabilityFacade | null = null;
let mainProviderFacade: MainProviderFacade | null = null;
let mainSessionCommandFacade: MainSessionCommandFacade | null = null;
let mainSessionPersistenceFacade: MainSessionPersistenceFacade | null = null;
let mainWindowFacade: MainWindowFacade | null = null;
let mainQueryService: MainQueryService | null = null;
let appTrayService: AppTrayService | null = null;
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

function getAppDatabaseDiagnostics(): AppDatabaseDiagnostics {
  if (!appDatabaseDiagnostics) {
    if (!dbPath) {
      throw new Error("DB path が初期化されていないよ。");
    }
    appDatabaseDiagnostics = inspectAppDatabase(app.getPath("userData"), dbPath, Boolean(userDataPathOverride));
  }
  return appDatabaseDiagnostics;
}

function recordMemoryV6DiagnosticError(kind: string, message: string): void {
  memoryV6DiagnosticErrors = [
    {
      kind,
      message,
      occurredAt: new Date().toISOString(),
    },
    ...memoryV6DiagnosticErrors,
  ].slice(0, 3);
}

function getConfiguredProviderSettings(): AppSettings["codingProviderSettings"] {
  try {
    return requireAppSettingsStorage().getSettings().codingProviderSettings;
  } catch {
    return {};
  }
}

async function getMemoryV6Diagnostics(): Promise<MemoryV6Diagnostics> {
  const configuredProviderSettings = getConfiguredProviderSettings();
  const configuredProviderIds = Object.keys(configuredProviderSettings).sort();
  const latestSkillResultByProvider = new Map(
    managedMemorySkillSyncResults.map((result) => [result.providerId, result]),
  );

  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      status: memoryV6RuntimeApi ? "running" : memoryV6RuntimeStatus,
      baseUrl: memoryV6RuntimeApi?.baseUrl ?? null,
      dbPath: memoryV6RuntimeApi?.dbPath ?? null,
      discoveryFilePath: memoryV6RuntimeApi?.discoveryFilePath ?? null,
      hasApiSecret: Boolean(memoryV6RuntimeApi),
    },
    providers: configuredProviderIds.map((providerId) => {
      const capabilities = getProviderRuntimeCapabilities({ providerId });
      return {
        providerId,
        providerSupported: capabilities.providerSupported,
      };
    }),
    skillSync: configuredProviderIds.map((providerId) => {
      const result = latestSkillResultByProvider.get(providerId);
      const configuredSkillRootPath = resolveProviderSkillRootPath(configuredProviderSettings[providerId]);
      return {
        providerId,
        skillRootConfigured: Boolean(result?.skillRootPath ?? configuredSkillRootPath.trim()),
        skillPath: result?.skillPath ?? null,
        status: result?.status ?? "not-run",
        ...(result?.errorMessage ? { errorMessage: result.errorMessage } : {}),
      };
    }),
    cliShim: await requireMemoryCliShimService().getDiagnostics(),
    lastErrors: memoryV6DiagnosticErrors,
  };
}

async function installMemoryV6CliShim(): Promise<MemoryV6Diagnostics> {
  await requireMemoryCliShimService().install();
  await syncManagedMemorySkillBestEffort();
  return getMemoryV6Diagnostics();
}

async function uninstallMemoryV6CliShim(): Promise<MemoryV6Diagnostics> {
  await requireMemoryCliShimService().uninstall();
  await syncManagedMemorySkillBestEffort();
  return getMemoryV6Diagnostics();
}

function createMemoryV6ReviewService(): MemoryV6ReviewService {
  return new MemoryV6ReviewService({
    resolveDbPath: () => memoryV6RuntimeApi?.dbPath ?? null,
  });
}

function searchMemoryV6Entries(request: MemoryV6ReviewSearchRequest | null | undefined) {
  return createMemoryV6ReviewService().searchEntries(request);
}

function getMemoryV6Entry(entryId: string) {
  return createMemoryV6ReviewService().getEntry(entryId);
}

function forgetMemoryV6Entry(entryId: string, reason?: MemoryForgetReason | null) {
  return createMemoryV6ReviewService().forgetEntry(entryId, reason);
}

async function startMemoryV6RuntimeApiBestEffort(): Promise<void> {
  if (memoryV6RuntimeApi) {
    return;
  }

  try {
    memoryV6RuntimeStatus = "stopped";
    memoryV6RuntimeApi = await startMemoryV6RuntimeApi({
      userDataPath: app.getPath("userData"),
      listCharacters: () => requireCharacterService().listCharacters(),
      log: writeAppLog,
    });
    memoryV6RuntimeStatus = "running";
    appDatabaseDiagnostics = inspectAppDatabase(app.getPath("userData"), dbPath, Boolean(userDataPathOverride));
  } catch (error) {
    memoryV6RuntimeStatus = "failed";
    recordMemoryV6DiagnosticError(
      "memory-v6.runtime-api.start-failed",
      error instanceof Error ? error.message : String(error),
    );
    writeAppLog({
      level: "warn",
      kind: "memory-v6.runtime-api.start-failed",
      process: "main",
      message: "Memory V6 runtime API did not start",
      error: appLogService.errorToLogError(error),
    });
  }
}

async function stopMemoryV6RuntimeApiBestEffort(): Promise<void> {
  const runtimeApi = memoryV6RuntimeApi;
  memoryV6RuntimeApi = null;
  memoryV6RuntimeStatus = "stopped";
  if (!runtimeApi) {
    return;
  }

  try {
    await runtimeApi.stop();
    writeAppLog({
      level: "info",
      kind: "memory-v6.runtime-api.stopped",
      process: "main",
      message: "Memory V6 runtime API stopped",
    });
  } catch (error) {
    recordMemoryV6DiagnosticError(
      "memory-v6.runtime-api.stop-failed",
      error instanceof Error ? error.message : String(error),
    );
    writeAppLog({
      level: "warn",
      kind: "memory-v6.runtime-api.stop-failed",
      process: "main",
      message: "Memory V6 runtime API cleanup failed",
      error: appLogService.errorToLogError(error),
    });
  }
}

async function syncManagedMemorySkillBestEffort(): Promise<void> {
  try {
    const results = await requireManagedMemorySkillService().syncConfiguredProviderSkills();
    managedMemorySkillSyncResults = results;
    const failed = results.filter((result) => result.status === "failed");
    const collisions = results.filter((result) => result.status === "skipped-collision");
    for (const result of failed) {
      recordMemoryV6DiagnosticError(
        "memory-v6.skill.sync.provider-failed",
        `${result.providerId}: ${result.errorMessage ?? "managed skill sync failed"}`,
      );
    }
    writeAppLog({
      level: failed.length > 0 || collisions.length > 0 ? "warn" : "info",
      kind: "memory-v6.skill.sync.completed",
      process: "main",
      message: "Memory V6 managed skill sync completed",
      data: {
        results,
      },
    });
  } catch (error) {
    recordMemoryV6DiagnosticError(
      "memory-v6.skill.sync.failed",
      error instanceof Error ? error.message : String(error),
    );
    writeAppLog({
      level: "warn",
      kind: "memory-v6.skill.sync.failed",
      process: "main",
      message: "Memory V6 managed skill sync failed",
      error: appLogService.errorToLogError(error),
    });
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
  await openLocalPath(directoryPath);
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

function requireAppTrayService(): AppTrayService {
  if (!appTrayService) {
    appTrayService = new AppTrayService({
      platform: process.platform,
      iconPath: trayIconPath,
      createTray: (iconPath) => new Tray(iconPath),
      buildMenu: (items) => Menu.buildFromTemplate(items),
      openHomeWindow: createHomeWindow,
      quitApp: () => {
        app.quit();
      },
    });
  }
  return appTrayService;
}

function publishAppBootStatus(status: AppBootStatus): void {
  appBootStatus = status;
  if (bootWindow && !bootWindow.isDestroyed()) {
    bootWindow.webContents.send(WITHMATE_APP_BOOT_STATUS_EVENT, status);
  }
}

async function openBootWindow(): Promise<BrowserWindow> {
  if (bootWindow && !bootWindow.isDestroyed()) {
    return bootWindow;
  }

  const window = createBaseWindow({
    width: 560,
    height: 520,
    minWidth: 460,
    minHeight: 420,
    title: "WithMate 起動中",
    resizable: true,
  });
  bootWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (bootWindow === window) {
      bootWindow = null;
    }
  });
  await requireWindowEntryLoader().loadBootEntry(window);
  publishAppBootStatus(appBootStatus);
  return window;
}

function closeBootWindow(): void {
  if (!bootWindow || bootWindow.isDestroyed()) {
    bootWindow = null;
    return;
  }
  const window = bootWindow;
  bootWindow = null;
  window.close();
}

function serializeBootError(error: unknown): AppBootStatus["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: typeof error === "string" ? error : "Unknown startup error",
  };
}

function listSessions(): Session[] {
  return sessions;
}

function listSessionSummaries(): SessionSummary[] {
  return sessions.map(projectSessionSummary);
}

async function listCompanionSessionSummaries() {
  return await requireCompanionStorage().listSessionSummaries();
}

async function listFullStoredSessions(): Promise<Session[]> {
  const storage = requireSessionStorage();
  const summaries = await storage.listSessionSummaries();
  const hydrated = await Promise.all(summaries.map((summary) => storage.getSession(summary.id)));
  return hydrated.filter((session): session is Session => session !== null);
}

function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

function hasInFlightSessionRuns(): boolean {
  return requireSessionRuntimeService().hasInFlightRuns()
    || requireCompanionRuntimeService().hasInFlightRuns()
    || requireAuxiliarySessionRuntimeService().hasInFlightRuns();
}

function isSessionRunInFlight(sessionId: string): boolean {
  if (requireSessionRuntimeService().isRunInFlight(sessionId)) {
    return true;
  }
  if (!auxiliarySessionStorage) {
    return false;
  }

  const activeAuxiliarySession = requireAuxiliarySessionService().getActiveAuxiliarySession(sessionId);
  return activeAuxiliarySession
    ? requireAuxiliarySessionRuntimeService().isRunInFlight(activeAuxiliarySession.id)
    : false;
}

function listRunningActiveAuxiliaryParentSessionIds(parentSessionIds: readonly string[]): Set<string> {
  const runningParentSessionIds = new Set<string>();
  if (!auxiliarySessionStorage) {
    return runningParentSessionIds;
  }

  for (const parentSessionId of parentSessionIds) {
    const activeAuxiliarySession = requireAuxiliarySessionService().getActiveAuxiliarySession(parentSessionId);
    if (activeAuxiliarySession && requireAuxiliarySessionRuntimeService().isRunInFlight(activeAuxiliarySession.id)) {
      runningParentSessionIds.add(parentSessionId);
    }
  }

  return runningParentSessionIds;
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
          loadDiffEntry: (window, token) => requireWindowEntryLoader().loadDiffEntry(window, token),
          loadChatEntry: (window, mode) => requireWindowEntryLoader().loadChatEntry(window, mode),
          loadCompanionMergeReviewEntry: (window, sessionId) =>
            requireWindowEntryLoader().loadCompanionMergeReviewEntry(window, sessionId),
          loadCharacterEditorEntry: (window, characterId) =>
            requireWindowEntryLoader().loadCharacterEditorEntry(window, characterId),
          generateDiffToken: () => crypto.randomUUID(),
          onCompanionReviewWindowsChanged: () => broadcastOpenCompanionReviewWindowIds(),
        }),
      createPersistentStoreLifecycleService: () =>
        new PersistentStoreLifecycleService({
          createModelCatalogStorage: (nextDbPath, nextBundledModelCatalogPath) =>
            new ModelCatalogStorage(nextDbPath, nextBundledModelCatalogPath),
          createCharacterStorage: (nextDbPath, nextUserDataPath) =>
            new CharacterStorage(nextDbPath, nextUserDataPath),
          createSessionStorage: (nextDbPath) => new SessionStorage(nextDbPath),
          createSessionMemoryStorage: (nextDbPath) => new SessionMemoryStorage(nextDbPath),
          createProjectMemoryStorage: (nextDbPath) => new ProjectMemoryStorage(nextDbPath),
          createAuditLogStorage: (nextDbPath) => new AuditLogStorage(nextDbPath),
          createAuxiliarySessionStorage: (nextDbPath) => new AuxiliarySessionStorage(nextDbPath),
          createAppSettingsStorage: (nextDbPath) => new AppSettingsStorage(nextDbPath),
          createMateStorage: (nextDbPath, nextUserDataPath) => new MateStorage(nextDbPath, nextUserDataPath),
          ensureV2Schema: (nextDbPath) => {
            const db = openAppDatabase(nextDbPath);
            try {
              for (const statement of CREATE_V2_SCHEMA_SQL) {
                db.exec(statement);
              }
            } finally {
              db.close();
            }
          },
          ensureV3Schema: (nextDbPath) => {
            const db = openAppDatabase(nextDbPath);
            try {
              for (const statement of CREATE_V3_SCHEMA_SQL) {
                db.exec(statement);
              }
            } finally {
              db.close();
            }
          },
          ensureV6Schema: (nextDbPath) => {
            const db = openAppDatabase(nextDbPath);
            try {
              ensureV6Schema(db);
            } finally {
              db.close();
            }
          },
          onBeforeClose: () => {
            sessionApprovalService?.reset();
            sessionElicitationService?.reset();
            sessionObservabilityService?.dispose();
          },
          truncateWal: truncateAppDatabaseWal,
          async removeFile(filePath) {
            await rm(filePath, { force: true });
          },
          async removeDirectory(directoryPath) {
            await rm(directoryPath, { recursive: true, force: true });
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
            shouldQuitWhenAllWindowsClosed: () => false,
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
            recoverInterruptedSessions,
            createHomeWindow: async () => {
              if (isBackgroundLaunch) {
                return null;
              }
              return createHomeWindow();
            },
            broadcastModelCatalog,
            onBootStatus: publishAppBootStatus,
            ipcRegistration: {
              window: {
                resolveEventWindow: (event) => BrowserWindow.fromWebContents(event.sender) ?? null,
                resolveHomeWindow: () => requireAuxWindowService().getHomeWindow(),
                resolveSessionWindow: (sessionId) => requireSessionWindowBridge().getWindow(sessionId),
                resolveCompanionReviewWindow: (sessionId) =>
                  requireMainWindowFacade().getCompanionReviewWindow(sessionId),
                openSessionWindow,
                openHomeWindow: createHomeWindow,
                openSessionMonitorWindow,
                openSettingsWindow,
                openMemoryV6ReviewWindow,
                isSettingsWindow: (window) => requireMainWindowFacade().isSettingsWindow(window),
                isMemoryV6ReviewWindow: (window) => requireMainWindowFacade().isMemoryV6ReviewWindow(window),
                openCharacterEditorWindow,
                openDiffWindow,
                openCompanionReviewWindow,
                openCompanionMergeWindow,
                pickDirectory: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickDirectory(targetWindow, initialPath),
                pickFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFile(targetWindow, initialPath),
                pickFiles: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFiles(targetWindow, initialPath),
                pickSessionFiles,
                pickSessionFolder,
                pickSessionImageFile,
                pickImageFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickImageFile(targetWindow, initialPath),
                copyFilesToSessionFiles,
                savePastedSessionFile,
                openSessionFilesDirectory,
                openSessionFilesTerminal,
                openPathTarget,
                openAppLogFolder: () => openDirectory(appLogsPath),
                openCrashDumpFolder: () => openDirectory(crashDumpsPath),
                openSessionTerminal,
                openTerminalAtPath: launchTerminalAtPath,
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
                getAppDatabaseDiagnostics,
                getMemoryV6Diagnostics,
                installMemoryV6CliShim,
                uninstallMemoryV6CliShim,
                searchMemoryV6Entries,
                getMemoryV6Entry,
                forgetMemoryV6Entry,
                resetAppDatabase: async (request) => requireSettingsCatalogService().resetAppDatabase(request),
              },
              sessionQuery: {
                listSessionSummaries: () => listSessionSummaries(),
                listCompanionSessionSummaries: () => listCompanionSessionSummaries(),
                listSessionAuditLogs: (sessionId) => listSessionAuditLogs(sessionId),
                listSessionAuditLogSummaries: (sessionId) => listSessionAuditLogSummaries(sessionId),
                listSessionAuditLogSummaryPage: (sessionId, request) =>
                  listSessionAuditLogSummaryPage(sessionId, request),
                getSessionAuditLogDetail: (sessionId, auditLogId) => getSessionAuditLogDetail(sessionId, auditLogId),
                getSessionAuditLogDetailSection: (sessionId, auditLogId, section) =>
                  getSessionAuditLogDetailSection(sessionId, auditLogId, section),
                getSessionAuditLogOperationDetail: (sessionId, auditLogId, operationIndex) =>
                  getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex),
                listCompanionAuditLogs: (sessionId) => listCompanionAuditLogs(sessionId),
                listCompanionAuditLogSummaries: (sessionId) => listCompanionAuditLogSummaries(sessionId),
                listCompanionAuditLogSummaryPage: (sessionId, request) =>
                  listCompanionAuditLogSummaryPage(sessionId, request),
                getCompanionAuditLogDetail: (sessionId, auditLogId) => getCompanionAuditLogDetail(sessionId, auditLogId),
                getCompanionAuditLogDetailSection: (sessionId, auditLogId, section) =>
                  getCompanionAuditLogDetailSection(sessionId, auditLogId, section),
                getCompanionAuditLogOperationDetail: (sessionId, auditLogId, operationIndex) =>
                  getCompanionAuditLogOperationDetail(sessionId, auditLogId, operationIndex),
                listSessionSkills: async (sessionId) => listSessionSkills(sessionId),
                listSessionCustomAgents: async (sessionId) => listSessionCustomAgents(sessionId),
                listWorkspaceSkills: async (providerId, workspacePath) =>
                  requireMainQueryService().listWorkspaceSkills(providerId, workspacePath),
                listWorkspaceCustomAgents: async (providerId, workspacePath) =>
                  requireMainQueryService().listWorkspaceCustomAgents(providerId, workspacePath),
                listOpenSessionWindowIds: () => listOpenSessionWindowIds(),
                listOpenCompanionReviewWindowIds: () => listOpenCompanionReviewWindowIds(),
                getSession: (sessionId) => getDisplaySession(sessionId),
                getSessionMessageArtifact,
                getDiffPreview: (token) => requireAuxWindowService().getDiffPreview(token),
                previewComposerInput,
              },
              auxiliary: {
                listAuxiliarySessions: (parentSessionId) =>
                  requireAuxiliarySessionService().listAuxiliarySessions(parentSessionId),
                getActiveAuxiliarySession: (parentSessionId) =>
                  requireAuxiliarySessionService().getActiveAuxiliarySession(parentSessionId),
                getAuxiliarySession: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId),
                createAuxiliarySession: (input) =>
                  requireAuxiliarySessionService().createAuxiliarySession(input),
                updateAuxiliarySession: (session) =>
                  requireAuxiliarySessionService().updateAuxiliarySession(session),
                closeAuxiliarySession: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().closeAuxiliarySession(auxiliarySessionId),
                runAuxiliarySessionTurn: async (auxiliarySessionId, request) => {
                  await requireAuxiliarySessionRuntimeService().runSessionTurn(auxiliarySessionId, request);
                  const session = requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId);
                  if (!session) {
                    throw new Error("Auxiliary Session が見つからないよ。");
                  }
                  return session;
                },
                cancelAuxiliarySessionRun: (auxiliarySessionId) =>
                  requireAuxiliarySessionRuntimeService().cancelRun(auxiliarySessionId),
              },
              companion: {
                createCompanionSession: async (input) => {
                  writeAppLog({
                    level: "info",
                    kind: "companion.session.create.started",
                    process: "main",
                    message: "Companion session creation started",
                    data: {
                      taskTitle: input.taskTitle,
                      workspacePath: input.workspacePath,
                      provider: input.provider,
                    },
                  });
                  const session = await requireCompanionSessionService().createSession(input);
                  writeAppLog({
                    level: "info",
                    kind: "companion.session.create.completed",
                    process: "main",
                    message: "Companion session creation completed",
                    data: {
                      sessionId: session.id,
                      repoRoot: session.repoRoot,
                      worktreePath: session.worktreePath,
                    },
                  });
                  broadcastCompanionSessions();
                  return session;
                },
                getCompanionSession: (sessionId) => requireCompanionStorage().getSession(sessionId),
                getCompanionMessageArtifact,
                getCompanionReviewSnapshot: (sessionId) => requireCompanionReviewService().getReviewSnapshot(sessionId),
                mergeCompanionSelectedFiles: async (request) => {
                  const result = await requireCompanionReviewService().mergeSelectedFiles(request.sessionId, request.selectedPaths);
                  broadcastCompanionSessions();
                  return result;
                },
                syncCompanionTarget: async (sessionId) => {
                  const result = await requireCompanionReviewService().syncTarget(sessionId);
                  broadcastCompanionSessions();
                  return result;
                },
                stashCompanionTargetChanges: async (sessionId) => {
                  const result = await requireCompanionReviewService().stashTargetChanges(sessionId);
                  broadcastCompanionSessions();
                  return result;
                },
                restoreCompanionTargetStash: async (sessionId) => {
                  const result = await requireCompanionReviewService().restoreTargetChanges(sessionId);
                  broadcastCompanionSessions();
                  return result;
                },
                dropCompanionTargetStash: async (sessionId) => {
                  const result = await requireCompanionReviewService().dropTargetStash(sessionId);
                  broadcastCompanionSessions();
                  return result;
                },
                updateCompanionSession: async (session) => {
                  const saved = await requireCompanionStorage().updateSession(session);
                  void broadcastCompanionSessions();
                  return saved;
                },
                previewCompanionComposerInput: (sessionId, userMessage) =>
                  requireCompanionRuntimeService().previewComposerInput(sessionId, userMessage),
                discardCompanionSession: async (sessionId) => {
                  const session = await requireCompanionReviewService().discardSession(sessionId);
                  await cleanupSessionFilesDirectory(sessionId);
                  broadcastCompanionSessions();
                  return session;
                },
                runCompanionSessionTurn: (sessionId, request) =>
                  requireCompanionRuntimeService().runSessionTurn(sessionId, request),
                cancelCompanionSessionRun: (sessionId) => requireCompanionRuntimeService().cancelRun(sessionId),
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
                deleteSessionsLastActiveBefore: (request) =>
                  requireMainSessionCommandFacade().deleteSessionsLastActiveBefore(request),
                runSessionTurn: (sessionId, request) => requireMainSessionCommandFacade().runSessionTurn(sessionId, request),
                cancelSessionRun: (sessionId) => requireMainSessionCommandFacade().cancelSessionRun(sessionId),
              },
              mate: {
                getMateState: () => requireMateStorage().getMateState(),
                getMateProfile: () => requireMateStorage().getMateProfile(),
                createMate,
                updateMate,
                setMateAvatar,
                resetMate,
              },
              character: {
                listCharacters: (options) => requireCharacterService().listCharacters(options ?? undefined),
                getCharacter: (characterId) => requireCharacterService().getCharacter(characterId),
                createCharacter: (input) => requireCharacterService().createCharacter(input),
                updateCharacterMetadata: (input) => requireCharacterService().updateCharacterMetadata(input),
                updateCharacterDefinition: (input) => requireCharacterService().updateCharacterDefinition(input),
                archiveCharacter: (characterId) => requireCharacterService().archiveCharacter(characterId),
                setDefaultCharacter: (characterId) => requireCharacterService().setDefaultCharacter(characterId),
                resolveLaunchCharacter: (input) => requireCharacterService().resolveLaunchCharacter(input),
                startCharacterAuthoringSession,
              },
            },
            getMateState: () => requireMateStorage().getMateState(),
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
    typeof candidate.deleteSessions === "function" &&
    typeof candidate.clearSessions === "function"
  );
}

function requireMainQueryService(): MainQueryService {
  if (!mainQueryService) {
    mainQueryService = new MainQueryService({
      getSessionSummaries: () => requireSessionStorage().listSessionSummaries(),
      getSession: (sessionId) => requireSessionStorage().getSession(sessionId),
      getSessionMessageArtifact: (sessionId, messageIndex) =>
        requireSessionStorage().getSessionMessageArtifact(sessionId, messageIndex),
      getAuditLogs: (sessionId) => requireAuditLogStorage().listSessionAuditLogs(sessionId),
      getAuditLogSummaries: (sessionId) => requireAuditLogStorage().listSessionAuditLogSummaries(sessionId),
      getAuditLogSummaryPage: (sessionId, request) =>
        requireAuditLogStorage().listSessionAuditLogSummaryPage(sessionId, request),
      getAuditLogDetail: (sessionId, auditLogId) => requireAuditLogStorage().getSessionAuditLogDetail(sessionId, auditLogId),
      getAuditLogDetailSection: (sessionId, auditLogId, section) =>
        requireAuditLogStorage().getSessionAuditLogDetailSection(sessionId, auditLogId, section),
      getAuditLogOperationDetail: (sessionId, auditLogId, operationIndex) =>
        requireAuditLogStorage().getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      discoverSessionSkills,
      discoverSessionCustomAgents,
      resolveComposerPreview: (session, userMessage) =>
        resolveComposerPreview(appendSessionFilesDirectory(app.getPath("userData"), session), userMessage),
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
      getModelCatalog: () => getModelCatalog(),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      listOpenSessionWindowIds: () => listOpenSessionWindowIds(),
      listOpenCompanionReviewWindowIds: () => listOpenCompanionReviewWindowIds(),
    });
  }

  return mainBroadcastFacade;
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
      cleanupSessionFilesDirectory,
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

function requireAuxiliarySessionStorage(): AuxiliarySessionStorageAccess {
  if (!auxiliarySessionStorage) {
    throw new Error("Auxiliary Session storage が初期化されていないよ。");
  }

  return auxiliarySessionStorage;
}

function requireAuxiliarySessionService(): AuxiliarySessionService {
  if (!auxiliarySessionService) {
    auxiliarySessionService = new AuxiliarySessionService({
      getParentSession: getAuxiliaryParentSession,
      getStorage: () => requireAuxiliarySessionStorage(),
      getModelCatalogSnapshot: () => getModelCatalog(null) ?? requireModelCatalogStorage().ensureSeeded(),
    });
  }

  return auxiliarySessionService;
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

async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  const savedSettings = await requireAppSettingsStorage().updateSettings(settings);
  applyLaunchAtLoginSetting(app, savedSettings.launchAtLoginEnabled);
  await syncManagedMemorySkillBestEffort();
  return savedSettings;
}

async function resetAppSettings(): Promise<AppSettings> {
  const settings = requireAppSettingsStorage().resetSettings();
  applyLaunchAtLoginSetting(app, settings.launchAtLoginEnabled);
  return settings;
}

function requireMateStorage(): MateStorage {
  if (!mateStorage) {
    throw new Error("mate storage が初期化されていないよ。");
  }

  return mateStorage;
}

function requireCharacterStorage(): CharacterStorageAccess {
  if (!characterStorage) {
    throw new Error("character storage が初期化されていないよ。");
  }

  return characterStorage;
}

function requireCharacterService(): CharacterService {
  if (!characterService) {
    characterService = new CharacterService(requireCharacterStorage());
  }

  return characterService;
}

function requireCharacterAuthoringService(): CharacterAuthoringService {
  if (!characterAuthoringService) {
    characterAuthoringService = new CharacterAuthoringService({
      bundledSkillPath: bundledCharacterAuthoringSkillPath,
      createSession: (input) => requireMainSessionCommandFacade().createSession(input),
      getCharacter: (characterId) => requireCharacterService().getCharacter(characterId),
      getCharacterDirectory: (characterId) => requireCharacterService().getCharacterDirectory(characterId),
    });
  }

  return characterAuthoringService;
}

function requireManagedMemorySkillService(): ManagedMemorySkillService {
  if (!managedMemorySkillService) {
    managedMemorySkillService = new ManagedMemorySkillService({
      bundledSkillPath: bundledMemorySkillPath,
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getAppVersion: () => app.getVersion(),
      shouldSyncSkillMarkdownOnly: () => requireMemoryCliShimService().isPathShimUsable(),
    });
  }

  return managedMemorySkillService;
}

function requireMemoryCliShimService(): MemoryCliShimService {
  if (!memoryCliShimService) {
    memoryCliShimService = new MemoryCliShimService({
      appExecutablePath: process.execPath,
      bundledCliScriptPath: path.join(bundledMemorySkillPath, "bin", "withmate-memory.mjs"),
      homeDirectory: homedir(),
      pathEnv: process.env.PATH,
    });
  }

  return memoryCliShimService;
}

async function createMate(input: Parameters<MateStorage["createMate"]>[0]): ReturnType<MateStorage["createMate"]> {
  const profile = await requireMateStorage().createMate(input);
  return profile;
}

async function updateMate(input: Parameters<MateStorage["updateMate"]>[0]): ReturnType<MateStorage["updateMate"]> {
  return requireMateStorage().updateMate(input);
}

async function setMateAvatar(input: Parameters<MateStorage["setMateAvatar"]>[0]): ReturnType<MateStorage["setMateAvatar"]> {
  return requireMateStorage().setMateAvatar(input);
}

async function resetMate(): Promise<void> {
  await requireMateStorage().resetMate();
}

async function startCharacterAuthoringSession(
  input: StartCharacterAuthoringSessionInput,
): Promise<CharacterAuthoringSessionStartResult> {
  const result = await requireCharacterAuthoringService().startSession(input);
  await openSessionWindow(result.session.id);
  void broadcastSessions();
  return result;
}

function requireMateProfileItemStorage(): MateProfileItemStorage {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  if (!mateProfileItemStorage) {
    mateProfileItemStorage = new MateProfileItemStorage(dbPath);
  }

  return mateProfileItemStorage;
}

function requireCompanionStorage(): CompanionStorageHandle {
  if (!companionStorage) {
    if (!dbPath) {
      throw new Error("DB path が初期化されていないよ。");
    }
    companionStorage = isValidV3Database(dbPath)
      ? new CompanionStorageV3(dbPath, path.join(path.dirname(dbPath), "blobs", "v3"))
      : new CompanionStorage(dbPath);
  }

  return companionStorage;
}

function canUseCompanionAuditLogStorage(): boolean {
  return dbPath.length > 0 && (isValidV3Database(dbPath) || isValidV4Database(dbPath));
}

function requireCompanionAuditLogStorage(): CompanionAuditLogStorage | CompanionAuditLogStorageV3 {
  if (!companionAuditLogStorage) {
    if (!canUseCompanionAuditLogStorage()) {
      throw new Error("companion audit log storage は V3/V4 DB でだけ利用できます。");
    }
    companionAuditLogStorage = isValidV3Database(dbPath)
      ? new CompanionAuditLogStorageV3(dbPath, path.join(path.dirname(dbPath), "blobs", "v3"))
      : new CompanionAuditLogStorage(dbPath, path.join(path.dirname(dbPath), "blobs", "v3"));
  }

  return companionAuditLogStorage;
}

function requireCompanionAuditLogService(): AuditLogService {
  if (!companionAuditLogService) {
    companionAuditLogService = new AuditLogService(requireCompanionAuditLogStorage());
  }

  return companionAuditLogService;
}

function requireSessionMemorySupportService(): SessionMemorySupportService {
  if (!sessionMemorySupportService) {
    sessionMemorySupportService = new SessionMemorySupportService({
      getSessionMemory: (sessionId) => requireSessionMemoryStorage().getSessionMemory(sessionId),
      upsertSessionMemory: (memory) => requireSessionMemoryStorage().upsertSessionMemory(memory),
      ensureProjectScope: (scope) => requireProjectMemoryStorage().ensureProjectScope(scope),
    });
  }

  return sessionMemorySupportService;
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
      getSession: getRuntimeSession,
      upsertSession: (session) => requireMainSessionPersistenceFacade().upsertSession(session),
      resolveRuntimeSessionForTurn: (session) => {
        if (session.sessionKind !== "character-authoring") {
          return session;
        }

        const snapshot = requireCharacterService().createRuntimeSnapshot(session.characterId);
        if (!snapshot) {
          return session;
        }

        return {
          ...session,
          character: snapshot.name,
          characterIconPath: snapshot.iconFilePath,
          characterThemeColors: snapshot.theme,
          characterRuntimeSnapshot: snapshot,
        };
      },
      resolveComposerPreview,
      resolveProviderSession: (session) => appendSessionFilesDirectory(app.getPath("userData"), session),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      resolveProviderCatalog,
      getProviderCodingAdapter,
      getSessionMemory: (session) => createDefaultSessionMemory({
        id: session.id,
        workspacePath: session.workspacePath,
        threadId: session.threadId,
        taskTitle: session.taskTitle,
      }),
      resolveProjectMemoryEntriesForPrompt: () => [],
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

function requireAuxiliarySessionRuntimeService(): SessionRuntimeService {
  if (!auxiliarySessionRuntimeService) {
    auxiliarySessionRuntimeService = new SessionRuntimeService({
      getSession: (sessionId) => requireAuxiliarySessionService().getAuxiliaryRuntimeSession(sessionId),
      upsertSession: async (session) => {
        const auxiliaryService = requireAuxiliarySessionService();
        auxiliaryService.upsertAuxiliaryRuntimeSession(session);
        const storedSession = await auxiliaryService.getAuxiliaryRuntimeSession(session.id);
        if (!storedSession) {
          throw new Error("Auxiliary Session の保存結果を読み戻せなかったよ。");
        }
        return storedSession;
      },
      resolveComposerPreview,
      resolveProviderSession: (session) => {
        const auxiliarySession = requireAuxiliarySessionService().getAuxiliarySession(session.id);
        return appendSessionFilesDirectoryForSessionId(
          app.getPath("userData"),
          session,
          auxiliarySession?.parentSessionId ?? session.id,
        );
      },
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      resolveProviderCatalog,
      getProviderCodingAdapter,
      getSessionMemory: (session) => createDefaultSessionMemory({
        id: session.id,
        workspacePath: session.workspacePath,
        threadId: session.threadId,
        taskTitle: session.taskTitle,
      }),
      resolveProjectMemoryEntriesForPrompt: () => [],
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

  return auxiliarySessionRuntimeService;
}

function requireCompanionSessionService(): CompanionSessionService {
  if (!companionSessionService) {
    companionSessionService = new CompanionSessionService({
      appDataPath: app.getPath("userData"),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getModelCatalogSnapshot: () => getModelCatalog(null) ?? requireModelCatalogStorage().ensureSeeded(),
      storage: requireCompanionStorage(),
      createCharacterRuntimeSnapshot: (characterId) => requireCharacterService().createRuntimeSnapshot(characterId),
    });
  }

  return companionSessionService;
}

function requireCompanionRuntimeService(): CompanionRuntimeService {
  if (!companionRuntimeService) {
    companionRuntimeService = new CompanionRuntimeService({
      getCompanionSession: (sessionId) => requireCompanionStorage().getSession(sessionId),
      listCompanionSessionSummaries: () => requireCompanionStorage().listSessionSummaries(),
      updateCompanionSession: (session) => requireCompanionStorage().updateSession(session),
      resolveComposerPreview,
      resolveProviderSession: (session) => appendSessionFilesDirectory(app.getPath("userData"), session),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      resolveProviderCatalog,
      getProviderCodingAdapter,
      ...(canUseCompanionAuditLogStorage()
        ? {
            createAuditLog: (entry) => requireCompanionAuditLogService().createAuditLog(entry),
            updateAuditLog: (id, entry) => requireCompanionAuditLogService().updateAuditLog(id, entry),
            listAuditLogs: (sessionId) => requireCompanionAuditLogService().listSessionAuditLogs(sessionId),
          }
        : {}),
      setLiveSessionRun,
      getLiveSessionRun,
      waitForApprovalDecision: (sessionId, request, signal) => waitForLiveApprovalDecision(sessionId, request, signal),
      waitForElicitationResponse: (sessionId, request, signal) => waitForLiveElicitationResponse(sessionId, request, signal),
      setProviderQuotaTelemetry: (telemetry) => setProviderQuotaTelemetry(telemetry.provider, telemetry),
      setSessionContextTelemetry: (telemetry) => setSessionContextTelemetry(telemetry.sessionId, telemetry),
      invalidateProviderSessionThread,
      scheduleProviderQuotaTelemetryRefresh,
      broadcastCompanionSessions,
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

  return companionRuntimeService;
}

function requireCompanionReviewService(): CompanionReviewService {
  if (!companionReviewService) {
    companionReviewService = new CompanionReviewService({
      getCompanionSession: (sessionId) => requireCompanionStorage().getSession(sessionId),
      listCompanionSessionSummaries: () => requireCompanionStorage().listSessionSummaries(),
      updateCompanionSession: (session) => requireCompanionStorage().updateSession(session),
      updateCompanionSessionBaseSnapshot: (session) => requireCompanionStorage().updateSessionBaseSnapshot(session),
      createCompanionMergeRun: (run) => requireCompanionStorage().createMergeRun(run),
      listCompanionMergeRunsForSession: (sessionId) => requireCompanionStorage().listMergeRunsForSession(sessionId),
      listCompanionMergeRunSummariesForSession: (sessionId) =>
        requireCompanionStorage().listMergeRunSummariesForSession(sessionId),
    });
  }

  return companionReviewService;
}

function requireSessionPersistenceService(): SessionPersistenceService {
  if (!sessionPersistenceService) {
    sessionPersistenceService = new SessionPersistenceService({
      getSessions: () => sessions,
      setSessions: (nextSessions) => {
        sessions = nextSessions;
      },
      getSession,
      getStoredSession: (sessionId) => requireSessionStorage().getSession(sessionId),
      isSessionRunInFlight,
      listRunningActiveAuxiliaryParentIds: listRunningActiveAuxiliaryParentSessionIds,
      upsertStoredSession: (session) => requireSessionStorageForWrite().upsertSession(session),
      replaceStoredSessions: async (nextSessions) => {
        await requireSessionStorageForWrite().replaceSessions(nextSessions);
      },
      listStoredSessions: () => requireSessionStorage().listSessions(),
      listStoredSessionIdsLastActiveBefore: (cutoff) =>
        requireSessionStorage().listSessionIdsLastActiveBefore(cutoff),
      deleteStoredSessions: (sessionIds) => requireSessionStorageForWrite().deleteSessions(sessionIds),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getModelCatalogSnapshot: () => getModelCatalog(null) ?? requireModelCatalogStorage().ensureSeeded(),
      createCharacterRuntimeSnapshot: (characterId) => requireCharacterService().createRuntimeSnapshot(characterId),
      syncSessionDependencies: (session) => requireSessionMemorySupportService().syncSessionDependencies(session),
      clearSessionContextTelemetry,
      clearSessionBackgroundActivities,
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
          title: getSession(sessionId)?.taskTitle.trim() || `WithMate Session - ${sessionId}`,
        }),
      loadChatEntry: (window, mode) => requireWindowEntryLoader().loadChatEntry(window, mode),
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

function requireSettingsCatalogService(): SettingsCatalogService {
  if (!settingsCatalogService) {
    settingsCatalogService = new SettingsCatalogService({
      hasInFlightSessionRuns,
      isSessionRunInFlight,
      isRunningSession,
      listSessions: listFullStoredSessions,
      listAuxiliarySessions: () => requireAuxiliarySessionService().listAllAuxiliarySessions(),
      listCompanionSessions: async () => {
        const summaries = await requireCompanionStorage().listSessionSummaries();
        const sessions = await Promise.all(summaries.map((summary) => requireCompanionStorage().getSession(summary.id)));
        return sessions.filter((session): session is NonNullable<typeof session> => session !== null);
      },
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      updateAppSettings,
      getModelCatalog,
      ensureModelCatalogSeeded: () => requireModelCatalogStorage().ensureSeeded(),
      importModelCatalogDocument: (document, source) => requireModelCatalogStorage().importCatalogDocument(document, source),
      exportModelCatalogDocument: (revision) => requireModelCatalogStorage().exportCatalogDocument(revision),
      replaceAllSessions: (nextSessions, options) =>
        requireMainSessionPersistenceFacade().replaceAllSessions(nextSessions, options),
      replaceAuxiliarySessions: (nextSessions) =>
        requireAuxiliarySessionService().replaceAuxiliarySessions(nextSessions),
      replaceCompanionSessions: async (nextSessions) =>
        Promise.all(nextSessions.map((session) => requireCompanionStorage().updateSession(session))),
      clearProviderQuotaTelemetry,
      clearSessionContextTelemetry,
      invalidateProviderSessionThread,
      clearAuditLogs: async () => {
        await requireAuditLogService().clearAuditLogs();
        if (canUseCompanionAuditLogStorage()) {
          await requireCompanionAuditLogService().clearAuditLogs();
        }
      },
      resetAppSettings,
      resetModelCatalogToBundled: () => requireModelCatalogStorage().resetToBundled(),
      clearProjectMemories: () => requireProjectMemoryStorage().clearProjectMemories(),
      resetSessionRuntime: () => requireSessionRuntimeService().reset(),
      clearAllProviderQuotaTelemetry,
      clearAllSessionContextTelemetry,
      clearAllSessionBackgroundActivities,
      invalidateAllProviderSessionThreads,
      closeResetTargetWindows,
      recreateDatabaseFile,
      applyAppSettingsSideEffects: (settings) => {
        applyLaunchAtLoginSetting(app, settings.launchAtLoginEnabled);
      },
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
  characterStorage = bundle.characterStorage;
  sessionStorage = bundle.sessionStorage;
  sessionMemoryStorage = bundle.sessionMemoryStorage;
  projectMemoryStorage = bundle.projectMemoryStorage;
  auditLogStorage = bundle.auditLogStorage;
  auxiliarySessionStorage = bundle.auxiliarySessionStorage;
  appSettingsStorage = bundle.appSettingsStorage;
  mateStorage = bundle.mateStorage;
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
  try {
    const bundle = await requirePersistentStoreLifecycleService().initialize(
      dbPath,
      bundledModelCatalogPath,
      app.getPath("userData"),
    );
    const activeModelCatalog = applyPersistentStoreBundle(bundle);
    appDatabaseDiagnostics = inspectAppDatabase(app.getPath("userData"), dbPath, Boolean(userDataPathOverride));
    startWalMaintenance();
    return activeModelCatalog;
  } catch (error) {
    throw error;
  }
}

function closePersistentStores(): void {
  stopWalMaintenance();
  companionStorage?.close();
  companionAuditLogStorage?.close();
  mateProfileItemStorage?.close();
  requirePersistentStoreLifecycleService().close({
    modelCatalogStorage,
    characterStorage,
    sessionStorage,
    sessionMemoryStorage,
    projectMemoryStorage,
    auditLogStorage,
    auxiliarySessionStorage,
    appSettingsStorage,
    mateStorage,
  }, dbPath);
  modelCatalogStorage = null;
  characterStorage = null;
  characterService = null;
  characterAuthoringService = null;
  managedMemorySkillService = null;
  memoryCliShimService = null;
  sessionStorage = null;
  sessionMemoryStorage = null;
  projectMemoryStorage = null;
  auditLogStorage = null;
  auditLogService = null;
  auxiliarySessionStorage = null;
  auxiliarySessionService = null;
  auxiliarySessionRuntimeService = null;
  appSettingsStorage = null;
  mateStorage = null;
  mateProfileItemStorage = null;
  companionStorage = null;
  companionAuditLogStorage = null;
  companionAuditLogService = null;
  companionSessionService = null;
  companionRuntimeService = null;
  companionReviewService = null;
  settingsCatalogService = null;
  sessionObservabilityService = null;
  sessionApprovalService = null;
  sessionElicitationService = null;
  sessionMemorySupportService = null;
  mainBroadcastFacade = null;
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
  await requireMateStorage().deleteMateProjectionDirectory();
  mateProfileItemStorage?.close();
  mateProfileItemStorage = null;
  companionStorage?.close();
  companionAuditLogStorage?.close();
  const bundle = await requirePersistentStoreLifecycleService().recreate(dbPath, bundledModelCatalogPath, {
    modelCatalogStorage,
    characterStorage,
    sessionStorage,
    sessionMemoryStorage,
    projectMemoryStorage,
    auditLogStorage,
    auxiliarySessionStorage,
    appSettingsStorage,
    mateStorage,
  }, app.getPath("userData"));

  characterStorage = null;
  characterService = null;
  characterAuthoringService = null;
  auditLogService = null;
  companionStorage = null;
  companionAuditLogService = null;
  companionAuditLogStorage = null;
  auxiliarySessionService = null;
  auxiliarySessionRuntimeService = null;
  companionSessionService = null;
  companionRuntimeService = null;
  companionReviewService = null;
  settingsCatalogService = null;
  sessionObservabilityService = null;
  sessionApprovalService = null;
  sessionElicitationService = null;
  sessionMemorySupportService = null;
  mainBroadcastFacade = null;
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
  appDatabaseDiagnostics = inspectAppDatabase(app.getPath("userData"), dbPath, Boolean(userDataPathOverride));
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

async function listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]> {
  return requireMainQueryService().listSessionAuditLogs(sessionId);
}

async function listSessionAuditLogSummaries(sessionId: string): Promise<AuditLogSummary[]> {
  return requireMainQueryService().listSessionAuditLogSummaries(sessionId);
}

async function listSessionAuditLogSummaryPage(
  sessionId: string,
  request?: AuditLogSummaryPageRequest | null,
): Promise<AuditLogSummaryPageResult> {
  return requireMainQueryService().listSessionAuditLogSummaryPage(sessionId, request);
}

async function getSessionAuditLogDetail(sessionId: string, auditLogId: number): Promise<AuditLogDetail | null> {
  return requireMainQueryService().getSessionAuditLogDetail(sessionId, auditLogId);
}

async function getSessionAuditLogDetailSection(
  sessionId: string,
  auditLogId: number,
  section: AuditLogDetailSection,
): Promise<AuditLogDetailFragment | null> {
  const startedAt = Date.now();
  writeAppLog({
    level: "debug",
    kind: "audit-log.detail.main-load-started",
    process: "main",
    message: "Audit log detail section main load started",
    data: {
      sessionId,
      auditLogId,
      section,
      source: "session",
    },
  });

  try {
    const fragment = await requireMainQueryService().getSessionAuditLogDetailSection(sessionId, auditLogId, section);
    writeAppLog({
      level: "debug",
      kind: "audit-log.detail.main-load-completed",
      process: "main",
      message: "Audit log detail section main load completed",
      data: {
        sessionId,
        auditLogId,
        section,
        source: "session",
        durationMs: Date.now() - startedAt,
        metrics: summarizeAuditLogDetailFragment(fragment),
      },
    });
    return fragment;
  } catch (error) {
    writeAppLog({
      level: "error",
      kind: "audit-log.detail.main-load-failed",
      process: "main",
      message: "Audit log detail section main load failed",
      data: {
        sessionId,
        auditLogId,
        section,
        source: "session",
        durationMs: Date.now() - startedAt,
      },
      error: appLogService.errorToLogError(error),
    });
    throw error;
  }
}

async function getSessionAuditLogOperationDetail(
  sessionId: string,
  auditLogId: number,
  operationIndex: number,
): Promise<AuditLogOperationDetailFragment | null> {
  const startedAt = Date.now();
  writeAppLog({
    level: "debug",
    kind: "audit-log.operation-detail.main-load-started",
    process: "main",
    message: "Audit log operation detail main load started",
    data: {
      sessionId,
      auditLogId,
      operationIndex,
      source: "session",
    },
  });

  try {
    const fragment = await requireMainQueryService().getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex);
    writeAppLog({
      level: "debug",
      kind: "audit-log.operation-detail.main-load-completed",
      process: "main",
      message: "Audit log operation detail main load completed",
      data: {
        sessionId,
        auditLogId,
        operationIndex,
        source: "session",
        durationMs: Date.now() - startedAt,
        detailsChars: fragment?.details.length ?? 0,
      },
    });
    return fragment;
  } catch (error) {
    writeAppLog({
      level: "error",
      kind: "audit-log.operation-detail.main-load-failed",
      process: "main",
      message: "Audit log operation detail main load failed",
      data: {
        sessionId,
        auditLogId,
        operationIndex,
        source: "session",
        durationMs: Date.now() - startedAt,
      },
      error: appLogService.errorToLogError(error),
    });
    throw error;
  }
}

async function listCompanionAuditLogs(sessionId: string): Promise<AuditLogEntry[]> {
  return requireCompanionAuditLogStorage().listSessionAuditLogs(sessionId);
}

async function listCompanionAuditLogSummaries(sessionId: string): Promise<AuditLogSummary[]> {
  return requireCompanionAuditLogStorage().listSessionAuditLogSummaries(sessionId);
}

async function listCompanionAuditLogSummaryPage(
  sessionId: string,
  request?: AuditLogSummaryPageRequest | null,
): Promise<AuditLogSummaryPageResult> {
  return requireCompanionAuditLogStorage().listSessionAuditLogSummaryPage(sessionId, request);
}

async function getCompanionAuditLogDetail(sessionId: string, auditLogId: number): Promise<AuditLogDetail | null> {
  return requireCompanionAuditLogStorage().getSessionAuditLogDetail(sessionId, auditLogId);
}

async function getCompanionAuditLogDetailSection(
  sessionId: string,
  auditLogId: number,
  section: AuditLogDetailSection,
): Promise<AuditLogDetailFragment | null> {
  const startedAt = Date.now();
  writeAppLog({
    level: "debug",
    kind: "audit-log.detail.main-load-started",
    process: "main",
    message: "Audit log detail section main load started",
    data: {
      sessionId,
      auditLogId,
      section,
      source: "companion",
    },
  });

  try {
    const fragment = await requireCompanionAuditLogStorage().getSessionAuditLogDetailSection(sessionId, auditLogId, section);
    writeAppLog({
      level: "debug",
      kind: "audit-log.detail.main-load-completed",
      process: "main",
      message: "Audit log detail section main load completed",
      data: {
        sessionId,
        auditLogId,
        section,
        source: "companion",
        durationMs: Date.now() - startedAt,
        metrics: summarizeAuditLogDetailFragment(fragment),
      },
    });
    return fragment;
  } catch (error) {
    writeAppLog({
      level: "error",
      kind: "audit-log.detail.main-load-failed",
      process: "main",
      message: "Audit log detail section main load failed",
      data: {
        sessionId,
        auditLogId,
        section,
        source: "companion",
        durationMs: Date.now() - startedAt,
      },
      error: appLogService.errorToLogError(error),
    });
    throw error;
  }
}

async function getCompanionAuditLogOperationDetail(
  sessionId: string,
  auditLogId: number,
  operationIndex: number,
): Promise<AuditLogOperationDetailFragment | null> {
  const startedAt = Date.now();
  writeAppLog({
    level: "debug",
    kind: "audit-log.operation-detail.main-load-started",
    process: "main",
    message: "Audit log operation detail main load started",
    data: {
      sessionId,
      auditLogId,
      operationIndex,
      source: "companion",
    },
  });

  try {
    const fragment = await requireCompanionAuditLogStorage().getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex);
    writeAppLog({
      level: "debug",
      kind: "audit-log.operation-detail.main-load-completed",
      process: "main",
      message: "Audit log operation detail main load completed",
      data: {
        sessionId,
        auditLogId,
        operationIndex,
        source: "companion",
        durationMs: Date.now() - startedAt,
        detailsChars: fragment?.details.length ?? 0,
      },
    });
    return fragment;
  } catch (error) {
    writeAppLog({
      level: "error",
      kind: "audit-log.operation-detail.main-load-failed",
      process: "main",
      message: "Audit log operation detail main load failed",
      data: {
        sessionId,
        auditLogId,
        operationIndex,
        source: "companion",
        durationMs: Date.now() - startedAt,
      },
      error: appLogService.errorToLogError(error),
    });
    throw error;
  }
}

async function listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]> {
  return requireMainQueryService().listSessionSkills(sessionId);
}

async function listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]> {
  return requireMainQueryService().listSessionCustomAgents(sessionId);
}

function getSession(sessionId: string): Session | null {
  return sessions.find((session) => session.id === sessionId) ?? null;
}

async function getAuxiliaryParentSession(parentSessionId: string): Promise<Session | null> {
  return resolveAuxiliaryParentSession({
    parentSessionId,
    getStoredSession: (sessionId) => requireSessionStorage().getSession(sessionId),
    getCachedSession: getSession,
    getCompanionSession: (sessionId) => requireCompanionStorage().getSession(sessionId),
  });
}

async function getDisplaySession(sessionId: string): Promise<Session | null> {
  const liveSession = getSession(sessionId);
  if (liveSession && (liveSession.messages.length > 0 || liveSession.stream.length > 0)) {
    return liveSession;
  }

  return await requireMainQueryService().getSession(sessionId) ?? liveSession ?? null;
}

async function getRuntimeSession(sessionId: string): Promise<Session | null> {
  return await requireSessionStorage().getSession(sessionId) ?? getSession(sessionId);
}

async function getSessionMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null> {
  const liveArtifact = getSession(sessionId)?.messages[messageIndex]?.artifact;
  if (liveArtifact && liveArtifact.detailAvailable !== true) {
    return liveArtifact;
  }

  return requireMainQueryService().getSessionMessageArtifact(sessionId, messageIndex);
}

async function getCompanionMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null> {
  const artifact = await requireCompanionStorage().getMessageArtifact(sessionId, messageIndex);
  return artifact ?? null;
}

async function openSessionTerminal(sessionId: string): Promise<void> {
  await requireMainQueryService().openSessionTerminal(sessionId);
}

function broadcastSessions(sessionIds?: Iterable<string>): void {
  requireMainBroadcastFacade().broadcastSessions(sessionIds);
}

async function broadcastCompanionSessions(): Promise<void> {
  requireWindowBroadcastService().broadcastCompanionSessionSummaries(await listCompanionSessionSummaries());
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

function listOpenCompanionReviewWindowIds(): string[] {
  return requireMainWindowFacade().listOpenCompanionReviewWindowIds();
}

function broadcastOpenSessionWindowIds(): void {
  requireMainBroadcastFacade().broadcastOpenSessionWindowIds();
}

function broadcastOpenCompanionReviewWindowIds(): void {
  requireMainBroadcastFacade().broadcastOpenCompanionReviewWindowIds();
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

async function upsertSession(nextSession: Session): Promise<Session> {
  return requireMainSessionPersistenceFacade().upsertSession(nextSession);
}

async function replaceAllSessions(
  nextSessions: Session[],
  options?: {
    broadcast?: boolean;
    invalidateSessionIds?: Iterable<string>;
  },
): Promise<Session[]> {
  return requireMainSessionPersistenceFacade().replaceAllSessions(nextSessions, options);
}

async function recoverInterruptedSessions(): Promise<void> {
  await requireMainSessionPersistenceFacade().recoverInterruptedSessions();
  await requireCompanionRuntimeService().recoverInterruptedSessions();
  requireAuxiliarySessionService().recoverInterruptedSessions();
}

async function previewComposerInput(
  sessionId: string,
  userMessage: string,
) {
  const auxiliaryService = requireAuxiliarySessionService();
  const auxiliarySession = auxiliaryService.getAuxiliarySession(sessionId);
  const auxiliaryRuntimeSession = auxiliarySession
    ? await auxiliaryService.getAuxiliaryRuntimeSession(sessionId)
    : null;
  if (auxiliaryRuntimeSession) {
    return resolveComposerPreview(
      appendSessionFilesDirectoryForSessionId(
        app.getPath("userData"),
        auxiliaryRuntimeSession,
        auxiliarySession?.parentSessionId ?? sessionId,
      ),
      userMessage,
    );
  }

  return requireMainQueryService().previewComposerInput(sessionId, userMessage);
}

async function copyFilesToSessionFiles(
  sessionId: string,
  sourcePaths: string[],
): Promise<string[]> {
  return copyFilesToSessionFilesStorage(app.getPath("userData"), sessionId, sourcePaths);
}

async function pickSessionFiles(targetWindow: BrowserWindow | null, sessionId: string): Promise<string[]> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  const selectedPaths = await requireWindowDialogService().pickFiles(targetWindow, directoryPath);
  return selectedPaths.filter((selectedPath) => isPathInsideOrEqual(directoryPath, selectedPath));
}

async function pickSessionFolder(targetWindow: BrowserWindow | null, sessionId: string): Promise<string | null> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  const selectedPath = await requireWindowDialogService().pickDirectory(targetWindow, directoryPath);
  return selectedPath && isPathInsideOrEqual(directoryPath, selectedPath) ? selectedPath : null;
}

async function pickSessionImageFile(targetWindow: BrowserWindow | null, sessionId: string): Promise<string | null> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  const selectedPath = await requireWindowDialogService().pickImageFile(targetWindow, directoryPath);
  return selectedPath && isPathInsideOrEqual(directoryPath, selectedPath) ? selectedPath : null;
}

async function savePastedSessionFile(request: SavePastedSessionFileRequest): Promise<string> {
  return saveSessionFile(app.getPath("userData"), {
    sessionId: request.sessionId,
    fileName: request.fileName,
    data: new Uint8Array(request.data),
  });
}

function ensureSessionFilesDirectory(sessionId: string): string {
  const directoryPath = resolveSessionFilesDirectory(app.getPath("userData"), sessionId);
  mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function cleanupSessionFilesDirectory(sessionId: string): Promise<void> {
  try {
    await deleteSessionFilesDirectory(app.getPath("userData"), sessionId);
  } catch (error) {
    console.warn("Session files directory の cleanup に失敗しました:", sessionId, error);
  }
}

async function openSessionFilesDirectory(sessionId: string): Promise<void> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  await openDirectory(directoryPath);
}

async function openSessionFilesTerminal(sessionId: string): Promise<void> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  await launchTerminalAtPath(directoryPath);
}

async function openDirectoryWithExplorerFallback(directoryPath: string): Promise<boolean> {
  let directoryStat;
  try {
    directoryStat = await stat(directoryPath);
  } catch {
    return false;
  }

  if (!directoryStat.isDirectory()) {
    return false;
  }

  const fallbackCommand = buildDirectoryOpenFallbackCommand(directoryPath);
  if (!fallbackCommand) {
    return false;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(fallbackCommand.command, fallbackCommand.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return true;
}

async function openLocalPath(targetPath: string): Promise<void> {
  const errorMessage = await shell.openPath(targetPath);
  if (!errorMessage) {
    return;
  }

  if (await openDirectoryWithExplorerFallback(targetPath)) {
    return;
  }

  throw new Error(errorMessage);
}

async function openPathTarget(target: string, options?: OpenPathOptions): Promise<void> {
  const protocolRelativeExternalFallback = resolveProtocolRelativeExternalFallback(target);
  const resolved = resolveOpenPathTarget(target, options);
  if (resolved.type === "external-url") {
    await shell.openExternal(resolved.target);
    return;
  }

  try {
    await openLocalPath(resolved.targetPath);
  } catch (error) {
    if (protocolRelativeExternalFallback) {
      await shell.openExternal(protocolRelativeExternalFallback);
      return;
    }
    throw error;
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

async function openMemoryV6ReviewWindow(): Promise<BrowserWindow> {
  return requireMainWindowFacade().openMemoryV6ReviewWindow();
}

async function openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
  return requireMainWindowFacade().openCharacterEditorWindow(characterId);
}

async function openSessionWindow(sessionId: string): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSessionWindow(sessionId);
}

async function openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
  return requireMainWindowFacade().openDiffWindow(diffPreview);
}

async function openCompanionReviewWindow(sessionId: string): Promise<BrowserWindow> {
  writeAppLog({
    level: "info",
    kind: "companion.review-window.open.started",
    process: "main",
    message: "Companion review window open started",
    data: { sessionId },
  });
  const window = await requireMainWindowFacade().openCompanionReviewWindow(sessionId);
  writeAppLog({
    level: "info",
    kind: "companion.review-window.open.completed",
    process: "main",
    message: "Companion review window open completed",
    windowId: window.id,
    data: { sessionId },
  });
  return window;
}

async function openCompanionMergeWindow(sessionId: string): Promise<BrowserWindow> {
  writeAppLog({
    level: "info",
    kind: "companion.merge-window.open.started",
    process: "main",
    message: "Companion merge window open started",
    data: { sessionId },
  });
  const window = await requireMainWindowFacade().openCompanionMergeWindow(sessionId);
  writeAppLog({
    level: "info",
    kind: "companion.merge-window.open.completed",
    process: "main",
    message: "Companion merge window open completed",
    windowId: window.id,
    data: { sessionId },
  });
  return window;
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!app.isReady()) {
      return;
    }
    void requireAppLifecycleService().handleSecondInstance();
  });

  app.whenReady().then(async () => {
    if (!isBackgroundLaunch) {
      await openBootWindow();
    }

    try {
      dbPath = await resolveOrMigrateAppDatabasePath(app.getPath("userData"), (progress) => {
        publishAppBootStatus({
          kind: "running",
          stage: "database",
          title: progress.title,
          detail: progress.detail,
        });
      });
      publishAppBootStatus({
        kind: "running",
        stage: "diagnostics",
        title: "データベース診断を確認しています",
        detail: "利用するデータベースと schema version を確認しています。",
      });
      appDatabaseDiagnostics = inspectAppDatabase(app.getPath("userData"), dbPath, Boolean(userDataPathOverride));
      writeAppLog({
        level: "info",
        kind: "app.ready",
        process: "main",
        message: "App ready",
        data: {
          userDataPath: app.getPath("userData"),
          userDataPathOverrideApplied: appDatabaseDiagnostics.userDataPathOverrideApplied,
          activeDatabasePath: appDatabaseDiagnostics.activeDatabasePath,
          activeDatabaseSchemaVersion: appDatabaseDiagnostics.schemaVersion,
          activeDatabaseCompatibilityMode: appDatabaseDiagnostics.compatibilityMode,
          logsPath: appLogsPath,
          crashDumpsPath,
        },
      });
      writeAppLog({
        level: appDatabaseDiagnostics.warnings.length > 0 ? "warn" : "info",
        kind: "app.database.selected",
        process: "main",
        message: "App database selected",
        data: appDatabaseDiagnostics,
      });
      await startMemoryV6RuntimeApiBestEffort();
      await requireMainBootstrapService().handleReady();
      requireAppTrayService().initialize();
      applyLaunchAtLoginSetting(app, requireAppSettingsStorage().getSettings().launchAtLoginEnabled);
      await syncManagedMemorySkillBestEffort();
      publishAppBootStatus({
        kind: "completed",
        stage: "home",
        title: "起動が完了しました",
        detail: isBackgroundLaunch ? "バックグラウンドで起動しました。" : "Home を表示しました。",
      });
      closeBootWindow();

      if (process.env.WITHMATE_DEBUG_OPEN_SESSION_ID) {
        await openSessionWindow(process.env.WITHMATE_DEBUG_OPEN_SESSION_ID);
      }

      app.on("activate", async () => {
        await requireAppLifecycleService().handleActivate();
      });
    } catch (error) {
      const serializedError = serializeBootError(error);
      writeAppLog({
        level: "fatal",
        kind: "app.boot.failed",
        process: "main",
        message: serializedError?.message ?? "App boot failed",
        error: appLogService.errorToLogError(error),
        data: {
          userDataPath: app.getPath("userData"),
          logsPath: appLogsPath,
          crashDumpsPath,
        },
      });
      if (!isBackgroundLaunch) {
        await openBootWindow();
      }
      publishAppBootStatus({
        kind: "failed",
        stage: "failed",
        title: "WithMate の起動に失敗しました",
        detail: "データベース移行または起動初期化でエラーが発生しました。ログに詳細を記録しました。",
        error: serializedError,
      });
    }
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
    appTrayService?.dispose();
    void stopMemoryV6RuntimeApiBestEffort();
  });
}
