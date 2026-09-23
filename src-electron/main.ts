import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
  Tray,
  type NativeImage,
} from "electron";

import { summarizeAuditLogDetailFragment } from "../src-shared/session/audit-log-detail-metrics.js";
import type { AuditLogDetail, AuditLogDetailFragment, AuditLogDetailSection, AuditLogEntry, AuditLogOperationDetailFragment, AuditLogSummary, AuditLogSummaryPageRequest, AuditLogSummaryPageResult, DiscoveredCustomAgent, DiscoveredSkill, LiveApprovalDecision, LiveApprovalRequest, LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState, ProviderQuotaTelemetry, RunSessionTurnRequest, SessionContextTelemetry } from "../src-shared/session/runtime-state.js";
import { currentTimestampLabel } from "../src-shared/time-state.js";
import { createDefaultSessionMemory } from "../src-shared/memory/session-memory-state.js";
import type { SessionBackgroundActivityKind, SessionBackgroundActivityState } from "../src-shared/memory/session-memory-state.js";
import type { SessionCharacterUsage, SessionSummaryPageRequest, HomeSessionSummaryPageResult } from "../src-shared/session/session-state.js";
import {
  type DiffPreviewPayload,
  getSessionIncarnationId,
  type MessageArtifact,
  type Session,
} from "../src-shared/session/session-state.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "../src-shared/character/character-authoring.js";
import {
  type ModelCatalogDocument,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src-shared/settings/model-catalog.js";
import {
  buildOpenSessionWindowIdsPage,
} from "../src-shared/window/withmate-window-types.js";
import type {
  OpenPathOptions,
  OpenPathResult,
  OpenSessionWindowIdsPageRequest,
  OpenSessionWindowIdsPageResult,
  SavePastedSessionFileRequest,
} from "../src-shared/window/withmate-window-types.js";
import type {
  SessionFileHistoryDiffWindowPayload,
  SessionFilePreviewWindowOpenRequest,
  SessionFilePreviewWindowOpenResult,
} from "../src-shared/file-explorer/file-explorer-contract.js";
import {
  isSessionFileGitCommitResource,
  resolveSessionFileGitCommitPreviewWindowTitle,
  resolveSessionFilePreviewWindowTitle,
} from "../src-shared/file-explorer/file-explorer-contract.js";
import { AuditLogStorage } from "./session/audit-log-storage.js";
import { AuditLogService } from "./session/audit-log-service.js";
import { AppSettingsStorage } from "./app/app-settings-storage.js";
import { PromptTemplateStorage } from "./prompt-templates/prompt-template-storage.js";
import { createV6StorageWorkerBundle, type V6StorageWorkerBundle } from "./storage/storage-worker-bundle.js";
import { createAppDatabaseBootstrapWorker } from "./storage/app-database-bootstrap-worker.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../src-shared/prompt-template.js";
import { resolveAuxiliaryParentSession } from "./auxiliary/auxiliary-parent-session.js";
import { AuxiliarySessionService } from "./auxiliary/auxiliary-session-service.js";
import { admitSessionTurn } from "./session/session-turn-admission.js";
import {
  AuxiliarySessionStorage,
  resolveLegacyAuxiliaryPreviewFromAuditEntries,
} from "./auxiliary/auxiliary-session-storage.js";
import { CharacterService } from "./character/character-service.js";
import { CharacterWorkspaceOperationCoordinator } from "./character/character-workspace-operation-coordinator.js";
import { CharacterStorage } from "./character/character-storage.js";
import {
  CharacterAuthoringService,
  CHARACTER_AUTHORING_SKILL_NAME,
  resolveCharacterAuthoringRuntimeSessionForTurn,
} from "./character/character-authoring-service.js";
import { CodexAdapter } from "./providers/codex/codex-adapter.js";
import { CopilotAdapter } from "./providers/copilot/copilot-adapter.js";
import { resolveComposerPreview } from "./files/composer-attachments.js";
import { areDirectoryPathsEquivalent } from "./files/additional-directories.js";
import { ModelCatalogStorage } from "./settings/model-catalog-storage.js";
import {
  openLocalPathWithDefaultApp,
  revealLocalPathInFileManager,
  resolveProtocolRelativeExternalFallbackAfterLocalOpen,
  resolveOpenPathTarget,
} from "./files/open-path.js";
import { launchTerminalAtPath } from "./files/open-terminal.js";
import { SessionStorage } from "./session/session-storage.js";
import { SessionMemoryStorage } from "./session/session-memory-storage.js";
import { ProjectMemoryStorage } from "./memory/project-memory-storage.js";
import { SessionRuntimeService } from "./session/session-runtime-service.js";
import { createMainSessionRuntime } from "./app/main-session-runtime-assembly.js";
import { createAuxiliarySessionRuntime } from "./auxiliary/auxiliary-session-runtime-assembly.js";
import { SessionTurnNotificationService } from "./session/session-turn-notification-service.js";
import { createCharacterAffectTurnRecoveryFailureLogData } from "./character/character-affect-turn-recovery.js";
import { CharacterAffectTurnRetryScheduler } from "./character/character-affect-turn-retry-scheduler.js";
import { CharacterAffectTurnOwnershipCoordinator } from "./character/character-affect-turn-ownership-coordinator.js";
import { createCharacterAffectTurnMainLifecycle } from "./character/character-affect-turn-main-lifecycle.js";
import type { CharacterAffectTurnDrainCursor } from "./character/character-affect-turn-drain.js";
import { CharacterAffectTurnSettlementStorage } from "./character/character-affect-turn-settlement-storage.js";
import { SessionPersistenceService } from "./session/session-persistence-service.js";
import { createSessionStorageCommandAdapter } from "./session/session-storage-command-adapter.js";
import { createSessionPersistenceAssembly } from "./session/session-persistence-assembly.js";
import { SessionWindowBridge } from "./windows/session-window-bridge.js";
import { SessionWindowRestoreService } from "./windows/session-window-restore-service.js";
import { SettingsCatalogService } from "./settings/settings-catalog-service.js";
import { SessionObservabilityService } from "./session/session-observability-service.js";
import { SessionApprovalService } from "./session/session-approval-service.js";
import { SessionElicitationService } from "./session/session-elicitation-service.js";
import { WindowBroadcastService } from "./windows/window-broadcast-service.js";
import { WindowDialogService } from "./windows/window-dialog-service.js";
import { WorkspaceDirectoryValidationService } from "./files/workspace-directory-validation-service.js";
import { SessionMemorySupportService } from "./session/session-memory-support-service.js";
import { SessionFileExplorerService, type SessionFileExplorerContext } from "./files/session-file-explorer-service.js";
import { SessionFileExplorerRuntime } from "./files/session-file-explorer-runtime.js";
import { SessionFilePreviewImageCopyService } from "./files/session-file-preview-image-copy-service.js";
import { SessionFileObjectCopyService } from "./files/session-file-object-copy-service.js";
import { SessionFileTreeContextMenuService } from "./files/session-file-tree-context-menu-service.js";
import { SessionMonitorContextMenuService } from "./session/session-monitor-context-menu-service.js";
import { MarkdownLinkContextMenuService } from "./windows/markdown-link-context-menu-service.js";
import { WindowsFileDropClipboardWriter } from "./files/windows-file-drop-clipboard-writer.js";
import { FileRootGitChangesService } from "./files/file-root-git-changes-service.js";
import {
  appendSessionFilesDirectory,
  appendSessionFilesDirectoryForSessionId,
  copyFilesToSessionFiles as copyFilesToSessionFilesStorage,
  createSessionFilesDirectory,
  deleteSessionFilesDirectory,
  resolveSessionFilesDirectory,
  saveSessionFile,
} from "./files/session-files.js";
import { MateStorage } from "./mate/mate-storage.js";
import { MateProfileItemStorage } from "./mate/mate-profile-item-storage.js";
import { WindowEntryLoader } from "./windows/window-entry-loader.js";
import { AuxWindowService } from "./auxiliary/aux-window-service.js";
import { registerMainIpcHandlers } from "./ipc/register-main-ipc.js";
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
} from "./storage/persistent-store-lifecycle-service.js";
import { AppLifecycleService } from "./app/app-lifecycle-service.js";
import { createAppLifecycleDeps } from "./app/app-lifecycle-deps.js";
import {
  applyLaunchAtLoginSetting,
  resolveAppUserModelId,
  shouldLaunchInBackground,
} from "./app/app-login-item.js";
import { AppTrayService } from "./app/app-tray-service.js";
import { createMainBootstrapDeps } from "./app/main-bootstrap-deps.js";
import { MainInfrastructureRegistry } from "./app/main-infrastructure-registry.js";
import { MainBootstrapService } from "./app/main-bootstrap-service.js";
import { MainBroadcastFacade } from "./app/main-broadcast-facade.js";
import { MainObservabilityFacade } from "./app/main-observability-facade.js";
import { MainProviderFacade } from "./app/main-provider-facade.js";
import { MainSessionCommandFacade } from "./app/main-session-command-facade.js";
import { ProviderRuntimeOperationCoordinator } from "./providers/provider-runtime-operation-coordinator.js";
import { runWithStorageOperationCorrelation, startEventLoopDelayMonitoring, type StorageOperationDiagnostic } from "./storage/storage-operation-diagnostics.js";
import { MainSessionPersistenceFacade } from "./app/main-session-persistence-facade.js";
import { SessionLaunchSelectionService } from "./session/session-launch-selection-service.js";
import { MainWindowFacade } from "./app/main-window-facade.js";
import { MainWindowComposition } from "./windows/main-window-composition.js";
import { MainWindowRuntime } from "./windows/main-window-runtime.js";
import { MainLogComposition } from "./app/main-log-composition.js";
import { MainQueryService } from "./app/main-query-service.js";
import {
  ManagedSkillDistributionService,
  type ManagedSkillBundleDescriptor,
  WITHMATE_GLOSSARY_SKILL_NAME,
} from "./skills/managed-skill-distribution-service.js";
import { MemoryCliShimService } from "./memory/memory-cli-shim-service.js";
import { hydrateSessionsFromSummaries } from "./session/session-summary-adapter.js";
import type { AppSettings } from "../src-shared/settings/provider-settings-state.js";
import type { ChatLayoutPreferenceUpdate } from "../src-shared/settings/chat-layout-preference.js";
import { discoverSessionSkills } from "./skills/skill-discovery.js";
import { discoverSessionCustomAgents } from "./skills/custom-agent-discovery.js";
import { HOME_WINDOW_DEFAULT_BOUNDS, SESSION_WINDOW_DEFAULT_BOUNDS } from "./windows/window-defaults.js";
import { AppLogService } from "./app/app-log-service.js";
import type { AppBootStatus } from "../src-shared/window/app-boot-state.js";
import type { AppDatabaseDiagnostics } from "../src-shared/window/app-database-diagnostics-state.js";
import type {
  MemoryV6DiagnosticEvent,
  MemoryV6Diagnostics,
} from "../src-shared/memory/memory-diagnostics-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest } from "../src-shared/memory/memory-contract.js";
import {
  CHARACTER_CONTEXT_SCHEMA_VERSION,
  isCharacterContextError,
} from "../src-shared/character-context/character-context-contract.js";
import type { MemoryV6ProtectedObjectGcRequest } from "../src-shared/memory/memory-review-state.js";
import {
  assertPersistentStoreOwnerActive,
  capturePersistentStoreOwner,
} from "./storage/persistent-store-owner-guard.js";
import {
  startMemoryV6RuntimeApi,
  type MemoryV6RuntimeApiHandle,
} from "./memory/memory-v6-runtime.js";
import { createElectronSafeStorageKeyProtector } from "./memory/memory-protected-object-key-store.js";
import { MemoryV6MainAssembly } from "./memory/memory-v6-main-assembly.js";
import { AgentRuntimeBindingRegistry } from "./providers/agent-runtime-binding.js";
import { updateAuxiliarySessionWithProviderRuntimeLifecycle } from "./auxiliary/auxiliary-provider-runtime-lifecycle.js";
import { getMemoryV6AgentRuntimeOperations } from "./memory/memory-v6-http-server.js";
import { RuntimeDiscoveryRegistryError } from "./platform/runtime-discovery/runtime-discovery-contract.js";
import {
  GlossaryApplicationService,
  projectGlossaryCheckoutAuthority,
} from "./glossary/glossary-application-service.js";
import { GlossaryRuntimeService } from "./glossary/glossary-runtime-service.js";
import { ProviderAgentRuntimeTurnCoordinator } from "./providers/provider-agent-runtime-turn-coordinator.js";
import { buildProviderAgentRuntimeAuthoritySnapshot } from "./providers/provider-agent-runtime-binding.js";
import { resolveMemoryV6ProjectCandidate } from "./memory/memory-v6-project-resolver.js";
import { resolveBundledMemoryCliScriptPath } from "./platform/cli-runtime-paths.js";
import { GlossarySessionProjectionService } from "./glossary/glossary-session-projection-service.js";
import { SessionGlossaryWindowSubscriptionCoordinator } from "./session/session-glossary-window-subscription.js";
import { getGlossaryAgentRuntimeOperations } from "../src-shared/glossary/glossary-operation-schema.js";
import { MainStoreContext } from "./app/main-store-context.js";
import {
  WITHMATE_GET_APP_BOOT_STATUS_CHANNEL,
  WITHMATE_OPEN_AUXILIARY_SESSION_EVENT,
  WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT,
  WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT,
  WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT,
  WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT,
} from "../src-shared/ipc/withmate-ipc-channels.js";
import { CREATE_V2_SCHEMA_SQL } from "./storage/database-schema-v2.js";
import { CREATE_V3_SCHEMA_SQL, isValidV3Database } from "./storage/database-schema-v3.js";
import { isValidV4Database } from "./storage/database-schema-v4.js";
import { ensureV6Schema } from "./storage/database-schema-v6.js";
import {
  markMainThreadAsNonStorageOwner,
  openAppDatabase,
  SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
  truncateAppDatabaseWal,
  truncateAppDatabaseWalIfLargerThan,
} from "./storage/sqlite-connection.js";

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
const mainLogComposition = new MainLogComposition(
  writeAppLog,
  (error) => appLogService.errorToLogError(error),
);
const crashDumpsPath = mainLogComposition.resolveCrashDumpsPath();
const WAL_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

const mainStoreContext = new MainStoreContext();
let characterService: CharacterService | null = null;
let characterAuthoringService: CharacterAuthoringService | null = null;
let managedSkillDistributionService: ManagedSkillDistributionService | null = null;
let memoryCliShimService: MemoryCliShimService | null = null;
let allowQuitWithInFlightRuns = false;
let memoryV6RuntimeApi: MemoryV6RuntimeApiHandle | null = null;
let characterAffectTurnRetryScheduler: CharacterAffectTurnRetryScheduler | null = null;
const characterAffectTurnStartupRecoveryCutoff = new Date().toISOString();
const isBackgroundLaunch = shouldLaunchInBackground(process.argv);
let memoryV6DiagnosticErrors: MemoryV6DiagnosticEvent[] = [];
const memoryV6MainAssembly = new MemoryV6MainAssembly({
  getRuntime: () => memoryV6RuntimeApi,
  getRuntimeStatus: () => mainStoreContext.memoryV6RuntimeStatus,
  getCliShimService: () => requireMemoryCliShimService(),
  getDiagnosticErrors: () => memoryV6DiagnosticErrors,
  userDataPath: fixedUserDataPath,
  protectedObjectKeyProtector: createElectronSafeStorageKeyProtector(safeStorage),
  getMemoryFileQuotaBytes: async () => (await requireAppSettingsStorage().getSettings()).memoryFileQuotaBytes,
});
const mainWindowComposition = new MainWindowComposition(
  preloadPath,
  mainLogComposition.attachWindowLogHandlers,
  (window) => requireWindowEntryLoader().loadBootEntry(window),
);
const mainWindowRuntime = new MainWindowRuntime({
  composition: mainWindowComposition,
  devServerUrl,
  rendererDistPath,
  userDataPath: fixedUserDataPath,
  getSession,
  readSession: (sessionId) => requireSessionStorage().getSession(sessionId),
  getSettingsCatalog: () => requireSettingsCatalogService(),
  isSessionRunInFlight,
  cancelInFlightSessionRuns,
  waitForPendingDraftSends: () => auxiliarySessionService?.waitForPendingDraftSends() ?? Promise.resolve(true),
  onSessionWindowClosed: (sessionId) => auxiliarySessionService?.releaseAuxiliaryCreationOwner(sessionId),
  confirmCloseWhileRunning: (window) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: ["KeepOpen", "CloseAndContinue"],
      defaultId: 0,
      cancelId: 0,
      title: "Session Is Running",
      message: "This session is still running.",
      detail: "The run will continue after this window closes. Reopen the session later to check its progress.",
      noLink: true,
    });
    return choice === 1;
  },
  persistSnapshotError: (error) => {
    writeAppLog({
      level: "warn",
      kind: "session.window.restore_snapshot.save_failed",
      process: "main",
      message: "Session Window restore snapshot save failed",
      error: appLogService.errorToLogError(error),
    });
  },
});
const sessionFileExplorerRuntime = new SessionFileExplorerRuntime({
  userDataPath: fixedUserDataPath,
  getSessionContext: getSessionFileExplorerContext,
  openResolvedPath: (targetPath, reveal) => openPathTarget(targetPath, { reveal }),
});
let appBootStatus: AppBootStatus = {
  kind: "running",
  stage: "starting",
  title: "Starting WithMate",
};
const hasSingleInstanceLock = app.requestSingleInstanceLock();

ipcMain.handle(WITHMATE_GET_APP_BOOT_STATUS_CHANNEL, () => appBootStatus);
const PROVIDER_QUOTA_STALE_TTL_MS = 5 * 60 * 1000;
let sessionRuntimeService: SessionRuntimeService | null = null;
let sessionTurnNotificationService: SessionTurnNotificationService<NativeImage> | null = null;
let auxiliarySessionService: AuxiliarySessionService | null = null;
let auxiliarySessionRuntimeService: SessionRuntimeService | null = null;
let sessionPersistenceService: SessionPersistenceService | null = null;
let settingsCatalogService: SettingsCatalogService | null = null;
let sessionObservabilityService: SessionObservabilityService | null = null;
let sessionApprovalService: SessionApprovalService | null = null;
let sessionElicitationService: SessionElicitationService | null = null;
let auditLogService: AuditLogService | null = null;
let sessionMemorySupportService: SessionMemorySupportService | null = null;
let mainBroadcastFacade: MainBroadcastFacade<BrowserWindow> | null = null;
let mainObservabilityFacade: MainObservabilityFacade | null = null;
let mainProviderFacade: MainProviderFacade | null = null;
let mainSessionCommandFacade: MainSessionCommandFacade | null = null;
let mainSessionPersistenceFacade: MainSessionPersistenceFacade | null = null;
let sessionLaunchSelectionService: SessionLaunchSelectionService | null = null;
const providerRuntimeOperationCoordinator = new ProviderRuntimeOperationCoordinator(logStorageOperationDiagnostic);
const characterAffectTurnOwnershipCoordinator = new CharacterAffectTurnOwnershipCoordinator(logStorageOperationDiagnostic);
const characterAffectTurnMainLifecycle = createCharacterAffectTurnMainLifecycle({
  getSettlementStorage: () => mainStoreContext.characterAffectTurnSettlementStorage,
  getRuntimeApi: () => memoryV6RuntimeApi,
  getCharacterSnapshot: (characterId) => requireCharacterService().createRuntimeSnapshot(characterId),
  getAppSettings: () => requireAppSettingsStorage().getSettings(),
  getProviderBackgroundAdapter,
  getSession: getRuntimeSession,
  startupRecoveryCutoff: characterAffectTurnStartupRecoveryCutoff,
  runAppraisalExclusive: (operation) => characterAffectTurnOwnershipCoordinator.runExclusive(operation),
  writeAppLog,
  getDrainCursor: () => mainStoreContext.characterAffectTurnDrainCursor,
  setDrainCursor: (cursor) => { mainStoreContext.setDrainCursor(cursor); },
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
let mainInfrastructureRegistry:
  | MainInfrastructureRegistry<
      PersistentStoreLifecycleService,
      AppLifecycleService,
      MainBootstrapService
    >
  | null = null;

mainLogComposition.startCrashReporter(crashDumpsPath);
mainLogComposition.registerProcessLogHandlers();
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
    data: { ...event, generationId: event.generationId ?? mainStoreContext.storageWorker?.client.generationId },
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
  if (!mainStoreContext.appDatabaseDiagnostics) {
    if (!mainStoreContext.dbPath) {
      throw new Error("Saved data is not initialized.");
    }
    mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
  }
  return mainStoreContext.appDatabaseDiagnostics!;
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
  return memoryV6MainAssembly.getDiagnostics();
}

async function installMemoryV6CliShim(): Promise<MemoryV6Diagnostics> {
  return memoryV6MainAssembly.installCliShim();
}

async function uninstallMemoryV6CliShim(): Promise<MemoryV6Diagnostics> {
  return memoryV6MainAssembly.uninstallCliShim();
}

function getMemoryV6FileUsage() {
  return memoryV6MainAssembly.getFileUsage();
}

async function exportMemoryV6EntryFiles(entryId: string, targetWindow?: BrowserWindow | null) {
  const outputDirectoryPath = await requireWindowDialogService().pickDirectory(targetWindow ?? null, null);
  if (!outputDirectoryPath) {
    return null;
  }
  return memoryV6MainAssembly.exportEntryFiles(entryId, outputDirectoryPath);
}

function runMemoryV6ProtectedObjectGc(request: MemoryV6ProtectedObjectGcRequest) {
  return memoryV6MainAssembly.runProtectedObjectGc(request);
}

function searchMemoryV6Entries(request: MemoryV6ReviewSearchRequest | null | undefined) {
  return memoryV6MainAssembly.searchEntries(request);
}

function getMemoryV6Entry(entryId: string) {
  return memoryV6MainAssembly.getEntry(entryId);
}

function forgetMemoryV6Entry(entryId: string, reason?: MemoryForgetReason | null) {
  return memoryV6MainAssembly.forgetEntry(entryId, reason);
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
  if (!mainStoreContext.auxiliarySessionStorage) {
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
    mainStoreContext.setMemoryRuntimeStatus("stopped");
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
    mainStoreContext.setMemoryRuntimeStatus("running");
    mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
  } catch (error) {
    mainStoreContext.setMemoryRuntimeStatus("failed");
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
  mainStoreContext.setMemoryRuntimeStatus("stopped");
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

async function openDirectory(directoryPath: string): Promise<void> {
  mkdirSync(directoryPath, { recursive: true });
  const result = await openLocalPath(directoryPath);
  if (result.status !== "opened") {
    throw new Error(result.message);
  }
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
  mainWindowComposition.publishBootStatus(status);
}

async function openBootWindow(): Promise<BrowserWindow> {
  return mainWindowComposition.openBootWindow(() => appBootStatus);
}

function closeBootWindow(): void {
  mainWindowComposition.closeBootWindow();
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
  return mainStoreContext.sessions;
}

async function listSessionSummaryPage(request?: SessionSummaryPageRequest | null): Promise<HomeSessionSummaryPageResult> {
  return requireMainQueryService().listSessionSummaryPage(request);
}

async function listSessionCharacterUsage(): Promise<SessionCharacterUsage[]> {
  return requireMainQueryService().listSessionCharacterUsage();
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
    || Boolean(auxiliarySessionRuntimeService?.hasInFlightRuns());
}

function cancelInFlightSessionRuns(): void {
  sessionRuntimeService?.cancelAllRuns();
  auxiliarySessionRuntimeService?.cancelAllRuns();
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
      if (mainWindowRuntime.getSessionWindowBridge().isQuitPending()) {
        throw new Error("The app is quitting, so a new message cannot be sent.");
      }
      if (databaseMaintenanceRequested) {
        throw new Error("A database maintenance operation is in progress, so a new turn cannot start.");
      }
    },
    reserve: operation,
    readProvider: async () => {
      const session = auxiliary
        ? await owner.auxiliarySessionStorage.getAuxiliarySession(sessionId)
        : await owner.sessionStorage.getSession(sessionId);
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      if (!session) {
        throw new Error("The session could not be found.");
      }
      if ("parentSessionId" in session && !await owner.sessionStorage.getSession(session.parentSessionId)) {
        throw new Error("The Auxiliary parent session could not be found.");
      }
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      return session.provider;
    },
    assertProviderAvailable: (provider) => requireSettingsCatalogService().assertProviderAvailableForTurn(provider),
  });
}

const auxiliaryRunParents = new Map<string, string>();
let databaseMaintenanceRequested = false;
function requireActivePersistentStoreOwnerForFactory(ownerName: string): PersistentStoreBundle {
  return capturePersistentStoreOwner(
    () => mainStoreContext.activePersistentStoreOwner,
    ownerName,
  ).owner;
}

function assertPersistentStoreOwnerIsActive(
  owner: PersistentStoreBundle,
  operation: string,
): void {
  assertPersistentStoreOwnerActive(() => mainStoreContext.activePersistentStoreOwner, owner, operation);
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
  if (!mainStoreContext.auxiliarySessionStorage) {
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
  PersistentStoreLifecycleService,
  AppLifecycleService,
  MainBootstrapService
> {
  if (!mainInfrastructureRegistry) {
    mainInfrastructureRegistry = new MainInfrastructureRegistry({
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
              const entries = mainStoreContext.auditLogStorage?.listSessionAuditLogs(auxiliarySessionId);
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
                buttons: ["GoBack", "Quit"],
                defaultId: 0,
                cancelId: 0,
                title: "Session Is Running",
                message: "A session is still running.",
                detail: "Quitting WithMate will interrupt the running work.",
                noLink: true,
              });
              return choice === 1;
            },
            prepareSessionWindowSnapshotForQuit: () =>
              requireSessionWindowBridge().prepareSnapshotForQuit(),
            flushSessionWindowDrafts: () => requireSessionWindowBridge().flushSessionWindowDrafts(),
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
            broadcastModelCatalog,
            onBootStatus: publishAppBootStatus,
            ipcRegistration: {
              window: {
                acknowledgeSessionDraftFlush: (event, payload) => {
                  requireSessionWindowBridge().acknowledgeDraftFlush(payload.requestId, event.sender, payload.success);
                },
                resolveEventWindow: (event) => BrowserWindow.fromWebContents(event.sender) ?? null,
                resolveHomeWindow: () => requireAuxWindowService().getHomeWindow(),
                resolveSessionWindow: (sessionId) => requireSessionWindowBridge().getWindow(sessionId),
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
                logIpcError: mainLogComposition.writeIpcErrorLog,
                reportRendererLog: mainLogComposition.writeRendererLog,
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
                    throw new Error("Database initialization is already in progress.");
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
                listSessionAuditLogs: (sessionId) => listSessionAuditLogs(sessionId),
                listSessionAuditLogSummaries: (sessionId) => listSessionAuditLogSummaries(sessionId),
                listSessionAuditLogSummaryPage: (sessionId, request) =>
                  listSessionAuditLogSummaryPage(sessionId, request),
                getSessionAuditLogDetail: (sessionId, auditLogId) => getSessionAuditLogDetail(sessionId, auditLogId),
                getSessionAuditLogDetailSection: (sessionId, auditLogId, section) =>
                  getSessionAuditLogDetailSection(sessionId, auditLogId, section),
                getSessionAuditLogOperationDetail: (sessionId, auditLogId, operationIndex) =>
                  getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex),
                listSessionSkills: async (sessionId) => listSessionSkills(sessionId),
                listSessionCustomAgents: async (sessionId) => listSessionCustomAgents(sessionId),
                listWorkspaceSkills: async (providerId, workspacePath) =>
                  requireMainQueryService().listWorkspaceSkills(providerId, workspacePath),
                listWorkspaceCustomAgents: async (providerId, workspacePath) =>
                  requireMainQueryService().listWorkspaceCustomAgents(providerId, workspacePath),
                listOpenSessionWindowIdsPage: (request) => listOpenSessionWindowIdsPage(request),
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
                  ]),
                listOpenAuxiliarySessionSummaries: () => {
                  const parentSessionIds = Array.from(new Set([
                    ...listOpenSessionWindowIds(),
                  ]));
                  return requireAuxiliarySessionService().listAuxiliarySessionSummaries(parentSessionIds);
                },
                getActiveAuxiliarySession: (parentSessionId) =>
                  requireAuxiliarySessionService().getActiveAuxiliarySession(parentSessionId),
                getAuxiliarySession: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId),
                getAuxiliaryDraft: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliaryDraft(auxiliarySessionId),
                saveAuxiliaryDraft: (input) =>
                  requireAuxiliarySessionService().saveAuxiliaryDraft(input),
                getAuxiliarySessionStatus: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliarySessionStatus(auxiliarySessionId),
                createAuxiliarySession: async (input) => {
                  if (databaseMaintenanceRequested) {
                    throw new Error("A database maintenance operation is in progress, so an Auxiliary Session cannot be created.");
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
                        throw new Error("A running Auxiliary Session cannot be closed.");
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
                runAuxiliarySessionTurn: (auxiliarySessionId, request) => requireAuxiliarySessionService().trackPendingDraftSend(async () => {
                  if (mainWindowRuntime.getSessionWindowBridge().isQuitPending()) {
                    throw new Error("The app is quitting, so a new message cannot be sent.");
                  }
                  const initial = await requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId);
                  if (!initial) {
                    throw new Error("The Auxiliary Session could not be found.");
                  }
                  if (mainWindowRuntime.getSessionWindowBridge().isQuitPending()) {
                    throw new Error("The app is quitting, so a new message cannot be sent.");
                  }
                  if (auxiliaryRunParents.has(auxiliarySessionId)) {
                    throw new Error("The Auxiliary Session is already running.");
                  }
                  auxiliaryRunParents.set(auxiliarySessionId, initial.parentSessionId);
                  try {
                    if (request.submitSource === "composer") {
                      if (!request.auxiliaryDraftIncarnation || request.auxiliaryDraftDurableRevision === undefined) {
                        throw new Error("The Auxiliary draft revision could not be found.");
                      }
                      await requireAuxiliarySessionService().runAuxiliaryTurnWithDraft({
                        auxiliarySessionId,
                        parentSessionId: initial.parentSessionId,
                        incarnation: request.auxiliaryDraftIncarnation,
                        expectedDurableRevision: request.auxiliaryDraftDurableRevision,
                        userMessage: request.userMessage,
                        run: () => requireAuxiliarySessionRuntimeService().runSessionTurn(auxiliarySessionId, request).then(() => undefined),
                      });
                    } else {
                      await requireAuxiliarySessionRuntimeService().runSessionTurn(auxiliarySessionId, request);
                    }
                    const session = await requireAuxiliarySessionService().getAuxiliarySession(auxiliarySessionId);
                    if (!session) {
                      throw new Error("The Auxiliary Session could not be found.");
                    }
                    return session;
                  } finally {
                    auxiliaryRunParents.delete(auxiliarySessionId);
                  }
                }),
                cancelAuxiliarySessionRun: (auxiliarySessionId) =>
                  requireAuxiliarySessionRuntimeService().cancelRun(auxiliarySessionId),
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
  if (!mainStoreContext.sessionStorage) {
    throw new Error("Session storage is not initialized.");
  }

  return mainStoreContext.sessionStorage;
}

function requireSessionStorageForWrite(): SessionStorageWrite {
  const storage = requireSessionStorage();
  if (isSessionStorageWritable(storage)) {
    return storage;
  }

  throw new Error("Session storage is read-only for this database and cannot be written.");
}

function requireSessionPinStorage(): SessionPinStorage {
  const storage = requireSessionStorage();
  const candidate = storage as Partial<SessionPinStorage>;
  if (typeof candidate.setSessionPinned === "function") {
    return candidate as SessionPinStorage;
  }
  throw new Error("Pinning is not available for this session format.");
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
          throw new Error("Session summary pages are not available for this database.");
        }
        return storage.listSessionSummaryPage(request);
      },
      getSessionCharacterUsage: () => {
        const storage = requireSessionStorage();
        if (!storage.listSessionCharacterUsage) {
          throw new Error("Session Character usage is not available for this database.");
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
      getSessions: () => mainStoreContext.sessions,
      getStoredSessionSummaries: () => requireSessionStorage().listSessionSummaries(),
      getSessionStorageIdentity: () => requireSessionStorage(),
      resolveSessionLaunchSelection: (providerId) =>
        requireSessionLaunchSelectionService().resolve(providerId),
      runProviderRuntimeOperationExclusive: (operation) => {
        if (databaseMaintenanceRequested) {
          throw new Error("A database maintenance operation is in progress, so a Session cannot be created.");
        }
        return providerRuntimeOperationCoordinator.runExclusive(() => {
          if (databaseMaintenanceRequested) {
            throw new Error("A database maintenance operation is in progress, so a Session cannot be created.");
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
        return mainStoreContext.sessions;
      },
      setSessions: (nextSessions) => {
        assertPersistentStoreOwnerIsActive(owner, "Main session persistence facade cache write");
        mainStoreContext.setSessions(nextSessions);
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
  if (!mainStoreContext.modelCatalogStorage) {
    throw new Error("Model catalog storage is not initialized.");
  }

  return mainStoreContext.modelCatalogStorage;
}

function requireAuditLogStorage(): AuditLogStorageRead {
  if (!mainStoreContext.auditLogStorage) {
    throw new Error("Audit log storage is not initialized.");
  }

  return mainStoreContext.auditLogStorage;
}

function requireAuxiliarySessionStorage(): AuxiliarySessionStorageAccess {
  if (!mainStoreContext.auxiliarySessionStorage) {
    throw new Error("Auxiliary Session storage is not initialized.");
  }

  return mainStoreContext.auxiliarySessionStorage;
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
            throw new Error("A database maintenance operation is in progress, so an Auxiliary Session cannot be created.");
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

  throw new Error("Audit log storage is read-only for this database and cannot be written.");
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
  return mainWindowRuntime.getWindowBroadcastService();
}

function requireWindowDialogService(): WindowDialogService {
  return mainWindowRuntime.getWindowDialogService();
}

function requireAppSettingsStorage(): PersistentStoreBundle["appSettingsStorage"] {
  if (!mainStoreContext.appSettingsStorage) {
    throw new Error("App settings storage is not initialized.");
  }

  return mainStoreContext.appSettingsStorage;
}

function requirePromptTemplateStorage(): NonNullable<typeof mainStoreContext.promptTemplateStorage> {
  if (!mainStoreContext.promptTemplateStorage) {
    if (!mainStoreContext.dbPath) {
      throw new Error("Saved data is not initialized.");
    }
    mainStoreContext.setPromptTemplateStorage(new PromptTemplateStorage(mainStoreContext.dbPath));
  }
  return mainStoreContext.promptTemplateStorage!;
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
  if (!mainStoreContext.mateStorage) {
    throw new Error("Mate storage is not initialized.");
  }

  return mainStoreContext.mateStorage;
}

function requireCharacterStorage(): CharacterStorageAccess {
  if (!mainStoreContext.characterStorage) {
    throw new Error("Character storage is not initialized.");
  }

  return mainStoreContext.characterStorage;
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

function requireMateProfileItemStorage(): NonNullable<typeof mainStoreContext.mateProfileItemStorage> {
  if (mainStoreContext.storageWorker) {
    throw new Error("Mate profile items are not available in this runtime.");
  }
  if (!mainStoreContext.dbPath) {
    throw new Error("Saved data is not initialized.");
  }

  if (!mainStoreContext.mateProfileItemStorage) {
    mainStoreContext.setMateProfileItemStorage(new MateProfileItemStorage(mainStoreContext.dbPath));
  }

  return mainStoreContext.mateProfileItemStorage!;
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
  return mainWindowRuntime.getWindowEntryLoader();
}

function requireAuxWindowService(): AuxWindowService<BrowserWindow> {
  return mainWindowRuntime.getAuxWindowService();
}

function requireCharacterAffectTurnSettlementStorage(): NonNullable<typeof mainStoreContext.characterAffectTurnSettlementStorage> {
  if (!mainStoreContext.characterAffectTurnSettlementStorage) {
    throw new Error("Character affect turn settlement storage is not initialized.");
  }
  return mainStoreContext.characterAffectTurnSettlementStorage;
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
    sessionRuntimeService = createMainSessionRuntime({
      owner: {
        assertActive: (operation) => assertPersistentStoreOwnerIsActive(owner, `Session runtime ${operation}`),
        isActive: () => mainStoreContext.activePersistentStoreOwner === owner,
      },
      admission: {
        runSessionAdmissionExclusive: (sessionId, operation, signal) =>
          runSessionTurnAdmission(sessionId, false, operation, signal),
      },
      sessions: {
        getSession: (sessionId) => getRuntimeSession(sessionId),
        upsertSession: (session) => requireMainSessionPersistenceFacade().upsertSessionPreservingPin(session),
        persistRunningTurnStart: (session, expectedMessageCount) => requireMainSessionPersistenceFacade().persistRunningTurnStart(session, expectedMessageCount),
        clearCharacterAuthoringRuntimeState: (session) => requireMainSessionPersistenceFacade().clearCharacterAuthoringRuntimeState(session),
        upsertTerminalSession: (session, terminalCommit) => requireMainSessionPersistenceFacade().upsertTerminalSession(session, terminalCommit),
      },
      resolution: {
        resolveRuntimeSessionForTurn: (session) => resolveCharacterAuthoringRuntimeSessionForTurn(session, (characterId) => requireCharacterService().createRuntimeSnapshot(characterId)),
        resolveComposerPreview,
        resolveProviderSession: (session) => appendSessionFilesDirectory(app.getPath("userData"), session),
        resolveSessionFolderPath: (sessionId) => resolveSessionFilesDirectory(app.getPath("userData"), sessionId),
        resolveProviderCatalog,
      },
      provider: { getProviderCodingAdapter, resetProviderSessionThread, getProviderAgentRuntimeBinding: ({ session, provider }) => issueProviderAgentRuntimeBinding(session, provider.id), beginProviderAgentRuntimeTurn: ({ session, provider, binding }) => binding ? glossaryRuntimeService.beginProviderTurn(session.id, binding) : undefined, endProviderAgentRuntimeTurn: (handle) => glossaryRuntimeService.endProviderTurn(handle as import("./glossary/glossary-proactive-turn.js").GlossaryProactiveTurnHandle) },
      memory: {
        getAppSettings: () => requireAppSettingsStorage().getSettings(),
        resolveProjectMemoryEntriesForPrompt: () => [],
        getCharacterContextService: () => memoryV6RuntimeApi?.characterContextService ?? null,
        onCharacterContextFailure: (session, result) => writeAppLog({ level: "warn", kind: "character-context.lifecycle.read-failed", process: "main", message: "Character context was unavailable for a session turn", data: { sessionId: session.id, code: result.error.code, retryable: result.error.retryable, conversationMayContinue: result.error.conversationMayContinue } }),
        getConversationTimingSnapshot: async (sessionId, observedAt) => {
          const storage = requireAuditLogStorage();
          if (!storage.getConversationTimingSnapshot) return null;
          return storage.getConversationTimingSnapshot(sessionId, observedAt);
        },
      },
      character: { getSettlementStorage: () => requireCharacterAffectTurnSettlementStorage() as CharacterAffectTurnSettlementStorage, requestAppraisal: () => requireCharacterAffectTurnRetryScheduler().request({ immediate: true, resetBackoff: true }) },
      audit: { createAuditLog: (entry) => requireAuditLogService().createAuditLog(entry), updateAuditLog: (id, entry) => requireAuditLogService().updateAuditLog(id, entry) },
      live: { setLiveSessionRun, getLiveSessionRun, setProviderQuotaTelemetry: (telemetry) => setProviderQuotaTelemetry(telemetry.provider, telemetry), setSessionContextTelemetry: (telemetry) => setSessionContextTelemetry(telemetry.sessionId, telemetry), scheduleProviderQuotaTelemetryRefresh, broadcastLiveSessionRun },
      interaction: { waitForApprovalDecision: waitForLiveApprovalDecision, waitForElicitationResponse: waitForLiveElicitationResponse, resolvePendingApprovalRequest: (sessionId, decision) => { const requestId = getLiveSessionRun(sessionId)?.approvalRequest?.requestId; if (requestId) requireSessionApprovalService().resolveLiveApproval(sessionId, requestId, decision); }, resolvePendingElicitationRequest: (sessionId, response) => { const requestId = getLiveSessionRun(sessionId)?.elicitationRequest?.requestId; if (requestId) requireSessionElicitationService().resolveLiveElicitation(sessionId, requestId, response); }, invalidateProviderSessionThread },
      notification: { notifySessionTurnTerminal: async (notification) => { await requireSessionTurnNotificationService().notifyTurnTerminal(notification); } },
      timing: { currentTimestampLabel },
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
          throw new Error("The Auxiliary Session notification target could not be found.");
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
    auxiliarySessionRuntimeService = createAuxiliarySessionRuntime({
      owner: {
        assertActive: (operation) => assertPersistentStoreOwnerIsActive(owner, operation),
      },
      admission: { runSessionAdmissionExclusive: (sessionId, operation, signal) => runSessionTurnAdmission(sessionId, true, operation, signal) },
      auxiliary: {
        getRuntimeSession: (sessionId) => requireAuxiliarySessionService().getAuxiliaryRuntimeSession(sessionId),
        getSession: (sessionId) => requireAuxiliarySessionService().getAuxiliarySession(sessionId),
        upsertRuntimeSession: async (session, options) => {
          const auxiliaryService = requireAuxiliarySessionService();
          await auxiliaryService.upsertAuxiliaryRuntimeSession(session, options);
          const storedSession = await auxiliaryService.getAuxiliaryRuntimeSession(session.id);
          if (!storedSession) throw new Error("The saved Auxiliary Session could not be loaded.");
          return storedSession;
        },
        isAuxiliarySession: async (sessionId) => Boolean(await requireAuxiliarySessionService().getAuxiliarySession(sessionId)),
      },
      parent: { getSession: (sessionId) => Promise.resolve(owner.sessionStorage.getSession(sessionId)) },
      resolution: { resolveComposerPreview, resolveProviderCatalog },
      provider: {
        getProviderCodingAdapter,
        resetProviderSessionThread,
        endProviderAgentRuntimeTurn: (handle) => glossaryRuntimeService.endProviderTurn(handle as import("./glossary/glossary-proactive-turn.js").GlossaryProactiveTurnHandle),
        resolveProviderSession: (session, parentSessionId) => appendSessionFilesDirectoryForSessionId(app.getPath("userData"), session, parentSessionId),
        resolveSessionFolderPath: (parentSessionId) => resolveSessionFilesDirectory(app.getPath("userData"), parentSessionId),
        issueRuntimeBinding: async (session, provider) => await issueProviderAgentRuntimeBinding(session, provider.id),
        beginRuntimeTurn: ({ session, binding }) => binding ? glossaryRuntimeService.beginProviderTurn(session.id, binding) : undefined,
      },
      memory: { getAppSettings: () => requireAppSettingsStorage().getSettings() },
      audit: { createAuditLog: (entry) => requireAuditLogService().createAuditLog(entry), updateAuditLog: (id, entry) => requireAuditLogService().updateAuditLog(id, entry) },
      live: {
        setLiveSessionRun: (sessionId, state) => setLiveSessionRun(sessionId, state),
        getLiveSessionRun,
        setProviderQuotaTelemetry: (telemetry) => setProviderQuotaTelemetry(telemetry.provider, telemetry),
        setSessionContextTelemetry: (telemetry) => setSessionContextTelemetry(telemetry.sessionId, telemetry),
        scheduleProviderQuotaTelemetryRefresh,
        broadcastLiveSessionRun,
      },
      interaction: {
        waitForApprovalDecision: waitForLiveApprovalDecision,
        waitForElicitationResponse: waitForLiveElicitationResponse,
        resolveApproval: (sessionId, requestId, decision) => { requireSessionApprovalService().resolveLiveApproval(sessionId, requestId, decision); },
        resolveElicitation: (sessionId, requestId, response) => { requireSessionElicitationService().resolveLiveElicitation(sessionId, requestId, response); },
        invalidateProviderSessionThread,
      },
      notification: async (notification, context) => { await requireSessionTurnNotificationService().notifyTurnTerminal(notification, context); },
      currentTimestampLabel,
    });
  }

  return auxiliarySessionRuntimeService;
}

function requireSessionPersistenceService(): SessionPersistenceService {
  if (!sessionPersistenceService) {
    const owner = requireActivePersistentStoreOwnerForFactory("Session persistence service");
    const storage = owner.sessionStorage as SessionStorageWrite;
    const pinStorage = storage as unknown as SessionPinStorage;
    sessionPersistenceService = createSessionPersistenceAssembly({
      owner: {
        assertActive: (operation) => assertPersistentStoreOwnerIsActive(owner, operation),
      },
      storage,
      pinStorage,
      cache: {
        getSessions: () => mainStoreContext.sessions,
        setSessions: (nextSessions) => mainStoreContext.setSessions(nextSessions),
        getSession,
      },
      runtime: {
        isSessionRunInFlight,
        listRunningActiveAuxiliaryParentIds: listRunningActiveAuxiliaryParentSessionIds,
      },
      auxiliary: {
        listAuxiliarySessionRuntimeIdentities: async (parentSessionId) =>
          (await requireAuxiliarySessionService().listAuxiliarySessions(parentSessionId)).map((auxiliary) => ({
            id: auxiliary.id,
            parentSessionId: auxiliary.parentSessionId,
            provider: auxiliary.provider,
          })),
      },
      settings: {
        getAppSettings: () => owner.appSettingsStorage.getSettings(),
        getModelCatalogSnapshot: async () =>
          await getModelCatalog(null) ?? await owner.modelCatalogStorage.ensureSeeded(),
      },
      character: {
        createCharacterRuntimeSnapshot: (characterId) => requireCharacterService().createRuntimeSnapshot(characterId),
      },
      effects: {
        syncSessionDependencies: (session) => requireSessionMemorySupportService().syncSessionDependencies(session),
        clearSessionContextTelemetry,
        clearSessionBackgroundActivities,
        invalidateProviderSessionThread,
        revokeSessionAgentRuntimeBindings: (sessionId) => agentRuntimeBindingRegistry.revokeSession(sessionId),
        closeSessionWindow: (sessionId) => {
          requireSessionWindowBridge().closeSessionWindow(sessionId);
          requireMainWindowFacade().closeFilePreviewWindowsForSession(sessionId);
        },
        discardSessionWindow: (sessionId) => {
          requireSessionWindowBridge().discardSessionWindow(sessionId);
          requireMainWindowFacade().closeFilePreviewWindowsForSession(sessionId);
        },
        broadcastSessions,
        runCharacterAffectTurnOwnershipExclusive: (operation) =>
          characterAffectTurnOwnershipCoordinator.runExclusive(operation),
      },
    });
  }
  return sessionPersistenceService;
}
function requireSessionWindowBridge(): SessionWindowBridge<BrowserWindow> {
  return mainWindowRuntime.getSessionWindowBridge();
}

function requireSessionWindowRestoreService(): SessionWindowRestoreService {
  return mainWindowRuntime.getSessionWindowRestoreService();
}

function requireSettingsCatalogService(): SettingsCatalogService {
  if (!settingsCatalogService) {
    settingsCatalogService = new SettingsCatalogService({
      captureStorageIdentity: () => requireActivePersistentStoreOwnerForFactory("Settings catalog"),
      isStorageIdentityCurrent: (owner) => mainStoreContext.activePersistentStoreOwner === owner,
      runProviderRuntimeOperationExclusive: (operation) =>
        providerRuntimeOperationCoordinator.runExclusive(operation),
      hasInFlightSessionRuns,
      isSessionRunInFlight,
      isRunningSession,
      listSessions: listFullStoredSessions,
      listAuxiliarySessions: () => requireAuxiliarySessionService().listAllAuxiliarySessions(),
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
      clearProviderQuotaTelemetry,
      clearSessionContextTelemetry,
      invalidateProviderSessionThread,
      clearAuditLogs: async () => {
        await requireAuditLogService().clearAuditLogs();
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

      const threadId = mainStoreContext.sessions.find((session) => session.id === sessionId)?.threadId ?? "";
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
  if (!mainStoreContext.sessionMemoryStorage) {
    throw new Error("Session memory storage is not initialized.");
  }

  return mainStoreContext.sessionMemoryStorage;
}

function requireProjectMemoryStorage(): ProjectMemoryStorageAccess {
  if (!mainStoreContext.projectMemoryStorage) {
    throw new Error("Project memory storage is not initialized.");
  }

  return mainStoreContext.projectMemoryStorage;
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
  mainStoreContext.activate(bundle);
  for (const session of mainStoreContext.sessions) {
    requireSessionMemorySupportService().syncSessionDependencies(session);
  }
  return bundle.activeModelCatalog;
}

function startWalMaintenance(): void {
  mainStoreContext.startWalMaintenance(async (owner, currentDbPath) => {
    if (owner) {
      await owner.truncateWal();
    } else {
      truncateAppDatabaseWalIfLargerThan(currentDbPath, undefined, {
        busyTimeoutMs: SQLITE_MAINTENANCE_BUSY_TIMEOUT_MS,
      });
    }
  }, WAL_MAINTENANCE_INTERVAL_MS);
}

function stopWalMaintenance(): void {
  mainStoreContext.stopWalMaintenance();
}

async function initializePersistentStores(): Promise<ModelCatalogSnapshot> {
  if (!mainStoreContext.dbPath) {
    throw new Error("Saved data is not initialized.");
  }

  await closePersistentStores();
  try {
    const bundle = await requirePersistentStoreLifecycleService().initialize(
      mainStoreContext.dbPath,
      bundledModelCatalogPath,
      app.getPath("userData"),
    );
    const activeModelCatalog = applyPersistentStoreBundle(bundle);
    mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
    startWalMaintenance();
    return activeModelCatalog;
  } catch (error) {
    throw error;
  }
}

async function closePersistentStores(): Promise<void> {
  await mainStoreContext.close((bundle, currentDbPath) =>
    requirePersistentStoreLifecycleService().close(bundle, currentDbPath));
  characterService = null;
  characterAuthoringService = null;
  managedSkillDistributionService = null;
  memoryCliShimService = null;
  auditLogService = null;
  auxiliarySessionService = null;
  auxiliarySessionRuntimeService = null;
  sessionRuntimeService = null;
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
  if (!mainStoreContext.dbPath) {
    throw new Error("Saved data is not initialized.");
  }

  mainStoreContext.setActivePersistentStoreOwner(null);
  const memoryRuntimeToStop = memoryV6RuntimeApi;
  memoryV6RuntimeApi = null;
  mainStoreContext.setMemoryRuntimeStatus("stopped");
  if (memoryRuntimeToStop) {
    // Reset must not remove a database still owned by another Worker.
    // Unlike application quit, a failed close aborts this destructive action.
    await memoryRuntimeToStop.stop();
  }

  stopWalMaintenance();
  if (!mainStoreContext.storageWorker) {
    await mainStoreContext.characterAffectTurnSettlementStorage?.close();
    await mainStoreContext.promptTemplateStorage?.close();
    await mainStoreContext.mateProfileItemStorage?.close();
  }
  mainStoreContext.setSettlementStorage(null);
  mainStoreContext.setDrainCursor(undefined);
  await requireMateStorage().deleteMateProjectionDirectory();
  mainStoreContext.setMateProfileItemStorage(null);
  const bundle = await requirePersistentStoreLifecycleService().recreate(mainStoreContext.dbPath, bundledModelCatalogPath, {
    storageWorker: mainStoreContext.storageWorker,
    modelCatalogStorage: mainStoreContext.modelCatalogStorage,
    characterStorage: mainStoreContext.characterStorage,
    sessionStorage: mainStoreContext.sessionStorage,
    sessionMemoryStorage: mainStoreContext.sessionMemoryStorage,
    projectMemoryStorage: mainStoreContext.projectMemoryStorage,
    auditLogStorage: mainStoreContext.auditLogStorage,
    auxiliarySessionStorage: mainStoreContext.auxiliarySessionStorage,
    appSettingsStorage: mainStoreContext.appSettingsStorage,
    mateStorage: mainStoreContext.mateStorage,
  }, app.getPath("userData"));

  mainStoreContext.setCharacterStorage(null);
  characterService = null;
  characterAuthoringService = null;
  auditLogService = null;
  auxiliarySessionService = null;
  auxiliarySessionRuntimeService = null;
  sessionRuntimeService = null;
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
  mainStoreContext.setSessions([]);

  const activeModelCatalog = applyPersistentStoreBundle(bundle);
  mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
  if (memoryRuntimeToStop) {
    await startMemoryV6RuntimeApiBestEffort();
    if (!memoryV6RuntimeApi) {
      throw new Error("Memory runtime restart failed after database initialization. Restart the app.");
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

async function listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]> {
  return requireMainQueryService().listSessionSkills(sessionId);
}

async function listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]> {
  return requireMainQueryService().listSessionCustomAgents(sessionId);
}

function getSession(sessionId: string): Session | null {
  return mainStoreContext.sessions.find((session) => session.id === sessionId) ?? null;
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
  return null;
}

async function getSessionFileExplorerOwnerSessionId(sessionId: string): Promise<string | null> {
  return (await getSessionFileExplorerContext(sessionId))?.parentSessionId ?? null;
}

function createSessionFileExplorerService(): SessionFileExplorerService {
  return sessionFileExplorerRuntime.getExplorer();
}

function createFileRootGitChangesService(): FileRootGitChangesService {
  return sessionFileExplorerRuntime.getGitChanges();
}

async function getAuxiliaryParentSession(parentSessionId: string): Promise<Session | null> {
  return resolveAuxiliaryParentSession({
    parentSessionId,
    getStoredSession: (sessionId) => requireSessionStorage().getSession(sessionId),
    getCachedSession: getSession,
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

async function openSessionTerminal(sessionId: string): Promise<void> {
  await requireMainQueryService().openSessionTerminal(sessionId);
}

function broadcastSessions(sessionIds?: Iterable<string>): void {
  requireMainBroadcastFacade().broadcastSessions(sessionIds);
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

function broadcastOpenSessionWindowIds(): void {
  requireMainBroadcastFacade().broadcastOpenSessionWindowIds();
}

function hasRunningSessions(): boolean {
  return mainStoreContext.sessions.some((session) => isRunningSession(session));
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
  const bootWindow = mainWindowComposition.getBootWindow();
  if (bootWindow) {
    return requireAuxWindowService().adoptHomeWindow(bootWindow);
  }
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

async function inspectCurrentAppDatabase(): Promise<AppDatabaseDiagnostics> {
  const worker = createAppDatabaseBootstrapWorker();
  try {
    return await worker.inspect({
      userDataPath: app.getPath("userData"),
      activeDatabasePath: mainStoreContext.dbPath,
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
    const bootWindow = mainWindowComposition.getBootWindow();
    if (bootWindow) {
      if (bootWindow.isMinimized()) bootWindow.restore();
      bootWindow.show();
      bootWindow.focus();
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
        mainStoreContext.setDbPath(resolved.dbPath);
      } finally {
        await bootstrapWorker.close();
      }
      publishAppBootStatus({
        kind: "running",
        stage: "diagnostics",
        title: "Checking database diagnostics",
        detail: "Checking the selected database and schema version.",
      });
      mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
      const diagnostics = mainStoreContext.appDatabaseDiagnostics!;
      writeAppLog({
        level: "info",
        kind: "app.ready",
        process: "main",
        message: "App ready",
        data: {
          userDataPath: app.getPath("userData"),
          userDataPathOverrideApplied: diagnostics.userDataPathOverrideApplied,
          activeDatabasePath: diagnostics.activeDatabasePath,
          activeDatabaseSchemaVersion: diagnostics.schemaVersion,
          activeDatabaseCompatibilityMode: diagnostics.compatibilityMode,
          logsPath: appLogsPath,
          crashDumpsPath,
        },
      });
      writeAppLog({
        level: diagnostics.warnings.length > 0 ? "warn" : "info",
        kind: "app.database.selected",
        process: "main",
        message: "App database selected",
        data: diagnostics,
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
      let homeWindow: BrowserWindow | null = null;
      if (!isBackgroundLaunch) {
        publishAppBootStatus({
          kind: "running",
          stage: "home",
          title: "Preparing Home",
        });
        homeWindow = await createHomeWindow();
      }
      publishAppBootStatus({
        kind: "completed",
        stage: "home",
        title: "Startup complete",
        detail: isBackgroundLaunch ? "Started in the background." : "Home is ready.",
      });
      if (homeWindow) {
        mainWindowComposition.releaseBootWindow(homeWindow);
      }
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
        title: "WithMate could not start",
        detail: "Database migration or startup initialization failed. See the logs for details.",
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
