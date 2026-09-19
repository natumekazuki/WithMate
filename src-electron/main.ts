import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  shell,
  Tray,
  type NativeImage,
} from "electron";

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
  type SessionCharacterUsage,
  type SessionSummaryPageRequest,
  type HomeSessionSummaryPageResult,
} from "../src/app-state.js";
import {
  type DiffPreviewPayload,
  getSessionIncarnationId,
  type MessageArtifact,
  type Session,
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
import {
  buildOpenSessionWindowIdsPage,
} from "../src/withmate-window-types.js";
import type {
  OpenPathOptions,
  OpenPathResult,
  OpenSessionWindowIdsPageRequest,
  OpenSessionWindowIdsPageResult,
  SavePastedSessionFileRequest,
} from "../src/withmate-window-types.js";
import type {
  SessionFileHistoryDiffWindowPayload,
  SessionFilePreviewWindowOpenRequest,
  SessionFilePreviewWindowOpenResult,
} from "../src/file-explorer/file-explorer-contract.js";
import {
  isSessionFileGitCommitResource,
  resolveSessionFileGitCommitPreviewWindowTitle,
  resolveSessionFilePreviewWindowTitle,
} from "../src/file-explorer/file-explorer-contract.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogService } from "./audit-log-service.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { PromptTemplateStorage } from "./prompt-template-storage.js";
import { createV6StorageWorkerBundle, type V6StorageWorkerBundle } from "./storage-worker-bundle.js";
import { createAppDatabaseBootstrapWorker } from "./app-database-bootstrap-worker.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../src/prompt-template.js";
import { resolveAuxiliaryParentSession } from "./auxiliary-parent-session.js";
import { AuxiliarySessionService } from "./auxiliary-session-service.js";
import { admitSessionTurn } from "./session-turn-admission.js";
import {
  AuxiliarySessionStorage,
  resolveLegacyAuxiliaryPreviewFromAuditEntries,
} from "./auxiliary-session-storage.js";
import { CharacterService } from "./character-service.js";
import { CharacterWorkspaceOperationCoordinator } from "./character-workspace-operation-coordinator.js";
import { CharacterStorage } from "./character-storage.js";
import {
  CharacterAuthoringService,
  CHARACTER_AUTHORING_SKILL_NAME,
  resolveCharacterAuthoringRuntimeSessionForTurn,
} from "./character-authoring-service.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CopilotAdapter } from "./copilot-adapter.js";
import { resolveComposerPreview } from "./composer-attachments.js";
import { areDirectoryPathsEquivalent } from "./additional-directories.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import {
  openLocalPathWithDefaultApp,
  revealLocalPathInFileManager,
  resolveProtocolRelativeExternalFallbackAfterLocalOpen,
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
import { resolveConversationTimingContext } from "./conversation-timing.js";
import { SessionTurnNotificationService } from "./session-turn-notification-service.js";
import { createCharacterAffectTurnRecoveryFailureLogData } from "./character-affect-turn-recovery.js";
import { CharacterAffectTurnRetryScheduler } from "./character-affect-turn-retry-scheduler.js";
import { CharacterAffectTurnOwnershipCoordinator } from "./character-affect-turn-ownership-coordinator.js";
import { createCharacterAffectTurnMainLifecycle } from "./character-affect-turn-main-lifecycle.js";
import type { CharacterAffectTurnDrainCursor } from "./character-affect-turn-drain.js";
import { CharacterAffectTurnSettlementStorage } from "./character-affect-turn-settlement-storage.js";
import { SessionPersistenceService } from "./session-persistence-service.js";
import { createSessionStorageCommandAdapter } from "./session-storage-command-adapter.js";
import { SessionWindowBridge } from "./session-window-bridge.js";
import { SessionWindowRestoreService } from "./session-window-restore-service.js";
import { SessionWindowRestoreStorage } from "./session-window-restore-storage.js";
import { SettingsCatalogService } from "./settings-catalog-service.js";
import { SessionObservabilityService } from "./session-observability-service.js";
import { SessionApprovalService } from "./session-approval-service.js";
import { SessionElicitationService } from "./session-elicitation-service.js";
import { WindowBroadcastService } from "./window-broadcast-service.js";
import { WindowDialogService } from "./window-dialog-service.js";
import { WorkspaceDirectoryValidationService } from "./workspace-directory-validation-service.js";
import { SessionMemorySupportService } from "./session-memory-support-service.js";
import { SessionFileExplorerService, type SessionFileExplorerContext } from "./session-file-explorer-service.js";
import { SessionFilePreviewImageCopyService } from "./session-file-preview-image-copy-service.js";
import { SessionFileObjectCopyService } from "./session-file-object-copy-service.js";
import { SessionFileTreeContextMenuService } from "./session-file-tree-context-menu-service.js";
import { SessionMonitorContextMenuService } from "./session-monitor-context-menu-service.js";
import { MarkdownLinkContextMenuService } from "./markdown-link-context-menu-service.js";
import { WindowsFileDropClipboardWriter } from "./windows-file-drop-clipboard-writer.js";
import { FileRootGitChangesService } from "./file-root-git-changes-service.js";
import {
  appendSessionFilesDirectory,
  appendSessionFilesDirectoryForSessionId,
  copyFilesToSessionFiles as copyFilesToSessionFilesStorage,
  createSessionFilesDirectory,
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
  type SessionPinStorage,
  type SessionStorageRead,
  type SessionStorageWrite,
} from "./persistent-store-lifecycle-service.js";
import { AppLifecycleService } from "./app-lifecycle-service.js";
import { createAppLifecycleDeps } from "./app-lifecycle-deps.js";
import {
  applyLaunchAtLoginSetting,
  resolveAppUserModelId,
  shouldLaunchInBackground,
} from "./app-login-item.js";
import { AppTrayService } from "./app-tray-service.js";
import { createMainBootstrapDeps } from "./main-bootstrap-deps.js";
import { MainInfrastructureRegistry } from "./main-infrastructure-registry.js";
import { MainBootstrapService } from "./main-bootstrap-service.js";
import { MainBroadcastFacade } from "./main-broadcast-facade.js";
import { MainObservabilityFacade } from "./main-observability-facade.js";
import { MainProviderFacade } from "./main-provider-facade.js";
import { MainSessionCommandFacade } from "./main-session-command-facade.js";
import { ProviderRuntimeOperationCoordinator } from "./provider-runtime-operation-coordinator.js";
import { runWithStorageOperationCorrelation, startEventLoopDelayMonitoring, type StorageOperationDiagnostic } from "./storage-operation-diagnostics.js";
import { MainSessionPersistenceFacade } from "./main-session-persistence-facade.js";
import { SessionLaunchSelectionService } from "./session-launch-selection-service.js";
import { MainWindowFacade } from "./main-window-facade.js";
import { MainQueryService } from "./main-query-service.js";
import {
  ManagedSkillDistributionService,
  type ManagedSkillBundleDescriptor,
  WITHMATE_GLOSSARY_SKILL_NAME,
} from "./managed-skill-distribution-service.js";
import { MemoryCliShimService } from "./memory-cli-shim-service.js";
import { hydrateSessionsFromSummaries } from "./session-summary-adapter.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { ChatLayoutPreferenceUpdate } from "../src/chat/chat-layout-preference.js";
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
import { projectMemoryV6Diagnostics } from "../src/memory-v6/memory-diagnostics-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest } from "../src/memory-v6/memory-contract.js";
import {
  CHARACTER_CONTEXT_SCHEMA_VERSION,
  isCharacterContextError,
} from "../src/character-context/character-context-contract.js";
import type { MemoryV6ProtectedObjectGcRequest } from "../src/memory-v6/memory-review-state.js";
import {
  assertPersistentStoreOwnerActive,
  capturePersistentStoreOwner,
} from "./persistent-store-owner-guard.js";
import {
  startMemoryV6RuntimeApi,
  type MemoryV6RuntimeApiHandle,
} from "./memory-v6-runtime.js";
import { exportMemoryProtectedObjectFile, exportMemoryProtectedObjectFiles } from "./memory-protected-object-exporter.js";
import { createElectronSafeStorageKeyProtector, MemoryProtectedObjectKeyStore } from "./memory-protected-object-key-store.js";
import { MemoryProtectedObjectStore } from "./memory-protected-object-store.js";
import { MemoryV6ReviewService } from "./memory-v6-review-service.js";
import { AgentRuntimeBindingRegistry } from "./agent-runtime-binding.js";
import { updateAuxiliarySessionWithProviderRuntimeLifecycle } from "./auxiliary-provider-runtime-lifecycle.js";
import { getMemoryV6AgentRuntimeOperations } from "./memory-v6-http-server.js";
import { RuntimeDiscoveryRegistryError } from "../src/runtime-discovery/runtime-discovery-contract.js";
import {
  GlossaryApplicationService,
  projectGlossaryCheckoutAuthority,
} from "./glossary-application-service.js";
import { GlossaryRuntimeService } from "./glossary-runtime-service.js";
import { ProviderAgentRuntimeTurnCoordinator } from "./provider-agent-runtime-turn-coordinator.js";
import { buildProviderAgentRuntimeAuthoritySnapshot } from "./provider-agent-runtime-binding.js";
import { resolveMemoryV6ProjectCandidate } from "./memory-v6-project-resolver.js";
import { resolveBundledMemoryCliScriptPath } from "../scripts/build-withmate-memory-cli.js";
import { GlossarySessionProjectionService } from "./glossary-session-projection-service.js";
import { SessionGlossaryWindowSubscriptionCoordinator } from "./session-glossary-window-subscription.js";
import { getGlossaryAgentRuntimeOperations } from "../src/glossary-operation-schema.js";
import {
  WITHMATE_APP_BOOT_STATUS_EVENT,
  WITHMATE_GET_APP_BOOT_STATUS_CHANNEL,
  WITHMATE_OPEN_AUXILIARY_SESSION_EVENT,
  WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT,
  WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT,
} from "../src/withmate-ipc-channels.js";
import { CREATE_V2_SCHEMA_SQL } from "./database-schema-v2.js";
import { CREATE_V3_SCHEMA_SQL, isValidV3Database } from "./database-schema-v3.js";
import { isValidV4Database } from "./database-schema-v4.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import {
  markMainThreadAsNonStorageOwner,
  openAppDatabase,
  SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
  truncateAppDatabaseWal,
  truncateAppDatabaseWalIfLargerThan,
} from "./sqlite-connection.js";

markMainThreadAsNonStorageOwner();

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "preload.js");
const rendererDistPath = path.resolve(currentDir, "../../dist");
const appDataPath = app.getPath("appData");
const userDataPathOverride = process.env.WITHMATE_USER_DATA_PATH?.trim();
const fixedUserDataPath = userDataPathOverride ? path.resolve(userDataPathOverride) : path.join(appDataPath, "WithMate");
const applicationInstanceId = crypto.randomUUID();
const processStartedAt = new Date().toISOString();
const runtimeBuildChannel = process.argv.some((argument) => argument.toLowerCase() === "--withmate-visual-check")
  ? "visual-check" as const
  : app.isPackaged
    ? "installed" as const
    : "development" as const;
app.setAppUserModelId(resolveAppUserModelId({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
}));
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
const bundledMemoryCliScriptPath = resolveBundledMemoryCliScriptPath({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  currentDir,
});
const bundledGlossarySkillPath = app.isPackaged
  ? path.join(process.resourcesPath, "resources", "skills", WITHMATE_GLOSSARY_SKILL_NAME)
  : path.resolve(currentDir, "../../resources/skills", WITHMATE_GLOSSARY_SKILL_NAME);
const trayIconPath = path.resolve(currentDir, "../../build/icon.ico");
const sessionFilePreviewImageCopyService = new SessionFilePreviewImageCopyService({
  buildMenu: (template) => Menu.buildFromTemplate(template),
});
const windowsFileDropClipboardWriter = new WindowsFileDropClipboardWriter({ platform: process.platform });
const sessionFileObjectCopyService = new SessionFileObjectCopyService({
  platform: process.platform,
  createAuthorizationBoundary: createSessionFileExplorerService,
  writeNativeFileDrop: (targetPath) => windowsFileDropClipboardWriter.copyFile(targetPath),
  buildMenu: (template) => Menu.buildFromTemplate(template),
});
const sessionFileTreeContextMenuService = new SessionFileTreeContextMenuService({
  platform: process.platform,
  createAuthorizationBoundary: createSessionFileExplorerService,
  writeText: (targetPath) => clipboard.writeText(targetPath),
  copyFileObject: (resource) => sessionFileObjectCopyService.copyTreeResource(resource),
  buildMenu: (template) => Menu.buildFromTemplate(template),
});
const sessionMonitorContextMenuService = new SessionMonitorContextMenuService({
  requestCloseSessionWindow: (sessionId) => requireMainWindowFacade().requestCloseSessionWindow(sessionId),
  closeCompanionReviewWindow: (sessionId) => requireMainWindowFacade().closeCompanionReviewWindow(sessionId),
  writeText: (value) => clipboard.writeText(value),
  buildMenu: (template) => Menu.buildFromTemplate(template),
});
const markdownLinkContextMenuService = new MarkdownLinkContextMenuService({
  buildMenu: (template) => Menu.buildFromTemplate(template),
  writeText: (target) => clipboard.writeText(target),
  resolveCopyableFile: (request) => request.fileContext
    ? sessionFileObjectCopyService.resolveCopyableLinkResource({
        ...request.fileContext,
        target: request.target,
      })
    : Promise.resolve(null),
  copyFile: (resource) => sessionFileObjectCopyService.copyResource(resource),
});
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
let modelCatalogStorage: PersistentStoreBundle["modelCatalogStorage"] | null = null;
let characterStorage: CharacterStorageAccess | null = null;
let characterService: CharacterService | null = null;
let characterAuthoringService: CharacterAuthoringService | null = null;
let managedSkillDistributionService: ManagedSkillDistributionService | null = null;
let memoryCliShimService: MemoryCliShimService | null = null;
let auditLogStorage: AuditLogStorageRead | null = null;
let auxiliarySessionStorage: AuxiliarySessionStorageAccess | null = null;
let appSettingsStorage: PersistentStoreBundle["appSettingsStorage"] | null = null;
let storageWorker: V6StorageWorkerBundle | null = null;
let promptTemplateStorage: PromptTemplateStorage | V6StorageWorkerBundle["stores"]["prompt"] | null = null;
let mateStorage: PersistentStoreBundle["mateStorage"] | null = null;
let mateProfileItemStorage: MateProfileItemStorage | null = null;
type CompanionStorageHandle = CompanionStorage | CompanionStorageV3 | V6StorageWorkerBundle["stores"]["companion"];

let companionStorage: CompanionStorageHandle | null = null;
let allowQuitWithInFlightRuns = false;
let dbPath = "";
let appDatabaseDiagnostics: AppDatabaseDiagnostics | null = null;
let memoryV6RuntimeApi: MemoryV6RuntimeApiHandle | null = null;
let memoryV6RuntimeStatus: MemoryV6Diagnostics["runtime"]["status"] = "stopped";
let characterAffectTurnSettlementStorage: CharacterAffectTurnSettlementStorage | V6StorageWorkerBundle["stores"]["settlement"] | null = null;
let characterAffectTurnRetryScheduler: CharacterAffectTurnRetryScheduler | null = null;
let characterAffectTurnDrainCursor: CharacterAffectTurnDrainCursor | undefined;
const characterAffectTurnStartupRecoveryCutoff = new Date().toISOString();
const isBackgroundLaunch = shouldLaunchInBackground(process.argv);
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
let sessionTurnNotificationService: SessionTurnNotificationService<NativeImage> | null = null;
let auxiliarySessionService: AuxiliarySessionService | null = null;
let auxiliarySessionRuntimeService: SessionRuntimeService | null = null;
let sessionPersistenceService: SessionPersistenceService | null = null;
let sessionWindowBridge: SessionWindowBridge<BrowserWindow> | null = null;
let sessionWindowRestoreService: SessionWindowRestoreService | null = null;
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
let sessionLaunchSelectionService: SessionLaunchSelectionService | null = null;
const providerRuntimeOperationCoordinator = new ProviderRuntimeOperationCoordinator(logStorageOperationDiagnostic);
const characterAffectTurnOwnershipCoordinator = new CharacterAffectTurnOwnershipCoordinator(logStorageOperationDiagnostic);
const characterAffectTurnMainLifecycle = createCharacterAffectTurnMainLifecycle({
  getSettlementStorage: () => characterAffectTurnSettlementStorage,
  getRuntimeApi: () => memoryV6RuntimeApi,
  getCharacterSnapshot: (characterId) => requireCharacterService().createRuntimeSnapshot(characterId),
  getAppSettings: () => requireAppSettingsStorage().getSettings(),
  getProviderBackgroundAdapter,
  getSession: getRuntimeSession,
  startupRecoveryCutoff: characterAffectTurnStartupRecoveryCutoff,
  runAppraisalExclusive: (operation) => characterAffectTurnOwnershipCoordinator.runExclusive(operation),
  writeAppLog,
  getDrainCursor: () => characterAffectTurnDrainCursor,
  setDrainCursor: (cursor) => { characterAffectTurnDrainCursor = cursor; },
});
const agentRuntimeBindingRegistry = new AgentRuntimeBindingRegistry();
const glossaryApplicationService = new GlossaryApplicationService();
const glossarySessionProjectionService = new GlossarySessionProjectionService({
  applicationService: glossaryApplicationService,
  getSession,
  getBindingGeneration: (sessionId, providerId) =>
    agentRuntimeBindingRegistry.getExecutionGeneration(sessionId, providerId),
  subscribeBindingChanges: (listener) => agentRuntimeBindingRegistry.subscribeChanges((change) => {
    listener({ sessionId: change.actorSessionId, providerId: change.providerId });
  }),
});
const glossaryWindowSubscriptionCoordinator = new SessionGlossaryWindowSubscriptionCoordinator<BrowserWindow>({
  getWindow: (sessionId) => requireSessionWindowBridge().getWindow(sessionId),
  subscribe: (sessionId, listener) => glossarySessionProjectionService.subscribe(sessionId, listener),
  deliver: (window, projection) => {
    window.webContents.send(WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT, projection);
  },
});
const workspaceDirectoryValidationService = new WorkspaceDirectoryValidationService();
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

function logStorageOperationDiagnostic(event: StorageOperationDiagnostic): void {
  writeAppLog({
    level: "info",
    kind: "storage.operation",
    process: "main",
    message: `${event.operation}: ${event.stage}`,
    data: { ...event, generationId: event.generationId ?? storageWorker?.client.generationId },
  });
}

const stopEventLoopDelayMonitoring = startEventLoopDelayMonitoring((report) => writeAppLog({
  level: "info",
  kind: "main.event_loop_delay",
  process: "main",
  message: "Main event loop delay summary",
  data: report,
}));
app.once("will-quit", stopEventLoopDelayMonitoring);

async function getAppDatabaseDiagnostics(): Promise<AppDatabaseDiagnostics> {
  if (!appDatabaseDiagnostics) {
    if (!dbPath) {
      throw new Error("DB path が初期化されていないよ。");
    }
    appDatabaseDiagnostics = await inspectCurrentAppDatabase();
  }
  return appDatabaseDiagnostics;
}

function recordMemoryV6DiagnosticError(
  kind: string,
  _message: string,
  discoveryCode?: MemoryV6DiagnosticEvent["discoveryCode"],
): void {
  memoryV6DiagnosticErrors = [
    {
      kind,
      occurredAt: new Date().toISOString(),
      ...(discoveryCode ? { discoveryCode } : {}),
    },
    ...memoryV6DiagnosticErrors,
  ].slice(0, 3);
}

async function getMemoryV6Diagnostics(): Promise<MemoryV6Diagnostics> {
  const cliShimDiagnostics = await requireMemoryCliShimService().getDiagnostics();

  return projectMemoryV6Diagnostics({
    generatedAt: new Date().toISOString(),
    runtime: {
      status: memoryV6RuntimeApi ? "running" : memoryV6RuntimeStatus,
      applicationInstanceId: memoryV6RuntimeApi?.applicationInstanceId ?? null,
      runtimeGenerationId: memoryV6RuntimeApi?.runtimeGenerationId ?? null,
      buildChannel: memoryV6RuntimeApi?.buildChannel ?? null,
      discoveryPublished: Boolean(memoryV6RuntimeApi),
    },
    cliShim: {
      platform: cliShimDiagnostics.platform,
      commandName: cliShimDiagnostics.commandName,
      supported: cliShimDiagnostics.supported,
      status: cliShimDiagnostics.status,
      pathContainsShimDirectory: cliShimDiagnostics.pathContainsShimDirectory,
    },
    lastErrors: memoryV6DiagnosticErrors,
  });
}

async function installMemoryV6CliShim(): Promise<MemoryV6Diagnostics> {
  await requireMemoryCliShimService().install();
  return getMemoryV6Diagnostics();
}

async function uninstallMemoryV6CliShim(): Promise<MemoryV6Diagnostics> {
  await requireMemoryCliShimService().uninstall();
  return getMemoryV6Diagnostics();
}

function createMemoryV6ReviewService(): MemoryV6ReviewService {
  const runtime = memoryV6RuntimeApi;
  if (!runtime) {
    throw new Error("Memory V6 runtime が利用できないため、Memory を読み書きできません。");
  }
  const userDataPath = app.getPath("userData");
  const protectedObjectStore = MemoryProtectedObjectStore.fromUserDataPath(userDataPath);
  const protectedObjectKeyStore = MemoryProtectedObjectKeyStore.fromUserDataPath(
    userDataPath,
    createElectronSafeStorageKeyProtector(safeStorage),
  );
  return new MemoryV6ReviewService({
    resolveDbPath: () => runtime.dbPath,
    storage: runtime.memoryStorage,
    getMemoryFileQuotaBytes: async () => (await requireAppSettingsStorage().getSettings()).memoryFileQuotaBytes,
    protectedObjectStore,
    protectedObjectExporter: {
      exportFile: (input) => exportMemoryProtectedObjectFile({
        keyStore: protectedObjectKeyStore,
        objectStore: protectedObjectStore,
      }, input),
      exportFiles: (input) => exportMemoryProtectedObjectFiles({
        keyStore: protectedObjectKeyStore,
        objectStore: protectedObjectStore,
      }, input),
    },
  });
}

function getMemoryV6FileUsage() {
  return createMemoryV6ReviewService().getFileUsage();
}

async function exportMemoryV6EntryFiles(entryId: string, targetWindow?: BrowserWindow | null) {
  const outputDirectoryPath = await requireWindowDialogService().pickDirectory(targetWindow ?? null, null);
  if (!outputDirectoryPath) {
    return null;
  }
  return createMemoryV6ReviewService().exportEntryFiles(entryId, outputDirectoryPath);
}

function runMemoryV6ProtectedObjectGc(request: MemoryV6ProtectedObjectGcRequest) {
  return createMemoryV6ReviewService().runProtectedObjectGc(request);
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

async function resolveAgentRuntimeActorSession(sessionId: string) {
  const session = getSession(sessionId);
  if (session) {
    return {
      id: session.id,
      providerId: session.provider,
      characterId: session.characterId,
      workspacePath: session.workspacePath,
    };
  }
  if (!auxiliarySessionStorage) {
    return null;
  }
  const auxiliary = await requireAuxiliarySessionService().getAuxiliaryRuntimeSession(sessionId);
  return auxiliary
    ? {
        id: auxiliary.id,
        providerId: auxiliary.provider,
        characterId: auxiliary.characterId,
        workspacePath: auxiliary.workspacePath,
      }
    : null;
}

async function getGlossaryProactiveCreateLimit(): Promise<number | null> {
  return (await requireAppSettingsStorage().getSettings()).glossaryProactiveCreateLimit;
}

async function ensureSessionGlossarySubscription(sessionId: string): Promise<void> {
  await glossaryWindowSubscriptionCoordinator.ensure(sessionId);
}

const providerAgentRuntimeTurns = new ProviderAgentRuntimeTurnCoordinator();
const glossaryRuntimeService = new GlossaryRuntimeService({
  applicationService: glossaryApplicationService,
  bindingRegistry: agentRuntimeBindingRegistry,
  resolveActorSession: resolveAgentRuntimeActorSession,
  getProactiveCreateLimit: getGlossaryProactiveCreateLimit,
  providerAgentRuntimeTurns,
});

async function issueProviderAgentRuntimeBinding(
  session: Pick<Session, "id" | "characterId" | "sessionKind" | "workspacePath">,
  providerId: string,
) {
  const memoryAuthority = buildProviderAgentRuntimeAuthoritySnapshot({
    characterId: session.characterId,
    workspacePath: session.workspacePath,
    resolveCanonicalProjectId: (workspacePath) => resolveMemoryV6ProjectCandidate(workspacePath)?.id,
  });
  if (!memoryAuthority) {
    throw new Error("Provider runtime binding requires a canonical Character authority.");
  }
  let glossaryAuthority: ReturnType<typeof projectGlossaryCheckoutAuthority> | null = null;
  try {
    glossaryAuthority = projectGlossaryCheckoutAuthority(
      await glossaryApplicationService.resolvePrimaryCheckout(session.workspacePath),
    );
  } catch {
    // Non-Git workspaces keep Memory grants but do not receive glossary authority.
  }
  const binding = agentRuntimeBindingRegistry.issueOrReuse({
    actorSessionId: session.id,
    providerId,
    authoritySnapshot: {
      ...memoryAuthority,
      sessionKind: session.sessionKind,
      ...(glossaryAuthority ? { glossaryPrimaryCheckout: glossaryAuthority } : {}),
    },
    operationGrants: [
      ...getMemoryV6AgentRuntimeOperations(),
      ...(glossaryAuthority ? getGlossaryAgentRuntimeOperations() : []),
    ],
  });
  return memoryV6RuntimeApi
    ? {
        ...binding,
        memoryRuntimeOwner: {
          applicationInstanceId: memoryV6RuntimeApi.applicationInstanceId,
          runtimeGenerationId: memoryV6RuntimeApi.runtimeGenerationId,
        },
      }
    : binding;
}

async function startMemoryV6RuntimeApiBestEffort(): Promise<void> {
  if (memoryV6RuntimeApi) {
    return;
  }

  try {
    memoryV6RuntimeStatus = "stopped";
    memoryV6RuntimeApi = await startMemoryV6RuntimeApi({
      storageOperationDiagnosticSink: logStorageOperationDiagnostic,
      userDataPath: app.getPath("userData"),
      applicationInstanceId,
      buildChannel: runtimeBuildChannel,
      processStartedAt,
      listCharacters: () => requireCharacterService().listCharacters(),
      resolveCharacterById: async (id) => {
        const character = await requireCharacterService().getCharacterCatalogEntry(id);
        return character ? { id: character.id, name: character.name } : null;
      },
      resolveCharacterRuntimeSnapshot: (characterId) =>
        requireCharacterService().createRuntimeSnapshot(characterId),
      getMemoryFileQuotaBytes: async () => (await requireAppSettingsStorage().getSettings()).memoryFileQuotaBytes,
      protectedObjectKeyProtector: createElectronSafeStorageKeyProtector(safeStorage),
      agentRuntimeBindingRegistry,
      providerAgentRuntimeTurns,
      resolveActorSession: resolveAgentRuntimeActorSession,
      routeAgentRuntimeExtension: (request) => glossaryRuntimeService.route(request),
      log: writeAppLog,
    });
    memoryV6RuntimeStatus = "running";
    appDatabaseDiagnostics = await inspectCurrentAppDatabase();
  } catch (error) {
    memoryV6RuntimeStatus = "failed";
    recordMemoryV6DiagnosticError(
      "memory-v6.runtime-api.start-failed",
      error instanceof Error ? error.message : String(error),
      error instanceof RuntimeDiscoveryRegistryError && error.code === "registry_capacity"
        ? "WITHMATE_RUNTIME_REGISTRY_CAPACITY"
        : undefined,
    );
    writeAppLog({
      level: "warn",
      kind: "memory-v6.runtime-api.start-failed",
      process: "main",
      message: "Memory V6 runtime API did not start",
      data: { errorName: error instanceof Error ? error.name : "UnknownError" },
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
      data: { errorName: error instanceof Error ? error.name : "UnknownError" },
    });
  }
}

async function syncManagedGlossarySkillBestEffort(): Promise<void> {
  try {
    const results = await requireManagedSkillDistributionService().syncConfiguredProviderSkills(
      MANAGED_GLOSSARY_SKILL_BUNDLE,
    );
    const failed = results.filter((result) => result.status === "failed");
    const collisions = results.filter((result) => result.status === "skipped-collision");
    writeAppLog({
      level: failed.length > 0 || collisions.length > 0 ? "warn" : "info",
      kind: "glossary.skill.sync.completed",
      process: "main",
      message: "Glossary managed skill sync completed",
      data: {
        results,
      },
    });
  } catch (error) {
    writeAppLog({
      level: "warn",
      kind: "glossary.skill.sync.failed",
      process: "main",
      message: "Glossary managed skill sync failed",
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
  window.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    writeAppLog({
      level: "info",
      kind: "renderer.navigation-started",
      process: "main",
      message: "Renderer main-frame navigation started",
      windowId: window.id,
      data: {
        url,
        isInPlace,
        windowTitle: readWindowTitle(window),
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

function writeIpcErrorLog(input: {
  channel: string;
  durationMs: number;
  error: unknown;
  clientRequestId?: string;
}): void {
  writeAppLog({
    level: "error",
    kind: "ipc.error",
    process: "main",
    message: `IPC failed: ${input.channel}`,
    requestId: input.clientRequestId,
    data: {
      channel: input.channel,
      durationMs: input.durationMs,
      success: false,
      clientRequestId: input.clientRequestId,
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
  correlationId?: string;
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
    correlationId: typeof rawInput.correlationId === "string"
      ? truncateRendererLogString(rawInput.correlationId, MAX_RENDERER_LOG_STRING_LENGTH)
      : undefined,
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
    correlationId: sanitizedInput.correlationId,
    data: {
      url: sanitizedInput.url,
      detail: sanitizedInput.data,
    },
    error: sanitizedInput.error,
  });
}

async function openDirectory(directoryPath: string): Promise<void> {
  mkdirSync(directoryPath, { recursive: true });
  const result = await openLocalPath(directoryPath);
  if (result.status !== "opened") {
    throw new Error(result.message);
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

async function listSessionSummaryPage(request?: SessionSummaryPageRequest | null): Promise<HomeSessionSummaryPageResult> {
  return requireMainQueryService().listSessionSummaryPage(request);
}

async function listSessionCharacterUsage(): Promise<SessionCharacterUsage[]> {
  return requireMainQueryService().listSessionCharacterUsage();
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
  return auxiliaryRunParents.size > 0
    || Boolean(sessionRuntimeService?.hasInFlightRuns())
    || Boolean(companionRuntimeService?.hasInFlightRuns())
    || Boolean(auxiliarySessionRuntimeService?.hasInFlightRuns());
}

async function runSessionTurnAdmission<T>(sessionId: string, auxiliary: boolean, operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  const owner = requireActivePersistentStoreOwnerForFactory("Turn admission");
  return admitSessionTurn({
    runExclusive: (callback) => providerRuntimeOperationCoordinator.runExclusive(
      () => characterAffectTurnOwnershipCoordinator.runExclusive(callback, "session-turn-admission"),
      "session-turn-admission",
    ),
    assertCurrent: () => {
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      if (signal.aborted) throw new Error("Session run canceled.");
      if (databaseMaintenanceRequested) {
        throw new Error("DB のメンテナンス中は新しい Turn を開始できません。");
      }
    },
    reserve: operation,
    readProvider: async () => {
      const session = auxiliary
        ? await owner.auxiliarySessionStorage.getAuxiliarySession(sessionId)
        : await owner.sessionStorage.getSession(sessionId);
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      if (!session) {
        throw new Error("対象セッションが見つかりません。");
      }
      if ("parentSessionId" in session && !await owner.sessionStorage.getSession(session.parentSessionId)) {
        throw new Error("Auxiliary の親セッションが見つかりません。");
      }
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      return session.provider;
    },
    assertProviderAvailable: (provider) => requireSettingsCatalogService().assertProviderAvailableForTurn(provider),
  });
}

const auxiliaryRunParents = new Map<string, string>();
let databaseMaintenanceRequested = false;
let activePersistentStoreOwner: PersistentStoreBundle | null = null;

function requireActivePersistentStoreOwnerForFactory(ownerName: string): PersistentStoreBundle {
  return capturePersistentStoreOwner(
    () => activePersistentStoreOwner,
    ownerName,
  ).owner;
}

function assertPersistentStoreOwnerIsActive(
  owner: PersistentStoreBundle,
  operation: string,
): void {
  assertPersistentStoreOwnerActive(() => activePersistentStoreOwner, owner, operation);
}

function isSessionRunInFlight(sessionId: string): boolean {
  if (sessionRuntimeService?.isRunInFlight(sessionId) ||
      auxiliarySessionRuntimeService?.isRunInFlight(sessionId) || auxiliaryRunParents.has(sessionId)) {
    return true;
  }
  return [...auxiliaryRunParents.values()].includes(sessionId);
}

function listRunningActiveAuxiliaryParentSessionIds(parentSessionIds: readonly string[]): Set<string> {
  const runningParentSessionIds = new Set<string>();
  if (!auxiliarySessionStorage) {
    return runningParentSessionIds;
  }

  for (const parentSessionId of parentSessionIds) {
    const hasRunningAuxiliary = [...auxiliaryRunParents.values()].includes(parentSessionId);
    if (hasRunningAuxiliary) {
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
          getPrimaryHomeWindow: () => requireAuxWindowService().getHomeWindow(),
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
          loadFilePreviewEntry: (window, token) => requireWindowEntryLoader().loadFilePreviewEntry(window, token),
          navigateFilePreviewWindow: (window, payload) => {
            window.webContents.send(WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT, payload);
          },
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
          createV6StorageWorker: (input) => createV6StorageWorkerBundle({
            ...input,
            diagnosticSink: logStorageOperationDiagnostic,
          }),
          createModelCatalogStorage: (nextDbPath, nextBundledModelCatalogPath) =>
            new ModelCatalogStorage(nextDbPath, nextBundledModelCatalogPath),
          createCharacterStorage: (nextDbPath, nextUserDataPath) =>
            new CharacterStorage(nextDbPath, nextUserDataPath),
          createSessionStorage: (nextDbPath) => new SessionStorage(nextDbPath),
          createSessionMemoryStorage: (nextDbPath) => new SessionMemoryStorage(nextDbPath),
          createProjectMemoryStorage: (nextDbPath) => new ProjectMemoryStorage(nextDbPath),
          createAuditLogStorage: (nextDbPath) => new AuditLogStorage(nextDbPath),
          createAuxiliarySessionStorage: (nextDbPath) => new AuxiliarySessionStorage(
            nextDbPath,
            (auxiliarySessionId) => {
              const entries = auditLogStorage?.listSessionAuditLogs(auxiliarySessionId);
              return entries && !(entries instanceof Promise)
                ? resolveLegacyAuxiliaryPreviewFromAuditEntries(entries)
                : null;
            },
          ),
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
            prepareSessionWindowSnapshotForQuit: () =>
              requireSessionWindowBridge().prepareSnapshotForQuit(),
            stopMemoryRuntime: stopMemoryV6RuntimeApiBestEffort,
            closePersistentStores,
            invalidateAllProviderSessionThreads,
            revokeAllAgentRuntimeBindings: () => agentRuntimeBindingRegistry.revokeAll(),
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
                showSessionMonitorContextMenu: (event, request) =>
                  sessionMonitorContextMenuService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                getSessionWindowRestoreSet: () => requireSessionWindowRestoreService().getSnapshot(),
                restoreSessionWindows: () => requireSessionWindowRestoreService().restoreSnapshot(),
                openHomeWindow: createHomeWindow,
                openSessionMonitorWindow,
                openSettingsWindow,
                openMemoryV6ReviewWindow,
                isSessionMonitorWindow: (window) => requireMainWindowFacade().isSessionMonitorWindow(window),
                isSettingsWindow: (window) => requireMainWindowFacade().isSettingsWindow(window),
                isMemoryV6ReviewWindow: (window) => requireMainWindowFacade().isMemoryV6ReviewWindow(window),
                openCharacterEditorWindow,
                openDiffWindow,
                isFilePreviewWindow: (window, sessionId) =>
                  requireMainWindowFacade().isFilePreviewWindow(window, sessionId),
                getFilePreviewWindowResource: (window, sessionId) =>
                  requireMainWindowFacade().getFilePreviewWindowResource(window, sessionId),
                isFilePreviewTokenWindow: (window, token) =>
                  requireMainWindowFacade().isFilePreviewTokenWindow(window, token),
                openCompanionReviewWindow,
                openCompanionMergeWindow,
                pickDirectory: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickDirectory(targetWindow, initialPath),
                validateWorkspaceDirectory: (targetPath) =>
                  workspaceDirectoryValidationService.validate(targetPath),
                pickFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFile(targetWindow, initialPath),
                pickFiles: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFiles(targetWindow, initialPath),
                pickSessionFiles,
                pickSessionFolder,
                pickSessionImageFile,
                pickImageFile: (targetWindow, initialPath, purpose) =>
                  requireWindowDialogService().pickImageFile(targetWindow, initialPath, purpose),
                copyFilesToSessionFiles,
                savePastedSessionFile,
                openSessionFilesDirectory,
                openSessionFilesTerminal,
                copySessionFilePreviewImage: (event, request) =>
                  sessionFilePreviewImageCopyService.copyImage(event.sender, request.point),
                showSessionFilePreviewImageContextMenu: (event, request) =>
                  sessionFilePreviewImageCopyService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    event.sender,
                    request.point,
                  ),
                copySessionFileObject: (_event, request) =>
                  sessionFileObjectCopyService.copyResource(request.resource),
                showSessionFileObjectCopyContextMenu: (event, request) =>
                  sessionFileObjectCopyService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                showSessionFileTreeContextMenu: (event, request) =>
                  sessionFileTreeContextMenuService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                showMarkdownLinkContextMenu: (event, request) =>
                  markdownLinkContextMenuService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
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
                updateChatLayoutPreference,
                getAppDatabaseDiagnostics,
                getMemoryV6Diagnostics,
                installMemoryV6CliShim,
                uninstallMemoryV6CliShim,
                getMemoryV6FileUsage,
                exportMemoryV6EntryFiles,
                runMemoryV6ProtectedObjectGc,
                searchMemoryV6Entries,
                getMemoryV6Entry,
                forgetMemoryV6Entry,
                resetAppDatabase: async (request) => {
                  if (databaseMaintenanceRequested) {
                    throw new Error("DB の初期化はすでに実行中です。");
                  }
                  databaseMaintenanceRequested = true;
                  try {
                    return await characterWorkspaceOperationCoordinator.runMaintenance(
                      () => requireSettingsCatalogService().resetAppDatabase(request),
                    );
                  } finally {
                    databaseMaintenanceRequested = false;
                  }
                },
              },
              promptTemplates: {
                listPromptTemplates,
                createPromptTemplate,
                updatePromptTemplate,
                deletePromptTemplate,
              },
              sessionQuery: {
                listSessionSummaryPage: (request) => listSessionSummaryPage(request),
                listSessionCharacterUsage: () => listSessionCharacterUsage(),
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
                listOpenSessionWindowIdsPage: (request) => listOpenSessionWindowIdsPage(request),
                listOpenCompanionReviewWindowIds: () => listOpenCompanionReviewWindowIds(),
                getSession: (sessionId) => getDisplaySession(sessionId),
                getSessionGlossaryProjection: (sessionId) =>
                  glossarySessionProjectionService.load(sessionId),
                searchSessionGlossary: (sessionId, request) =>
                  glossarySessionProjectionService.search(sessionId, request),
                ensureSessionGlossarySubscription,
                getSessionFileExplorerOwnerSessionId,
                listSessionFileRoots: (sessionId) => createSessionFileExplorerService().listRoots(sessionId),
                listSessionDirectory: (request) => createSessionFileExplorerService().listDirectory(request),
                inspectSessionFile: (request) => isSessionFileGitCommitResource(request)
                  ? createFileRootGitChangesService().inspectHistoryFile(request)
                  : createSessionFileExplorerService().inspectFile(request),
                readSessionFileChunk: (request) => isSessionFileGitCommitResource(request)
                  ? createFileRootGitChangesService().readHistoryFileChunk(request)
                  : createSessionFileExplorerService().readFileChunk(request),
                openSessionFile: (request) => createSessionFileExplorerService().openFile(request),
                openSessionFilePreviewWindow,
                getSessionFilePreviewWindowPayload: (token) =>
                  requireMainWindowFacade().getFilePreviewPayload(token),
                listFileRootChanges: (request) => createFileRootGitChangesService().listChanges(request),
                listFileRootChangesRepositories: (request) =>
                  createFileRootGitChangesService().listChangesRepositories(request),
                getFileRootDiff: (request) => createFileRootGitChangesService().getFileDiff(request),
                listFileRootGitHistoryRepositories: (request) =>
                  createFileRootGitChangesService().listHistoryRepositories(request),
                listFileRootGitHistoryCommits: (request) =>
                  createFileRootGitChangesService().listHistoryCommits(request),
                getFileRootGitHistoryCommitDetail: (request) =>
                  createFileRootGitChangesService().getHistoryCommitDetail(request),
                getFileRootGitHistoryComparison: (request) =>
                  createFileRootGitChangesService().getHistoryComparison(request),
                getFileRootGitHistoryDiff: (request) =>
                  createFileRootGitChangesService().getHistoryDiff(request),
                getSessionMessageArtifact,
                getDiffPreview: (token) => requireAuxWindowService().getDiffPreview(token),
                previewComposerInput,
              },
              auxiliary: {
                listAuxiliarySessions: (parentSessionId) =>
                  requireAuxiliarySessionService().listAuxiliarySessions(parentSessionId),
                listAuxiliarySessionSummaries: (parentSessionIds) =>
                  requireAuxiliarySessionService().listAuxiliarySessionSummaries(parentSessionIds),
                listOpenActiveAuxiliarySessionSummaries: () =>
                  requireAuxiliarySessionService().listActiveAuxiliarySessionSummaries([
                    ...listOpenSessionWindowIds(),
                    ...listOpenCompanionReviewWindowIds(),
                  ]),
                listOpenAuxiliarySessionSummaries: () => {
                  const parentSessionIds = Array.from(new Set([
                    ...listOpenSessionWindowIds(),
                    ...listOpenCompanionReviewWindowIds(),
                  ]));
                  return requireAuxiliarySessionService().listAuxiliarySessionSummaries(parentSessionIds);
                },
                getActiveAuxiliarySession: (parentSessionId) =>
                  requireAuxiliarySessionService().getActiveAuxiliarySession(parentSessionId),
                getAuxiliarySession: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId),
                createAuxiliarySession: async (input) => {
                  if (databaseMaintenanceRequested) {
                    throw new Error("DB のメンテナンス中は Auxiliary を作成できません。");
                  }
                  const created = await runWithStorageOperationCorrelation(input.clientRequestId ?? crypto.randomUUID(),
                    () => requireAuxiliarySessionService().createAuxiliarySession(input));
                  broadcastSessions([created.parentSessionId]);
                  return created;
                },
                getAuxiliaryCreationContext: (parentSessionId) =>
                  requireAuxiliarySessionService().getAuxiliaryCreationContext(parentSessionId),
                cancelAuxiliaryCreation: (request) =>
                  requireAuxiliarySessionService().cancelAuxiliaryCreation(request),
                getAuxiliaryCreation: (request) =>
                  requireAuxiliarySessionService().getAuxiliaryCreation(request),
                updateAuxiliarySession: async (session) => {
                  const updated = await updateAuxiliarySessionWithProviderRuntimeLifecycle({
                    session,
                    isRunInFlight: (sessionId) =>
                      requireAuxiliarySessionRuntimeService().isRunInFlight(sessionId),
                    getAuxiliarySession: (sessionId) =>
                      requireAuxiliarySessionService().getAuxiliarySession(sessionId),
                    updateAuxiliarySession: (nextSession) =>
                      requireAuxiliarySessionService().updateAuxiliarySession(nextSession),
                    revokeSessionAgentRuntimeBindings: (sessionId) =>
                      agentRuntimeBindingRegistry.revokeSession(sessionId),
                    invalidateProviderSessionThread,
                  });
                  broadcastSessions([updated.parentSessionId]);
                  return updated;
                },
                closeAuxiliarySession: async (auxiliarySessionId) => {
                  const owner = requireActivePersistentStoreOwnerForFactory("Auxiliary close");
                  const { current, closed } = await providerRuntimeOperationCoordinator.runExclusive(
                    () => characterAffectTurnOwnershipCoordinator.runExclusive(async () => {
                      assertPersistentStoreOwnerIsActive(owner, "Auxiliary close");
                      if (auxiliaryRunParents.has(auxiliarySessionId)
                        || auxiliarySessionRuntimeService?.isRunInFlight(auxiliarySessionId)) {
                        throw new Error("実行中の Auxiliary Session は終了できないよ。");
                      }
                      const service = requireAuxiliarySessionService();
                      const current = await service.getAuxiliarySession(auxiliarySessionId);
                      const closed = await service.closeAuxiliarySession(auxiliarySessionId);
                      return { current, closed };
                    }, "auxiliary-session-close"),
                    "auxiliary-session-close",
                  );
                  agentRuntimeBindingRegistry.revokeSession(auxiliarySessionId);
                  await invalidateProviderSessionThread(current?.provider ?? closed.provider, auxiliarySessionId);
                  requireMainWindowFacade().closeFilePreviewWindowsForSession(auxiliarySessionId);
                  broadcastSessions([closed.parentSessionId]);
                  return closed;
                },
                runAuxiliarySessionTurn: async (auxiliarySessionId, request) => {
                  const initial = await requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId);
                  if (!initial) {
                    throw new Error("Auxiliary Session が見つからないよ。");
                  }
                  if (auxiliaryRunParents.has(auxiliarySessionId)) {
                    throw new Error("Auxiliary Session はすでに実行中だよ。");
                  }
                  auxiliaryRunParents.set(auxiliarySessionId, initial.parentSessionId);
                  try {
                    await requireAuxiliarySessionRuntimeService().runSessionTurn(auxiliarySessionId, request);
                    const session = await requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId);
                    if (!session) {
                      throw new Error("Auxiliary Session が見つからないよ。");
                    }
                    return session;
                  } finally {
                    auxiliaryRunParents.delete(auxiliarySessionId);
                  }
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
                createSession: (input) => requireMainSessionCommandFacade().createSessionFromRequest(input),
                updateSession: (session) => requireMainSessionCommandFacade().updateSession(session),
                setSessionPinned: (request) => requireMainSessionCommandFacade().setSessionPinned(request),
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

function requireSessionStorageForWrite(): SessionStorageWrite {
  const storage = requireSessionStorage();
  if (isSessionStorageWritable(storage)) {
    return storage;
  }

  throw new Error("session storage は V2 DB の読み取り専用のため書き込み不可です。");
}

function requireSessionPinStorage(): SessionPinStorage {
  const storage = requireSessionStorage();
  const candidate = storage as Partial<SessionPinStorage>;
  if (typeof candidate.setSessionPinned === "function") {
    return candidate as SessionPinStorage;
  }
  throw new Error("このセッション保存形式ではピン止めを利用できないよ。");
}

function isSessionStorageWritable(storage: SessionStorageRead): storage is SessionStorageWrite {
  const candidate = storage as Partial<SessionStorageWrite>;
  return (
    typeof candidate.insertSession === "function" &&
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
      getSessionSummaryPage: (request) => {
        const storage = requireSessionStorage();
        if (!storage.listSessionSummaryPage) {
          throw new Error("このDBのSession summary page queryは利用できないよ。");
        }
        return storage.listSessionSummaryPage(request);
      },
      getSessionCharacterUsage: () => {
        const storage = requireSessionStorage();
        if (!storage.listSessionCharacterUsage) {
          throw new Error("このDBのSession character usage queryは利用できないよ。");
        }
        return storage.listSessionCharacterUsage();
      },
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
      getModelCatalog: () => getModelCatalog(),
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      listPromptTemplates,
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
      revokeProviderExecution: (sessionId, providerId) =>
        agentRuntimeBindingRegistry.revokeProviderExecution(sessionId, providerId),
      revokeAllProviderExecutions: () => agentRuntimeBindingRegistry.revokeAll(),
    });
  }

  return mainProviderFacade;
}

function requireMainSessionCommandFacade(): MainSessionCommandFacade {
  if (!mainSessionCommandFacade) {
    mainSessionCommandFacade = new MainSessionCommandFacade({
      getSession,
      getSessions: () => sessions,
      getStoredSessionSummaries: () => requireSessionStorage().listSessionSummaries(),
      getSessionStorageIdentity: () => requireSessionStorage(),
      resolveSessionLaunchSelection: (providerId) =>
        requireSessionLaunchSelectionService().resolve(providerId),
      runProviderRuntimeOperationExclusive: (operation) => {
        if (databaseMaintenanceRequested) {
          throw new Error("DB のメンテナンス中は Session を作成できません。");
        }
        return providerRuntimeOperationCoordinator.runExclusive(() => {
          if (databaseMaintenanceRequested) {
            throw new Error("DB のメンテナンス中は Session を作成できません。");
          }
          return operation();
        }, "session-create");
      },
      getSessionPersistenceService: () => requireSessionPersistenceService(),
      getSessionRuntimeService: () => requireSessionRuntimeService(),
      getProviderQuotaTelemetry: (providerId) => getProviderQuotaTelemetry(providerId),
      isProviderQuotaTelemetryStale: (telemetry) => isProviderQuotaTelemetryStale(telemetry),
      refreshProviderQuotaTelemetry: (providerId) => refreshProviderQuotaTelemetry(providerId),
      initializeCreatedSession: ensureDefaultAuxiliarySession,
      createSessionId: () => `launch-${crypto.randomUUID()}`,
      createSessionFilesDirectory: (sessionId) =>
        createSessionFilesDirectory(app.getPath("userData"), sessionId),
      isSessionFilesWorkspace: (session) =>
        areDirectoryPathsEquivalent(
          session.workspacePath,
          resolveSessionFilesDirectory(app.getPath("userData"), session.id),
        ),
      dismissSessionTurnNotification: (sessionId) =>
        requireSessionTurnNotificationService().dismissSessionNotification(sessionId),
      cleanupSessionFilesDirectory,
      validateWorkspaceDirectory: (targetPath) =>
        workspaceDirectoryValidationService.validate(targetPath),
    });
  }

  return mainSessionCommandFacade;
}

function requireSessionLaunchSelectionService(): SessionLaunchSelectionService {
  if (!sessionLaunchSelectionService) {
    sessionLaunchSelectionService = new SessionLaunchSelectionService({
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getModelCatalogSnapshot: async () => await getModelCatalog(null) ?? await requireModelCatalogStorage().ensureSeeded(),
      getLatestSessionSummaryForProvider: (providerId) =>
        requireSessionStorage().getLatestSessionSummaryForProvider(providerId),
    });
  }

  return sessionLaunchSelectionService;
}

function requireMainSessionPersistenceFacade(): MainSessionPersistenceFacade {
  if (!mainSessionPersistenceFacade) {
    const owner = requireActivePersistentStoreOwnerForFactory("Main session persistence facade");
    mainSessionPersistenceFacade = new MainSessionPersistenceFacade({
      getSessions: () => {
        assertPersistentStoreOwnerIsActive(owner, "Main session persistence facade cache read");
        return sessions;
      },
      setSessions: (nextSessions) => {
        assertPersistentStoreOwnerIsActive(owner, "Main session persistence facade cache write");
        sessions = nextSessions;
      },
      getSessionPersistenceService: () => requireSessionPersistenceService(),
      getSessionStorage: () => {
        assertPersistentStoreOwnerIsActive(owner, "Main session persistence facade storage read");
        return owner.sessionStorage;
      },
    });
  }

  return mainSessionPersistenceFacade;
}

function requireModelCatalogStorage(): PersistentStoreBundle["modelCatalogStorage"] {
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
    const owner = requireActivePersistentStoreOwnerForFactory("Auxiliary session service");
    const storage = owner.auxiliarySessionStorage;
    auxiliarySessionService = new AuxiliarySessionService({
      onCreationStateChanged: (event) => writeAppLog({
        level: "info",
        kind: "auxiliary.creation",
        process: "main",
        message: `Auxiliary creation: ${event.status}`,
        data: { ...event, correlationId: event.clientRequestId },
      }),
      getParentSession: async (parentSessionId) => {
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session parent read");
        const parent = await getAuxiliaryParentSession(parentSessionId);
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session parent read");
        return parent;
      },
      getStorage: () => {
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session storage access");
        return storage;
      },
      getModelCatalogSnapshot: async () => {
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session catalog read");
        const catalog = await getModelCatalog(null) ?? await owner.modelCatalogStorage.ensureSeeded();
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session catalog read");
        return catalog;
      },
      listActiveCharacters: async () => {
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session character read");
        const characters = await requireCharacterService().listCharacters();
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session character read");
        return characters;
      },
      createCharacterRuntimeSnapshot: async (characterId) => {
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session character snapshot");
        const snapshot = await requireCharacterService().createRuntimeSnapshot(characterId);
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session character snapshot");
        return snapshot;
      },
      runCharacterAffectTurnOwnershipExclusive: (operation) =>
        characterAffectTurnOwnershipCoordinator.runExclusive(async () => {
          assertPersistentStoreOwnerIsActive(owner, "Auxiliary session Character affect ownership");
          const result = await operation();
          assertPersistentStoreOwnerIsActive(owner, "Auxiliary session Character affect ownership");
          return result;
        }),
      resolveSessionLaunchSelection: async (providerId) => {
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session launch selection");
        const selection = await requireSessionLaunchSelectionService().resolve(providerId);
        assertPersistentStoreOwnerIsActive(owner, "Auxiliary session launch selection");
        return selection;
      },
      runProviderRuntimeOperationExclusive: (operation) =>
        providerRuntimeOperationCoordinator.runExclusive(async () => {
          assertPersistentStoreOwnerIsActive(owner, "Auxiliary session provider operation");
          if (databaseMaintenanceRequested) {
            throw new Error("DB のメンテナンス中は Auxiliary を作成できません。");
          }
          const result = await operation();
          assertPersistentStoreOwnerIsActive(owner, "Auxiliary session provider operation");
          return result;
        }),
    });
  }

  return auxiliarySessionService;
}

async function ensureDefaultAuxiliarySession(session: Session): Promise<void> {
  const service = requireAuxiliarySessionService();
  if ((await service.listAuxiliarySessions(session.id)).length > 0) {
    return;
  }

  await service.createAuxiliarySession({
    parentSessionId: session.id,
    provider: session.provider,
    runtimeSelection: "latest-session",
    clientRequestId: `default:${session.id}`,
  });
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

function requireAppSettingsStorage(): PersistentStoreBundle["appSettingsStorage"] {
  if (!appSettingsStorage) {
    throw new Error("app settings storage が初期化されていないよ。");
  }

  return appSettingsStorage;
}

function requirePromptTemplateStorage(): NonNullable<typeof promptTemplateStorage> {
  if (!promptTemplateStorage) {
    if (!dbPath) {
      throw new Error("DB path が初期化されていないよ。");
    }
    promptTemplateStorage = new PromptTemplateStorage(dbPath);
  }
  return promptTemplateStorage;
}

async function listPromptTemplates(): Promise<PromptTemplate[]> {
  return requirePromptTemplateStorage().listPromptTemplates();
}

async function publishPromptTemplates(): Promise<PromptTemplate[]> {
  const templates = await listPromptTemplates();
  await requireMainBroadcastFacade().broadcastPromptTemplates(templates);
  return templates;
}

async function createPromptTemplate(input: CreatePromptTemplateInput): Promise<PromptTemplate[]> {
  await requirePromptTemplateStorage().createPromptTemplate(input);
  return publishPromptTemplates();
}

async function updatePromptTemplate(input: UpdatePromptTemplateInput): Promise<PromptTemplate[]> {
  await requirePromptTemplateStorage().updatePromptTemplate(input);
  return publishPromptTemplates();
}

async function deletePromptTemplate(id: string): Promise<PromptTemplate[]> {
  await requirePromptTemplateStorage().deletePromptTemplate(id);
  return publishPromptTemplates();
}

async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  const savedSettings = await requireAppSettingsStorage().updateSettings(settings);
  applyLaunchAtLoginSetting(app, savedSettings.launchAtLoginEnabled, app.isPackaged);
  await syncManagedGlossarySkillBestEffort();
  return savedSettings;
}

async function updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): Promise<AppSettings> {
  return requireAppSettingsStorage().updateChatLayoutPreference(update);
}

async function resetAppSettings(): Promise<AppSettings> {
  const settings = await requireAppSettingsStorage().resetSettings();
  applyLaunchAtLoginSetting(app, settings.launchAtLoginEnabled, app.isPackaged);
  return settings;
}

function requireMateStorage(): PersistentStoreBundle["mateStorage"] {
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

const characterWorkspaceOperationCoordinator = new CharacterWorkspaceOperationCoordinator();

function requireCharacterService(): CharacterService {
  if (!characterService) {
    characterService = new CharacterService(requireCharacterStorage(), characterWorkspaceOperationCoordinator);
  }

  return characterService;
}

function requireCharacterAuthoringService(): CharacterAuthoringService {
  if (!characterAuthoringService) {
    characterAuthoringService = new CharacterAuthoringService({
      runCharacterWorkspaceOperationExclusive: (characterId, operation) =>
        characterWorkspaceOperationCoordinator.runExclusive(characterId, operation),
      bundledSkillPath: bundledCharacterAuthoringSkillPath,
      createSession: (input) => requireMainSessionCommandFacade().createSession(input),
      getCharacter: (characterId) => requireCharacterService().getCharacter(characterId),
      getCharacterDirectory: (characterId) => requireCharacterService().getCharacterDirectory(characterId),
      getSessionStorageIdentity: () => requireSessionStorage(),
      resolveProvider: (providerId) =>
        requireSessionPersistenceService().resolveCharacterAuthoringProvider(providerId),
      runProviderRuntimeOperationExclusive: (operation) =>
        providerRuntimeOperationCoordinator.runExclusive(operation),
    });
  }

  return characterAuthoringService;
}

const MANAGED_GLOSSARY_SKILL_BUNDLE: ManagedSkillBundleDescriptor = {
  skillName: WITHMATE_GLOSSARY_SKILL_NAME,
  bundledSkillPath: bundledGlossarySkillPath,
  documentationRelativePaths: ["SKILL.md", "agents"],
};

function requireManagedSkillDistributionService(): ManagedSkillDistributionService {
  if (!managedSkillDistributionService) {
    managedSkillDistributionService = new ManagedSkillDistributionService({
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      getAppVersion: () => app.getVersion(),
      isPackagedApp: () => app.isPackaged,
    });
  }

  return managedSkillDistributionService;
}

function requireMemoryCliShimService(): MemoryCliShimService {
  if (!memoryCliShimService) {
    memoryCliShimService = new MemoryCliShimService({
      appExecutablePath: process.execPath,
      bundledCliScriptPath: bundledMemoryCliScriptPath,
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
  void broadcastSessions([result.session.id]);
  return result;
}

function requireMateProfileItemStorage(): NonNullable<typeof mateProfileItemStorage> {
  if (storageWorker) {
    throw new Error("Mate profile item storage は V6 runtime では利用できません。");
  }
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
    companionStorage = storageWorker?.stores.companion ?? (isValidV3Database(dbPath)
      ? new CompanionStorageV3(dbPath, path.join(path.dirname(dbPath), "blobs", "v3"))
      : new CompanionStorage(dbPath));
  }

  return companionStorage;
}

function canUseCompanionAuditLogStorage(): boolean {
  return !storageWorker && dbPath.length > 0 && (isValidV3Database(dbPath) || isValidV4Database(dbPath));
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

function requireCharacterAffectTurnSettlementStorage(): NonNullable<typeof characterAffectTurnSettlementStorage> {
  if (!characterAffectTurnSettlementStorage) {
    throw new Error("Character affect turn settlement storage is not initialized.");
  }
  return characterAffectTurnSettlementStorage;
}

function requireCharacterAffectTurnRetryScheduler(): CharacterAffectTurnRetryScheduler {
  if (!characterAffectTurnRetryScheduler) {
    characterAffectTurnRetryScheduler = new CharacterAffectTurnRetryScheduler({
      drain: drainPendingCharacterAffectTurns,
      onError: (error) => {
        writeAppLog({
          level: "warn",
          kind: "character-affect.lifecycle.recovery-failed",
          process: "main",
          message: "Character affect recovery did not complete",
          data: createCharacterAffectTurnRecoveryFailureLogData(error),
        });
      },
    });
  }
  return characterAffectTurnRetryScheduler;
}

async function drainPendingCharacterAffectTurns(): Promise<boolean> {
  return characterAffectTurnMainLifecycle.drain();
}

function requireSessionRuntimeService(): SessionRuntimeService {
  if (!sessionRuntimeService) {
    const owner = requireActivePersistentStoreOwnerForFactory("Session runtime service");
    const assertOwner = (operation: string) =>
      assertPersistentStoreOwnerIsActive(owner, `Session runtime ${operation}`);
    const guarded = async <T>(operation: string, callback: () => T | Promise<T>): Promise<T> => {
      assertOwner(operation);
      const result = await callback();
      assertOwner(operation);
      return result;
    };
    sessionRuntimeService = new SessionRuntimeService({
      runSessionAdmissionExclusive: (sessionId, operation, signal) =>
        runSessionTurnAdmission(sessionId, false, () => guarded("admission", operation), signal),
      getSession: (sessionId) => {
        assertOwner("session read");
        return getRuntimeSession(sessionId);
      },
      upsertSession: (session) => guarded("session upsert", () =>
        requireMainSessionPersistenceFacade().upsertSessionPreservingPin(session)),
      persistRunningTurnStart: (session, expectedMessageCount) =>
        guarded("running turn start", () =>
          requireMainSessionPersistenceFacade().persistRunningTurnStart(session, expectedMessageCount)),
      clearCharacterAuthoringRuntimeState: (session) =>
        guarded("authoring runtime clear", () =>
          requireMainSessionPersistenceFacade().clearCharacterAuthoringRuntimeState(session)),
      upsertTerminalSession: (session, terminalCommit) =>
        guarded("terminal session", () =>
          requireMainSessionPersistenceFacade().upsertTerminalSession(session, terminalCommit)),
      resolveRuntimeSessionForTurn: (session) => guarded("runtime session resolution", () =>
        resolveCharacterAuthoringRuntimeSessionForTurn(
          session,
          (characterId) => requireCharacterService().createRuntimeSnapshot(characterId),
        )),
      resolveComposerPreview: (session, userMessage) => guarded("composer preview", () =>
        resolveComposerPreview(session, userMessage)),
      resolveProviderSession: (session) => guarded("provider session path", () =>
        appendSessionFilesDirectory(app.getPath("userData"), session)),
      resolveSessionFolderPath: (sessionId) => guarded("session folder path", () =>
        resolveSessionFilesDirectory(app.getPath("userData"), sessionId)),
      getAppSettings: () => guarded("settings read", () => requireAppSettingsStorage().getSettings()),
      resolveProviderCatalog: (providerId, revision) => guarded("provider catalog", () =>
        resolveProviderCatalog(providerId, revision)),
      getProviderCodingAdapter,
      resetProviderSessionThread,
      getProviderAgentRuntimeBinding: ({ session, provider }) =>
        guarded("provider runtime binding", () => issueProviderAgentRuntimeBinding(session, provider.id)),
      beginProviderAgentRuntimeTurn: ({ session, provider, binding }) => binding
        ? guarded("provider runtime turn", () => glossaryRuntimeService.beginProviderTurn(session.id, binding))
        : undefined,
      endProviderAgentRuntimeTurn: (handle) =>
        glossaryRuntimeService.endProviderTurn(handle as import("./glossary-proactive-turn.js").GlossaryProactiveTurnHandle),
      getSessionMemory: (session) => createDefaultSessionMemory({
        id: session.id,
        workspacePath: session.workspacePath,
        threadId: session.threadId,
        taskTitle: session.taskTitle,
      }),
      resolveProjectMemoryEntriesForPrompt: () => [],
      resolveConversationTimingContext: async (session, observedAt) => {
        assertOwner("conversation timing");
        if (session.sessionKind !== "default") {
          return null;
        }
        const storage = requireAuditLogStorage();
        if (!storage.getConversationTimingSnapshot) {
          return null;
        }
        const snapshot = await storage.getConversationTimingSnapshot(session.id, observedAt.toISOString());
        assertOwner("conversation timing");
        return resolveConversationTimingContext(snapshot, observedAt);
      },
      resolveCharacterContext: async (session, query) => {
        assertOwner("character context");
        if (session.sessionKind !== "default" || !session.characterId || !memoryV6RuntimeApi) {
          return null;
        }
        const result = await memoryV6RuntimeApi.characterContextService.getContext({
          schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
          characterId: session.characterId,
          sessionId: session.id,
          query,
          memoryLimit: 3,
        }, "lifecycle");
        assertOwner("character context");
        if (isCharacterContextError(result)) {
          writeAppLog({
            level: "warn",
            kind: "character-context.lifecycle.read-failed",
            process: "main",
            message: "Character context was unavailable for a session turn",
            data: {
              sessionId: session.id,
              code: result.error.code,
              retryable: result.error.retryable,
              conversationMayContinue: result.error.conversationMayContinue,
            },
          });
          return null;
        }
        return result;
      },
      queueCompletedTurnAppraisal: async ({
        session,
        correlationId,
        userMessage,
        assistantMessage,
        assistantMessageIndex,
        occurredAt,
      }) => {
        assertOwner("appraisal enqueue");
        if (session.sessionKind !== "default" || !session.characterId) {
          return;
        }
        await requireCharacterAffectTurnSettlementStorage().enqueue({
          correlationId,
          characterId: session.characterId,
          sessionId: session.id,
          sessionIncarnationId: getSessionIncarnationId(session),
          userMessage,
          assistantMessage,
          assistantMessageIndex,
          occurredAt,
        });
        assertOwner("appraisal enqueue");
      },
      markCompletedTurnAppraisalReady: async (correlationId) => {
        assertOwner("appraisal ready");
        const result = await requireCharacterAffectTurnSettlementStorage().markReady(correlationId);
        assertOwner("appraisal ready");
        if (!result.updated) {
          return "absent";
        }
        return "ready";
      },
      requireDurableCompletedTurnAppraisal: true,
      appraiseCompletedTurn: () => {
        requireCharacterAffectTurnRetryScheduler().request({ immediate: true, resetBackoff: true });
      },
      createAuditLog: (entry) => guarded("audit create", () => requireAuditLogService().createAuditLog(entry)),
      updateAuditLog: (id, entry) => guarded("audit update", () => requireAuditLogService().updateAuditLog(id, entry)),
      setLiveSessionRun: (sessionId, state) => {
        assertOwner("live session projection");
        setLiveSessionRun(sessionId, state);
      },
      getLiveSessionRun: (sessionId) => {
        assertOwner("live session read");
        return getLiveSessionRun(sessionId);
      },
      waitForApprovalDecision: (sessionId, request, signal) =>
        waitForLiveApprovalDecision(sessionId, request, signal),
      waitForElicitationResponse: (sessionId, request, signal) =>
        waitForLiveElicitationResponse(sessionId, request, signal),
      setProviderQuotaTelemetry: (telemetry) => {
        assertOwner("provider quota projection");
        setProviderQuotaTelemetry(telemetry.provider, telemetry);
      },
      setSessionContextTelemetry: (telemetry) => {
        assertOwner("session context projection");
        setSessionContextTelemetry(telemetry.sessionId, telemetry);
      },
      invalidateProviderSessionThread: (providerId, sessionId) =>
        guarded("provider thread invalidation", () => invalidateProviderSessionThread(providerId, sessionId)),
      scheduleProviderQuotaTelemetryRefresh: (providerId, delaysMs) => {
        assertOwner("provider quota schedule");
        scheduleProviderQuotaTelemetryRefresh(providerId, delaysMs);
      },
      broadcastLiveSessionRun: (sessionId) => {
        assertOwner("live session broadcast");
        broadcastLiveSessionRun(sessionId);
      },
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
      notifySessionTurnTerminal: async (notification) => {
        await guarded("terminal notification", () =>
          requireSessionTurnNotificationService().notifyTurnTerminal(notification));
      },
      currentTimestampLabel,
    });
  }

  return sessionRuntimeService;
}

function requireSessionTurnNotificationService(): SessionTurnNotificationService<NativeImage> {
  if (!sessionTurnNotificationService) {
    sessionTurnNotificationService = new SessionTurnNotificationService({
      platform: process.platform,
      isNotificationSupported: () => Notification.isSupported(),
      isNotificationEnabled: async () => (await requireAppSettingsStorage().getSettings()).sessionTurnNotificationEnabled,
      isResponsePreviewEnabled: async () =>
        (await requireAppSettingsStorage().getSettings()).sessionTurnNotificationResponsePreviewEnabled,
      isSessionWindowFocused: (sessionId) => {
        const sessionWindow = requireSessionWindowBridge().getWindow(sessionId);
        return Boolean(sessionWindow && !sessionWindow.isDestroyed() && sessionWindow.isFocused());
      },
      loadCharacterIcon: (iconPath) => {
        if (!path.isAbsolute(iconPath)) {
          return null;
        }

        const icon = nativeImage.createFromPath(iconPath);
        return icon.isEmpty() ? null : icon;
      },
      createNotification: (options) => {
        const notification = new Notification(options);
        return {
          show: () => notification.show(),
          close: () => notification.close(),
          onClick: (listener) => {
            notification.on("click", listener);
          },
          onClose: (listener) => {
            notification.on("close", (details) => listener(details.reason));
          },
          onFailed: (listener) => {
            notification.on("failed", (_event, error) => listener(error));
          },
        };
      },
      getSession: (sessionId) => requireSessionStorage().getSession(sessionId),
      openSessionWindow: async (sessionId) => {
        await openSessionWindow(sessionId);
      },
      openAuxiliarySessionWindow: async (parentSessionId, auxiliarySessionId) => {
        const auxiliary = await requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId);
        if (
          !auxiliary
          || auxiliary.parentSessionId !== parentSessionId
          || !await requireSessionStorage().getSession(parentSessionId)
        ) {
          throw new Error("Auxiliary Session の通知対象が見つからないよ。");
        }
        await requireSessionWindowBridge().openAuxiliarySessionWindow(parentSessionId, auxiliarySessionId);
      },
      openHomeWindow: async () => {
        await createHomeWindow();
      },
      logWarning: (event, sessionId, error) => {
        writeAppLog({
          level: "warn",
          kind: `session.turn-notification.${event}`,
          process: "main",
          message: "Session turn notification warning",
          data: { sessionId },
          ...(error === undefined ? {} : { error: appLogService.errorToLogError(error) }),
        });
      },
    });
  }

  return sessionTurnNotificationService;
}

function requireAuxiliarySessionRuntimeService(): SessionRuntimeService {
  if (!auxiliarySessionRuntimeService) {
    const owner = requireActivePersistentStoreOwnerForFactory("Auxiliary session runtime service");
    const assertOwner = (operation: string) =>
      assertPersistentStoreOwnerIsActive(owner, `Auxiliary session runtime ${operation}`);
    const guarded = async <T>(operation: string, callback: () => T | Promise<T>): Promise<T> => {
      assertOwner(operation);
      const result = await callback();
      assertOwner(operation);
      return result;
    };
    auxiliarySessionRuntimeService = new SessionRuntimeService({
      runSessionAdmissionExclusive: (sessionId, operation, signal) =>
        runSessionTurnAdmission(sessionId, true, () => guarded("admission", operation), signal),
      getSession: (sessionId) => guarded("session read", () =>
        requireAuxiliarySessionService().getAuxiliaryRuntimeSession(sessionId)),
      upsertSession: async (session, options) => {
        return guarded("session upsert", async () => {
          const auxiliaryService = requireAuxiliarySessionService();
          await auxiliaryService.upsertAuxiliaryRuntimeSession(session, options);
          const storedSession = await auxiliaryService.getAuxiliaryRuntimeSession(session.id);
          if (!storedSession) {
            throw new Error("Auxiliary Session の保存結果を読み戻せなかったよ。");
          }
          return storedSession;
        });
      },
      resolveComposerPreview: (session, userMessage) => guarded("composer preview", () =>
        resolveComposerPreview(session, userMessage)),
      resolveProviderSession: async (session) => {
        return guarded("provider session path", async () => {
          const auxiliarySession = await requireAuxiliarySessionService().getAuxiliarySession(session.id);
          return appendSessionFilesDirectoryForSessionId(
            app.getPath("userData"),
            session,
            auxiliarySession?.parentSessionId ?? session.id,
          );
        });
      },
      resolveSessionFolderPath: async (sessionId) => {
        return guarded("session folder path", async () => {
          const auxiliarySession = await requireAuxiliarySessionService().getAuxiliarySession(sessionId);
          return resolveSessionFilesDirectory(
            app.getPath("userData"),
            auxiliarySession?.parentSessionId ?? sessionId,
          );
        });
      },
      getAppSettings: () => guarded("settings read", () => requireAppSettingsStorage().getSettings()),
      resolveProviderCatalog: (providerId, revision) => guarded("provider catalog", () =>
        resolveProviderCatalog(providerId, revision)),
      getProviderCodingAdapter: (providerId) => {
        assertOwner("provider coding adapter");
        return getProviderCodingAdapter(providerId);
      },
      getProviderAgentRuntimeBinding: ({ session, provider }) =>
        guarded("provider runtime binding", () => issueProviderAgentRuntimeBinding(session, provider.id)),
      beginProviderAgentRuntimeTurn: ({ session, provider, binding }) => binding
        ? guarded("provider runtime turn", () => glossaryRuntimeService.beginProviderTurn(session.id, binding))
        : undefined,
      endProviderAgentRuntimeTurn: (handle) =>
        glossaryRuntimeService.endProviderTurn(handle as import("./glossary-proactive-turn.js").GlossaryProactiveTurnHandle),
      resetProviderSessionThread: (providerId, sessionId) =>
        guarded("provider thread reset", () => resetProviderSessionThread(providerId, sessionId)),
      isAuxiliarySession: async (sessionId) => guarded("Auxiliary session check", async () =>
        Boolean(await requireAuxiliarySessionService().getAuxiliarySession(sessionId))),
      getSessionMemory: (session) => createDefaultSessionMemory({
        id: session.id,
        workspacePath: session.workspacePath,
        threadId: session.threadId,
        taskTitle: session.taskTitle,
      }),
      resolveProjectMemoryEntriesForPrompt: () => [],
      createAuditLog: (entry) => guarded("audit create", () => requireAuditLogService().createAuditLog(entry)),
      updateAuditLog: (id, entry) => guarded("audit update", () => requireAuditLogService().updateAuditLog(id, entry)),
      setLiveSessionRun: (sessionId, state) => {
        assertOwner("live session projection");
        setLiveSessionRun(sessionId, state);
      },
      getLiveSessionRun: (sessionId) => {
        assertOwner("live session read");
        return getLiveSessionRun(sessionId);
      },
      waitForApprovalDecision: (sessionId, request, signal) =>
        waitForLiveApprovalDecision(sessionId, request, signal),
      waitForElicitationResponse: (sessionId, request, signal) =>
        waitForLiveElicitationResponse(sessionId, request, signal),
      setProviderQuotaTelemetry: (telemetry) => {
        assertOwner("provider quota projection");
        setProviderQuotaTelemetry(telemetry.provider, telemetry);
      },
      setSessionContextTelemetry: (telemetry) => {
        assertOwner("session context projection");
        setSessionContextTelemetry(telemetry.sessionId, telemetry);
      },
      invalidateProviderSessionThread: (providerId, sessionId) =>
        guarded("provider thread invalidation", () => invalidateProviderSessionThread(providerId, sessionId)),
      scheduleProviderQuotaTelemetryRefresh: (providerId, delaysMs) => {
        assertOwner("provider quota schedule");
        scheduleProviderQuotaTelemetryRefresh(providerId, delaysMs);
      },
      broadcastLiveSessionRun: (sessionId) => {
        assertOwner("live session broadcast");
        broadcastLiveSessionRun(sessionId);
      },
      resolvePendingApprovalRequest: (sessionId, decision) => {
        assertOwner("pending approval resolution");
        const liveRun = getLiveSessionRun(sessionId);
        const requestId = liveRun?.approvalRequest?.requestId;
        if (requestId) {
          requireSessionApprovalService().resolveLiveApproval(sessionId, requestId, decision);
        }
      },
      resolvePendingElicitationRequest: (sessionId, response) => {
        assertOwner("pending elicitation resolution");
        const liveRun = getLiveSessionRun(sessionId);
        const requestId = liveRun?.elicitationRequest?.requestId;
        if (requestId) {
          requireSessionElicitationService().resolveLiveElicitation(sessionId, requestId, response);
        }
      },
      notifySessionTurnTerminal: async (notification) => {
        await guarded("terminal notification", async () => {
          const auxiliary = await requireAuxiliarySessionService().getAuxiliarySession(notification.session.id);
          if (!auxiliary || !await owner.sessionStorage.getSession(auxiliary.parentSessionId)) {
            return;
          }
          await requireSessionTurnNotificationService().notifyTurnTerminal(notification, {
            kind: "auxiliary",
            parentSessionId: auxiliary.parentSessionId,
            auxiliarySessionId: auxiliary.id,
          });
        });
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
      resolveSessionLaunchSelection: (providerId) =>
        requireSessionLaunchSelectionService().resolve(providerId),
      runProviderRuntimeOperationExclusive: (operation) =>
        providerRuntimeOperationCoordinator.runExclusive(operation),
      getStorage: () => requireCompanionStorage(),
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
      resolveSessionFolderPath: (sessionId) => resolveSessionFilesDirectory(app.getPath("userData"), sessionId),
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
    const owner = requireActivePersistentStoreOwnerForFactory("Session persistence service");
    const storage = owner.sessionStorage as SessionStorageWrite;
    const pinStorage = storage as unknown as SessionPinStorage;
    const assertOwner = (operation: string) =>
      assertPersistentStoreOwnerIsActive(owner, `Session persistence ${operation}`);
    const sessionStorageCommands = createSessionStorageCommandAdapter(() => {
      assertOwner("storage command");
      return storage;
    });
    sessionPersistenceService = new SessionPersistenceService({
      getSessions: () => {
        assertOwner("cache read");
        return sessions;
      },
      setSessions: (nextSessions) => {
        assertOwner("cache write");
        sessions = nextSessions;
      },
      getSession: (sessionId) => {
        assertOwner("session read");
        return getSession(sessionId);
      },
      getStoredSession: async (sessionId) => {
        assertOwner("stored session read");
        const stored = await storage.getSession(sessionId);
        assertOwner("stored session read");
        return stored;
      },
      isSessionRunInFlight,
      listRunningActiveAuxiliaryParentIds: listRunningActiveAuxiliaryParentSessionIds,
      listAuxiliarySessionRuntimeIdentities: async (parentSessionIds) =>
        (await Promise.all(parentSessionIds.map(async (parentSessionId) => {
          assertOwner("Auxiliary identity read");
          const identities =
          (await requireAuxiliarySessionService().listAuxiliarySessions(parentSessionId)).map((auxiliary) => ({
            id: auxiliary.id,
            parentSessionId: auxiliary.parentSessionId,
            provider: auxiliary.provider,
          }));
          assertOwner("Auxiliary identity read");
          return identities;
        }))).flat(),
      upsertStoredSession: sessionStorageCommands.upsertStoredSession,
      updateStoredSessionThreadIfMatches: (input) => {
        assertOwner("thread update");
        if (!storage.updateSessionThreadIfMatches) {
          throw new Error("Session thread の条件付き更新storageが利用できないよ。");
        }
        return Promise.resolve(storage.updateSessionThreadIfMatches(input)).then((stored) => {
          assertOwner("thread update");
          return stored;
        });
      },
      updateStoredSessionRuntimeMetadataIfMatches: async (input) => {
        assertOwner("runtime metadata update");
        if (!storage.updateSessionRuntimeMetadataIfMatches) {
          throw new Error("Session runtime metadata の条件付き更新storageが利用できません。");
        }
        const stored = await storage.updateSessionRuntimeMetadataIfMatches(input);
        assertOwner("runtime metadata update");
        return stored;
      },
      appendStoredRunningTurnStart: (input) => {
        assertOwner("running turn start");
        if (!storage.appendRunningTurnStart) {
          throw new Error("running turn 開始のincremental storageが利用できないよ。");
        }
        return Promise.resolve(storage.appendRunningTurnStart(input)).then((result) => {
          assertOwner("running turn start");
          return result;
        });
      },
      clearStoredCharacterAuthoringRuntimeState: (input) => {
        assertOwner("Character authoring runtime clear");
        if (!storage.clearCharacterAuthoringRuntimeState) {
          throw new Error("Character authoring runtime clearのstorageが利用できないよ。");
        }
        return Promise.resolve(storage.clearCharacterAuthoringRuntimeState(input)).then((result) => {
          assertOwner("Character authoring runtime clear");
          return result;
        });
      },
      replaceStoredSessions: async (nextSessions) => {
        assertOwner("session replacement");
        await storage.replaceSessions(nextSessions);
        assertOwner("session replacement");
      },
      setStoredSessionPinned: (sessionId, isPinned) =>
        Promise.resolve().then(async () => {
          assertOwner("session pin update");
          if (typeof pinStorage.setSessionPinned !== "function") {
            throw new Error("このセッション保存形式ではピン止めを利用できないよ。");
          }
          const result = await pinStorage.setSessionPinned(sessionId, isPinned);
          assertOwner("session pin update");
          return result;
        }),
      listStoredSessions: async () => {
        assertOwner("session list");
        const result = await storage.listSessions();
        assertOwner("session list");
        return result;
      },
      listStoredSessionIdsLastActiveBefore: (cutoff) =>
        (async () => {
          assertOwner("session cutoff list");
          const result = await storage.listSessionIdsLastActiveBefore(cutoff);
          assertOwner("session cutoff list");
          return result;
        })(),
      deleteStoredSessions: async (sessionIds) => {
        assertOwner("session deletion");
        await storage.deleteSessions(sessionIds);
        assertOwner("session deletion");
      },
      getAppSettings: async () => {
        assertOwner("settings read");
        const result = await owner.appSettingsStorage.getSettings();
        assertOwner("settings read");
        return result;
      },
      getModelCatalogSnapshot: async () => {
        assertOwner("catalog read");
        const result = await getModelCatalog(null) ?? await owner.modelCatalogStorage.ensureSeeded();
        assertOwner("catalog read");
        return result;
      },
      createCharacterRuntimeSnapshot: async (characterId) => {
        assertOwner("character snapshot");
        const result = await requireCharacterService().createRuntimeSnapshot(characterId);
        assertOwner("character snapshot");
        return result;
      },
      syncSessionDependencies: (session) => {
        assertOwner("session dependency sync");
        requireSessionMemorySupportService().syncSessionDependencies(session);
      },
      clearSessionContextTelemetry: (sessionId) => {
        assertOwner("context telemetry clear");
        clearSessionContextTelemetry(sessionId);
      },
      clearSessionBackgroundActivities: (sessionId) => {
        assertOwner("background activity clear");
        clearSessionBackgroundActivities(sessionId);
      },
      invalidateProviderSessionThread: async (providerId, sessionId) => {
        assertOwner("provider thread invalidation");
        await invalidateProviderSessionThread(providerId, sessionId);
        assertOwner("provider thread invalidation");
      },
      revokeSessionAgentRuntimeBindings: (sessionId) =>
        (() => {
          assertOwner("agent runtime revoke");
          agentRuntimeBindingRegistry.revokeSession(sessionId);
        })(),
      closeSessionWindow: (sessionId) => {
        assertOwner("session window close");
        requireSessionWindowBridge().closeSessionWindow(sessionId);
        requireMainWindowFacade().closeFilePreviewWindowsForSession(sessionId);
      },
      upsertStoredTerminalSession: sessionStorageCommands.upsertStoredTerminalSession,
      broadcastSessions: (sessionIds) => {
        assertOwner("broadcast");
        broadcastSessions(sessionIds);
      },
      runCharacterAffectTurnOwnershipExclusive: (operation) =>
        characterAffectTurnOwnershipCoordinator.runExclusive(async () => {
          assertOwner("Character affect ownership");
          const result = await operation();
          assertOwner("Character affect ownership");
          return result;
        }),
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
      sendAuxiliarySessionNavigation: (window, payload) => {
        window.webContents.send(WITHMATE_OPEN_AUXILIARY_SESSION_EVENT, payload);
      },
      getSession,
      isRunInFlight: isSessionRunInFlight,
      onSessionWindowClosed: (sessionId) => auxiliarySessionService?.releaseAuxiliaryCreationOwner(sessionId),
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
      persistOpenSessionWindowIds: (sessionIds) =>
        requireSessionWindowRestoreService().saveSnapshot(sessionIds),
      onSnapshotPersistenceError: (error) => {
        writeAppLog({
          level: "warn",
          kind: "session.window.restore_snapshot.save_failed",
          process: "main",
          message: "Session Window restore snapshot save failed",
          error: appLogService.errorToLogError(error),
        });
      },
    });
  }

  return sessionWindowBridge;
}

function requireSessionWindowRestoreService(): SessionWindowRestoreService {
  if (!sessionWindowRestoreService) {
    sessionWindowRestoreService = new SessionWindowRestoreService({
      storage: new SessionWindowRestoreStorage(app.getPath("userData")),
      getSession: (sessionId) => requireSessionStorage().getSession(sessionId),
      getSessionWindowRestoreStates: () =>
        requireSessionWindowBridge().getSessionWindowRestoreStates(),
      openSessionWindow: (sessionId) => requireSessionWindowBridge().openSessionWindow(sessionId),
      onRestoreSetChanged: (sessionIds) => {
        requireWindowBroadcastService().broadcastSessionWindowRestoreSet(sessionIds);
      },
    });
  }
  return sessionWindowRestoreService;
}

function requireSettingsCatalogService(): SettingsCatalogService {
  if (!settingsCatalogService) {
    settingsCatalogService = new SettingsCatalogService({
      captureStorageIdentity: () => requireActivePersistentStoreOwnerForFactory("Settings catalog"),
      isStorageIdentityCurrent: (owner) => activePersistentStoreOwner === owner,
      runProviderRuntimeOperationExclusive: (operation) =>
        providerRuntimeOperationCoordinator.runExclusive(operation),
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
      updateSessionThreadIfMatches: (input) =>
        requireMainSessionPersistenceFacade().updateSessionThreadIfMatches(input),
      updateSessionRuntimeMetadataIfMatches: (input) =>
        requireMainSessionPersistenceFacade().updateSessionRuntimeMetadataIfMatches(input),
      replaceAuxiliarySessions: (nextSessions) =>
        requireAuxiliarySessionService().replaceAuxiliarySessions(nextSessions),
      updateAuxiliarySessionThreadIfMatches: (input) =>
        requireAuxiliarySessionService().updateAuxiliarySessionThreadIfMatches(input),
      updateAuxiliarySessionRuntimeMetadataIfMatches: (input) =>
        requireAuxiliarySessionService().updateAuxiliarySessionRuntimeMetadataIfMatches(input),
      updateCompanionRuntimeMetadataIfMatches: (sessionId, input) =>
        requireCompanionStorage().updateRuntimeMetadataIfMatches(sessionId, input),
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
      dismissSessionTurnNotification: (sessionId) =>
        requireSessionTurnNotificationService().dismissSessionNotification(sessionId),
      recreateDatabaseFile,
      applyAppSettingsSideEffects: (settings) => {
        applyLaunchAtLoginSetting(app, settings.launchAtLoginEnabled, app.isPackaged);
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
  activePersistentStoreOwner = bundle;
  storageWorker = bundle.storageWorker ?? null;
  promptTemplateStorage = storageWorker?.stores.prompt ?? null;
  mateProfileItemStorage = null;
  characterAffectTurnSettlementStorage = storageWorker?.stores.settlement ?? null;
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
  let pending = false;
  walMaintenanceTimer = setInterval(() => {
    if (!dbPath || pending) {
      return;
    }
    const owner = storageWorker;
    pending = true;
    void (async () => {
      try {
        if (owner) {
          await owner.truncateWal();
        } else {
          truncateAppDatabaseWalIfLargerThan(dbPath, undefined, {
            busyTimeoutMs: SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
          });
        }
      } catch (error) {
        console.warn("SQLite WAL maintenance failed", error);
      } finally {
        pending = false;
      }
    })();
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

  await closePersistentStores();
  try {
    const bundle = await requirePersistentStoreLifecycleService().initialize(
      dbPath,
      bundledModelCatalogPath,
      app.getPath("userData"),
    );
    const activeModelCatalog = applyPersistentStoreBundle(bundle);
    appDatabaseDiagnostics = await inspectCurrentAppDatabase();
    startWalMaintenance();
    return activeModelCatalog;
  } catch (error) {
    throw error;
  }
}

async function closePersistentStores(): Promise<void> {
  activePersistentStoreOwner = null;
  stopWalMaintenance();
  if (!storageWorker) {
    await characterAffectTurnSettlementStorage?.close();
    await promptTemplateStorage?.close();
    await mateProfileItemStorage?.close();
  }
  characterAffectTurnSettlementStorage = null;
  characterAffectTurnDrainCursor = undefined;
  if (!storageWorker) {
    await companionStorage?.close();
  }
  companionAuditLogStorage?.close();
  await requirePersistentStoreLifecycleService().close({
    storageWorker,
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
  storageWorker = null;
  modelCatalogStorage = null;
  characterStorage = null;
  characterService = null;
  characterAuthoringService = null;
  managedSkillDistributionService = null;
  memoryCliShimService = null;
  sessionStorage = null;
  sessionMemoryStorage = null;
  projectMemoryStorage = null;
  auditLogStorage = null;
  auditLogService = null;
  auxiliarySessionStorage = null;
  auxiliarySessionService = null;
  auxiliarySessionRuntimeService = null;
  sessionRuntimeService = null;
  appSettingsStorage = null;
  promptTemplateStorage = null;
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
  sessionLaunchSelectionService = null;
  sessionPersistenceService = null;
  mainWindowFacade = null;
  mainQueryService = null;
  mainInfrastructureRegistry?.reset();
  mainInfrastructureRegistry = null;
}

async function recreateDatabaseFile(): Promise<ModelCatalogSnapshot> {
  if (!dbPath) {
    throw new Error("DB path が初期化されていないよ。");
  }

  activePersistentStoreOwner = null;
  const memoryRuntimeToStop = memoryV6RuntimeApi;
  memoryV6RuntimeApi = null;
  memoryV6RuntimeStatus = "stopped";
  if (memoryRuntimeToStop) {
    // Reset must not remove a database still owned by another Worker.
    // Unlike application quit, a failed close aborts this destructive action.
    await memoryRuntimeToStop.stop();
  }

  stopWalMaintenance();
  if (!storageWorker) {
    await characterAffectTurnSettlementStorage?.close();
    await promptTemplateStorage?.close();
    await mateProfileItemStorage?.close();
  }
  characterAffectTurnSettlementStorage = null;
  characterAffectTurnDrainCursor = undefined;
  await requireMateStorage().deleteMateProjectionDirectory();
  mateProfileItemStorage = null;
  if (!storageWorker) {
    await companionStorage?.close();
  }
  companionAuditLogStorage?.close();
  const bundle = await requirePersistentStoreLifecycleService().recreate(dbPath, bundledModelCatalogPath, {
    storageWorker,
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
  sessionRuntimeService = null;
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
  sessionLaunchSelectionService = null;
  sessionPersistenceService = null;
  mainWindowFacade = null;
  mainQueryService = null;
  mainInfrastructureRegistry?.reset();
  mainInfrastructureRegistry = null;
  sessions = [];

  const activeModelCatalog = applyPersistentStoreBundle(bundle);
  appDatabaseDiagnostics = await inspectCurrentAppDatabase();
  if (memoryRuntimeToStop) {
    await startMemoryV6RuntimeApiBestEffort();
    if (!memoryV6RuntimeApi) {
      throw new Error("DB は初期化済みですが、Memory runtime の再起動に失敗しました。アプリを再起動してください。");
    }
  }
  startWalMaintenance();
  return activeModelCatalog;
}

async function getModelCatalog(revision?: number | null): Promise<ModelCatalogSnapshot | null> {
  return requireMainProviderFacade().getModelCatalog(revision);
}

async function resolveProviderCatalog(
  providerId: string | null | undefined,
  revision?: number | null,
): Promise<{ snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider }> {
  return requireMainProviderFacade().resolveProviderCatalog(providerId, revision);
}

function getProviderCodingAdapter(providerId: string | null | undefined) {
  return requireMainProviderFacade().getProviderCodingAdapter(providerId);
}

function getProviderBackgroundAdapter(providerId: string | null | undefined) {
  return requireMainProviderFacade().getProviderBackgroundAdapter(providerId);
}

async function resetProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void> {
  await requireMainProviderFacade().resetProviderSessionThread(providerId, sessionId);
}

async function invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void> {
  await requireMainProviderFacade().invalidateProviderSessionThread(providerId, sessionId);
}

async function invalidateAllProviderSessionThreads(): Promise<void> {
  await requireMainProviderFacade().invalidateAllProviderSessionThreads();
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

async function getSessionFileExplorerContext(sessionId: string): Promise<SessionFileExplorerContext | null> {
  const auxiliarySession = await requireAuxiliarySessionService().getAuxiliarySession(sessionId);
  if (auxiliarySession) {
    const parentSession = await getAuxiliaryParentSession(auxiliarySession.parentSessionId);
    if (!parentSession) {
      return null;
    }
    return {
      workspacePath: parentSession.workspacePath,
      parentSessionId: parentSession.id,
      allowedAdditionalDirectories: auxiliarySession.allowedAdditionalDirectories,
    };
  }

  const session = await getRuntimeSession(sessionId);
  if (session) {
    return {
      workspacePath: session.workspacePath,
      parentSessionId: session.id,
      allowedAdditionalDirectories: session.allowedAdditionalDirectories,
    };
  }
  const companionSession = await requireCompanionStorage().getSession(sessionId);
  return companionSession
    ? {
        workspacePath: companionSession.worktreePath,
        parentSessionId: companionSession.id,
        allowedAdditionalDirectories: companionSession.allowedAdditionalDirectories ?? [],
      }
    : null;
}

async function getSessionFileExplorerOwnerSessionId(sessionId: string): Promise<string | null> {
  return (await getSessionFileExplorerContext(sessionId))?.parentSessionId ?? null;
}

function createSessionFileExplorerService(): SessionFileExplorerService {
  return new SessionFileExplorerService({
    userDataPath: app.getPath("userData"),
    getSessionContext: getSessionFileExplorerContext,
    openResolvedPath: (targetPath, reveal) => openPathTarget(targetPath, { reveal }),
  });
}

function createFileRootGitChangesService(): FileRootGitChangesService {
  const explorer = createSessionFileExplorerService();
  return new FileRootGitChangesService({
    resolveRootContext: async (request) => {
      const root = await explorer.resolveRoot(request.sessionId, request.rootId);
      return root ? { rootPath: root.absolutePath } : null;
    },
    resolveHistoryRootContexts: async (sessionId) => (await explorer.resolveHistoryRoots(sessionId)).map((root) => ({
      rootId: root.id,
      label: root.label,
      displayPath: root.displayPath,
      rootPath: root.absolutePath,
    })),
    resolveHistoryRootContext: async (request) => {
      const root = await explorer.resolveHistoryRoot(request.sessionId, request.rootId);
      return root ? { rootPath: root.absolutePath } : null;
    },
  });
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

async function broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): Promise<void> {
  await requireMainBroadcastFacade().broadcastModelCatalog(snapshot);
}

async function broadcastAppSettings(settings?: AppSettings): Promise<void> {
  await requireMainBroadcastFacade().broadcastAppSettings(settings);
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

function listOpenSessionWindowIdsPage(
  request?: OpenSessionWindowIdsPageRequest | null,
): OpenSessionWindowIdsPageResult {
  return buildOpenSessionWindowIdsPage(listOpenSessionWindowIds(), request);
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
  await requireAuxiliarySessionService().recoverInterruptedSessions();
}

async function previewComposerInput(
  sessionId: string,
  userMessage: string,
) {
  const auxiliaryService = requireAuxiliarySessionService();
  const auxiliarySession = await auxiliaryService.getAuxiliarySession(sessionId);
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

async function openLocalPath(targetPath: string): Promise<OpenPathResult> {
  return openLocalPathWithDefaultApp(targetPath, {
    statTarget: stat,
    openWithDefaultApp: (pathValue) => shell.openPath(pathValue),
  });
}

async function openPathTarget(target: string, options?: OpenPathOptions): Promise<OpenPathResult> {
  try {
    const resolved = resolveOpenPathTarget(target, options);
    if (resolved.type === "external-url") {
      await shell.openExternal(resolved.target);
      return { status: "opened", targetType: "external-url", target: resolved.target };
    }

    if (options?.reveal) {
      return revealLocalPathInFileManager(resolved.targetPath, {
        statTarget: stat,
        openWithDefaultApp: (pathValue) => shell.openPath(pathValue),
        revealInFileManager: (pathValue) => shell.showItemInFolder(pathValue),
      });
    }

    const localResult = await openLocalPath(resolved.targetPath);
    const externalFallback = resolveProtocolRelativeExternalFallbackAfterLocalOpen(target, localResult);
    if (externalFallback) {
      await shell.openExternal(externalFallback);
      return { status: "opened", targetType: "external-url", target: externalFallback };
    }
    return localResult;
  } catch (error) {
    return {
      status: "failed",
      targetType: "unknown",
      target,
      message: error instanceof Error ? error.message : "The target could not be opened.",
    };
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

async function openSessionWindow(sessionId: string, auxiliarySessionId?: string): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSessionWindow(sessionId, auxiliarySessionId);
}

async function openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
  return requireMainWindowFacade().openDiffWindow(diffPreview);
}

async function openSessionFilePreviewWindow(
  request: SessionFilePreviewWindowOpenRequest,
): Promise<SessionFilePreviewWindowOpenResult> {
  if (request.kind === "history-diff") {
    const result = await createFileRootGitChangesService().getHistoryDiff(request.request);
    if (result.status !== "ok") {
      return {
        status: "failed",
        targetType: "local-file",
        target: request.request.relativePath ?? "Git history diff",
        message: result.message,
      };
    }
    try {
      const ownerSessionId = await getSessionFileExplorerOwnerSessionId(request.request.sessionId);
      if (!ownerSessionId) {
        throw new Error("The owning Session could not be resolved.");
      }
      const historyDiff: SessionFileHistoryDiffWindowPayload = {
        request: request.request,
        patch: result.patch,
        previewResource: "previewResource" in result ? result.previewResource : null,
        previewBeforeResource: "previewBeforeResource" in result ? result.previewBeforeResource : null,
        previewAfterResource: "previewAfterResource" in result ? result.previewAfterResource : null,
      };
      const { disposition } = await requireMainWindowFacade().openFilePreviewWindow({
        historyDiff,
        ownerSessionId,
        windowTitle: resolveSessionFilePreviewWindowTitle(request.request.relativePath ?? "Git Diff"),
      });
      return {
        status: "opened",
        targetType: "preview-window",
        disposition,
        historyDiff: request.request,
      };
    } catch (error) {
      return {
        status: "failed",
        targetType: "local-file",
        target: request.request.relativePath ?? "Git history diff",
        message: error instanceof Error ? error.message : "The Git history diff could not be opened.",
      };
    }
  }
  const explorer = createSessionFileExplorerService();
  let resource = request.kind === "resource" ? request.resource : null;
  if (request.kind === "link") {
    const resolution = await explorer.resolvePreviewTarget(
      request.sessionId,
      request.target,
      request.baseResource,
    );
    if (resolution.type === "external-url") {
      const opened = await openPathTarget(resolution.target);
      return opened.status === "opened"
        ? { status: "opened", targetType: "external-url", target: opened.target }
        : {
            status: "failed",
            targetType: "unknown",
            target: opened.target,
            message: opened.message ?? "The external URL could not be opened.",
          };
    }
    if (resolution.type === "directory") {
      const opened = await openPathTarget(resolution.targetPath);
      return opened.status === "opened"
        ? { status: "opened", targetType: "local-directory", target: opened.target }
        : {
            status: opened.status === "not-found" ? "not-found" : "failed",
            targetType: "local-path",
            target: opened.target,
            message: opened.message ?? "The directory could not be opened.",
          };
    }
    if (resolution.type !== "file") {
      return {
        status: resolution.type,
        targetType: resolution.type === "not-previewable" ? "local-file" : "local-path",
        target: resolution.targetPath,
        message: resolution.message,
      };
    }
    resource = resolution.resource;
  }

  if (!resource) {
    return {
      status: "failed",
      targetType: "unknown",
      target: "",
      message: "The preview resource could not be resolved.",
    };
  }
  try {
    const fileName = isSessionFileGitCommitResource(resource)
      ? (await createFileRootGitChangesService().resolveHistoryFilePreview(resource)).name
      : (await explorer.inspectFile(resource)).name;
    const ownerSessionId = await getSessionFileExplorerOwnerSessionId(resource.sessionId);
    if (!ownerSessionId) {
      throw new Error("The owning Session could not be resolved.");
    }
    const { disposition } = await requireMainWindowFacade().openFilePreviewWindow({
      resource,
      ownerSessionId,
      windowTitle: isSessionFileGitCommitResource(resource)
        ? resolveSessionFileGitCommitPreviewWindowTitle(fileName, resource.commitId)
        : resolveSessionFilePreviewWindowTitle(fileName),
      view: request.kind === "resource" ? request.view ?? { kind: "preview" } : { kind: "preview" },
    });
    return { status: "opened", targetType: "preview-window", disposition, resource };
  } catch (error) {
    return {
      status: "failed",
      targetType: "local-file",
      target: "absolutePath" in resource ? resource.absolutePath : resource.relativePath,
      message: error instanceof Error ? error.message : "The file preview could not be opened.",
    };
  }
}

async function openCompanionReviewWindow(sessionId: string, auxiliarySessionId?: string): Promise<BrowserWindow> {
  writeAppLog({
    level: "info",
    kind: "companion.review-window.open.started",
    process: "main",
    message: "Companion review window open started",
    data: { sessionId, auxiliarySessionId: auxiliarySessionId ?? null },
  });
  const window = await requireMainWindowFacade().openCompanionReviewWindow(sessionId, auxiliarySessionId);
  if (auxiliarySessionId) {
    requireMainBroadcastFacade().broadcastAuxiliarySessionSelection(sessionId, auxiliarySessionId);
  }
  writeAppLog({
    level: "info",
    kind: "companion.review-window.open.completed",
    process: "main",
    message: "Companion review window open completed",
    windowId: window.id,
    data: { sessionId, auxiliarySessionId: auxiliarySessionId ?? null },
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

async function inspectCurrentAppDatabase(): Promise<AppDatabaseDiagnostics> {
  const worker = createAppDatabaseBootstrapWorker();
  try {
    return await worker.inspect({
      userDataPath: app.getPath("userData"),
      activeDatabasePath: dbPath,
      userDataPathOverrideApplied: Boolean(userDataPathOverride),
    });
  } finally {
    await worker.close();
  }
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
      const bootstrapWorker = createAppDatabaseBootstrapWorker();
      try {
        const resolved = await bootstrapWorker.resolveOrMigrate({
          userDataPath: app.getPath("userData"),
          userDataPathOverrideApplied: Boolean(userDataPathOverride),
        }, (progress) => {
          publishAppBootStatus({
            kind: "running",
            stage: "database",
            title: progress.title,
            detail: progress.detail,
          });
        });
        dbPath = resolved.dbPath;
      } finally {
        await bootstrapWorker.close();
      }
      publishAppBootStatus({
        kind: "running",
        stage: "diagnostics",
        title: "データベース診断を確認しています",
        detail: "利用するデータベースと schema version を確認しています。",
      });
      appDatabaseDiagnostics = await inspectCurrentAppDatabase();
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
      await requireMainBootstrapService().handleReady();
      await startMemoryV6RuntimeApiBestEffort();
      requireCharacterAffectTurnRetryScheduler().request({ immediate: true, resetBackoff: true });
      requireAppTrayService().initialize();
      applyLaunchAtLoginSetting(
        app,
        (await requireAppSettingsStorage().getSettings()).launchAtLoginEnabled,
        app.isPackaged,
      );
      await syncManagedGlossarySkillBestEffort();
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
    void requireAppLifecycleService().handleBeforeQuit(event);
  });

  app.on("will-quit", () => {
    writeAppLog({
      level: "info",
      kind: "app.will-quit",
      process: "main",
      message: "App will quit",
    });
    appTrayService?.dispose();
    characterAffectTurnRetryScheduler?.dispose();
  });
}
