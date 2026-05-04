import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, crashReporter, dialog, ipcMain, screen, shell } from "electron";

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
  type MessageArtifact,
  projectSessionSummary,
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
import {
  canUseProviderForMateTalkBackgroundPrompt,
  ProviderTurnError,
} from "./provider-runtime.js";
import { resolveComposerPreview } from "./composer-attachments.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { resolveOpenPathTarget } from "./open-path.js";
import { launchTerminalAtPath } from "./open-terminal.js";
import { SessionStorage } from "./session-storage.js";
import { SessionMemoryStorage } from "./session-memory-storage.js";
import { ProjectMemoryStorage } from "./project-memory-storage.js";
import { CharacterMemoryStorage } from "./character-memory-storage.js";
import { CompanionReviewService } from "./companion-review-service.js";
import { CompanionRuntimeService } from "./companion-runtime-service.js";
import { CompanionSessionService } from "./companion-session-service.js";
import { CompanionAuditLogStorageV3 } from "./companion-audit-log-storage-v3.js";
import { CompanionStorage } from "./companion-storage.js";
import { CompanionStorageV3 } from "./companion-storage-v3.js";
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
import { MateStorage } from "./mate-storage.js";
import { MateMemoryStorage } from "./mate-memory-storage.js";
import { MateEmbeddingCacheService } from "./mate-embedding-cache.js";
import { MateEmbeddingDownloadService } from "./mate-embedding-download-service.js";
import { buildMateMemoryRuntimeInstructionFiles } from "./mate-memory-runtime-instructions.js";
import { MateGrowthApplyService } from "./mate-growth-apply-service.js";
import { MateGrowthStorage } from "./mate-growth-storage.js";
import { MateProjectContextService } from "./mate-project-context-service.js";
import { type MateProjectDigest, MateProjectDigestStorage } from "./mate-project-digest-storage.js";
import { MateProfileItemStorage } from "./mate-profile-item-storage.js";
import { ProviderInstructionTargetStorage } from "./provider-instruction-target-storage.js";
import { MateEmbeddingVectorizer } from "./mate-embedding-vectorizer.js";
import { MateSemanticEmbeddingStorage } from "./mate-semantic-embedding-storage.js";
import { MateSemanticEmbeddingRetrievalService } from "./mate-semantic-embedding-retrieval-service.js";
import { MateSemanticEmbeddingIndexService } from "./mate-semantic-embedding-index-service.js";
import {
  MateProviderInstructionSyncBlockedError,
  syncDisabledProviderInstructionTargets,
  syncEnabledProviderInstructionTargets,
} from "./mate-provider-instruction-sync.js";
import { createMateMemoryGenerationRunner } from "./mate-memory-generation-runner.js";
import { MateMemoryGenerationService } from "./mate-memory-generation-service.js";
import { MemoryRuntimeWorkspaceService } from "./memory-runtime-workspace.js";
import {
  buildMateTalkRuntimeInstructionFiles,
  MateTalkRuntimeWorkspaceService,
  sanitizeMateTalkProfileContextText,
} from "./mate-talk-runtime-workspace.js";
import { MateTalkService } from "./mate-talk-service.js";
import { buildMateTalkProfileContextText } from "./mate-talk-profile-context.js";
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
import { getMateMemoryGenerationSettings, getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import type { MateTalkTurnInput, MateTalkTurnResult } from "../src/mate-state.js";
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
import { CREATE_V2_SCHEMA_SQL } from "./database-schema-v2.js";
import { CREATE_V3_SCHEMA_SQL, isValidV3Database } from "./database-schema-v3.js";
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
const fixedUserDataPath = path.join(appDataPath, "WithMate");
app.setAppUserModelId("com.natumekazuki.withmate");
app.setPath("userData", fixedUserDataPath);
const appLogsPath = path.join(fixedUserDataPath, "logs");
const MATE_TALK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    assistantMessage: { type: "string" },
  },
  required: ["assistantMessage"],
} as const;
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
let mateStorage: MateStorage | null = null;
let mateMemoryStorage: MateMemoryStorage | null = null;
let mateEmbeddingCacheService: MateEmbeddingCacheService | null = null;
let mateEmbeddingVectorizer: MateEmbeddingVectorizer | null = null;
let mateSemanticEmbeddingStorage: MateSemanticEmbeddingStorage | null = null;
let mateSemanticEmbeddingRetrievalService: MateSemanticEmbeddingRetrievalService | null = null;
let mateSemanticEmbeddingIndexService: MateSemanticEmbeddingIndexService | null = null;
let mateGrowthStorage: MateGrowthStorage | null = null;
let mateProfileItemStorage: MateProfileItemStorage | null = null;
let mateProjectDigestStorage: MateProjectDigestStorage | null = null;
let providerInstructionTargetStorage: ProviderInstructionTargetStorage | null = null;
let mateProjectContextService: MateProjectContextService | null = null;
let mateGrowthApplyService: MateGrowthApplyService | null = null;
let memoryRuntimeWorkspaceService: MemoryRuntimeWorkspaceService | null = null;
let mateTalkRuntimeWorkspaceService: MateTalkRuntimeWorkspaceService | null = null;
let mateMemoryGenerationService: MateMemoryGenerationService | null = null;
type CompanionStorageHandle = CompanionStorage | CompanionStorageV3;

let companionStorage: CompanionStorageHandle | null = null;
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
let companionSessionService: CompanionSessionService | null = null;
let companionAuditLogStorage: CompanionAuditLogStorageV3 | null = null;
let companionAuditLogService: AuditLogService | null = null;
let companionRuntimeService: CompanionRuntimeService | null = null;
let companionReviewService: CompanionReviewService | null = null;
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
  return requireSessionRuntimeService().hasInFlightRuns() || requireCompanionRuntimeService().hasInFlightRuns();
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
          loadCompanionChatEntry: (window, sessionId) =>
            requireWindowEntryLoader().loadCompanionChatEntry(window, sessionId),
          loadCompanionMergeEntry: (window, sessionId) =>
            requireWindowEntryLoader().loadCompanionMergeEntry(window, sessionId),
          generateDiffToken: () => crypto.randomUUID(),
          onCompanionReviewWindowsChanged: () => broadcastOpenCompanionReviewWindowIds(),
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
            recoverInterruptedSessions,
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
                openCompanionReviewWindow,
                openCompanionMergeWindow,
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
                resetAppDatabase: async (request) => requireSettingsCatalogService().resetAppDatabase(request),
                getMemoryManagementSnapshot: () => requireMemoryManagementService().getSnapshot(),
                getMemoryManagementPage: (request) => requireMemoryManagementService().getPage(request),
                getMateEmbeddingSettings: () => requireMateEmbeddingCacheService().getEmbeddingSettings(),
                listProviderInstructionTargets: () => requireProviderInstructionTargetStorage().listTargets(),
                upsertProviderInstructionTarget: (input) => requireProviderInstructionTargetStorage().upsertTarget(input),
                startMateEmbeddingDownload: () => startMateEmbeddingDownload(),
                deleteSessionMemory: (sessionId) => requireMemoryManagementService().deleteSessionMemory(sessionId),
                deleteProjectMemoryEntry: (entryId) => requireMemoryManagementService().deleteProjectMemoryEntry(entryId),
                deleteCharacterMemoryEntry: (entryId) =>
                  requireMemoryManagementService().deleteCharacterMemoryEntry(entryId),
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
                searchWorkspaceFiles,
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
                searchCompanionWorkspaceFiles,
                discardCompanionSession: async (sessionId) => {
                  const session = await requireCompanionReviewService().discardSession(sessionId);
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
              mate: {
                getMateState: () => requireMateStorage().getMateState(),
                getMateProfile: () => requireMateStorage().getMateProfile(),
                createMate,
                applyPendingGrowth,
                runMateTalkTurn,
                resetMate,
              },
            },
            getMateState: () => requireMateStorage().getMateState(),
            applyPendingGrowth,
            getGrowthApplyIntervalMs: () => resolveMateGrowthApplyIntervalMs(),
            createGrowthApplyTimer: (handler, intervalMs) => setInterval(handler, intervalMs),
            clearGrowthApplyTimer: (timer) => {
              clearInterval(timer as ReturnType<typeof setInterval>);
            },
          }),
        ),
      });
  }

  return mainInfrastructureRegistry;
}

function resolveMateGrowthApplyIntervalMs(): number {
  const settings = requireMateStorage().getMateGrowthSettings();
  return (settings?.applyIntervalMinutes ?? 60) * 60 * 1000;
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
      getSessionMessageArtifact: (sessionId, messageIndex) =>
        requireSessionStorage().getSessionMessageArtifact(sessionId, messageIndex),
      getCharacters: () => characters,
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
      listOpenCompanionReviewWindowIds: () => listOpenCompanionReviewWindowIds(),
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

function getMateMemoryGenerationProviderIds(): string[] {
  const settings = getMateMemoryGenerationSettings(requireAppSettingsStorage().getSettings());
  const providerIds = settings.priorityList
    .map((candidate) => candidate.provider)
    .filter((provider) => provider.trim().length > 0);

  return [...new Set(providerIds)];
}

function syncMateGrowthApplyIntervalFromAppSettings(settings: AppSettings = requireAppSettingsStorage().getSettings()): void {
  const mateMemoryGenerationSettings = getMateMemoryGenerationSettings(settings);
  requireMateStorage().updateMateGrowthApplyIntervalMinutes(mateMemoryGenerationSettings.triggerIntervalMinutes);
}

async function restartMateGrowthApplyTimerIfMateActive(): Promise<void> {
  if (requireMateStorage().getMateState() !== "active") {
    return;
  }

  const bootstrapService = requireMainBootstrapService();
  bootstrapService.clearGrowthApplyTimer();
  await bootstrapService.ensureGrowthApplyTimer();
}

async function updateAppSettingsAndSyncMateGrowth(settings: AppSettings): Promise<AppSettings> {
  const savedSettings = requireAppSettingsStorage().updateSettings(settings);
  syncMateGrowthApplyIntervalFromAppSettings(savedSettings);
  await restartMateGrowthApplyTimerIfMateActive();
  return savedSettings;
}

async function resetAppSettingsAndSyncMateGrowth(): Promise<AppSettings> {
  const savedSettings = requireAppSettingsStorage().resetSettings();
  syncMateGrowthApplyIntervalFromAppSettings(savedSettings);
  await restartMateGrowthApplyTimerIfMateActive();
  return savedSettings;
}

function requireMemoryRuntimeWorkspaceService(): MemoryRuntimeWorkspaceService {
  if (!memoryRuntimeWorkspaceService) {
    memoryRuntimeWorkspaceService = new MemoryRuntimeWorkspaceService({
      userDataPath: app.getPath("userData"),
    });
  }

  return memoryRuntimeWorkspaceService;
}

function requireMateTalkRuntimeWorkspaceService(): MateTalkRuntimeWorkspaceService {
  if (!mateTalkRuntimeWorkspaceService) {
    mateTalkRuntimeWorkspaceService = new MateTalkRuntimeWorkspaceService({
      userDataPath: app.getPath("userData"),
    });
  }

  return mateTalkRuntimeWorkspaceService;
}

function requireMateMemoryGenerationService(): MateMemoryGenerationService {
  if (!mateMemoryGenerationService) {
    const workspaceService = requireMemoryRuntimeWorkspaceService();
    if (!mateMemoryStorage) {
      throw new Error("mate memory storage が初期化されていないよ。");
    }
    const memoryStorage = mateMemoryStorage;

    mateMemoryGenerationService = new MateMemoryGenerationService({
      workspace: workspaceService,
      storage: memoryStorage,
      growthStorage: requireMateGrowthStorage(),
      runStructuredGeneration: createMateMemoryGenerationRunner({
        getAppSettings: () => requireAppSettingsStorage().getSettings(),
        getProviderBackgroundAdapter,
        getWorkspacePath: () => workspaceService.getWorkspacePath(),
      }),
      getTagCatalog: async () => memoryStorage.listMemoryTagCatalog(),
      getInstructionFiles: async (input) => buildMateMemoryRuntimeInstructionFiles({
        prompt: input.prompt,
        logicalPrompt: input.logicalPrompt,
        providerIds: input.providerIds,
      }),
      getRecentConversationText: async () => "",
    });
  }

  return mateMemoryGenerationService;
}

function requireMateStorage(): MateStorage {
  if (!mateStorage) {
    throw new Error("mate storage が初期化されていないよ。");
  }

  return mateStorage;
}

async function createMate(input: Parameters<MateStorage["createMate"]>[0]): ReturnType<MateStorage["createMate"]> {
  const profile = await requireMateStorage().createMate(input);
  syncMateGrowthApplyIntervalFromAppSettings();
  await requireMainBootstrapService().ensureGrowthApplyTimer();
  await syncEnabledProviderInstructionTargetsForMateProfile(profile);
  return profile;
}

async function syncEnabledProviderInstructionTargetsForMateProfile(
  profile: NonNullable<ReturnType<MateStorage["getMateProfile"]>>,
): Promise<void> {
  try {
    await syncEnabledProviderInstructionTargets(
      requireProviderInstructionTargetStorage(),
      profile,
      {
        readTextFile: async (filePath) => readFile(filePath, "utf8"),
        writeTextFile: (filePath, content) => writeFile(filePath, content, "utf8"),
      },
    );
  } catch (error) {
    if (error instanceof MateProviderInstructionSyncBlockedError) {
      throw error;
    }

    writeAppLog({
      level: "warn",
      kind: "mate.provider-instruction-sync.failed",
      process: "main",
      message: "有効な Provider Instruction Target の同期に失敗しました",
      data: {
        mateId: profile.id,
        revisionId: profile.activeRevisionId,
      },
      error: appLogService.errorToLogError(error),
    });
  }
}

async function resetMate(): Promise<void> {
  requireMainBootstrapService().clearGrowthApplyTimer();
  await requireMateStorage().resetMate();
  await syncProviderInstructionTargetsForDisabledMateProfile();
}

async function syncProviderInstructionTargetsForDisabledMateProfile(): Promise<void> {
  try {
    await syncDisabledProviderInstructionTargets(
      requireProviderInstructionTargetStorage(),
      {
        readTextFile: async (filePath) => readFile(filePath, "utf8"),
        writeTextFile: (filePath, content) => writeFile(filePath, content, "utf8"),
      },
    );
  } catch (error) {
    if (error instanceof MateProviderInstructionSyncBlockedError) {
      writeAppLog({
        level: "warn",
        kind: "mate.provider-instruction-sync.disabled-projection.failed",
        process: "main",
        message: "Mate reset 後の Provider Instruction cleanup が完了しませんでした。再同期を実行してください。",
        data: {
          providerId: error.providerId,
          targetId: error.targetId,
        },
        error: appLogService.errorToLogError(error),
      });
      return;
    }

    writeAppLog({
      level: "warn",
      kind: "mate.provider-instruction-sync.disabled-projection.failed",
      process: "main",
      message: "Mate reset 後の Provider Instruction cleanup が完了しませんでした。再同期を実行してください。",
      error: appLogService.errorToLogError(error),
    });
  }
}

async function applyPendingGrowth(): ReturnType<MateGrowthApplyService["applyPendingGrowth"]> {
  if (requireMateStorage().getMateState() === "not_created") {
    return {
      candidateCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      revisionId: null,
    };
  }

  const result = await requireMateGrowthApplyService().applyPendingGrowth();
  if (result.revisionId && requireMateStorage().getMateState() === "active") {
    const profile = requireMateStorage().getMateProfile();
    if (profile) {
      await syncEnabledProviderInstructionTargetsForMateProfile(profile);
    } else {
      writeAppLog({
        level: "warn",
        kind: "mate.provider-instruction-sync.skipped",
        process: "main",
        message: "Provider Instruction Target の同期対象プロファイルが見つかりませんでした",
        data: {
          revisionId: result.revisionId,
        },
      });
    }
  }

  return result;
}

function extractMateTalkAssistantMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const assistantMessage = (value as { assistantMessage?: unknown }).assistantMessage;
  return typeof assistantMessage === "string" && assistantMessage.trim()
    ? assistantMessage.trim()
    : null;
}

async function generateMateTalkAssistantMessage(input: {
  userMessage: string;
  mateProfile: {
    id: string;
    displayName: string;
    description: string;
    themeMain: string;
    themeSub: string;
    contextText?: string;
  };
}): Promise<string> {
  const appSettings = requireAppSettingsStorage().getSettings();
  const settings = getMateMemoryGenerationSettings(appSettings);
  let lastFailure: Error | null = null;
  const workspaceService = requireMateTalkRuntimeWorkspaceService();
  let preparedRun: { workspacePath: string; lockPath: string } | null = null;

  try {
    preparedRun = await workspaceService.prepareRun();
    await workspaceService.regenerateInstructionFiles(buildMateTalkRuntimeInstructionFiles(input.mateProfile));
    const profileContextText = sanitizeMateTalkProfileContextText(input.mateProfile.contextText);

    for (const candidate of settings.priorityList) {
      const providerSettings = getProviderAppSettings(appSettings, candidate.provider);
      if (!providerSettings.enabled) {
        continue;
      }

      const backgroundAdapter = getProviderBackgroundAdapter(candidate.provider);
      if (!canUseProviderForMateTalkBackgroundPrompt(backgroundAdapter)) {
        console.warn("メイトーク背景 structured prompt の条件を満たさない provider をスキップしました:", candidate.provider);
        continue;
      }

      try {
        const result = await backgroundAdapter.runBackgroundStructuredPrompt({
          providerId: candidate.provider,
          workspacePath: preparedRun.workspacePath,
          appSettings,
          model: candidate.model,
          reasoningEffort: candidate.reasoningEffort,
          timeoutMs: candidate.timeoutSeconds * 1000,
          prompt: {
            systemText: [
              "あなたは WithMate の Mate として、ユーザーと自然に会話します。",
              "Mate の現在の定義を尊重し、まだ未確定な性格や口調は決めつけすぎないでください。",
              "ファイル操作や外部操作は行わず、会話文だけを返してください。",
              "返答は JSON object のみを返してください。",
            ].join("\n"),
            userText: [
              "# Mate",
              `id: ${input.mateProfile.id}`,
              `name: ${input.mateProfile.displayName}`,
              `description: ${input.mateProfile.description || "(未設定)"}`,
              ...(profileContextText ? [``, "# Profile context", profileContextText] : []),
              "",
              "# User message",
              input.userMessage,
              "",
              "# Output JSON shape",
              '{"assistantMessage":"..."}',
            ].join("\n"),
            outputSchema: MATE_TALK_OUTPUT_SCHEMA,
          },
        });

        const output = result.structuredOutput ?? result.parsedJson ?? result.output;
        const assistantMessage = extractMateTalkAssistantMessage(output);
        if (assistantMessage) {
          return assistantMessage;
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error : new Error(String(error));
        console.warn("Failed to generate MateTalk response", candidate.provider, lastFailure);
      }
    }

    if (lastFailure) {
      throw lastFailure;
    }

    throw new Error("有効な MateTalk provider が見つかりませんでした。");
  } finally {
    if (preparedRun) {
      await workspaceService.completeRun();
    }
  }
}

function requireMateGrowthStorage(): MateGrowthStorage {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  if (!mateGrowthStorage) {
    mateGrowthStorage = new MateGrowthStorage(dbPath);
  }

  return mateGrowthStorage;
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

function requireMateProjectDigestStorage(): MateProjectDigestStorage {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  if (!mateProjectDigestStorage) {
    mateProjectDigestStorage = new MateProjectDigestStorage(dbPath);
  }

  return mateProjectDigestStorage;
}

function requireProviderInstructionTargetStorage(): ProviderInstructionTargetStorage {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  if (!providerInstructionTargetStorage) {
    providerInstructionTargetStorage = new ProviderInstructionTargetStorage(dbPath);
  }

  return providerInstructionTargetStorage;
}

function requireMateProjectContextService(): MateProjectContextService {
  if (!mateProjectContextService) {
    mateProjectContextService = new MateProjectContextService(
      requireMateProfileItemStorage(),
      requireMateSemanticEmbeddingRetrievalService(),
    );
  }

  return mateProjectContextService;
}

function resolveMateProjectDigestForSession(session: Session): MateProjectDigest | null {
  const activeMateStorage = requireMateStorage();
  if (activeMateStorage.getMateState() === "not_created") {
    return null;
  }

  try {
    return requireMateProjectDigestStorage().resolveProjectDigestForWorkspace(session.workspacePath);
  } catch (error) {
    console.warn("Failed to resolve Mate Project Digest", session.id, error);
    return null;
  }
}

async function resolveMateProjectContextTextForPrompt(
  session: Session,
  userMessage: string,
): Promise<string | null> {
  const digest = resolveMateProjectDigestForSession(session);
  if (!digest) {
    return null;
  }

  try {
    return await requireMateProjectContextService().getProjectDigestContextText(digest.id, {
      queryText: userMessage,
    });
  } catch (error) {
    console.warn("Failed to resolve Mate Project Context", session.id, error);
    return null;
  }
}

function requireMateGrowthApplyService(): MateGrowthApplyService {
  if (!mateGrowthApplyService) {
    mateGrowthApplyService = new MateGrowthApplyService(
      requireMateGrowthStorage(),
      requireMateProfileItemStorage(),
      requireMateStorage(),
      requireMateSemanticEmbeddingIndexService(),
    );
  }

  return mateGrowthApplyService;
}

function requireMateEmbeddingVectorizer(): MateEmbeddingVectorizer {
  if (!mateEmbeddingVectorizer) {
    mateEmbeddingVectorizer = new MateEmbeddingVectorizer(requireMateEmbeddingCacheService());
  }

  return mateEmbeddingVectorizer;
}

function requireMateSemanticEmbeddingStorage(): MateSemanticEmbeddingStorage {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  if (!mateSemanticEmbeddingStorage) {
    mateSemanticEmbeddingStorage = new MateSemanticEmbeddingStorage(dbPath);
  }

  return mateSemanticEmbeddingStorage;
}

function requireMateSemanticEmbeddingRetrievalService(): MateSemanticEmbeddingRetrievalService {
  if (!mateSemanticEmbeddingRetrievalService) {
    mateSemanticEmbeddingRetrievalService = new MateSemanticEmbeddingRetrievalService(
      requireMateEmbeddingCacheService(),
      requireMateEmbeddingVectorizer(),
      requireMateSemanticEmbeddingStorage(),
    );
  }

  return mateSemanticEmbeddingRetrievalService;
}

function requireMateSemanticEmbeddingIndexService(): MateSemanticEmbeddingIndexService {
  if (!mateSemanticEmbeddingIndexService) {
    mateSemanticEmbeddingIndexService = new MateSemanticEmbeddingIndexService(
      requireMateEmbeddingCacheService(),
      requireMateEmbeddingVectorizer(),
      requireMateSemanticEmbeddingStorage(),
    );
  }

  return mateSemanticEmbeddingIndexService;
}

function requireMateEmbeddingCacheService(): MateEmbeddingCacheService {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  if (!mateEmbeddingCacheService) {
    mateEmbeddingCacheService = new MateEmbeddingCacheService(dbPath, app.getPath("userData"));
  }

  return mateEmbeddingCacheService;
}

async function startMateEmbeddingDownload(): Promise<void> {
  const service = requireMateEmbeddingCacheService();
  const settings = service.getEmbeddingSettings();
  if (!settings) {
    return;
  }

  const downloadService = new MateEmbeddingDownloadService({ cacheService: service });
  await downloadService.downloadModel();
}

async function runMateTalkTurn(input: MateTalkTurnInput): Promise<MateTalkTurnResult> {
  const service = new MateTalkService({
    getMateProfile: () => requireMateStorage().getMateProfile(),
    getMateProfileContextText: (profile) => {
      try {
        const profileItems = requireMateProfileItemStorage().listProfileItems({
          state: "active",
          projectionAllowed: true,
          projectDigestId: null,
          limit: 40,
        }).map(({ sectionKey, claimKey, renderedText }) => ({
          sectionKey,
          claimKey,
          renderedText,
        }));
        return buildMateTalkProfileContextText({
          ...profile,
          profileItems,
        });
      } catch (error) {
        console.warn("Failed to load Mate profile items for MateTalk", error);
        return buildMateTalkProfileContextText(profile);
      }
    },
    generateAssistantMessage: generateMateTalkAssistantMessage,
    scheduleMemoryGeneration: ({ userMessage, assistantText }) => {
      const mateProfile = requireMateStorage().getMateProfile();
      const recentConversationText = [
        userMessage.trim() ? `User: ${userMessage.trim()}` : null,
        assistantText.trim() ? `Assistant: ${assistantText.trim()}` : null,
      ].filter((entry): entry is string => Boolean(entry)).join("\n\n");
      const providerIds = getMateMemoryGenerationProviderIds();
      if (!recentConversationText || providerIds.length === 0) {
        return;
      }

      void requireMateMemoryGenerationService().runOnce({
        recentConversationText,
        providerIds,
        sourceDefaults: {
          sourceType: "mate_talk",
          sourceSessionId: null,
          sourceAuditLogId: null,
          projectDigestId: null,
        },
        mateName: mateProfile?.displayName,
        mateSummary: mateProfile?.description,
      }).catch((error) => {
        console.warn("Failed to run MateTalk Memory generation", error);
      });
    },
  });

  return service.runTurn(input);
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
  return dbPath.length > 0 && isValidV3Database(dbPath);
}

function requireCompanionAuditLogStorage(): CompanionAuditLogStorageV3 {
  if (!companionAuditLogStorage) {
    if (!canUseCompanionAuditLogStorage()) {
      throw new Error("companion audit log storage は V3 DB でだけ利用できます。");
    }
    companionAuditLogStorage = new CompanionAuditLogStorageV3(dbPath, path.join(path.dirname(dbPath), "blobs", "v3"));
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
      listMateProfileItems: () => requireMateProfileItemStorage().listProfileItems({ state: "active" }).map((item) => ({
        id: item.id,
        sectionKey: item.sectionKey,
        projectDigestId: item.projectDigestId,
        category: item.category,
        claimKey: item.claimKey,
        claimValue: item.claimValue,
        renderedText: item.renderedText,
        normalizedClaim: item.normalizedClaim,
        confidence: item.confidence,
        salienceScore: item.salienceScore,
        state: item.state,
        tags: item.tags.map((tag) => `${tag.type}:${tag.value}`),
        updatedAt: item.updatedAt,
      })),
      forgetMateProfileItem: (itemId) => requireMateProfileItemStorage().forgetProfileItem(itemId),
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
      listSessions: () => listFullStoredSessions(),
      upsertStoredSession: (session) => requireSessionStorageForWrite().upsertSession(session),
      reloadStoredSessions: () => listFullStoredSessions(),
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
      getSession: getDisplaySession,
        upsertSession: (session) => requireMainSessionPersistenceFacade().upsertSession(session),
      resolveComposerPreview,
      resolveSessionCharacter,
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      resolveProviderCatalog,
      getProviderCodingAdapter,
      getSessionMemory: (session) => requireSessionMemoryStorage().ensureSessionMemory(session),
      resolveProjectMemoryEntriesForPrompt: (session, userMessage, sessionMemory) =>
        requireSessionMemorySupportService().resolveProjectMemoryEntriesForPrompt(session, userMessage, sessionMemory),
      resolveProjectContextTextForPrompt: (session, userMessage) =>
        resolveMateProjectContextTextForPrompt(session, userMessage),
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
      scheduleMateMemoryGeneration: (params) => {
        const activeMateStorage = requireMateStorage();
        if (activeMateStorage.getMateState() === "not_created") {
          return;
        }

        const mateProfile = activeMateStorage.getMateProfile();
        const userMessage = params.userMessage.trim();
        const assistantText = params.assistantText.trim();
        const recentConversationText = [
          userMessage ? `User: ${userMessage}` : null,
          assistantText ? `Assistant: ${assistantText}` : null,
        ].filter((entry): entry is string => Boolean(entry)).join("\n\n");
        const providerIds = getMateMemoryGenerationProviderIds();
        if (!recentConversationText || providerIds.length === 0) {
          return;
        }

        void requireMateMemoryGenerationService().runOnce({
          recentConversationText,
          providerIds,
          sourceDefaults: {
            sourceType: "session",
            sourceSessionId: params.session.id,
            sourceAuditLogId: params.auditLogId,
            projectDigestId: resolveMateProjectDigestForSession(params.session)?.id ?? null,
          },
          mateName: mateProfile?.displayName,
          mateSummary: mateProfile?.description,
        }).catch((error) => {
          console.warn("Failed to run Mate Memory generation", params.session.id, error);
        });
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

function requireCompanionSessionService(): CompanionSessionService {
  if (!companionSessionService) {
    companionSessionService = new CompanionSessionService({
      appDataPath: app.getPath("userData"),
      storage: requireCompanionStorage(),
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
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      resolveProviderCatalog,
      getProviderCodingAdapter,
      ...(canUseCompanionAuditLogStorage()
        ? {
            createAuditLog: (entry) => requireCompanionAuditLogService().createAuditLog(entry),
            updateAuditLog: (id, entry) => requireCompanionAuditLogService().updateAuditLog(id, entry),
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
      clearWorkspaceFileIndex,
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
      upsertStoredSession: (session) => requireSessionStorageForWrite().upsertSession(session),
      replaceStoredSessions: async (nextSessions) => {
        await requireSessionStorageForWrite().replaceSessions(nextSessions);
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
      updateAppSettings: updateAppSettingsAndSyncMateGrowth,
      getModelCatalog,
      ensureModelCatalogSeeded: () => requireModelCatalogStorage().ensureSeeded(),
      importModelCatalogDocument: (document, source) => requireModelCatalogStorage().importCatalogDocument(document, source),
      exportModelCatalogDocument: (revision) => requireModelCatalogStorage().exportCatalogDocument(revision),
      replaceAllSessions: (nextSessions, options) =>
        requireMainSessionPersistenceFacade().replaceAllSessions(nextSessions, options),
      clearProviderQuotaTelemetry,
      clearSessionContextTelemetry,
      invalidateProviderSessionThread,
      clearAuditLogs: async () => {
        await requireAuditLogService().clearAuditLogs();
        if (canUseCompanionAuditLogStorage()) {
          await requireCompanionAuditLogService().clearAuditLogs();
        }
      },
      resetAppSettings: resetAppSettingsAndSyncMateGrowth,
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
  const nextMateMemoryStorage = new MateMemoryStorage(dbPath);
  try {
    const bundle = await requirePersistentStoreLifecycleService().initialize(
      dbPath,
      bundledModelCatalogPath,
      app.getPath("userData"),
    );
    mateMemoryStorage = nextMateMemoryStorage;
    const activeModelCatalog = applyPersistentStoreBundle(bundle);
    startWalMaintenance();
    return activeModelCatalog;
  } catch (error) {
    nextMateMemoryStorage.close();
    throw error;
  }
}

function closePersistentStores(): void {
  stopWalMaintenance();
  mainInfrastructureRegistry?.getMainBootstrapService().clearGrowthApplyTimer();
  companionStorage?.close();
  companionAuditLogStorage?.close();
  mateMemoryStorage?.close();
  mateGrowthStorage?.close();
  mateProfileItemStorage?.close();
  mateProjectDigestStorage?.close();
  providerInstructionTargetStorage?.close();
  mateEmbeddingCacheService?.close();
  mateSemanticEmbeddingStorage?.close();
  requirePersistentStoreLifecycleService().close({
    modelCatalogStorage,
    sessionStorage,
    sessionMemoryStorage,
    projectMemoryStorage,
    characterMemoryStorage,
    auditLogStorage,
    appSettingsStorage,
    mateStorage,
  }, dbPath);
  modelCatalogStorage = null;
  sessionStorage = null;
  sessionMemoryStorage = null;
  projectMemoryStorage = null;
  characterMemoryStorage = null;
  auditLogStorage = null;
  auditLogService = null;
  appSettingsStorage = null;
  mateStorage = null;
  mateMemoryStorage = null;
  mateGrowthStorage = null;
  mateProfileItemStorage = null;
  mateProjectDigestStorage = null;
  providerInstructionTargetStorage = null;
  mateProjectContextService = null;
  mateSemanticEmbeddingRetrievalService = null;
  mateGrowthApplyService = null;
  mateEmbeddingVectorizer = null;
  mateSemanticEmbeddingStorage = null;
  mateSemanticEmbeddingIndexService = null;
  mateEmbeddingCacheService = null;
  memoryRuntimeWorkspaceService = null;
  mateTalkRuntimeWorkspaceService = null;
  mateMemoryGenerationService = null;
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
  mainInfrastructureRegistry?.getMainBootstrapService().clearGrowthApplyTimer();
  mateMemoryStorage?.close();
  mateMemoryStorage = null;
  mateGrowthStorage?.close();
  mateGrowthStorage = null;
  mateProfileItemStorage?.close();
  mateProfileItemStorage = null;
  mateProjectDigestStorage?.close();
  mateProjectDigestStorage = null;
  providerInstructionTargetStorage?.close();
  providerInstructionTargetStorage = null;
  mateSemanticEmbeddingStorage?.close();
  mateSemanticEmbeddingStorage = null;
  mateProjectContextService = null;
  mateSemanticEmbeddingRetrievalService = null;
  mateGrowthApplyService = null;
  mateEmbeddingVectorizer = null;
  mateSemanticEmbeddingIndexService = null;
  mateEmbeddingCacheService?.close();
  mateEmbeddingCacheService = null;
  companionStorage?.close();
  companionAuditLogStorage?.close();
  const bundle = await requirePersistentStoreLifecycleService().recreate(dbPath, bundledModelCatalogPath, {
    modelCatalogStorage,
    sessionStorage,
    sessionMemoryStorage,
    projectMemoryStorage,
    characterMemoryStorage,
    auditLogStorage,
    appSettingsStorage,
    mateStorage,
  }, app.getPath("userData"));

  auditLogService = null;
  companionStorage = null;
  companionAuditLogService = null;
  companionAuditLogStorage = null;
  companionSessionService = null;
  companionRuntimeService = null;
  companionReviewService = null;
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
  memoryRuntimeWorkspaceService = null;
  mateTalkRuntimeWorkspaceService = null;
  mateMemoryGenerationService = null;
  mateEmbeddingCacheService = null;
  mainInfrastructureRegistry?.reset();
  mainInfrastructureRegistry = null;
  mateMemoryStorage = new MateMemoryStorage(dbPath);
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

async function getDisplaySession(sessionId: string): Promise<Session | null> {
  const liveSession = getSession(sessionId);
  if (
    liveSession
    && (liveSession.messages.length > 0 || liveSession.stream.length > 0 || isSessionRunInFlight(sessionId))
  ) {
    return liveSession;
  }

  return await requireMainQueryService().getSession(sessionId) ?? liveSession ?? null;
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

async function refreshCharactersFromStorage(): Promise<CharacterProfile[]> {
  return requireMainCharacterFacade().refreshCharactersFromStorage();
}

async function getCharacter(characterId: string): Promise<CharacterProfile | null> {
  return requireMainCharacterFacade().getCharacter(characterId);
}

function broadcastSessions(sessionIds?: Iterable<string>): void {
  requireMainBroadcastFacade().broadcastSessions(sessionIds);
}

async function broadcastCompanionSessions(): Promise<void> {
  requireWindowBroadcastService().broadcastCompanionSessionSummaries(await listCompanionSessionSummaries());
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

async function searchCompanionWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]> {
  const session = await requireCompanionStorage().getSession(sessionId);
  if (!session) {
    throw new Error("対象 CompanionSession が見つからないよ。");
  }

  return searchWorkspacePathCandidates(session.worktreePath, query);
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

