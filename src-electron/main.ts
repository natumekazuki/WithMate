import {
  startAgentRuntimeApi,
  type AgentRuntimeApiHandle,
} from "./platform/agent-runtime/runtime-api.js";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { SessionFolderCleanupService } from "./files/session-folder-cleanup-service.js";
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
  shell,
  Tray,
  type NativeImage,
} from "electron";

import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
  LiveApprovalDecision,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  RunSessionTurnRequest,
  SessionContextTelemetry,
} from "../src-shared/session/runtime-state.js";
import { projectLiveSessionRunStatus } from "../src-shared/session/live-session-run-status.js";
import {
  captureSessionTurnQueueDisplay,
  type SessionTurnQueueReceipt,
  type SessionTurnQueueOrigin,
  type SessionSteerOrigin,
} from "../src-shared/session/session-turn-queue.js";
import {
  savedFinalAnswerTurnId,
  type SessionReply,
} from "../src-shared/session/session-reply.js";
import {
  conversationThreadsResultSchema,
  savedMessageConversationFrame,
} from "../src-shared/session/conversation-threads.js";
import { initiatingReply } from "./session/initiating-reply.js";
import { currentTimestampLabel } from "../src-shared/time-state.js";
import type {
  SessionCharacterUsage,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
} from "../src-shared/session/session-state.js";
import {
  validateSessionInstructions,
  type SessionInstructionsTarget,
} from "../src-shared/session/session-instructions.js";
import type { AgentRuntimeSourceRef } from "../src-shared/agent-runtime/agent-runtime-source.js";
import {
  type DiffPreviewPayload,
  getSessionIncarnationId,
  type MessageArtifact,
  type Session,
  type SessionSummary,
} from "../src-shared/session/session-state.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "../src-shared/character/character-authoring.js";
import {
  type ModelCatalogRequest,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src-shared/settings/model-catalog.js";
import { buildOpenSessionWindowIdsPage } from "../src-shared/window/withmate-window-types.js";
import type {
  OpenPathOptions,
  OpenPathResult,
  OpenSessionWindowIdsPageRequest,
  OpenSessionWindowIdsPageResult,
  SavePastedSessionFileRequest,
  SavePastedSessionFileResult,
} from "../src-shared/window/withmate-window-types.js";
import { isSessionFileGitCommitResource } from "../src-shared/file-explorer/file-explorer-contract.js";
import { SessionTurnService } from "./session/session-turn-service.js";
import { SessionResultReadService } from "./session/session-result-read-service.js";
import { registerHtmlPreviewHandlers } from "./ipc/html-preview.js";
import { registerHtmlPreviewScheme } from "./files/html-preview-service.js";
import { readSessionHtmlPreview } from "./files/session-html-preview-reader.js";
import { createHtmlPreviewResources } from "./files/html-preview-resources.js";
import type { SessionTurnRecord } from "../src-shared/session/session-turn-state.js";
import { AppSettingsStorage } from "./app/app-settings-storage.js";
import { PromptTemplateStorage } from "./prompt-templates/prompt-template-storage.js";
import {
  createV6StorageWorkerBundle,
  type V6StorageWorkerBundle,
} from "./storage/storage-worker-bundle.js";
import { createAppDatabaseBootstrapWorker } from "./storage/app-database-bootstrap-worker.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../src-shared/prompt-template.js";
import {
  sessionSummariesToSessions,
  sessionSummaryToSession,
} from "./session/session-summary-adapter.js";
import { AuxiliarySessionService } from "./auxiliary/auxiliary-session-service.js";
import { AuxiliaryLiveRunParents } from "./auxiliary/auxiliary-live-run-parents.js";
import { admitSessionTurn } from "./session/session-turn-admission.js";
import { AuxiliarySessionStorage } from "./auxiliary/auxiliary-session-storage.js";
import { CharacterService } from "./character/character-service.js";
import { refreshSessionCharacterRuntimeSnapshot } from "./character/character-runtime-service.js";
import { CharacterWorkspaceOperationCoordinator } from "./character/character-workspace-operation-coordinator.js";
import { CharacterStorage } from "./character/character-storage.js";
import {
  CharacterAuthoringService,
  CHARACTER_AUTHORING_SKILL_NAME,
  resolveCharacterAuthoringRuntimeSessionForTurn,
} from "./character/character-authoring-service.js";
import { CodexAdapter } from "./providers/codex/codex-adapter.js";
import { CopilotAdapter } from "./providers/copilot/copilot-adapter.js";
import { ClaudeAdapter } from "./providers/claude/claude-adapter.js";
import { OpenCodeAdapter } from "./providers/opencode/opencode-adapter.js";
import {
  assertCapturedComposerAttachmentsAvailable,
  resolveComposerPreview,
} from "./files/composer-attachments.js";
import { areDirectoryPathsEquivalent } from "./files/additional-directories.js";
import { ModelCatalogStorage } from "./settings/model-catalog-storage.js";
import {
  openLocalPathWithDefaultApp,
  openResolvedDirectoryInFileManager,
  revealLocalPathInFileManager,
  resolveProtocolRelativeExternalFallbackAfterLocalOpen,
  resolveOpenPathTarget,
} from "./files/open-path.js";
import { launchTerminalAtPath } from "./files/open-terminal.js";
import { SessionStorage } from "./session/session-storage.js";
import {
  SessionRuntimeService,
  stopWindowSessionRun,
} from "./session/session-runtime-service.js";
import { createMainSessionRuntime } from "./app/main-session-runtime-assembly.js";
import {
  MainSessionTurnQueueFacade,
  SessionTurnQueuePreflightRejectedError,
} from "./app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "./session/session-turn-queue-service.js";
import { createAuxiliarySessionRuntime } from "./auxiliary/auxiliary-session-runtime-assembly.js";
import { SessionTurnNotificationService } from "./session/session-turn-notification-service.js";
import { SessionPersistenceService } from "./session/session-persistence-service.js";
import { manageSessionDirectories } from "./session/session-directory-management.js";
import { createSessionStorageCommandAdapter } from "./session/session-storage-command-adapter.js";
import { createSessionPersistenceAssembly } from "./session/session-persistence-assembly.js";
import { readSessionFileExplorerContext } from "./files/session-file-explorer-context.js";
import { SessionWindowBridge } from "./windows/session-window-bridge.js";
import { SessionWindowRestoreService } from "./windows/session-window-restore-service.js";
import { SettingsCatalogService } from "./settings/settings-catalog-service.js";
import { SessionObservabilityService } from "./session/session-observability-service.js";
import { SessionApprovalService } from "./session/session-approval-service.js";
import {
  ApprovalReviewInputFence,
  WithMateApprovalReviewTurn,
  type PendingApprovalReview,
  type StartWithMateApprovalReview,
} from "./session/withmate-approval-review.js";
import type { OpenApprovalReviewer } from "./providers/approval-reviewer.js";
import type { WithMateReviewProviderId } from "../src-shared/settings/withmate-auto-review.js";
import { SessionElicitationService } from "./session/session-elicitation-service.js";
import { WindowBroadcastService } from "./windows/window-broadcast-service.js";
import { WindowDialogService } from "./windows/window-dialog-service.js";
import { WorkspaceDirectoryValidationService } from "./files/workspace-directory-validation-service.js";
import {
  SessionFileExplorerService,
  type SessionFileExplorerContext,
} from "./files/session-file-explorer-service.js";
import { SessionFileExplorerRuntime } from "./files/session-file-explorer-runtime.js";
import { SessionFilePreviewImageCopyService } from "./files/session-file-preview-image-copy-service.js";
import { SessionFileObjectCopyService } from "./files/session-file-object-copy-service.js";
import { SessionFileTreeContextMenuService } from "./files/session-file-tree-context-menu-service.js";
import { SessionMonitorContextMenuService } from "./session/session-monitor-context-menu-service.js";
import { readSessionMonitorPage } from "./session/session-monitor-query.js";
import { readHomeCrewPage } from "./session/home-crew-query.js";
import { HomeCrewContextMenuService } from "./session/home-crew-context-menu-service.js";
import { readHomeCrewCloseRunIdentities } from "./session/home-crew-close-runs.js";
import { SessionFilePreviewContextMenuService } from "./files/session-file-preview-context-menu-service.js";
import { MarkdownLinkContextMenuService } from "./windows/markdown-link-context-menu-service.js";
import { WindowsFileDropClipboardWriter } from "./files/windows-file-drop-clipboard-writer.js";
import { FileRootGitChangesService } from "./files/file-root-git-changes-service.js";
import {
  appendSessionFilesDirectory,
  appendSessionFilesDirectoryForSessionId,
  appendCrewFilesDirectory,
  resolveCrewFilesDirectory,
  copyFilesToSessionFiles as copyFilesToSessionFilesStorage,
  createSessionFilesDirectory,
  deleteSessionFilesDirectory,
  ensureSessionFilesDirectory as ensureManagedSessionFilesDirectory,
  resolveSessionFilesDirectory,
  saveSessionFile,
} from "./files/session-files.js";
import { MateStorage } from "./mate/mate-storage.js";
import { MateProfileItemStorage } from "./mate/mate-profile-item-storage.js";
import { WindowEntryLoader } from "./windows/window-entry-loader.js";
import { AuxWindowService } from "./auxiliary/aux-window-service.js";
import { registerMainIpcHandlers } from "./ipc/register-main-ipc.js";
import { registerTerminalHandlers } from "./ipc/terminal.js";
import {
  TerminalService,
  resolveTerminalShell,
  spawnTerminalPty,
} from "./terminal/terminal-service.js";
import {
  PersistentStoreLifecycleService,
  type SessionTurnStorageAccess,
  type AuxiliarySessionStorageAccess,
  type CharacterStorageAccess,
  type PersistentStoreBundle,
  type SessionPinStorage,
  type SessionFilePinStorage,
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
import { ProviderModelDiscoveryService } from "./settings/provider-model-discovery-service.js";
import { MainSessionCommandFacade } from "./app/main-session-command-facade.js";
import { ProviderRuntimeOperationCoordinator } from "./providers/provider-runtime-operation-coordinator.js";
import type { ApprovalDecisionSourceObserver } from "./providers/provider-runtime.js";
import {
  runWithStorageOperationCorrelation,
  startEventLoopDelayMonitoring,
  type StorageOperationDiagnostic,
} from "./storage/storage-operation-diagnostics.js";
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
import { hydrateSessionsFromSummaries } from "./session/session-summary-adapter.js";
import {
  getProviderAppSettings,
  type AppSettings,
} from "../src-shared/settings/provider-settings-state.js";
import { assertModelEnabled } from "../src-shared/settings/model-availability.js";
import { resolveWorkspaceDirectoryValidationMessage } from "../src-shared/window/workspace-directory-validation.js";
import type { ChatLayoutPreferenceUpdate } from "../src-shared/settings/chat-layout-preference.js";
import { discoverSessionSkills } from "./skills/skill-discovery.js";
import { discoverSessionCustomAgents } from "./skills/custom-agent-discovery.js";
import {
  HOME_WINDOW_DEFAULT_BOUNDS,
  SESSION_WINDOW_DEFAULT_BOUNDS,
} from "./windows/window-defaults.js";
import { AppLogService } from "./app/app-log-service.js";
import { StorageOperationLogService } from "./app/storage-operation-log-service.js";
import type { AppBootStatus } from "../src-shared/window/app-boot-state.js";
import type { AppDatabaseDiagnostics } from "../src-shared/window/app-database-diagnostics-state.js";
import {
  assertPersistentStoreOwnerActive,
  capturePersistentStoreOwner,
} from "./storage/persistent-store-owner-guard.js";
import { AgentRuntimeBindingRegistry } from "./providers/agent-runtime-binding.js";
import { updateAuxiliarySessionWithProviderRuntimeLifecycle } from "./auxiliary/auxiliary-provider-runtime-lifecycle.js";
import { toConversationView } from "./storage/conversation-query.js";
import { RuntimeDiscoveryRegistryError } from "./platform/runtime-discovery/runtime-discovery-contract.js";
import {
  GlossaryApplicationService,
  projectGlossaryCheckoutAuthority,
} from "./glossary/glossary-application-service.js";
import { GlossaryRuntimeService } from "./glossary/glossary-runtime-service.js";
import { ProviderAgentRuntimeTurnCoordinator } from "./providers/provider-agent-runtime-turn-coordinator.js";
import { GlossarySessionProjectionService } from "./glossary/glossary-session-projection-service.js";
import { SessionGlossaryWindowSubscriptionCoordinator } from "./session/session-glossary-window-subscription.js";
import { getGlossaryAgentRuntimeOperations } from "../src-shared/glossary/glossary-operation-schema.js";
import {
  SessionManagementApplication,
  SessionManagementError,
} from "./session/session-management-application.js";
import { SessionOperatingPolicyService } from "./session/session-operating-policy-service.js";
import {
  createSessionManagementScopeReader,
  SessionManagementRuntimeService,
} from "./session/session-management-runtime-service.js";
import { getSessionAgentRuntimeOperations } from "../src-shared/session/session-management-contract.js";
import { getModelDisabledReason } from "../src-shared/settings/model-availability.js";
import { registerSessionRoleHandlers } from "./ipc/session-role.js";
import { registerSessionExecutionHandlers } from "./ipc/session-execution.js";
import { executionOperationResultSchemas } from "../src-shared/session/session-execution-read.js";
import { registerSessionCrewHandlers } from "./ipc/session-crew.js";
import { assertOwningSessionWindowSender } from "./ipc/shared.js";
import { registerCoordinationHandlers } from "./ipc/coordination.js";
import { CoordinationApplicationService } from "./coordination/coordination-application-service.js";
import {
  LocalPrApplication,
  failure as localPrFailure,
} from "./local-pr/local-pr-application.js";
import { LocalPrCiService } from "./local-pr/local-pr-ci-service.js";
import {
  LocalPrService,
  resolveLocalPrRepository,
  type LocalPrRepository,
} from "./local-pr/local-pr-service.js";
import { LocalPrWindowService } from "./local-pr/local-pr-window.js";
import { enqueueLocalPrDiscussion } from "./local-pr/local-pr-session-bridge.js";
import { saveLocalPrClipboardImage } from "./local-pr/local-pr-attachments.js";
import type {
  LocalPrInput,
  LocalPrResult,
} from "../src-shared/local-pr/local-pr-contract.js";
import type { SessionTarget } from "../src-shared/session/session-target.js";
import { ChildSessionCreationRejectedError } from "./session/session-storage-errors.js";
import { MainStoreContext } from "./app/main-store-context.js";
import {
  WITHMATE_GET_APP_BOOT_STATUS_CHANNEL,
  WITHMATE_OPEN_AUXILIARY_SESSION_EVENT,
  WITHMATE_SESSION_DRAFT_FLUSH_REQUEST_EVENT,
  WITHMATE_SESSION_DRAFT_FLUSH_RELEASE_EVENT,
  WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT,
  WITHMATE_SESSION_FILE_PREVIEW_NAVIGATION_EVENT,
  WITHMATE_TERMINAL_EVENT,
} from "../src-shared/ipc/withmate-ipc-channels.js";
import { CREATE_V2_SCHEMA_SQL } from "./storage/database-schema-v2.js";
import {
  registerPdfReaderProtocol,
  registerPdfReaderScheme,
} from "./windows/pdf-reader-protocol.js";
import {
  CREATE_V3_SCHEMA_SQL,
  isValidV3Database,
} from "./storage/database-schema-v3.js";
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
registerPdfReaderScheme();
registerHtmlPreviewScheme();

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "preload.js");
const rendererDistPath = path.resolve(currentDir, "../../dist");
const appDataPath = app.getPath("appData");
const userDataPathOverride = process.env.WITHMATE_USER_DATA_PATH?.trim();
const fixedUserDataPath = userDataPathOverride
  ? path.resolve(userDataPathOverride)
  : path.join(appDataPath, "WithMate");
const applicationInstanceId = crypto.randomUUID();
const processStartedAt = new Date().toISOString();
const runtimeBuildChannel = process.argv.some(
  (argument) => argument.toLowerCase() === "--withmate-visual-check",
)
  ? ("visual-check" as const)
  : app.isPackaged
    ? ("installed" as const)
    : ("development" as const);
app.setAppUserModelId(
  resolveAppUserModelId({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
  }),
);
app.setPath("userData", fixedUserDataPath);
const appLogsPath = path.join(fixedUserDataPath, "logs");
const appLogRuntimeInfo = {
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron ?? "",
  chromeVersion: process.versions.chrome ?? "",
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  isPackaged: app.isPackaged,
};
const appLogService = new AppLogService({
  logsPath: appLogsPath,
  runtimeInfo: appLogRuntimeInfo,
});
const storageOperationLogService = new StorageOperationLogService(writeAppLog);
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const bundledCharacterAuthoringSkillPath = app.isPackaged
  ? path.join(
      process.resourcesPath,
      "resources",
      "skills",
      CHARACTER_AUTHORING_SKILL_NAME,
    )
  : path.resolve(
      currentDir,
      "../../resources/skills",
      CHARACTER_AUTHORING_SKILL_NAME,
    );
const bundledGlossarySkillPath = app.isPackaged
  ? path.join(
      process.resourcesPath,
      "resources",
      "skills",
      WITHMATE_GLOSSARY_SKILL_NAME,
    )
  : path.resolve(
      currentDir,
      "../../resources/skills",
      WITHMATE_GLOSSARY_SKILL_NAME,
    );
const trayIconPath = path.resolve(currentDir, "../../build/icon.ico");
const sessionFilePreviewImageCopyService =
  new SessionFilePreviewImageCopyService({
    /** 画像プレビューの操作メニューを Electron のネイティブメニューに変換する。 */
    buildMenu: (template) => Menu.buildFromTemplate(template),
    /** Session のアクセス境界を使って、コピー対象の画像を検査する。 */
    inspectImage: (request) =>
      createSessionFileExplorerService().inspectImage(request),
    /** 検査済み画像のパスをクリップボードへ書き込む。 */
    writeText: (targetPath) => clipboard.writeText(targetPath),
  });
const windowsFileDropClipboardWriter = new WindowsFileDropClipboardWriter({
  platform: process.platform,
});
const sessionFileObjectCopyService = new SessionFileObjectCopyService({
  platform: process.platform,
  createAuthorizationBoundary: createSessionFileExplorerService,
  /** ファイル実体を Windows のファイルドロップ形式でクリップボードへ書き込む。 */
  writeNativeFileDrop: (targetPath) =>
    windowsFileDropClipboardWriter.copyFile(targetPath),
  /** ファイル実体のコピーに使うネイティブメニューを組み立てる。 */
  buildMenu: (template) => Menu.buildFromTemplate(template),
});
const sessionFileTreeContextMenuService = new SessionFileTreeContextMenuService(
  {
    platform: process.platform,
    createAuthorizationBoundary: createSessionFileExplorerService,
    /** 選択した項目のパスをテキストとしてクリップボードへ渡す。 */
    writeText: (targetPath) => clipboard.writeText(targetPath),
    /** ファイルツリーの項目を、アクセス確認を行う実体コピーサービスへ渡す。 */
    copyFileObject: (resource) =>
      sessionFileObjectCopyService.copyTreeResource(resource),
    /** ファイルツリーの操作項目をネイティブメニューに変換する。 */
    buildMenu: (template) => Menu.buildFromTemplate(template),
  },
);
const sessionMonitorContextMenuService = new SessionMonitorContextMenuService({
  /** 一覧の Session ID に対応する Window が現在開いているかを返す。 */
  isSessionWindowOpen: (sessionId) =>
    requireSessionWindowBridge().getWindow(sessionId) !== null,
  /** Session Window に通常の終了手順と同じ確認経路で閉じるよう要求する。 */
  requestCloseSessionWindow: (sessionId) =>
    requireMainWindowFacade().requestCloseSessionWindow(sessionId),
  /** 表示用の Session 概要からタイトルを取得し、見つからなければ null を返す。 */
  readSessionTitle: async (sessionId) =>
    (await getDisplaySessionSummary(sessionId))?.taskTitle ?? null,
  /** 一覧のコピー操作で選んだ値をクリップボードへ書き込む。 */
  writeText: (value) => clipboard.writeText(value),
  /** Session 一覧のコンテキストメニューを組み立てる。 */
  buildMenu: (template) => Menu.buildFromTemplate(template),
});
/** Home の Crew メニューに、終了時の影響確認と Session 情報の読み取りを接続する。 */
function createHomeCrewContextMenuService() {
  return new HomeCrewContextMenuService({
    bridge: requireSessionWindowBridge(),
    /** DB メンテナンス中やアプリの終了処理中には永続ストアを使わせない。 */
    getStoreOwner: () =>
      databaseMaintenanceRequested ||
      requireSessionWindowBridge().isQuitPending()
        ? null
        : mainStoreContext.activePersistentStoreOwner,
    /** Crew メニューに現在のインメモリ Session 一覧を渡す。 */
    listSessions: () => mainStoreContext.sessions,
    /** 選択された永続ストアの世代から保存済み Session の概要を読み取る。 */
    readSavedSession: async (owner, sessionId) => {
      if (!owner.sessionStorage.getSessionSummary)
        throw new Error("Session summary reads are unavailable.");
      return owner.sessionStorage.getSessionSummary(sessionId);
    },
    /** Window を閉じる際に影響のある実行と端末を列挙する。 */
    getCloseEffects: (sessionId, window) => ({
      runs: getHomeCrewCloseRunIdentities(sessionId),
      terminals: terminalService?.getWindowCloseImpacts(window) ?? [],
    }),
    /** Home を親とする確認ダイアログで、二番目の選択肢を選んだときだけ許可する。 */
    confirm: async (home, options) =>
      (await dialog.showMessageBox(home, options)).response === 1,
    /** Crew メニューで指定された文字列をクリップボードへ書き込む。 */
    writeText: (value) => clipboard.writeText(value),
    /** Home の Crew 操作をネイティブメニューとして表示できる形にする。 */
    buildMenu: (template) => Menu.buildFromTemplate(template),
  });
}
const sessionFilePreviewContextMenuService =
  new SessionFilePreviewContextMenuService({
    /** ファイルプレビューのコンテキストメニューを組み立てる。 */
    buildMenu: (template) => Menu.buildFromTemplate(template),
  });
const markdownLinkContextMenuService = new MarkdownLinkContextMenuService({
  /** Markdown リンクの操作項目をネイティブメニューに変換する。 */
  buildMenu: (template) => Menu.buildFromTemplate(template),
  /** Markdown リンクの対象文字列をクリップボードへ書き込む。 */
  writeText: (target) => clipboard.writeText(target),
  /** ファイルの文脈を伴うリンクだけを、アクセス確認付きの実体コピー対象として解決する。 */
  resolveCopyableFile: (request) =>
    request.fileContext
      ? sessionFileObjectCopyService.resolveCopyableLinkResource({
          ...request.fileContext,
          target: request.target,
        })
      : Promise.resolve(null),
  /** 解決済みのファイルをクリップボードに載せる実体コピー処理へ渡す。 */
  copyFile: (resource) => sessionFileObjectCopyService.copyResource(resource),
});
const codexAdapter = new CodexAdapter(
  (input) =>
    writeAppLog({
      ...input,
      process: "main",
    }),
  { appVersion: app.getVersion() },
);
const copilotAdapter = new CopilotAdapter({
  /** Copilot の診断イベントを Main プロセスのログに記録する。 */
  log: (input) =>
    writeAppLog({
      ...input,
      process: "main",
    }),
});
const claudeAdapter = new ClaudeAdapter({
  /** Claude の診断イベントを Main のプロバイダーログに記録する。 */
  log: (input) =>
    writeAppLog({
      ...input,
      kind: "provider",
      process: "main",
    }),
});
const opencodeAdapter = new OpenCodeAdapter({
  legacyDatabasePath: path.join(
    fixedUserDataPath,
    "providers",
    "opencode",
    runtimeBuildChannel,
    "opencode.db",
  ),
  /** OpenCode の診断イベントを Main のプロバイダーログに記録する。 */
  log: (input) => writeAppLog({ ...input, kind: "provider", process: "main" }),
});
const mainLogComposition = new MainLogComposition(writeAppLog, (error) =>
  appLogService.errorToLogError(error),
);
const crashDumpsPath = mainLogComposition.resolveCrashDumpsPath();
const WAL_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

const mainStoreContext = new MainStoreContext();
let characterService: CharacterService | null = null;
let characterAuthoringService: CharacterAuthoringService | null = null;
let managedSkillDistributionService: ManagedSkillDistributionService | null =
  null;
let allowQuitWithInFlightRuns = false;
let agentRuntimeApi: AgentRuntimeApiHandle | null = null;
const approvalReviewInputs = new ApprovalReviewInputFence();
let approvalReviewSettingsRevision = 0;
const isBackgroundLaunch = shouldLaunchInBackground(process.argv);
const mainWindowComposition = new MainWindowComposition(
  preloadPath,
  mainLogComposition.attachWindowLogHandlers,
  (window) => requireWindowEntryLoader().loadBootEntry(window),
);
let terminalService: TerminalService<BrowserWindow> | null = null;
const mainWindowRuntime = new MainWindowRuntime({
  composition: mainWindowComposition,
  devServerUrl,
  rendererDistPath,
  userDataPath: fixedUserDataPath,
  getSession,
  /** Window 処理が現在のストレージ世代を参照できるようにする。 */
  getStorageGeneration: () => mainStoreContext.storageWorker,
  /** Session Window が表示する最新のデータを永続ストアから読み取る。 */
  readSession: (sessionId) => requireSessionStorage().getSession(sessionId),
  /** Auxiliary 実行は親を、通常実行は対応 Window がある場合だけ自身を Window 所有者として返す。 */
  getLiveSessionRunOwnerSessionId: (sessionId) =>
    auxiliaryLiveRunParents.get(sessionId) ??
    (mainWindowRuntime.getSessionWindowBridge().getWindow(sessionId)
      ? sessionId
      : null),
  isSessionRunInFlight,
  /** 指定 Window を閉じる際に確認が必要な端末の数を返す。 */
  getTerminalCloseConfirmationCount: (window) =>
    terminalService?.countRequiringCloseConfirmation(window) ?? 0,
  cancelInFlightSessionRuns,
  /** 下書き送信とキュー・実行の終了を待ち、Auxiliary の下書き復元が未解決なら false を返す。 */
  waitForPendingDraftSends: async () => {
    const [auxiliarySaved] = await Promise.all([
      auxiliarySessionService?.waitForPendingDraftSends() ??
        Promise.resolve(true),
      sessionTurnQueueService?.waitForPending(),
      sessionRuntimeService?.waitForPendingRuns(),
      auxiliarySessionRuntimeService?.waitForPendingRuns(),
    ]);
    return auxiliarySaved;
  },
  /** Session Window が閉じた後、その Window に紐づく端末と Auxiliary 作成権の保持を終了する。 */
  onSessionWindowClosed: (sessionId) => {
    terminalService?.releaseSession(sessionId);
    auxiliarySessionService?.releaseAuxiliaryCreationOwner(sessionId);
  },
  /** 終了前の下書き保存結果を、理由・結果・待機時間とともに記録する。 */
  onDraftFlushSettled: (result) => {
    writeAppLog({
      level: result.outcome === "saved" ? "info" : "warn",
      kind: "session.window.draft_flush.settled",
      process: "main",
      message: "Session Window draft flush settled",
      data: {
        reason: result.reason,
        outcome: result.outcome,
        elapsedMs: result.elapsedMs,
      },
    });
  },
  /** Window 宛てのイベント配送に失敗した際に警告を記録する。 */
  onWindowBroadcastFailed: () => {
    writeAppLog({
      level: "warn",
      kind: "window.broadcast.send_failed",
      process: "main",
      message: "Window event delivery failed",
    });
  },
  /** 進行中のターンと稼働中の端末への影響を表示し、Window を閉じる選択だけを承認として返す。 */
  confirmCloseWhileRunning: async (window, sessionId, signal) => {
    const hasRun = isSessionRunInFlight(sessionId);
    const liveTerminals = terminalService?.countLive(window) ?? 0;
    const choice = await dialog.showMessageBox(window, {
      signal,
      type: "warning",
      buttons: ["Keep Open", hasRun ? "Close And Continue" : "Close Window"],
      defaultId: 0,
      cancelId: 0,
      title: hasRun ? "Session Is Running" : "Close Window",
      message:
        hasRun && liveTerminals
          ? "The session is running and the terminals will close."
          : hasRun
            ? "This session is still running."
            : "Terminals may have work in progress.",
      detail:
        hasRun && liveTerminals
          ? "The session run will continue, but the terminals will stop when this window closes."
          : hasRun
            ? "The run will continue after this window closes. Reopen the session later to check its progress."
            : "The terminals will stop when this window closes.",
      noLink: true,
    });
    return choice.response === 1;
  },
  /** 復元に用いる Window 状態を保存できなかった場合に、原因を警告ログへ残す。 */
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
terminalService = new TerminalService<BrowserWindow>({
  /** メインフレームの IPC 送信元が稼働中の Session Window と一致するときだけ端末所有者を返す。 */
  resolveOwner: (candidate) => {
    if (!candidate || typeof candidate !== "object" || !("sender" in candidate))
      return null;
    const event = candidate as
      Electron.IpcMainEvent | Electron.IpcMainInvokeEvent;
    if (event.senderFrame !== event.sender.mainFrame) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return null;
    const sessionId = mainWindowRuntime
      .getSessionWindowBridge()
      .listOpenSessionWindowIds()
      .find(
        (candidate) =>
          mainWindowRuntime.getSessionWindowBridge().getWindow(candidate) ===
          window,
      );
    if (!sessionId) return null;
    const session = getSession(sessionId);
    return session
      ? { window, sessionId, workspacePath: session.workspacePath }
      : null;
  },
  /** 端末を閉じるとシェルとその子プロセスが停止することを示し、閉じる選択を承認とする。 */
  confirmClose: async (window, signal) =>
    (
      await dialog.showMessageBox(window, {
        signal,
        type: "warning",
        buttons: ["Keep Open", "Close Terminal"],
        defaultId: 0,
        cancelId: 0,
        title: "Close Terminal",
        message: "This terminal may have work in progress.",
        detail: "Closing it will stop the shell and any processes it started.",
        noLink: true,
      })
    ).response === 1,
  /** 端末イベントを所有 Window の renderer に送る。 */
  sendEvent: (window, event) =>
    window.webContents.send(WITHMATE_TERMINAL_EVENT, event),
  spawn: spawnTerminalPty,
  resolveShell: resolveTerminalShell,
});
const sessionFileExplorerRuntime = new SessionFileExplorerRuntime({
  userDataPath: fixedUserDataPath,
  getSessionContext: getSessionFileExplorerContext,
  getPinStorage: requireSessionFilePinStorage,
  /** 解決済みのファイルを、その場所の表示または通常の起動に振り分ける。 */
  openResolvedPath: (targetPath, reveal) =>
    openPathTarget(targetPath, { reveal }),
  /** ファイルプレビューの内容を専用 Window に渡して開く。 */
  openPreviewWindow: (payload) =>
    requireMainWindowFacade().openFilePreviewWindow(payload),
  /** ファイル探索機能からの外部リンクを共通の起動経路へ渡す。 */
  openExternalUrl: (target) => openPathTarget(target),
  /** 送信元を確認したうえで、解決済みのディレクトリを既定のファイルマネージャーで開く。 */
  openDirectory: (targetPath, assertSender) =>
    openResolvedDirectoryInFileManager(targetPath, {
      statTarget: stat,
      realpathTarget: realpath,
      assertSender,
      /** 確認済みディレクトリを OS の既定アプリへ渡す。 */
      openWithDefaultApp: (directoryPath) => shell.openPath(directoryPath),
    }),
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
let sessionTurnQueueService: SessionTurnQueueService | null = null;
let mainSessionTurnQueueFacade: MainSessionTurnQueueFacade | null = null;
let sessionTurnNotificationService: SessionTurnNotificationService<NativeImage> | null =
  null;
let auxiliarySessionService: AuxiliarySessionService | null = null;
let auxiliarySessionRuntimeService: SessionRuntimeService | null = null;
let sessionPersistenceService: SessionPersistenceService | null = null;
let settingsCatalogService: SettingsCatalogService | null = null;
let sessionObservabilityService: SessionObservabilityService | null = null;
let sessionApprovalService: SessionApprovalService | null = null;
let sessionElicitationService: SessionElicitationService | null = null;
let sessionTurnService: SessionTurnService | null = null;
const sessionResultReadService = new SessionResultReadService((sessionId) => {
  requireWindowBroadcastService().broadcastSessionTurnUpdated(sessionId);
});
/** Session のターン結果に未読項目があるかを返す。 */
const hasUnreadResult = (sessionId: string) =>
  sessionResultReadService.getUnreadResult(sessionId) !== null;
let mainBroadcastFacade: MainBroadcastFacade<BrowserWindow> | null = null;
let mainObservabilityFacade: MainObservabilityFacade | null = null;
let mainProviderFacade: MainProviderFacade | null = null;
let providerModelDiscoveryService: ProviderModelDiscoveryService | null = null;
let mainSessionCommandFacade: MainSessionCommandFacade | null = null;
let mainSessionPersistenceFacade: MainSessionPersistenceFacade | null = null;
let sessionLaunchSelectionService: SessionLaunchSelectionService | null = null;
const providerRuntimeOperationCoordinator =
  new ProviderRuntimeOperationCoordinator(logStorageOperationDiagnostic);
const agentRuntimeBindingRegistry = new AgentRuntimeBindingRegistry();
const glossaryApplicationService = new GlossaryApplicationService();
const glossarySessionProjectionService = new GlossarySessionProjectionService({
  applicationService: glossaryApplicationService,
  getSession,
  /** Glossary 投影に使用する Session とプロバイダーの実行バインディング世代を返す。 */
  getBindingGeneration: (sessionId, providerId) =>
    agentRuntimeBindingRegistry.getExecutionGeneration(sessionId, providerId),
  /** 実行バインディングの変更を購読し、投影に必要な Session とプロバイダーを通知する。 */
  subscribeBindingChanges: (listener) =>
    agentRuntimeBindingRegistry.subscribeChanges((change) => {
      listener({
        sessionId: change.actorSessionId,
        providerId: change.providerId,
      });
    }),
});
const glossaryWindowSubscriptionCoordinator =
  new SessionGlossaryWindowSubscriptionCoordinator<BrowserWindow>({
    /** Glossary 更新を受け取る Session Window を現在の Window 一覧から取得する。 */
    getWindow: (sessionId) => requireSessionWindowBridge().getWindow(sessionId),
    /** 指定 Session の Glossary 投影の変更を購読する。 */
    subscribe: (sessionId, listener) =>
      glossarySessionProjectionService.subscribe(sessionId, listener),
    /** 新しい Glossary 投影を、その Session を表示する renderer に送る。 */
    deliver: (window, projection) => {
      window.webContents.send(
        WITHMATE_SESSION_GLOSSARY_CHANGED_EVENT,
        projection,
      );
    },
  });
const workspaceDirectoryValidationService =
  new WorkspaceDirectoryValidationService();
let mainWindowFacade: MainWindowFacade | null = null;
let mainQueryService: MainQueryService | null = null;
let appTrayService: AppTrayService | null = null;
// 終了時の後処理も含め、アプリの終了状態は永続ストアの世代をまたいで維持する。
let appLifecycleService: AppLifecycleService | null = null;
let mainInfrastructureRegistry: MainInfrastructureRegistry<
  PersistentStoreLifecycleService,
  MainBootstrapService
> | null = null;

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

/** アプリのログを書き込み、ログ出力の失敗を呼び出し元に波及させずコンソールへ知らせる。 */
function writeAppLog(input: Parameters<AppLogService["write"]>[0]): void {
  try {
    appLogService.write(input);
  } catch (error) {
    console.warn("App log write failed", error);
  }
}

/** ストレージ操作の診断に世代 ID がなければ、現在の Worker の ID を補って記録する。 */
function logStorageOperationDiagnostic(
  event: StorageOperationDiagnostic,
): void {
  storageOperationLogService.record({
    ...event,
    generationId:
      event.generationId ?? mainStoreContext.storageWorker?.client.generationId,
  });
}

const stopEventLoopDelayMonitoring = startEventLoopDelayMonitoring((report) =>
  writeAppLog({
    level: "info",
    kind: "main.event_loop_delay",
    process: "main",
    message: "Main event loop delay summary",
    data: report,
  }),
);
app.once("will-quit", stopEventLoopDelayMonitoring);
app.once("will-quit", () => storageOperationLogService.dispose());

/** 起動済みの DB を必要なときに検査し、現在のストア世代の診断情報としてキャッシュする。 */
async function getAppDatabaseDiagnostics(): Promise<AppDatabaseDiagnostics> {
  if (!mainStoreContext.appDatabaseDiagnostics) {
    if (!mainStoreContext.dbPath) {
      throw new Error("Saved data is not initialized.");
    }
    mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
  }
  return mainStoreContext.appDatabaseDiagnostics!;
}

/** 実行主体を通常または Auxiliary Session から解決し、Auxiliary の場合は有効な親の incarnation も返す。 */
async function resolveAgentRuntimeActorSession(
  sessionId: string,
  sourceKind?: "main" | "auxiliary",
) {
  const session = sourceKind === "auxiliary" ? null : getSession(sessionId);
  if (session) {
    return {
      id: session.id,
      providerId: session.provider,
      characterId: session.characterId,
      workspacePath: session.workspacePath,
      source: {
        kind: "main" as const,
        sessionId: session.id,
        incarnationId: getSessionIncarnationId(session),
      },
    };
  }
  if (sourceKind === "main" || !mainStoreContext.auxiliarySessionStorage) {
    return null;
  }
  const service = requireAuxiliarySessionService();
  const [auxiliary, metadata] = await Promise.all([
    service.getAuxiliaryRuntimeSession(sessionId),
    service.getAuxiliarySessionMetadata(sessionId),
  ]);
  const parent = metadata ? getSession(metadata.parentSessionId) : null;
  return auxiliary && parent
    ? {
        id: auxiliary.id,
        providerId: auxiliary.provider,
        characterId: auxiliary.characterId,
        workspacePath: auxiliary.workspacePath,
        source: {
          kind: "auxiliary" as const,
          sessionId: auxiliary.id,
          incarnationId: getSessionIncarnationId(auxiliary),
          parent: {
            sessionId: parent.id,
            incarnationId: getSessionIncarnationId(parent),
          },
        },
      }
    : null;
}

/** Glossary の自発的な項目作成に適用する設定上限を読み取る。 */
async function getGlossaryProactiveCreateLimit(): Promise<number | null> {
  return (await requireAppSettingsStorage().getSettings())
    .glossaryProactiveCreateLimit;
}

/** Session Window が Glossary 変更を受け取れるように購読を確立する。 */
async function ensureSessionGlossarySubscription(
  sessionId: string,
): Promise<void> {
  await glossaryWindowSubscriptionCoordinator.ensure(sessionId);
}

const providerAgentRuntimeTurns = new ProviderAgentRuntimeTurnCoordinator();
const pendingSourceDisplays = new Map<string, Map<string, string>>();
/** Session ID・incarnation・ターン ID の組から送信元表示の追跡キーを作る。 */
function sourceDisplayTurnKey(
  sessionId: string,
  incarnationId: string,
  turnId: string,
): string {
  return JSON.stringify([sessionId, incarnationId, turnId]);
}
/** ターン中の送信元表示を追跡し、同じ登録が残っている場合だけ解除する後処理を返す。 */
function beginSourceDisplayTurn(session: Session, turnId: string): () => void {
  const key = sourceDisplayTurnKey(
    session.id,
    getSessionIncarnationId(session),
    turnId,
  );
  const prefixes = new Map<string, string>();
  pendingSourceDisplays.set(key, prefixes);
  return () => {
    if (pendingSourceDisplays.get(key) === prefixes)
      pendingSourceDisplays.delete(key);
  };
}
/** 元のターンがまだ追跡中なら、送信元表示の先頭に入れた内容を受領 ID ごとに保持する。 */
function rememberSourceDisplay(
  receipt: SessionTurnQueueReceipt,
  text: string,
): void {
  const origin = receipt.accepted?.origin;
  if (
    !receipt.sourceDisplayInserted ||
    !origin?.actorSessionId ||
    !origin.actorIncarnationId ||
    !origin.actorTurnId
  )
    return;
  // 送信元のランタイムが終了した後に受領記録が届くことがある。
  pendingSourceDisplays
    .get(
      sourceDisplayTurnKey(
        origin.actorSessionId,
        origin.actorIncarnationId,
        origin.actorTurnId,
      ),
    )
    ?.set(receipt.id, text);
}
/** 表示された送信内容が最終メッセージの先頭にあるかを保存結果へ反映し、更新を Window に通知する。 */
async function verifySourceDisplays(
  session: Session,
  turnId: string,
): Promise<void> {
  const incarnationId = getSessionIncarnationId(session);
  const prefixes = pendingSourceDisplays.get(
    sourceDisplayTurnKey(session.id, incarnationId, turnId),
  );
  if (!prefixes) return;
  const text = session.messages.at(-1)?.text ?? "";
  let updated = false;
  for (const [id, prefix] of prefixes) {
    prefixes.delete(id);
    try {
      const owner = requireActivePersistentStoreOwnerForFactory(
        "Sent delivery position",
      );
      if (owner.storageWorker) {
        await owner.storageWorker.stores.queue.verifySourceDisplayPosition(
          id,
          session.id,
          incarnationId,
          turnId,
          text.startsWith(prefix),
        );
        updated = true;
      }
    } catch (error) {
      writeAppLog({
        level: "warn",
        kind: "sent-delivery.position-verification-failed",
        process: "main",
        message: "A sent delivery position could not be verified",
        error: appLogService.errorToLogError(error),
      });
    }
  }
  if (updated) {
    try {
      const auxiliary =
        await requireAuxiliarySessionService().getAuxiliarySessionStatus(
          session.id,
        );
      requireWindowBroadcastService().broadcastSessionTurnQueueChanged(
        session.id,
        auxiliary?.parentSessionId ?? session.id,
      );
    } catch (error) {
      writeAppLog({
        level: "warn",
        kind: "sent-delivery.position-broadcast-failed",
        process: "main",
        message: "A sent delivery position update could not be broadcast",
        error: appLogService.errorToLogError(error),
      });
    }
  }
}
const coordinationApplicationService = new CoordinationApplicationService({
  /** 取得済みの永続世代から Coordination ストアを返し、DB メンテナンス中の操作を拒否する。 */
  getStore: () => {
    const owner = requireActivePersistentStoreOwnerForFactory("Coordination");
    if (!owner.storageWorker || databaseMaintenanceRequested)
      throw new Error("Coordination storage is unavailable.");
    return owner.storageWorker.stores.coordination;
  },
  /** 送受信 Session の世代を照合し、配送元と配送先の表示情報および稼働中ターンの挿入位置を確定する。 */
  prepareDelivery: async (target, operationId, actor) => {
    const captured =
      await requireMainSessionTurnQueueFacade().prepareCoordinationDelivery(
        target,
        operationId,
      );
    const recipient =
      target.kind === "main"
        ? await getRuntimeSession(target.sessionId)
        : await requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
            target.sessionId,
          );
    const sender =
      actor.kind === "user"
        ? null
        : actor.kind === "main"
          ? await getRuntimeSession(actor.sessionId)
          : await requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
              actor.sessionId,
            );
    const auxiliarySender =
      actor.kind === "auxiliary"
        ? await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
            actor.sessionId,
          )
        : null;
    if (
      !recipient ||
      getSessionIncarnationId(recipient) !== target.incarnationId ||
      (actor.kind !== "user" &&
        (!sender || getSessionIncarnationId(sender) !== actor.incarnationId))
    )
      throw new Error("The Coordination sender or recipient changed.");
    const live =
      actor.kind === "user" ? null : getLiveSessionRun(actor.sessionId);
    return {
      ...captured,
      ...(actor.kind !== "user" && live?.sessionTurnId === actor.turnId
        ? {
            sourceDisplayPosition: live.assistantText.length,
            sourceDisplayText: live.assistantText,
          }
        : {}),
      origin: {
        kind: actor.kind === "user" ? "gui" : "session",
        operation: "send",
        targetSessionId: target.sessionId,
        targetIncarnationId: target.incarnationId,
        targetSnapshot: captureSessionTurnQueueDisplay(recipient),
        ...(sender
          ? { actorSnapshot: captureSessionTurnQueueDisplay(sender) }
          : {}),
        ...(auxiliarySender
          ? { actorMainSessionId: auxiliarySender.parentSessionId }
          : {}),
      },
    };
  },
  /** 確定した受領をキューへ反映し、送信元に挿入した表示文があれば検証用に記憶する。 */
  onAccepted: (receipt, text) => {
    if (text !== undefined) rememberSourceDisplay(receipt, text);
    requireMainSessionTurnQueueService().acceptCommittedReceipt(receipt);
  },
  /** 保存後の Coordination 通知に失敗したとき、受領そのものとは区別して警告を残す。 */
  onNotificationError: (error) =>
    writeAppLog({
      level: "warn",
      kind: "coordination.notification-failed",
      process: "main",
      message: "A saved Coordination notification failed",
      error: appLogService.errorToLogError(error),
    }),
});

const localPrCore = new LocalPrService({
  /** Local PR 操作が利用できる現行の永続データ所有者を返す。 */
  getActiveOwner: () =>
    databaseMaintenanceRequested
      ? null
      : mainStoreContext.activePersistentStoreOwner,
  /** メンテナンスとの同時操作を避け、利用可能な Worker の Local PR ストアだけを供給する。 */
  getStore: () =>
    databaseMaintenanceRequested
      ? null
      : (mainStoreContext.storageWorker?.stores.localPr ?? null),
  /** リポジトリに紐づく PR Window へ変更を通知する。 */
  onChanged: (repositoryId) => localPrWindowService.notify(repositoryId),
});
let localPrCiInitialization: Promise<LocalPrCiService> | null = null;

/** renderer の存続期間に依存せず、アプリが所有する CI ランナーを初期化する。 */
function getLocalPrCi(): Promise<LocalPrCiService> {
  if (localPrCiInitialization) return localPrCiInitialization;
  const instance = new LocalPrCiService({
    userDataPath: app.getPath("userData"),
    /** CI の結果が変わったリポジトリの PR Window を更新する。 */
    onChanged: (id) => localPrWindowService.notify(id),
  });
  const initialization = instance
    .initialize()
    .then(() => instance)
    .catch((error: unknown) => {
      localPrCiInitialization = null;
      throw error;
    });
  localPrCiInitialization = initialization;
  return initialization;
}

/** 保存された incarnation と、Auxiliary の場合は対象に含まれる正確な親が一致することを確認する。 */
async function readLocalPrSession(
  target: SessionTarget,
): Promise<Session | null> {
  if (target.kind === "main") {
    const session = await getRuntimeSession(target.sessionId);
    return session &&
      session.sessionKind === "default" &&
      getSessionIncarnationId(session) === target.incarnationId
      ? session
      : null;
  }
  const service = requireAuxiliarySessionService();
  const metadata = await service.getAuxiliarySessionMetadata(target.sessionId);
  if (
    !metadata ||
    metadata.parentSessionId !== target.mainSessionId ||
    metadata.createdAt !== target.incarnationId
  )
    return null;
  const parent = await readLocalPrSession({
    kind: "main",
    sessionId: target.mainSessionId,
    incarnationId: target.mainIncarnationId,
  });
  if (!parent || parent.accessMode !== "active") return null;
  const session = await service.getAuxiliaryRuntimeSession(target.sessionId);
  return session && getSessionIncarnationId(session) === target.incarnationId
    ? session
    : null;
}

/** 通常の PR ツールで同じリポジトリを扱える、有効な保存済み Session だけを候補にする。 */
async function chooseLocalPrSessions(
  repository: LocalPrRepository,
  input: LocalPrInput<"session_choices">,
): Promise<LocalPrResult<"session_choices">> {
  const owner =
    requireActivePersistentStoreOwnerForFactory("PR Session choices");
  const mains = await owner.sessionStorage.listSessionSummaries();
  const query = input.query?.trim().toLowerCase() ?? "";
  const active = mains.filter(
    (session) =>
      session.sessionKind === "default" && session.accessMode === "active",
  );
  const parents = new Map(active.map((session) => [session.id, session]));
  const candidates: Array<{
    workspacePath: string;
    target: SessionTarget;
    title: string;
    character: string;
    iconPath: string;
  }> = [];
  for (const main of active) {
    if (`${main.taskTitle} ${main.character}`.toLowerCase().includes(query))
      candidates.push({
        workspacePath: main.workspacePath,
        title: main.taskTitle,
        character: main.character,
        iconPath: main.characterIconPath,
        target: {
          kind: "main",
          sessionId: main.id,
          incarnationId: getSessionIncarnationId(main),
        },
      });
  }
  // 保存済み Session が数千件ある場合でも、SQLite に渡すパラメーター数を制限する。
  const auxiliaries = [];
  for (let start = 0; start < active.length; start += 500) {
    auxiliaries.push(
      ...(await requireAuxiliarySessionService().listAuxiliarySessionSummaries(
        active.slice(start, start + 500).map((session) => session.id),
      )),
    );
  }
  for (const auxiliary of auxiliaries) {
    const parent = parents.get(auxiliary.parentSessionId);
    if (
      parent &&
      `${parent.taskTitle} / ${auxiliary.title} ${auxiliary.character ?? parent.character}`
        .toLowerCase()
        .includes(query)
    )
      candidates.push({
        workspacePath: parent.workspacePath,
        title: `${parent.taskTitle} / ${auxiliary.title}`,
        character: auxiliary.character ?? parent.character,
        iconPath: auxiliary.characterIconPath ?? parent.characterIconPath,
        target: {
          kind: "auxiliary",
          sessionId: auxiliary.id,
          incarnationId: auxiliary.createdAt,
          mainSessionId: parent.id,
          mainIncarnationId: getSessionIncarnationId(parent),
        },
      });
  }
  /** 優先表示の対象を判定する。Auxiliary では親の ID と incarnation も一致条件に含める。 */
  const isPreferred = (target: SessionTarget) =>
    target.kind === input.preferred?.kind &&
    target.sessionId === input.preferred.sessionId &&
    target.incarnationId === input.preferred.incarnationId &&
    (target.kind === "main" ||
      (input.preferred.kind === "auxiliary" &&
        target.mainSessionId === input.preferred.mainSessionId &&
        target.mainIncarnationId === input.preferred.mainIncarnationId));
  candidates.sort(
    (a, b) => Number(isPreferred(b.target)) - Number(isPreferred(a.target)),
  );
  const offset = input.offset ?? 0;
  const matches = new Map<string, Promise<boolean>>();
  const sessions: Array<{
    target: SessionTarget;
    title: string;
    character: string;
    iconPath: string;
  }> = [];
  // 要求されたページに必要な候補までを解決し、Git の同時実行数も制限する。
  for (
    let start = 0;
    start < candidates.length && sessions.length <= offset + 50;
    start += 16
  ) {
    const batch = candidates.slice(start, start + 16);
    const results = await Promise.all(
      batch.map((candidate) => {
        let match = matches.get(candidate.workspacePath);
        if (!match) {
          match = resolveLocalPrRepository(candidate.workspacePath).then(
            (value) => value.repositoryId === repository.repositoryId,
            () => false,
          );
          matches.set(candidate.workspacePath, match);
        }
        return match;
      }),
    );
    batch.forEach(({ workspacePath: _workspacePath, ...candidate }, index) => {
      if (results[index]) sessions.push(candidate);
    });
  }
  assertPersistentStoreOwnerIsActive(owner, "PR Session choices");
  return {
    ok: true,
    data: {
      sessions: sessions.slice(offset, offset + 50),
      hasMore: sessions.length > offset + 50,
    },
  };
}

const localPrApplication = new LocalPrApplication<LocalPrRepository>({
  /** 解決済みリポジトリと操作主体を Local PR の保存処理に渡す。 */
  core: (repository, actor, origin, operation, input) =>
    localPrCore.execute(repository, actor, origin, operation, input),
  /** 初期化済みの CI ランナーを取得し、対象 PR とバージョンを指定して操作する。 */
  ci: async (repository, prId, version, operation, input) =>
    (await getLocalPrCi()).execute(repository, prId, version, operation, input),
  sessionChoices: chooseLocalPrSessions,
  /** 議論の送信先を、同じリポジトリを扱う有効な Session に限定する。 */
  assertDiscussionTarget: async (target, repository) => {
    const session = await readLocalPrSession(target);
    if (
      !session ||
      session.accessMode !== "active" ||
      (await resolveLocalPrRepository(session.workspacePath)).repositoryId !==
        repository.repositoryId
    ) {
      throw new Error("Choose an active Session for this repository.");
    }
  },
  /** 送信先を読み直してから、PR の議論文を Session のターンキューに入れる。 */
  sendDiscussion: (input, message, assertCurrent) =>
    enqueueLocalPrDiscussion(
      requireMainSessionTurnQueueFacade(),
      input,
      message,
      readLocalPrSession,
      assertCurrent,
    ),
});

const localPrWindowService: LocalPrWindowService<LocalPrRepository> =
  new LocalPrWindowService({
    /** アクティブな Session からリポジトリを解決し、途中で永続世代が変わっていない場合だけ Window 所有情報を返す。 */
    resolveOwner: async (actor) => {
      const generation = mainStoreContext.activePersistentStoreOwner;
      if (!generation || databaseMaintenanceRequested) return null;
      const session = await readLocalPrSession(actor);
      if (!session || session.accessMode !== "active") return null;
      const repository = await resolveLocalPrRepository(session.workspacePath);
      if (
        generation !== mainStoreContext.activePersistentStoreOwner ||
        databaseMaintenanceRequested
      )
        return null;
      return { actor, repository, generation };
    },
    /** PR Window と関連付ける既存の Session Window を検索する。 */
    sessionWindow: (sessionId) =>
      requireSessionWindowBridge().getWindow(sessionId),
    /** Local PR 専用 preload と独立した設定で別 Window を作る。 */
    createWindow: () =>
      mainWindowComposition.createCursorPlacedWindow({
        width: 1400,
        height: 900,
        minWidth: 720,
        minHeight: 520,
        title: "Pull Requests",
        webPreferences: {
          preload: path.resolve(currentDir, "local-pr/local-pr-preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          sandbox: false,
          webviewTag: false,
        },
      }),
    /** PR Window に Local PR 用の renderer エントリを読み込む。 */
    loadWindow: (window) => requireWindowEntryLoader().loadLocalPrEntry(window),
    application: localPrApplication,
    /** 要求元の Window とワークスペースを使って添付ファイル用ダイアログを開く。 */
    pickAttachment: (window, workspacePath) =>
      requireWindowDialogService().pickFiles(window, workspacePath),
    /** クリップボード画像をアプリデータ配下に Local PR の添付として保存する。 */
    saveClipboardImage: (input) =>
      saveLocalPrClipboardImage(fixedUserDataPath, input),
    /** Local PR の添付を共通のパス起動処理に渡す。 */
    openAttachment: (target) => openPathTarget(target),
    imageReader: createSessionFileExplorerService,
  });

/** Session 管理ツールを現在のバインディングと永続サービスへ接続する。 */
const sessionManagementRuntimeService = new SessionManagementRuntimeService({
  bindingRegistry: agentRuntimeBindingRegistry,
  providerAgentRuntimeTurns,
  localPr: {
    /** 実行元のワークスペースをリポジトリに解決してから Local PR 操作を委譲し、解決失敗は専用の結果に変換する。 */
    execute: async (
      operation,
      input,
      { actor, workspacePath, assertCurrent },
    ) => {
      let repository: LocalPrRepository;
      try {
        repository = await resolveLocalPrRepository(workspacePath);
      } catch (error) {
        return localPrFailure(
          "PR_REPOSITORY_UNAVAILABLE",
          error instanceof Error ? error.message : String(error),
        );
      }
      assertCurrent();
      return localPrApplication.execute(
        repository,
        actor,
        "agent",
        operation,
        input,
        assertCurrent,
      );
    },
  },
  application: new SessionManagementApplication({
    /** 主体のワークスペース、設定、利用枠を使って Session の運用ポリシーを判定する。 */
    operatingPolicy: (actor, operation, request, assertCurrent) =>
      new SessionOperatingPolicyService({
        /** 運用ポリシーの読み取りに現在の設定ストアを使う。 */
        getStore: () => requireAppSettingsStorage(),
        getQuota: getProviderQuotaTelemetry,
      }).execute(operation, request, actor.workspacePath, assertCurrent),
    /** 主体と実行の識別情報を保って通常子を作り、業務上の作成拒否を管理 API のエラーへ変換する。 */
    createChild: async (actor, request, assertCurrent, actorExecution) => {
      try {
        return await requireMainSessionCommandFacade().createChildSession(
          { id: actor.id, incarnationId: actor.incarnationId },
          request,
          assertCurrent,
          actorExecution,
        );
      } catch (error) {
        if (error instanceof ChildSessionCreationRejectedError)
          throw new SessionManagementError("SESSION_REJECTED", error.message);
        throw error;
      }
    },
    /** 現行の主体からワークスペースを解決し、設定で利用不可になったプロバイダーやモデルをカタログから除く。 */
    catalog: async (actor, request) => {
      const session =
        actor.kind === "main"
          ? await getRuntimeSession(actor.id)
          : await requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
              actor.id,
            );
      if (!session || getSessionIncarnationId(session) !== actor.incarnationId)
        throw new SessionManagementError(
          "SESSION_REPLACED",
          "The catalog actor was replaced or deleted.",
        );
      const catalog = await getModelCatalog({
        providerId: request.provider,
        workspacePath: request.workspacePath ?? session.workspacePath,
      });
      const settings = await requireAppSettingsStorage().getSettings();
      return {
        ...catalog,
        providers: catalog.providers
          .filter(
            (provider) => getProviderAppSettings(settings, provider.id).enabled,
          )
          .map((provider) => ({
            ...provider,
            models: provider.models.filter(
              (model) =>
                getModelDisabledReason(
                  settings.modelAvailability,
                  provider.id,
                  model.id,
                ) === null,
            ),
            defaultModelAvailable:
              provider.models.some(
                (model) => model.id === provider.defaultModelId,
              ) &&
              getModelDisabledReason(
                settings.modelAvailability,
                provider.id,
                provider.defaultModelId,
              ) === null,
          })),
      };
    },
    /** ターンを持たない要求は読み取りに限定し、ターン内要求は主体を指定して Coordination に渡す。 */
    coordinate: async (actor, turnId, request, assertCurrent) => {
      const identity = {
        kind: actor.kind,
        sessionId: actor.id,
        incarnationId: actor.incarnationId,
      };
      /** Coordination 操作時点のバインディングを検査し、失効なら例外で止める。 */
      const guard = () => {
        assertCurrent();
        return true;
      };
      try {
        return await (turnId === null
          ? coordinationApplicationService.read(identity, request, guard)
          : coordinationApplicationService.executeAgent(
              { ...identity, turnId },
              request,
              guard,
            ));
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "COORDINATION_REJECTED" ||
            error.code === "COORDINATION_DELETED")
        )
          throw new SessionManagementError(error.code, error.message);
        throw error;
      }
    },
    /** 実行主体の所属 Crew を基準に、共有ファイルの保存先を返す。 */
    crewFolder: async (actor) => ({
      rootSessionId: actor.rootSessionId,
      path: resolveCrewFilesDirectory(
        app.getPath("userData"),
        actor.rootSessionId,
      ),
    }),
    /** 指定された Session の追加ディレクトリを、現行性の確認を伴う永続化処理で変更する。 */
    directories: (target, change, assertCurrent) =>
      manageSessionDirectories(
        requireSessionPersistenceService(),
        app.getPath("userData"),
        target,
        change,
        assertCurrent,
      ),
    readSessionScope: createSessionManagementScopeReader(
      () => mainStoreContext.activePersistentStoreOwner,
    ),
    /** 実行元が一致する進行中ターンを特定し、そのターンを開始した受領と送信元情報を返す。 */
    currentTurn: async (actor) => {
      const owner = requireActivePersistentStoreOwnerForFactory(
        "Session current Turn",
      );
      const mainRunning = Boolean(
        sessionRuntimeService?.isRunInFlight(actor.id),
      );
      const auxiliaryRunning = Boolean(
        auxiliarySessionRuntimeService?.isRunInFlight(actor.id),
      );
      const actualOwnerRunning =
        actor.kind === "main"
          ? mainRunning && !auxiliaryRunning
          : auxiliaryRunning && !mainRunning;
      const turnId = actualOwnerRunning
        ? (getLiveSessionRun(actor.id)?.sessionTurnId ?? null)
        : null;
      const receipts = turnId
        ? await owner.storageWorker!.stores.queue.listActive({
            sessionId: actor.id,
            incarnationId: actor.incarnationId,
          })
        : [];
      assertPersistentStoreOwnerIsActive(owner, "Session current Turn");
      const receipt =
        receipts.find(
          (entry) => entry.turnId === turnId && !entry.inputTurnId,
        ) ?? null;
      return {
        turnId,
        receipt: receipt
          ? {
              sessionId: receipt.sessionId,
              incarnationId: receipt.incarnationId,
              receiptId: receipt.id,
              requestId: receipt.requestId,
              turnId: receipt.turnId,
            }
          : null,
        origin: receipt?.accepted?.origin ?? null,
      };
    },
    /** 指定 incarnation の Session に保存された指示を取得する。 */
    getInstructions: (target) => getSessionInstructions(target),
    setInstructions: setSessionInstructions,
    /** 通常 Session と Auxiliary の保存先を振り分け、Auxiliary の変更を親の一覧にも反映する。 */
    updateMetadata: async (actor, patch, assertCurrent) => {
      assertCurrent();
      if (actor.kind === "main")
        return requireSessionPersistenceService().patchSessionMetadata(
          actor.id,
          actor.incarnationId,
          patch,
          assertCurrent,
        );
      const metadata =
        await requireAuxiliarySessionService().patchAuxiliarySessionMetadata(
          {
            auxiliarySessionId: actor.id,
            parentSessionId: actor.mainSessionId,
            createdAt: actor.incarnationId,
            patch,
          },
          assertCurrent,
        );
      broadcastSessions([actor.mainSessionId]);
      return metadata;
    },
    /** 送受信側の情報と起点への返信参照を揃え、Session 間メッセージをターンキューへ登録する。 */
    enqueue: async (target, input, actor, turnId, assertCurrent) => {
      const session = await getQueueRuntimeSession(target.id);
      if (!session) throw new Error("The target Session is unavailable.");
      const facade = requireMainSessionTurnQueueFacade();
      const sender =
        actor.kind === "main"
          ? await getRuntimeSession(actor.id)
          : await requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
              actor.id,
            );
      if (!sender || getSessionIncarnationId(sender) !== actor.incarnationId)
        throw new Error("The sender Session is unavailable or changed.");
      const origin = {
        kind: "session" as const,
        actorKind: actor.kind,
        actorSessionId: actor.id,
        actorIncarnationId: actor.incarnationId,
        actorTurnId: turnId,
        actorSnapshot: captureSessionTurnQueueDisplay(sender),
        operation: "send" as const,
        targetSessionId: target.id,
        targetIncarnationId: target.incarnationId,
        targetSnapshot: captureSessionTurnQueueDisplay(session),
      };
      try {
        const owner = requireActivePersistentStoreOwnerForFactory(
          "Session reply reference",
        );
        const source =
          actor.kind === "main"
            ? {
                kind: "main" as const,
                sessionId: actor.id,
                incarnationId: actor.incarnationId,
              }
            : {
                kind: "auxiliary" as const,
                sessionId: actor.id,
                incarnationId: actor.incarnationId,
                mainSessionId: actor.mainSessionId,
                mainIncarnationId: actor.mainIncarnationId,
              };
        const replyTo = initiatingReply(
          source,
          {
            kind: target.kind,
            sessionId: target.id,
            incarnationId: target.incarnationId,
          },
          turnId,
          await owner.storageWorker!.stores.queue.listActive(source),
        );
        assertCurrent();
        return await facade.enqueueSessionMessage(
          input,
          origin,
          assertCurrent,
          replyTo,
        );
      } catch (error) {
        if (error instanceof SessionTurnQueuePreflightRejectedError)
          throw new SessionManagementError("SESSION_REJECTED", error.message);
        throw error;
      }
    },
    /** 指定した incarnation のキューから、要求 ID に対応する受領を取得する。 */
    getReceipt: (target, requestId) =>
      requireMainSessionTurnQueueFacade().getSessionTurnQueueReceipt(
        target.id,
        requestId,
        target.incarnationId,
      ),
    /** 現在の永続世代から操作結果を読み取り、処理の前後で要求元とストアが有効なことを確認する。 */
    readExecution: async (_target, operation, request, assertCurrent) => {
      const owner = requireActivePersistentStoreOwnerForFactory(
        "Session execution read",
      );
      const worker = owner.storageWorker;
      if (!worker || databaseMaintenanceRequested)
        throw new Error("Saved Session execution storage is unavailable.");
      assertCurrent();
      const result = await worker.stores.execution.execute({
        target: request.target,
        operation,
        request,
      });
      assertPersistentStoreOwnerIsActive(owner, "Session execution read");
      assertCurrent();
      return result;
    },
    /** 対象の incarnation と受領 ID を指定してキュー上のターンを取り消す。 */
    cancelReceipt: (target, receiptId, assertCurrent) =>
      requireMainSessionTurnQueueFacade().cancelSessionTurnReceipt(
        { sessionId: target.id, incarnationId: target.incarnationId },
        receiptId,
        assertCurrent,
      ),
    /** 対象 Session の指定ターンへ停止を要求し、現在の主体かどうかを処理側でも確認できるようにする。 */
    stopTurn: (target, turnId, assertCurrent) =>
      requireSessionRuntimeService().stopSessionTurn(
        target.id,
        target.incarnationId,
        turnId,
        assertCurrent,
      ),
    /** 送り手の Session とターンを記録したうえで、通常子の実行中ターンへ追加入力を渡す。 */
    steer: (target, input, actor, turnId, assertCurrent) =>
      requireSessionRuntimeService().steerChildSessionTurn(
        { sessionId: target.id, incarnationId: target.incarnationId },
        input.turnId,
        input.message,
        { sessionId: actor.id, incarnationId: actor.incarnationId, turnId },
        assertCurrent,
      ),
  }),
});

const glossaryRuntimeService = new GlossaryRuntimeService({
  applicationService: glossaryApplicationService,
  bindingRegistry: agentRuntimeBindingRegistry,
  resolveActorSession: resolveAgentRuntimeActorSession,
  getProactiveCreateLimit: getGlossaryProactiveCreateLimit,
  providerAgentRuntimeTurns,
});

/** 有効な実行バインディングに対してターン単位の管理 MCP を発行し、発行に失敗した場合はターン登録も解除する。 */
async function beginManagedProviderTurn(
  session: Session,
  binding:
    | import("./providers/agent-runtime-binding.js").ProviderAgentRuntimeBindingProjection
    | null,
  signal: AbortSignal,
  executionOptions: import("../src-shared/session/session-execution-options.js").SessionExecutionOptions,
) {
  if (!binding) return undefined;
  signal.throwIfAborted();
  const turn = await glossaryRuntimeService.beginProviderTurn(
    session.id,
    binding,
    executionOptions,
  );
  try {
    const host = agentRuntimeApi?.managedMcp;
    if (!host) throw new Error("Managed MCP runtime is unavailable.");
    const managedMcp = host.issue(turn.binding, turn.handle, signal);
    signal.throwIfAborted();
    return { handle: turn.handle, binding: { ...turn.binding, managedMcp } };
  } catch (error) {
    glossaryRuntimeService.endProviderTurn(turn.handle);
    throw error;
  }
}

/** ターンに発行した管理 MCP と Glossary の実行状態を解放する。 */
function endManagedProviderTurn(handle: unknown): void {
  const turn =
    handle as import("./glossary/glossary-proactive-turn.js").GlossaryProactiveTurnHandle;
  agentRuntimeApi?.managedMcp?.release(turn);
  glossaryRuntimeService.endProviderTurn(turn);
}

const approvalReviewAdapters = {
  /** Claude のアダプターで承認レビュー用の実行を開く。 */
  claude: (input) => claudeAdapter.openApprovalReviewer(input),
  /** Codex のアダプターで承認レビュー用の実行を開く。 */
  codex: (input) => codexAdapter.openApprovalReviewer(input),
} satisfies Record<WithMateReviewProviderId, OpenApprovalReviewer>;

/** 管理 MCP を利用できる現行ターンに限り、自動承認レビューの実行を組み立てる。 */
const startWithMateApprovalReview: StartWithMateApprovalReview = ({
  selection,
  binding,
  ...turn
}) => {
  if (!binding?.managedMcp?.sessionUrl || !binding.turnCapability)
    return undefined;
  const resolved = agentRuntimeBindingRegistry.resolveIdentity(
    binding.bindingReference,
  );
  const source = resolved.ok ? resolved.binding.actorSource : undefined;
  if (!source) return undefined;
  /** 元の Session、プロバイダー、ターン権限から、現在許可されている実行を取得する。 */
  const admit = () =>
    providerAgentRuntimeTurns.admit({
      actorSessionId: source.sessionId,
      providerId: binding.providerId,
      turnCapability: binding.turnCapability,
    });
  const active = admit();
  if (!active.ok) return undefined;
  const settingsRevision = approvalReviewSettingsRevision;
  /** 承認レビュー開始時と同じ実行ハンドル、バインディング、設定世代が有効なことを確認する。 */
  const policyCurrent = () => {
    const current = admit();
    return (
      approvalReviewSettingsRevision === settingsRevision &&
      current.ok &&
      current.handle === active.handle &&
      agentRuntimeBindingRegistry.resolveIdentity(binding.bindingReference).ok
    );
  };
  return new WithMateApprovalReviewTurn({
    ...turn,
    inputs: approvalReviewInputs,
    source:
      source.kind === "main"
        ? source
        : {
            kind: "auxiliary",
            sessionId: source.sessionId,
            incarnationId: source.incarnationId,
            mainSessionId: source.parent.sessionId,
            mainIncarnationId: source.parent.incarnationId,
          },
    policyCurrent,
    /** 選択したレビュアーの利用可否とモデル・推論深度を現行設定で確認し、失効していない場合だけアダプターを開く。 */
    open: async (signal) => {
      const settings = await requireAppSettingsStorage().getSettings();
      const current = settings.withMateAutoReview;
      if (
        !policyCurrent() ||
        !getProviderAppSettings(settings, selection.providerId).enabled ||
        current?.providerId !== selection.providerId ||
        current.model !== selection.model ||
        current.reasoningEffort !== selection.reasoningEffort
      ) {
        throw new Error("Approval reviewer settings are not current.");
      }
      assertModelEnabled(
        settings.modelAvailability,
        selection.providerId,
        selection.model,
      );
      const { provider } = await resolveProviderCatalog(
        selection.providerId,
        turn.workspacePath,
      );
      const model = provider.models.find(({ id }) => id === selection.model);
      if (
        provider.id !== selection.providerId ||
        !model ||
        (model.reasoningEfforts.length
          ? !selection.reasoningEffort ||
            !model.reasoningEfforts.includes(selection.reasoningEffort)
          : selection.reasoningEffort !== "")
      )
        throw new Error("Review model or depth is unavailable.");
      signal.throwIfAborted();
      if (!policyCurrent())
        throw new Error("Approval reviewer settings are not current.");
      return approvalReviewAdapters[selection.providerId]({
        selection,
        binding,
        workspacePath: turn.workspacePath,
        appSettings: settings,
        signal,
      });
    },
  });
};

/** 実行中の Main または Auxiliary の保存済み識別情報に限り、ツールの権限を発行する。 */
async function issueProviderAgentRuntimeBinding(
  session: Pick<
    Session,
    "id" | "incarnationId" | "characterId" | "sessionKind" | "workspacePath"
  >,
  providerId: string,
  actorSource: AgentRuntimeSourceRef = {
    kind: "main",
    sessionId: session.id,
    incarnationId: getSessionIncarnationId(session),
  },
) {
  const owner = requireActivePersistentStoreOwnerForFactory(
    "Provider runtime binding",
  );
  let glossaryAuthority: ReturnType<
    typeof projectGlossaryCheckoutAuthority
  > | null = null;
  try {
    glossaryAuthority = projectGlossaryCheckoutAuthority(
      await glossaryApplicationService.resolvePrimaryCheckout(
        session.workspacePath,
      ),
    );
  } catch {
    // Git で管理されていないワークスペースには用語集の権限を付与しない。
  }
  // チェックアウトの検査後に保存された送信元を解決し、置き換えられた Session は拒否する。
  assertPersistentStoreOwnerIsActive(owner, "Provider runtime binding");
  const auxiliary =
    actorSource.kind === "auxiliary"
      ? await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
          session.id,
        )
      : null;
  if (
    actorSource.kind === "auxiliary" &&
    (!auxiliary ||
      auxiliary.createdAt !== actorSource.incarnationId ||
      auxiliary.parentSessionId !== actorSource.parent.sessionId)
  ) {
    throw new Error(
      "Provider runtime binding requires the current saved Auxiliary Session identity.",
    );
  }
  const main = await owner.sessionStorage.getSessionSummary?.(
    auxiliary?.parentSessionId ?? session.id,
  );
  assertPersistentStoreOwnerIsActive(owner, "Provider runtime binding");
  if (databaseMaintenanceRequested)
    throw new Error(
      "Provider runtime binding is unavailable during database maintenance.",
    );
  if (!main)
    throw new Error(
      "Provider runtime binding requires a saved Main Session identity.",
    );
  const mainIncarnationId = getSessionIncarnationId(main);
  if (
    mainIncarnationId !==
    (actorSource.kind === "main"
      ? actorSource.incarnationId
      : actorSource.parent.incarnationId)
  ) {
    throw new Error(
      "Provider runtime binding requires the current saved Main Session incarnation.",
    );
  }
  const sessionIdentity = auxiliary
    ? {
        kind: "auxiliary" as const,
        sessionId: auxiliary.id,
        incarnationId: auxiliary.createdAt,
        mainSessionId: main.id,
        mainIncarnationId,
      }
    : {
        kind: "main" as const,
        sessionId: main.id,
        incarnationId: mainIncarnationId,
      };
  const binding = agentRuntimeBindingRegistry.issueOrReuse({
    actorSessionId: session.id,
    actorSource,
    providerId,
    authoritySnapshot: {
      userId: "local-user",
      characterId: session.characterId,
      sessionKind: session.sessionKind,
      sessionIdentity,
      sessionWorkspacePath: session.workspacePath,
      ...(glossaryAuthority
        ? { glossaryPrimaryCheckout: glossaryAuthority }
        : {}),
    },
    operationGrants: [
      ...getSessionAgentRuntimeOperations(),
      ...(glossaryAuthority ? getGlossaryAgentRuntimeOperations() : []),
    ],
  });
  return agentRuntimeApi
    ? {
        ...binding,
        runtimeOwner: {
          applicationInstanceId: agentRuntimeApi.applicationInstanceId,
          runtimeGenerationId: agentRuntimeApi.runtimeGenerationId,
        },
      }
    : binding;
}

/** プロセス内で一つだけ Agent ランタイム API を起動する。失敗は起動全体を止めず警告に残す。 */
async function startAgentRuntimeApiBestEffort(): Promise<void> {
  if (agentRuntimeApi) return;
  try {
    agentRuntimeApi = await startAgentRuntimeApi({
      applicationInstanceId,
      buildChannel: runtimeBuildChannel,
      processStartedAt,
      agentRuntimeBindingRegistry,
      providerAgentRuntimeTurns,
      /** Session 管理で扱わない拡張リクエストを Glossary のルーターへ渡す。 */
      routeAgentRuntimeExtension: async (request) =>
        (await sessionManagementRuntimeService.route(request)) ??
        glossaryRuntimeService.route(request),
    });
  } catch (error) {
    writeAppLog({
      level: "warn",
      kind: "agent-runtime.start-failed",
      process: "main",
      message: "Agent tool runtime did not start",
      error: appLogService.errorToLogError(error),
    });
  }
}

/** API の現行参照を先に外してから停止し、後処理の失敗を警告に残す。 */
async function stopAgentRuntimeApiBestEffort(): Promise<void> {
  const runtime = agentRuntimeApi;
  agentRuntimeApi = null;
  if (!runtime) return;
  try {
    await runtime.stop();
  } catch (error) {
    writeAppLog({
      level: "warn",
      kind: "agent-runtime.stop-failed",
      process: "main",
      message: "Agent tool runtime cleanup failed",
      error: appLogService.errorToLogError(error),
    });
  }
}

/** 設定済みプロバイダーへ同梱 Glossary スキルを同期し、失敗や既存スキルとの衝突をログに記録する。 */
async function syncManagedGlossarySkillBestEffort(): Promise<void> {
  try {
    const results =
      await requireManagedSkillDistributionService().syncConfiguredProviderSkills(
        MANAGED_GLOSSARY_SKILL_BUNDLE,
      );
    const failed = results.filter((result) => result.status === "failed");
    const collisions = results.filter(
      (result) => result.status === "skipped-collision",
    );
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

/** ディレクトリがなければ作成して OS で開き、起動に失敗した場合は例外を返す。 */
async function openDirectory(directoryPath: string): Promise<void> {
  mkdirSync(directoryPath, { recursive: true });
  const result = await openLocalPath(directoryPath);
  if (result.status !== "opened") {
    throw new Error(result.message);
  }
}

/** トレイが初めて必要になった時点で作成し、以降は同じサービスを使う。 */
function requireAppTrayService(): AppTrayService {
  if (!appTrayService) {
    appTrayService = new AppTrayService({
      platform: process.platform,
      iconPath: trayIconPath,
      /** 指定したアイコンで Electron のトレイを作成する。 */
      createTray: (iconPath) => new Tray(iconPath),
      /** トレイの項目をネイティブメニューに変換する。 */
      buildMenu: (items) => Menu.buildFromTemplate(items),
      openHomeWindow: createHomeWindow,
      /** トレイから通常のアプリ終了経路を開始する。 */
      quitApp: () => {
        app.quit();
      },
    });
  }
  return appTrayService;
}

/** 最新の起動状態を保持し、既に開いている起動 Window にも配信する。 */
function publishAppBootStatus(status: AppBootStatus): void {
  appBootStatus = status;
  mainWindowComposition.publishBootStatus(status);
}

/** 現在の起動状態を初期値として使う起動 Window を開く。 */
async function openBootWindow(): Promise<BrowserWindow> {
  return mainWindowComposition.openBootWindow(() => appBootStatus);
}

/** 起動専用の状態表示 Window を閉じる。 */
function closeBootWindow(): void {
  mainWindowComposition.closeBootWindow();
}

/** 起動時の例外を renderer に渡せる形にし、Error では名前とスタックも残す。 */
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

/** 現行ストア世代のインメモリ Session 一覧を返す。 */
function listSessions(): Session[] {
  return mainStoreContext.sessions;
}

/** Home のページを永続データから読み、実行中の取消状態と承認待ちの有無を各項目に重ねる。 */
async function listSessionSummaryPage(
  request?: SessionSummaryPageRequest | null,
): Promise<HomeSessionSummaryPageResult> {
  const page = await requireMainQueryService().listSessionSummaryPage(request);
  return {
    ...page,
    entries: page.entries.map((summary) => {
      const status = projectLiveSessionRunStatus(getLiveSessionRun(summary.id));
      return {
        ...summary,
        cancellationState: status?.cancellationState,
        approvalPending: status?.approvalPending ?? false,
      };
    }),
  };
}

/** キャラクターの利用状況を Session の読み取りサービスから取得する。 */
async function listSessionCharacterUsage(): Promise<SessionCharacterUsage[]> {
  return requireMainQueryService().listSessionCharacterUsage();
}

/** メンテナンス向けに保存済みの Session 本体を読み、一覧取得後に見つからなくなった項目を除く。 */
async function listFullStoredSessionsForMaintenance(): Promise<Session[]> {
  const storage = requireSessionStorage();
  const summaries = await storage.listSessionSummaries();
  const sessions = await Promise.all(
    summaries.map((summary) => storage.getSession(summary.id)),
  );
  return sessions.filter((session): session is Session => session !== null);
}

/** ステータスと実行状態のいずれかが実行中を示す Session を判定する。 */
function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

/** 通常・Auxiliary ランタイムと直接追跡している Auxiliary のいずれかに進行中の実行があるか調べる。 */
function hasInFlightSessionRuns(): boolean {
  return (
    auxiliaryRunParents.size > 0 ||
    Boolean(sessionRuntimeService?.hasInFlightRuns()) ||
    Boolean(auxiliarySessionRuntimeService?.hasInFlightRuns())
  );
}

/** 通常と Auxiliary の両ランタイムへ進行中の実行の取消を要求する。 */
function cancelInFlightSessionRuns(): void {
  sessionRuntimeService?.cancelAllRuns();
  auxiliarySessionRuntimeService?.cancelAllRuns();
}

/** 永続世代とプロバイダーの利用可否を検査し、停止処理や設定変更とターン受付を調整する。 */
async function runSessionTurnAdmission<T>(
  sessionId: string,
  auxiliary: boolean,
  operation: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const owner = requireActivePersistentStoreOwnerForFactory("Turn admission");
  return admitSessionTurn({
    /** ターン受付をプロバイダー操作の排他区間に置く。 */
    runExclusive: (callback) =>
      providerRuntimeOperationCoordinator.runExclusive(
        callback,
        "session-turn-admission",
      ),
    /** 対象ストアの切替、取消、終了要求、DB メンテナンスがあれば新規ターンを拒否する。 */
    assertCurrent: () => {
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      if (signal.aborted) throw new Error("Session run canceled.");
      if (mainWindowRuntime.getSessionWindowBridge().isQuitPending()) {
        throw new Error(
          "The app is quitting, so a new message cannot be sent.",
        );
      }
      if (databaseMaintenanceRequested) {
        throw new Error(
          "A database maintenance operation is in progress, so a new turn cannot start.",
        );
      }
    },
    reserve: operation,
    /** 現行の保存情報からプロバイダーを読み出し、Auxiliary の場合は親の存在も確認する。 */
    readProvider: async () => {
      const session = auxiliary
        ? await owner.auxiliarySessionStorage.getAuxiliarySessionMetadata(
            sessionId,
          )
        : await getRuntimeSession(sessionId);
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      if (!session) {
        throw new Error("The session could not be found.");
      }
      if (
        "createdAt" in session &&
        !(await owner.sessionStorage.getSessionSummary?.(
          session.parentSessionId,
        ))
      ) {
        throw new Error("The Auxiliary parent session could not be found.");
      }
      assertPersistentStoreOwnerIsActive(owner, "Turn admission");
      return session.provider;
    },
    /** ターン開始時に対象プロバイダーが設定上利用できることを確認する。 */
    assertProviderAvailable: (provider) =>
      requireSettingsCatalogService().assertProviderAvailableForTurn(provider),
  });
}

const auxiliaryRunParents = new Map<string, { parentSessionId: string }>();
const auxiliaryLiveRunParents = new AuxiliaryLiveRunParents({
  /** Auxiliary 実行追跡が参照すべき現在の永続世代を返す。 */
  getStorageOwner: () => mainStoreContext.activePersistentStoreOwner,
  /** 直接追跡中またはランタイムで稼働中の Auxiliary 実行を検出する。 */
  isRunPending: (sessionId) =>
    auxiliaryRunParents.has(sessionId) ||
    Boolean(auxiliarySessionRuntimeService?.isRunInFlight(sessionId)),
  /** 監視サービスに既に公開済みの実行状態があるか調べる。 */
  hasLiveSessionRun: (sessionId) =>
    Boolean(sessionObservabilityService?.getLiveSessionRun(sessionId)),
  /** 承認待ちや取消中も親をモニターに残し、Auxiliary の実行更新を Window へ配信する。 */
  broadcastLiveSessionRun: (sessionId, state) => {
    const status = projectLiveSessionRunStatus(state);
    if (
      status?.runState === "running" ||
      status?.cancellationState ||
      status?.approvalPending
    ) {
      requireSessionWindowBridge().retainSessionForMonitor(
        auxiliaryLiveRunParents.get(sessionId) ??
          auxiliaryRunParents.get(sessionId)?.parentSessionId ??
          sessionId,
      );
    }
    requireWindowBroadcastService().broadcastLiveSessionRun(sessionId, state);
  },
});
let databaseMaintenanceRequested = false;
let sessionFolderCleanupLoadedSessions: readonly Session[] | null = null;
const sessionFolderCleanupService = new SessionFolderCleanupService({
  writeLog: writeAppLog,
  /** Session Folder を解決するため、Electron が現在使用しているデータルートを返す。 */
  get userDataPath() {
    return app.getPath("userData");
  },
  /** クリーンアップ候補の判定に使う保存済み概要と現行世代を取り、比較用のインメモリ一覧も保持する。 */
  readState: async () => {
    const owner = requireActivePersistentStoreOwnerForFactory(
      "Session Folder cleanup",
    );
    sessionFolderCleanupLoadedSessions = mainStoreContext.sessions;
    const sessions = await owner.sessionStorage.listSessionSummaries();
    assertPersistentStoreOwnerIsActive(owner, "Session Folder cleanup");
    return { identity: owner, sessions };
  },
  /** 走査時と同じ永続世代・Session 一覧かを確認し、メンテナンス中や終了中の削除を拒否する。 */
  assertCurrent: (identity) => {
    assertPersistentStoreOwnerIsActive(
      identity as PersistentStoreBundle,
      "Session Folder cleanup",
    );
    if (sessionFolderCleanupLoadedSessions !== mainStoreContext.sessions) {
      throw new Error(
        "Session state has changed. Scan again before deleting files.",
      );
    }
    if (
      databaseMaintenanceRequested ||
      mainWindowRuntime.getSessionWindowBridge().isQuitPending()
    ) {
      throw new Error(
        "Session Folder cleanup is unavailable during maintenance or shutdown.",
      );
    }
  },
  /** ランタイム側とインメモリ側のどちらから見ても実行中の Session を削除対象から外す。 */
  isRunning: (sessionId) =>
    isSessionRunInFlight(sessionId) ||
    mainStoreContext.sessions.some(
      (session) => session.id === sessionId && isRunningSession(session),
    ),
});
/** 名前付きの処理に現在の永続世代を渡し、ストアを利用できなければ例外を返す。 */
function requireActivePersistentStoreOwnerForFactory(
  ownerName: string,
): PersistentStoreBundle {
  return capturePersistentStoreOwner(
    () => mainStoreContext.activePersistentStoreOwner,
    ownerName,
  ).owner;
}

/** 非同期操作中に永続データの所有者が切り替わっていないことを確認する。 */
function assertPersistentStoreOwnerIsActive(
  owner: PersistentStoreBundle,
  operation: string,
): void {
  assertPersistentStoreOwnerActive(
    () => mainStoreContext.activePersistentStoreOwner,
    owner,
    operation,
  );
}

/** 信頼された GUI、認証済み Agent、または Turn の対象について指示本文を読み取る。 */
async function getSessionInstructions(
  target: SessionInstructionsTarget,
  owner = requireActivePersistentStoreOwnerForFactory("Session instructions"),
): Promise<string> {
  assertPersistentStoreOwnerIsActive(owner, "Session instructions");
  const worker = owner.storageWorker;
  // ストレージを利用できない状態を、保存済みの空の本文として扱わない。
  if (!worker || databaseMaintenanceRequested)
    throw new Error("Session instructions storage is unavailable.");
  const body = await worker.stores.instructions.get(target);
  assertPersistentStoreOwnerIsActive(owner, "Session instructions");
  // null は保存済みの識別情報に完全一致する対象が存在しなくなったことを示す。
  if (body === null)
    throw new SessionManagementError(
      "SESSION_REPLACED",
      "The Session was replaced or deleted.",
    );
  return body;
}

/** 実行オプション、活動、履歴を書き換えず、指示本文だけを置き換える。 */
async function setSessionInstructions(
  target: SessionInstructionsTarget,
  body: string,
): Promise<{ byteLength: number }> {
  const owner = requireActivePersistentStoreOwnerForFactory(
    "Session instructions",
  );
  const worker = owner.storageWorker;
  // 置き換えを確定できるのは有効な Worker だけ。
  if (!worker || databaseMaintenanceRequested)
    throw new Error("Session instructions storage is unavailable.");
  const result = await worker.stores.instructions.set(target, body);
  // 識別情報が完全一致しなかったため、更新された行はない。
  if (!result)
    throw new SessionManagementError(
      "SESSION_REPLACED",
      "The Session was replaced or deleted.",
    );
  return result;
}

/** 対象自身の稼働を判定し、指定範囲に応じて配下の Auxiliary 実行も含める。 */
function isSessionRunInFlight(
  sessionId: string,
  scope: "self" | "with-auxiliary" = "with-auxiliary",
): boolean {
  if (
    sessionRuntimeService?.isRunInFlight(sessionId) ||
    auxiliarySessionRuntimeService?.isRunInFlight(sessionId) ||
    auxiliaryRunParents.has(sessionId)
  ) {
    return true;
  }
  return (
    scope === "with-auxiliary" &&
    ([...auxiliaryRunParents.values()].some(
      (run) => run.parentSessionId === sessionId,
    ) ||
      auxiliaryLiveRunParents.hasPendingRunForParent(sessionId))
  );
}

/** Home から閉じる際に提示すべき実行の識別情報を集め、稼働中なのに特定できなければ閉じる処理を進めさせない。 */
function getHomeCrewCloseRunIdentities(sessionId: string): object[] {
  const runs = readHomeCrewCloseRunIdentities(sessionId, {
    mainRuntime: sessionRuntimeService,
    auxiliaryRuntime: auxiliarySessionRuntimeService,
    directAuxiliaryRuns: auxiliaryRunParents,
    liveAuxiliaryParents: auxiliaryLiveRunParents,
  });
  if (!runs.length && isSessionRunInFlight(sessionId))
    throw new Error("Session Window run identity is unavailable.");
  return runs;
}

/** 候補の親 ID から、直接追跡中の Auxiliary 実行を持つ親だけを選ぶ。 */
function listRunningActiveAuxiliaryParentSessionIds(
  parentSessionIds: readonly string[],
): Set<string> {
  const runningParentSessionIds = new Set<string>();
  if (!mainStoreContext.auxiliarySessionStorage) {
    return runningParentSessionIds;
  }

  for (const parentSessionId of parentSessionIds) {
    const hasRunningAuxiliary = [...auxiliaryRunParents.values()].some(
      (run) => run.parentSessionId === parentSessionId,
    );
    if (hasRunningAuxiliary) {
      runningParentSessionIds.add(parentSessionId);
    }
  }

  return runningParentSessionIds;
}

/** ストアの起動・終了とアプリ初期化を組み立てるレジストリを遅延初期化する。 */
function requireMainInfrastructureRegistry(): MainInfrastructureRegistry<
  PersistentStoreLifecycleService,
  MainBootstrapService
> {
  if (!mainInfrastructureRegistry) {
    mainInfrastructureRegistry = new MainInfrastructureRegistry({
      /** 永続世代ごとの Worker とストアの生成・破棄処理を組み立てる。 */
      createPersistentStoreLifecycleService: () =>
        new PersistentStoreLifecycleService({
          /** Main のストレージ診断を受け取る V6 Worker バンドルを作る。 */
          createV6StorageWorker: (input) =>
            createV6StorageWorkerBundle({
              ...input,
              diagnosticSink: logStorageOperationDiagnostic,
            }),
          /** 指定 DB からモデルカタログを扱うストアを構成する。 */
          createModelCatalogStorage: (nextDbPath) =>
            new ModelCatalogStorage(nextDbPath),
          /** 指定 DB とユーザーデータのルートを Character ストアへ渡す。 */
          createCharacterStorage: (nextDbPath, nextUserDataPath) =>
            new CharacterStorage(nextDbPath, nextUserDataPath),
          /** 指定 DB に紐づく通常 Session ストアを作成する。 */
          createSessionStorage: (nextDbPath) => new SessionStorage(nextDbPath),
          /** 指定 DB に紐づく Auxiliary Session ストアを作成する。 */
          createAuxiliarySessionStorage: (nextDbPath) =>
            new AuxiliarySessionStorage(nextDbPath),
          /** 指定 DB に紐づくアプリ設定ストアを作成する。 */
          createAppSettingsStorage: (nextDbPath) =>
            new AppSettingsStorage(nextDbPath),
          /** 指定 DB とユーザーデータのルートを Mate ストアへ渡す。 */
          createMateStorage: (nextDbPath, nextUserDataPath) =>
            new MateStorage(nextDbPath, nextUserDataPath),
          /** V2 のスキーマ文を対象 DB に適用し、成功・失敗にかかわらず接続を閉じる。 */
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
          /** V3 のスキーマ文を対象 DB に適用し、処理後に接続を解放する。 */
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
          /** 対象 DB を V6 のスキーマに揃え、処理後に接続を解放する。 */
          ensureV6Schema: (nextDbPath) => {
            const db = openAppDatabase(nextDbPath);
            try {
              ensureV6Schema(db);
            } finally {
              db.close();
            }
          },
          /** 永続世代を閉じる前に、承認・質問の状態をリセットし、実行監視を破棄する。 */
          onBeforeClose: () => {
            sessionApprovalService?.reset();
            sessionElicitationService?.reset();
            sessionObservabilityService?.dispose();
          },
          truncateWal: truncateAppDatabaseWal,
          /** ストアの後処理で指定されたファイルを、既に存在しなくても削除済みとして扱う。 */
          async removeFile(filePath) {
            await rm(filePath, { force: true });
          },
          /** ストアの後処理で指定されたディレクトリとその中身を削除する。 */
          async removeDirectory(directoryPath) {
            await rm(directoryPath, { recursive: true, force: true });
          },
        }),
      /** Main の IPC と起動時依存を配線するブートストラップサービスを作成する。 */
      createMainBootstrapService: () =>
        new MainBootstrapService(
          createMainBootstrapDeps({
            ipcMain,
            /** 共通の IPC に加えて PR・Session・Coordination 固有の Window ハンドラーを登録する。 */
            registerMainIpcHandlers: (ipc, deps) => {
              registerMainIpcHandlers(ipc, deps);
              localPrWindowService.register(ipc);
              registerSessionRoleHandlers(ipc, {
                /** Role 操作の IPC 送信元を Electron Window に対応付ける。 */
                resolveEventWindow: (event) =>
                  BrowserWindow.fromWebContents(event.sender),
                /** Role 操作の対象 ID に対応する所有 Window を取得する。 */
                resolveSessionWindow: (sessionId) =>
                  requireSessionWindowBridge().getWindow(sessionId),
                /** 対象 incarnation と現行性の検査を渡し、全体統括への昇格を Session command に委譲する。 */
                promoteSessionToOverallCoordinator: (
                  id,
                  incarnationId,
                  assertCurrent,
                ) =>
                  requireMainSessionCommandFacade().promoteSessionToOverallCoordinator(
                    id,
                    incarnationId,
                    assertCurrent,
                  ),
              });
              registerSessionCrewHandlers(ipc, {
                /** Crew 操作が対象 Session を所有する Window から届いたことを検証する。 */
                assertOwningSessionWindowSender: (event, sessionId) =>
                  assertOwningSessionWindowSender(event, sessionId, {
                    /** Crew 操作を送った WebContents を Window に変換する。 */
                    resolveEventWindow: (entry) =>
                      BrowserWindow.fromWebContents(entry.sender),
                    /** Crew 操作の所有権照合に使う Session Window を取得する。 */
                    resolveSessionWindow: (id) =>
                      requireSessionWindowBridge().getWindow(id),
                  }),
                /** 指定した Session の incarnation に対する Crew 削除の可否情報を読み取る。 */
                getCrewDeletionStatus: (id, incarnationId) =>
                  requireMainSessionCommandFacade().getCrewDeletionStatus(
                    id,
                    incarnationId,
                  ),
              });
              registerSessionExecutionHandlers(ipc, {
                /** 実行照会の送信元 WebContents に対応する Window を取得する。 */
                resolveEventWindow: (event) =>
                  BrowserWindow.fromWebContents(event.sender),
                /** 実行照会の対象 Session を表示する Window を検索する。 */
                resolveSessionWindow: (sessionId) =>
                  requireSessionWindowBridge().getWindow(sessionId),
                hasUnreadResult,
                /** GUI の実行照会を有効な Worker に委ね、応答前にも永続世代を確認する。 */
                readExecution: async (input) => {
                  const owner =
                    requireActivePersistentStoreOwnerForFactory(
                      "GUI execution read",
                    );
                  if (!owner.storageWorker || databaseMaintenanceRequested)
                    throw new Error(
                      "Saved Session execution storage is unavailable.",
                    );
                  const result =
                    await owner.storageWorker.stores.execution.execute(input);
                  assertPersistentStoreOwnerIsActive(
                    owner,
                    "GUI execution read",
                  );
                  return result;
                },
              });
              registerCoordinationHandlers(ipc, {
                service: coordinationApplicationService,
                /** Coordination の状態を現在の Worker で問い合わせ、処理後の世代切替も検出する。 */
                readStatus: async (id) => {
                  const owner = requireActivePersistentStoreOwnerForFactory(
                    "Coordination status",
                  );
                  if (!owner.storageWorker || databaseMaintenanceRequested)
                    throw new Error("Coordination storage is unavailable.");
                  try {
                    return await owner.storageWorker.stores.coordination.readStatus(
                      id,
                    );
                  } finally {
                    assertPersistentStoreOwnerIsActive(
                      owner,
                      "Coordination status",
                    );
                  }
                },
                /** 現在の incarnation に合う保存情報から Coordination に表示するタイトル、名前、アイコンを解決する。 */
                resolveIdentity: async (identity) => {
                  const owner = requireActivePersistentStoreOwnerForFactory(
                    "Coordination display identity",
                  );
                  if (!owner.sessionStorage.getSessionMetadata)
                    throw new Error("Session metadata reads are unavailable.");
                  const auxiliary =
                    identity.kind === "auxiliary"
                      ? await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
                          identity.sessionId,
                        )
                      : null;
                  assertPersistentStoreOwnerIsActive(
                    owner,
                    "Coordination display identity",
                  );
                  if (
                    identity.kind === "auxiliary" &&
                    (!auxiliary ||
                      auxiliary.createdAt !== identity.incarnationId)
                  )
                    return null;
                  const metadata =
                    await owner.sessionStorage.getSessionMetadata(
                      auxiliary?.parentSessionId ?? identity.sessionId,
                    );
                  assertPersistentStoreOwnerIsActive(
                    owner,
                    "Coordination display identity",
                  );
                  if (
                    !metadata ||
                    (identity.kind === "main" &&
                      getSessionIncarnationId(metadata.summary) !==
                        identity.incarnationId)
                  )
                    return null;
                  const snapshot =
                    auxiliary?.characterRuntimeSnapshot ??
                    metadata.characterRuntimeSnapshot;
                  return {
                    title: auxiliary
                      ? auxiliary.title
                      : metadata.summary.taskTitle,
                    character: {
                      name: snapshot?.name ?? metadata.summary.character,
                      iconPath:
                        auxiliary?.characterIconPath ??
                        snapshot?.iconFilePath ??
                        metadata.summary.characterIconPath,
                    },
                  };
                },
                /** Coordination の送信元 WebContents が属する Window を取得する。 */
                resolveWindow: (sender) =>
                  BrowserWindow.fromWebContents(sender),
                /** Coordination の照会元を Home、Session モニター、登録済み Session Window に限定する。 */
                isTrustedWindow: (window) =>
                  window === requireAuxWindowService().getHomeWindow() ||
                  requireMainWindowFacade().isSessionMonitorWindow(window) ||
                  listOpenSessionWindowIds().some(
                    (id) =>
                      requireSessionWindowBridge().getWindow(id) === window,
                  ),
                /** Coordination の配信先候補として Electron が把握する Window 一覧を渡す。 */
                allWindows: () => BrowserWindow.getAllWindows(),
                /** Coordination の書き込みを、対象の開始者または応答者を所有する Session Window に限定する。 */
                authorizeRequest: async (window, request) => {
                  if (
                    request.operation === "list" ||
                    request.operation === "get"
                  )
                    return;
                  const sessionId = listOpenSessionWindowIds().find(
                    (id) =>
                      requireSessionWindowBridge().getWindow(id) === window,
                  );
                  if (!sessionId || !("id" in request))
                    throw new Error(
                      "Coordination writes require the owning Session window.",
                    );
                  const result =
                    await coordinationApplicationService.executeUser(
                      { operation: "get", id: request.id },
                      () =>
                        !window.isDestroyed() &&
                        requireSessionWindowBridge().getWindow(sessionId) ===
                          window,
                    );
                  if (!("record" in result))
                    throw new Error("The Coordination record is unavailable.");
                  const owner = requireActivePersistentStoreOwnerForFactory(
                    "Coordination window authorization",
                  );
                  const identities = [
                    result.record.initiator,
                    result.record.respondent,
                  ].filter((identity) => identity.kind !== "user");
                  for (const identity of identities) {
                    if (identity.kind === "main") {
                      const main =
                        await owner.sessionStorage.getSessionSummary?.(
                          identity.sessionId,
                        );
                      assertPersistentStoreOwnerIsActive(
                        owner,
                        "Coordination window authorization",
                      );
                      if (
                        main?.id === sessionId &&
                        getSessionIncarnationId(main) === identity.incarnationId
                      )
                        return;
                    } else {
                      const auxiliary =
                        await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
                          identity.sessionId,
                        );
                      assertPersistentStoreOwnerIsActive(
                        owner,
                        "Coordination window authorization",
                      );
                      if (
                        auxiliary?.parentSessionId === sessionId &&
                        auxiliary.createdAt === identity.incarnationId
                      )
                        return;
                    }
                  }
                  throw new Error(
                    "This Session window does not own the Coordination initiator or respondent.",
                  );
                },
                /** 保存時の incarnation が現在も一致する場合だけ、対象 Session または親から Auxiliary を開く。 */
                open: async (request) => {
                  const owner = requireActivePersistentStoreOwnerForFactory(
                    "Coordination navigation",
                  );
                  if (request.kind === "main") {
                    const summary =
                      await owner.sessionStorage.getSessionSummary?.(
                        request.sessionId,
                      );
                    assertPersistentStoreOwnerIsActive(
                      owner,
                      "Coordination navigation",
                    );
                    if (
                      !summary ||
                      getSessionIncarnationId(summary) !== request.incarnationId
                    )
                      throw new Error(
                        "The Coordination Main Session was replaced or deleted.",
                      );
                    return openSessionWindow(summary.id);
                  }
                  const auxiliary =
                    await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
                      request.sessionId,
                    );
                  const parent = auxiliary
                    ? await owner.sessionStorage.getSessionSummary?.(
                        auxiliary.parentSessionId,
                      )
                    : null;
                  assertPersistentStoreOwnerIsActive(
                    owner,
                    "Coordination navigation",
                  );
                  if (
                    !auxiliary ||
                    auxiliary.createdAt !== request.incarnationId ||
                    !parent
                  )
                    throw new Error(
                      "The Coordination Auxiliary Session was replaced or deleted.",
                    );
                  return openSessionWindow(parent.id, auxiliary.id);
                },
              });
              if (!terminalService)
                throw new Error("Terminal service is unavailable.");
              registerTerminalHandlers(ipc, terminalService);
              registerHtmlPreviewHandlers(ipc, {
                authorization: deps.sessionQuery,
                /** 既存のファイル参照またはアクセス確認後のローカルファイルから、HTML プレビュー用リソースを作る。 */
                resolveResources: async (source) => {
                  const explorer = createSessionFileExplorerService();
                  if (source.kind === "resource") {
                    return createHtmlPreviewResources(
                      explorer,
                      createFileRootGitChangesService(),
                      source.resource,
                    );
                  }
                  const resolved = await explorer.resolvePreviewTarget(
                    source.request.sessionId,
                    source.request.target,
                    source.request.baseResource,
                  );
                  if (resolved.type !== "file")
                    throw new Error("HTML preview requires a local HTML file.");
                  return createHtmlPreviewResources(
                    explorer,
                    createFileRootGitChangesService(),
                    resolved.resource,
                  );
                },
              });
            },
            initializePersistentStores,
            /** 中断した Session の復旧処理に、Agent API の起動処理を渡す。 */
            recoverInterruptedSessions: () =>
              recoverInterruptedSessions(startAgentRuntimeApiBestEffort),
            /** 起動時にモデル候補を非同期で取得・配信し、失敗はログで知らせる。 */
            broadcastModelCatalog: () => {
              void getModelCatalog()
                .then(broadcastModelCatalog)
                .catch((error: unknown) =>
                  writeAppLog({
                    level: "warn",
                    kind: "model.discovery.bootstrap-failed",
                    process: "main",
                    message: "Model choices could not be loaded",
                    error: appLogService.errorToLogError(error),
                  }),
                );
            },
            onBootStatus: publishAppBootStatus,
            ipcRegistration: {
              sessionInstructions: {
                /** Session の incarnation とストレージ世代が一致する Window を指示編集の所有者として返す。 */
                resolveOwningSessionWindow: (sessionId, incarnationId) => {
                  const bridge = requireSessionWindowBridge();
                  const window = bridge.getWindow(sessionId);
                  // 置き換えられたデータベース世代のウィンドウが残っていても、所有者ではない。
                  return window &&
                    bridge.getWindowIncarnation(window) === incarnationId &&
                    bridge.getWindowStorageGeneration(window) ===
                      mainStoreContext.storageWorker
                    ? window
                    : null;
                },
                /** 指示表示 IPC に、対象識別情報で解決した指示本文を返す。 */
                getSessionInstructions: (target) =>
                  getSessionInstructions(target),
                /** GUI から受け取った指示本文を検証してから保存する。 */
                setSessionInstructions: (target, body) =>
                  setSessionInstructions(
                    target,
                    validateSessionInstructions(body),
                  ),
              },
              window: {
                /** 下書き保存の要求 ID、返信元、成否を Window ブリッジに渡す。 */
                acknowledgeSessionDraftFlush: (event, payload) => {
                  requireSessionWindowBridge().acknowledgeDraftFlush(
                    payload.requestId,
                    event.sender,
                    payload.success,
                  );
                },
                /** 一般 Window IPC の送信元 WebContents から対応 Window を取得する。 */
                resolveEventWindow: (event) =>
                  BrowserWindow.fromWebContents(event.sender) ?? null,
                /** 一般 Window IPC の照合に現在の Home Window を渡す。 */
                resolveHomeWindow: () =>
                  requireAuxWindowService().getHomeWindow(),
                /** 一般 Window IPC が指定した Session の所有 Window を検索する。 */
                resolveSessionWindow: (sessionId) =>
                  requireSessionWindowBridge().getWindow(sessionId),
                openSessionWindow,
                /** 開いている Window と保存済みの Crew 構成を現行世代のページとして照会する。 */
                listHomeCrewPage: (request) => {
                  const owner =
                    requireActivePersistentStoreOwnerForFactory("Home Crew");
                  return readHomeCrewPage(
                    {
                      /** 保存世代と Crew 表示の改訂番号を組み合わせ、ページの継続可否を判定できる値を返す。 */
                      getGeneration: () => {
                        assertPersistentStoreOwnerIsActive(owner, "Home Crew");
                        return `${owner.storageWorker?.client.generationId ?? "legacy"}:${requireWindowBroadcastService().getHomeCrewRevision()}`;
                      },
                      /** Crew 一覧に投影するため、開いている Session Window の識別情報を列挙する。 */
                      listOpenSessionWindows: () =>
                        requireSessionWindowBridge().listOpenSessionWindowIdentities(),
                      /** 開いている Window を基準に、カーソル以降の Crew メンバーを指定件数まで取得する。 */
                      readMembers: async (openWindows, afterId, limit) => {
                        if (!owner.sessionStorage.listHomeCrewMembersPage)
                          throw new Error("Home Crew reads are unavailable.");
                        return owner.sessionStorage.listHomeCrewMembersPage(
                          openWindows,
                          afterId,
                          limit,
                        );
                      },
                      /** Crew の親 ID 群から配下の Auxiliary の概要をまとめて取得する。 */
                      readAuxiliarySummaries: (ids) =>
                        requireAuxiliarySessionService().listAuxiliarySessionSummaries(
                          ids,
                        ),
                      getLiveSessionRun,
                      hasUnreadResult,
                    },
                    request,
                  );
                },
                /** Home の Crew 項目に対する操作メニューを要求元 Window で開く。 */
                showHomeCrewContextMenu: (home, request) =>
                  createHomeCrewContextMenuService().show(home, request),
                /** 送信元 Window を解決して Session モニターの右クリック操作を表示する。 */
                showSessionMonitorContextMenu: (event, request) =>
                  sessionMonitorContextMenuService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                /** 保存された Session Window の復元スナップショットを取得する。 */
                getSessionWindowRestoreSet: () =>
                  requireSessionWindowRestoreService().getSnapshot(),
                /** 保存された Session Window の集合を復元する。 */
                restoreSessionWindows: () =>
                  requireSessionWindowRestoreService().restoreSnapshot(),
                openHomeWindow: createHomeWindow,
                openSessionMonitorWindow,
                openSettingsWindow,
                /** 対象が登録済み Session モニター Window か判定する。 */
                isSessionMonitorWindow: (window) =>
                  requireMainWindowFacade().isSessionMonitorWindow(window),
                /** 対象が現在の設定 Window か判定する。 */
                isSettingsWindow: (window) =>
                  requireMainWindowFacade().isSettingsWindow(window),
                openCharacterEditorWindow,
                openDiffWindow,
                /** 所有 Session の表示用概要を付け、ファイルプレビュー Window をグループごとに返す。 */
                listSessionFilePreviewWindows: async () =>
                  Promise.all(
                    requireMainWindowFacade()
                      .listFilePreviewWindows()
                      .map(async (group) => ({
                        ...group,
                        session: await getDisplaySessionSummary(
                          group.ownerSessionId,
                        ),
                      })),
                  ),
                /** ファイルプレビューを表示している送信元 Window に操作メニューを開く。 */
                showSessionFilePreviewContextMenu: (event, request) =>
                  sessionFilePreviewContextMenuService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                /** プレビュートークンに対応する Window へフォーカスを移す。 */
                focusSessionFilePreviewWindow: (token) =>
                  requireMainWindowFacade().focusFilePreviewWindow(token),
                /** 指定トークンに対応する単一のファイルプレビュー Window を閉じる。 */
                closeSessionFilePreviewWindow: (token) =>
                  requireMainWindowFacade().closeFilePreviewWindow(token),
                /** 指定 Session が所有するファイルプレビュー Window をまとめて閉じる。 */
                closeSessionFilePreviewWindows: (ownerSessionId) =>
                  requireMainWindowFacade().closeFilePreviewWindowsForOwner(
                    ownerSessionId,
                  ),
                /** ファイルプレビュー Window が指定 Session に属するか判定する。 */
                isFilePreviewWindow: (window, sessionId) =>
                  requireMainWindowFacade().isFilePreviewWindow(
                    window,
                    sessionId,
                  ),
                /** 要求元 Window と Session に紐づくプレビューの指定表現のリソースを取得する。 */
                getFilePreviewWindowResource: (
                  window,
                  sessionId,
                  representation,
                ) =>
                  requireMainWindowFacade().getFilePreviewWindowResource(
                    window,
                    sessionId,
                    representation,
                  ),
                /** 要求元 Window が指定プレビュートークンに対応するか判定する。 */
                isFilePreviewTokenWindow: (window, token) =>
                  requireMainWindowFacade().isFilePreviewTokenWindow(
                    window,
                    token,
                  ),
                /** 初期パスを指定し、要求元 Window からディレクトリ選択を開く。 */
                pickDirectory: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickDirectory(
                    targetWindow,
                    initialPath,
                  ),
                /** 入力パスがワークスペースディレクトリとして使用可能か確かめる。 */
                validateWorkspaceDirectory: (targetPath) =>
                  workspaceDirectoryValidationService.validate(targetPath),
                /** 要求元 Window に単一ファイルの選択ダイアログを開く。 */
                pickFile: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFile(
                    targetWindow,
                    initialPath,
                  ),
                /** 要求元 Window に複数ファイルの選択ダイアログを開く。 */
                pickFiles: (targetWindow, initialPath) =>
                  requireWindowDialogService().pickFiles(
                    targetWindow,
                    initialPath,
                  ),
                pickSessionFiles,
                pickSessionFolder,
                pickSessionImageFile,
                /** 用途に応じた設定で画像ファイルの選択ダイアログを開く。 */
                pickImageFile: (targetWindow, initialPath, purpose) =>
                  requireWindowDialogService().pickImageFile(
                    targetWindow,
                    initialPath,
                    purpose,
                  ),
                copyFilesToSessionFiles,
                savePastedSessionFile,
                openSessionFilesDirectory,
                openSessionFilesTerminal,
                /** 送信元プレビュー内の指定位置の画像をクリップボードへコピーする。 */
                copySessionFilePreviewImage: (event, request) =>
                  sessionFilePreviewImageCopyService.copyImage(
                    event.sender,
                    request.point,
                  ),
                /** 指定位置に画像の操作メニューを表示する。ファイル参照があれば Session ID と送信元の検査も渡す。 */
                showSessionFilePreviewImageContextMenu: (
                  event,
                  request,
                  assertSender,
                ) =>
                  sessionFilePreviewImageCopyService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    event.sender,
                    request.point,
                    request.image
                      ? {
                          request: {
                            ...request.image,
                            sessionId: request.sessionId,
                          },
                          assertSender,
                        }
                      : undefined,
                  ),
                /** Session のリソース参照を実体コピー経路へ渡す。 */
                copySessionFileObject: (_event, request) =>
                  sessionFileObjectCopyService.copyResource(request.resource),
                /** ファイル実体をコピーする操作メニューを、要求元を親にして表示する。 */
                showSessionFileObjectCopyContextMenu: (event, request) =>
                  sessionFileObjectCopyService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                /** Session のファイルツリーに対する操作メニューを要求元 Window に表示する。 */
                showSessionFileTreeContextMenu: (event, request) =>
                  sessionFileTreeContextMenuService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                /** Markdown リンクの操作候補を要求元 Window に表示する。 */
                showMarkdownLinkContextMenu: (event, request) =>
                  markdownLinkContextMenuService.showContextMenu(
                    BrowserWindow.fromWebContents(event.sender) ?? null,
                    request,
                  ),
                openPathTarget,
                /** アプリのログ保存先を作成して OS で開く。 */
                openAppLogFolder: () => openDirectory(appLogsPath),
                /** クラッシュダンプの保存先を作成して OS で開く。 */
                openCrashDumpFolder: () => openDirectory(crashDumpsPath),
                openSessionTerminal,
                openTerminalAtPath: launchTerminalAtPath,
                logIpcError: mainLogComposition.writeIpcErrorLog,
                reportRendererLog: mainLogComposition.writeRendererLog,
              },
              catalog: {
                getModelCatalog,
              },
              settings: {
                /** 実行中のアプリのバージョンを設定画面へ返す。 */
                getAppVersion: () => app.getVersion(),
                /** 設定画面に現在のアプリ設定を返す。 */
                getAppSettings: () =>
                  requireSettingsCatalogService().getAppSettings(),
                /** 承認レビュー入力と設定更新を調整し、旧設定世代で開始されたレビューを失効させる。 */
                updateAppSettings: (settings) =>
                  approvalReviewInputs.during(() => {
                    approvalReviewSettingsRevision++;
                    return requireSettingsCatalogService().updateAppSettings(
                      settings,
                    );
                  }),
                updateChatLayoutPreference,
                getAppDatabaseDiagnostics,
                /** ターン受付などと競合しない排他区間で Session Folder の候補を走査する。 */
                scanSessionFolderCleanup: (request) =>
                  providerRuntimeOperationCoordinator.runExclusive(
                    () => sessionFolderCleanupService.scan(request),
                    "session-folder-cleanup-scan",
                  ),
                /** 排他区間で指定の走査結果に基づき Session Folder をクリーンアップする。 */
                runSessionFolderCleanup: ({ scanId }) =>
                  providerRuntimeOperationCoordinator.runExclusive(
                    () => sessionFolderCleanupService.run(scanId),
                    "session-folder-cleanup-run",
                  ),
                /** DB 初期化中の新規キュー処理を止めて保守操作を直列化し、終了要求がなければキューを再開する。 */
                resetAppDatabase: async (request) => {
                  if (databaseMaintenanceRequested) {
                    throw new Error(
                      "Database initialization is already in progress.",
                    );
                  }
                  databaseMaintenanceRequested = true;
                  sessionTurnQueueService?.beginShutdown();
                  try {
                    return await characterWorkspaceOperationCoordinator.runMaintenance(
                      () =>
                        requireSettingsCatalogService().resetAppDatabase(
                          request,
                        ),
                    );
                  } finally {
                    databaseMaintenanceRequested = false;
                    if (!requireSessionWindowBridge().isQuitPending())
                      sessionTurnQueueService?.resume();
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
                /** モニター対象の通常・Auxiliary の概要に実行中状態と未読結果を重ね、ページとして返す。 */
                listSessionMonitorPage: (request) =>
                  readSessionMonitorPage(
                    {
                      /** Window ブリッジが現在追跡しているモニター対象の Session ID を返す。 */
                      listMonitorSessionIds: () =>
                        requireSessionWindowBridge().listMonitorSessionIds(),
                      /** モニター対象 ID に限定して通常 Session の概要を取得する。 */
                      readSummaries: async (sessionIds) =>
                        (
                          await requireMainQueryService().listSessionSummaryPage(
                            { scope: "open", sessionIds },
                          )
                        ).entries,
                      /** モニター対象の親 ID 群に属する Auxiliary の概要を取得する。 */
                      readAuxiliarySummaries: (sessionIds) =>
                        requireAuxiliarySessionService().listAuxiliarySessionSummaries(
                          sessionIds,
                        ),
                      getLiveSessionRun,
                      hasUnreadResult,
                    },
                    request,
                  ),
                /** Home の条件に合う保存済み Session 一覧に実行状態を重ねて返す。 */
                listSessionSummaryPage: (request) =>
                  listSessionSummaryPage(request),
                /** キャラクター別の Session 利用状況を IPC へ返す。 */
                listSessionCharacterUsage: () => listSessionCharacterUsage(),
                /** 対象 Session の最新ターンを表示用に読み取る。 */
                getLatestSessionTurn: (sessionId) =>
                  getLatestSessionTurn(sessionId),
                /** 対象 Session に未読の実行結果があれば返す。 */
                getUnreadSessionResult: (sessionId) =>
                  sessionResultReadService.getUnreadResult(sessionId),
                /** 指定された Session とターンの結果を既読にする。 */
                markSessionResultRead: (sessionId, turnId) =>
                  sessionResultReadService.markRead(sessionId, turnId),
                /** 対象 Session の構成で利用できるスキルを一覧にする。 */
                listSessionSkills: async (sessionId) =>
                  listSessionSkills(sessionId),
                /** 対象 Session の構成で利用できるカスタムエージェントを一覧にする。 */
                listSessionCustomAgents: async (sessionId) =>
                  listSessionCustomAgents(sessionId),
                /** 指定プロバイダーと作業ディレクトリを基準にスキルを探索する。 */
                listWorkspaceSkills: async (providerId, workspacePath) =>
                  requireMainQueryService().listWorkspaceSkills(
                    providerId,
                    workspacePath,
                  ),
                /** 指定プロバイダーと作業ディレクトリを基準にカスタムエージェントを探索する。 */
                listWorkspaceCustomAgents: async (providerId, workspacePath) =>
                  requireMainQueryService().listWorkspaceCustomAgents(
                    providerId,
                    workspacePath,
                  ),
                /** 開いている Session Window の ID 一覧をページ単位で返す。 */
                listOpenSessionWindowIdsPage: (request) =>
                  listOpenSessionWindowIdsPage(request),
                /** 指定 ID の通常 Session の表示用データを読み取る。 */
                getSession: (sessionId) => getDisplaySession(sessionId),
                /** Auxiliary の会話を表示する権限を持つ親 Session を解決し、通常なら自身の ID を返す。 */
                getConversationOwnerSessionId: async (sessionId) =>
                  (
                    await requireAuxiliarySessionStorage().getAuxiliarySessionSummary(
                      sessionId,
                    )
                  )?.parentSessionId ?? sessionId,
                /** 対象が Auxiliary かどうかに応じて会話ページの保存先を切り替える。 */
                getConversationPage: async (sessionId, request) => {
                  const auxiliary =
                    await requireAuxiliarySessionStorage().getAuxiliarySessionSummary(
                      sessionId,
                    );
                  return auxiliary
                    ? requireAuxiliarySessionStorage().getConversationPage(
                        sessionId,
                        request,
                      )
                    : requireSessionStorage().getConversationPage!(
                        sessionId,
                        request,
                      );
                },
                /** 通常と Auxiliary の保存先を捕捉し、会話照会の所有者・世代確認・操作をひとまとめに返す。 */
                resolveConversationQueryOwner: async (sessionId) => {
                  const sessionStorage = requireSessionStorage();
                  const auxiliaryStorage = requireAuxiliarySessionStorage();
                  const auxiliary =
                    await auxiliaryStorage.getAuxiliarySessionSummary(
                      sessionId,
                    );
                  const storage = auxiliary ? auxiliaryStorage : sessionStorage;
                  return {
                    ownerSessionId: auxiliary?.parentSessionId ?? sessionId,
                    /** 照会開始時の両ストアが現在も使われており、メンテナンス中でないことを確認する。 */
                    isCurrent: () =>
                      mainStoreContext.sessionStorage === sessionStorage &&
                      mainStoreContext.auxiliarySessionStorage ===
                        auxiliaryStorage &&
                      !databaseMaintenanceRequested,
                    /** 捕捉した保存先で対象 Session の会話を検索する。 */
                    search: (request) =>
                      storage.searchConversation!(sessionId, request),
                    /** 同じ保存先から対象会話のナビゲーション項目を取得する。 */
                    navigate: (request) =>
                      storage.listConversationNavigator!(sessionId, request),
                    /** 捕捉した保存先に会話照会の取消を要求する。 */
                    cancel: (request) =>
                      storage.cancelConversationQuery!(request),
                  };
                },
                /** 対象 Session の表示に必要な概要のみを読み取る。 */
                getSessionSummary: (sessionId) =>
                  getDisplaySessionSummary(sessionId),
                /** Session に適用される Glossary の投影を読み取る。 */
                getSessionGlossaryProjection: (sessionId) =>
                  glossarySessionProjectionService.load(sessionId),
                /** 指定 Session が利用できる Glossary の範囲で検索する。 */
                searchSessionGlossary: (sessionId, request) =>
                  glossarySessionProjectionService.search(sessionId, request),
                ensureSessionGlossarySubscription,
                getSessionFileExplorerOwnerSessionId,
                /** ファイル探索で参照可能なルートを Session ごとに列挙する。 */
                listSessionFileRoots: (sessionId) =>
                  createSessionFileExplorerService().listRoots(sessionId),
                /** 対象 Session のファイルピンの一覧を取得する。 */
                listSessionFilePins: (sessionId) =>
                  createSessionFileExplorerService().listSessionFilePins(
                    sessionId,
                  ),
                /** ファイル探索のリソースを Session のピンに登録する。 */
                pinSessionFile: (request) =>
                  createSessionFileExplorerService().pinSessionFile(request),
                /** 指定のファイルピンを Session の一覧から外す。 */
                unpinSessionFile: (request) =>
                  createSessionFileExplorerService().unpinSessionFile(request),
                /** アクセス境界内の指定ディレクトリの内容を列挙する。 */
                listSessionDirectory: (request) =>
                  createSessionFileExplorerService().listDirectory(request),
                /** ファイル参照を画像として検査してプレビュー用の情報を返す。 */
                inspectSessionImage: (request) =>
                  createSessionFileExplorerService().inspectImage(request),
                /** Session のファイル探索経路で HTML プレビューを読み取る。 */
                readSessionHtmlPreview: (request) =>
                  readSessionHtmlPreview(
                    createSessionFileExplorerService(),
                    request,
                  ),
                /** Session の画像リソースの要求範囲を読み取る。 */
                readSessionImageChunk: (request) =>
                  createSessionFileExplorerService().readImageChunk(request),
                /** 対象の PDF リソースを検査してプレビュー用の情報を返す。 */
                inspectSessionPdf: (request) =>
                  createSessionFileExplorerService().inspectPdf(request),
                /** PDF プレビューが要求したバイト範囲を読み取る。 */
                readSessionPdfChunk: (request) =>
                  createSessionFileExplorerService().readPdfChunk(request),
                /** コミット上の参照は Git 履歴、その他はファイル探索サービスで検査する。 */
                inspectSessionFile: (request) =>
                  isSessionFileGitCommitResource(request)
                    ? createFileRootGitChangesService().inspectHistoryFile(
                        request,
                      )
                    : createSessionFileExplorerService().inspectFile(request),
                /** Git 履歴上の内容と現在のファイルを区別し、指定された範囲を読み取る。 */
                readSessionFileChunk: (request) =>
                  isSessionFileGitCommitResource(request)
                    ? createFileRootGitChangesService().readHistoryFileChunk(
                        request,
                      )
                    : createSessionFileExplorerService().readFileChunk(request),
                /** ファイル探索の認可経路から OS にファイルを開くよう要求する。 */
                openSessionFile: (request) =>
                  createSessionFileExplorerService().openFile(request),
                /** リンク送信元の検査を渡し、Session のファイルプレビューを開く。 */
                openSessionFilePreviewWindow: (request, assertLinkSender) =>
                  sessionFileExplorerRuntime
                    .getPreview()
                    .open(request, assertLinkSender),
                /** プレビュートークンに結び付けた Window の初期データを返す。 */
                getSessionFilePreviewWindowPayload: (token) =>
                  requireMainWindowFacade().getFilePreviewPayload(token),
                /** 指定ファイルルートで検出した Git 変更を返す。 */
                listFileRootChanges: (request) =>
                  createFileRootGitChangesService().listChanges(request),
                /** ファイルルートの変更表示に応じた Git リポジトリ候補を列挙する。 */
                listFileRootChangesRepositories: (request) =>
                  createFileRootGitChangesService().listChangesRepositories(
                    request,
                  ),
                /** 変更一覧から選ばれたファイルの差分を返す。 */
                getFileRootDiff: (request) =>
                  createFileRootGitChangesService().getFileDiff(request),
                /** ファイルルート内で履歴表示できる Git リポジトリを列挙する。 */
                listFileRootGitHistoryRepositories: (request) =>
                  createFileRootGitChangesService().listHistoryRepositories(
                    request,
                  ),
                /** ファイルルートの履歴画面に指定されたリポジトリのコミットを返す。 */
                listFileRootGitHistoryCommits: (request) =>
                  createFileRootGitChangesService().listHistoryCommits(request),
                /** 選択したコミットの詳細をファイルルートの Git 履歴から読む。 */
                getFileRootGitHistoryCommitDetail: (request) =>
                  createFileRootGitChangesService().getHistoryCommitDetail(
                    request,
                  ),
                /** Git 履歴の画面で指定されたリビジョン間の比較を取得する。 */
                getFileRootGitHistoryComparison: (request) =>
                  createFileRootGitChangesService().getHistoryComparison(
                    request,
                  ),
                /** 履歴上のファイルについて指定された差分を読み取る。 */
                getFileRootGitHistoryDiff: (request) =>
                  createFileRootGitChangesService().getHistoryDiff(request),
                getSessionMessageArtifact,
                /** 差分 Window のトークンに対応するプレビュー情報を取得する。 */
                getDiffPreview: (token) =>
                  requireAuxWindowService().getDiffPreview(token),
                previewComposerInput,
              },
              auxiliary: {
                /** 指定した親 Session に属する Auxiliary の一覧を返す。 */
                listAuxiliarySessions: (parentSessionId) =>
                  requireAuxiliarySessionService().listAuxiliarySessions(
                    parentSessionId,
                  ),
                /** 複数の親 Session を指定して Auxiliary の表示用概要をまとめて取得する。 */
                listAuxiliarySessionSummaries: (parentSessionIds) =>
                  requireAuxiliarySessionService().listAuxiliarySessionSummaries(
                    parentSessionIds,
                  ),
                /** 開いている Session Window を親とする Auxiliary の概要だけを取得する。 */
                listOpenAuxiliarySessionSummaries: () =>
                  requireAuxiliarySessionService().listAuxiliarySessionSummaries(
                    [...listOpenSessionWindowIds()],
                  ),
                /** 指定された親の最新 Auxiliary を表示用のビューとして取得する。 */
                getLatestAuxiliarySession: (parentSessionId) =>
                  requireAuxiliarySessionService().getLatestAuxiliarySessionView(
                    parentSessionId,
                  ),
                /** 指定された Auxiliary の画面表示に必要なデータを取得する。 */
                getAuxiliarySession: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliarySessionView(
                    auxiliarySessionId,
                  ),
                /** 対象 Auxiliary の未送信下書きを読み取る。 */
                getAuxiliaryDraft: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliaryDraft(
                    auxiliarySessionId,
                  ),
                /** 受け取った下書きをその Auxiliary に保存する。 */
                saveAuxiliaryDraft: (input) =>
                  requireAuxiliarySessionService().saveAuxiliaryDraft(input),
                /** 指定 Auxiliary の所属と稼働状態を取得する。 */
                getAuxiliarySessionStatus: (auxiliarySessionId) =>
                  requireAuxiliarySessionService().getAuxiliarySessionStatus(
                    auxiliarySessionId,
                  ),
                /** 対象 Auxiliary の表示タイトルを更新する。 */
                setAuxiliaryTitle: (request) =>
                  requireAuxiliarySessionService().setAuxiliaryTitle(request),
                /** 指定された Auxiliary メッセージのブックマーク状態を変更する。 */
                setAuxiliaryMessageBookmark: (request) =>
                  requireAuxiliarySessionService().setAuxiliaryMessageBookmark(
                    request,
                  ),
                /** 指定 Auxiliary に適用するターン実行オプションを保存する。 */
                setAuxiliaryExecutionOptions: (request) =>
                  requireAuxiliarySessionService().setAuxiliaryExecutionOptions(
                    request,
                  ),
                /** メンテナンス外で要求 ID を診断に紐づけて Auxiliary を作成し、親 Session の更新を配信する。 */
                createAuxiliarySession: async (input) => {
                  if (databaseMaintenanceRequested) {
                    throw new Error(
                      "A database maintenance operation is in progress, so an Auxiliary Session cannot be created.",
                    );
                  }
                  const created = await runWithStorageOperationCorrelation(
                    input.clientRequestId ?? crypto.randomUUID(),
                    () =>
                      requireAuxiliarySessionService().createAuxiliarySession(
                        input,
                      ),
                  );
                  broadcastSessions([created.parentSessionId]);
                  return created;
                },
                /** 指定した親から Auxiliary を作成する際に必要な初期情報を返す。 */
                getAuxiliaryCreationContext: (parentSessionId) =>
                  requireAuxiliarySessionService().getAuxiliaryCreationContext(
                    parentSessionId,
                  ),
                /** 要求 ID に対応する Auxiliary の作成処理を取り消す。 */
                cancelAuxiliaryCreation: (request) =>
                  requireAuxiliarySessionService().cancelAuxiliaryCreation(
                    request,
                  ),
                /** 指定した Auxiliary 作成要求の状態を読み取る。 */
                getAuxiliaryCreation: (request) =>
                  requireAuxiliarySessionService().getAuxiliaryCreation(
                    request,
                  ),
                /** Auxiliary の更新時にプロバイダー実行の状態を調整し、確定後に親の表示へ反映する。 */
                updateAuxiliarySession: async (session) => {
                  const updated =
                    await updateAuxiliarySessionWithProviderRuntimeLifecycle({
                      session,
                      /** 更新対象の Auxiliary がランタイムで実行中かを確認する。 */
                      isRunInFlight: (sessionId) =>
                        requireAuxiliarySessionRuntimeService().isRunInFlight(
                          sessionId,
                        ),
                      /** Auxiliary の更新に先立ち、保存された現行データを取得する。 */
                      getAuxiliarySession: (sessionId) =>
                        requireAuxiliarySessionService().getAuxiliarySession(
                          sessionId,
                        ),
                      /** 変更後の Auxiliary データを永続化する。 */
                      updateAuxiliarySession: (nextSession) =>
                        requireAuxiliarySessionService().updateAuxiliarySession(
                          nextSession,
                        ),
                      /** 実行設定の変更で不要になった Auxiliary のツールバインディングを失効させる。 */
                      revokeSessionAgentRuntimeBindings: (sessionId) => {
                        agentRuntimeBindingRegistry.revokeSession(sessionId);
                      },
                      invalidateProviderSessionThread,
                    });
                  broadcastSessions([updated.parentSessionId]);
                  return updated;
                },
                /** Auxiliary の実行と親の対応を追跡し、コンポーザーからの送信は指定した下書きリビジョンと結び付けて処理する。 */
                runAuxiliarySessionTurn: (auxiliarySessionId, request) =>
                  requireAuxiliarySessionService().trackPendingDraftSend(
                    async () => {
                      approvalReviewInputs.invalidate();
                      const owner = requireActivePersistentStoreOwnerForFactory(
                        "Auxiliary run admission",
                      );
                      if (
                        mainWindowRuntime
                          .getSessionWindowBridge()
                          .isQuitPending()
                      ) {
                        throw new Error(
                          "The app is quitting, so a new message cannot be sent.",
                        );
                      }
                      const initial =
                        await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
                          auxiliarySessionId,
                        );
                      assertPersistentStoreOwnerIsActive(
                        owner,
                        "Auxiliary run admission",
                      );
                      if (!initial) {
                        throw new Error(
                          "The Auxiliary Session could not be found.",
                        );
                      }
                      if (
                        mainWindowRuntime
                          .getSessionWindowBridge()
                          .isQuitPending()
                      ) {
                        throw new Error(
                          "The app is quitting, so a new message cannot be sent.",
                        );
                      }
                      if (auxiliaryRunParents.has(auxiliarySessionId)) {
                        throw new Error(
                          "The Auxiliary Session is already running.",
                        );
                      }
                      auxiliaryRunParents.set(auxiliarySessionId, {
                        parentSessionId: initial.parentSessionId,
                      });
                      auxiliaryLiveRunParents.remember(initial, owner);
                      try {
                        if (request.submitSource === "composer") {
                          if (
                            !request.auxiliaryDraftIncarnation ||
                            request.auxiliaryDraftDurableRevision === undefined
                          ) {
                            throw new Error(
                              "The Auxiliary draft revision could not be found.",
                            );
                          }
                          await requireAuxiliarySessionService().runAuxiliaryTurnWithDraft(
                            {
                              auxiliarySessionId,
                              parentSessionId: initial.parentSessionId,
                              incarnation: request.auxiliaryDraftIncarnation,
                              expectedDurableRevision:
                                request.auxiliaryDraftDurableRevision,
                              userMessage: request.userMessage,
                              displayAnchorParentMessageCount:
                                request.displayAnchorParentMessageCount,
                              /** 下書きが照合された後に対象 Auxiliary のランタイムを実行し、下書き側には完了だけを知らせる。 */
                              run: () =>
                                requireAuxiliarySessionRuntimeService()
                                  .runSessionTurn(auxiliarySessionId, request)
                                  .then(() => undefined),
                            },
                          );
                        } else {
                          if (
                            request.displayAnchorParentMessageCount !==
                            undefined
                          ) {
                            await requireAuxiliarySessionService().setAuxiliaryDisplayAnchor(
                              auxiliarySessionId,
                              request.displayAnchorParentMessageCount,
                            );
                          }
                          await requireAuxiliarySessionRuntimeService().runSessionTurn(
                            auxiliarySessionId,
                            request,
                          );
                        }
                        const session =
                          await requireAuxiliarySessionService().getAuxiliarySessionView(
                            auxiliarySessionId,
                          );
                        if (!session) {
                          throw new Error(
                            "The Auxiliary Session could not be found.",
                          );
                        }
                        return session;
                      } finally {
                        auxiliaryRunParents.delete(auxiliarySessionId);
                        auxiliaryLiveRunParents.releaseIfUnused(
                          auxiliarySessionId,
                          owner,
                        );
                      }
                    },
                  ),
                /** 指定した下書き世代から稼働中の Auxiliary に追加入力し、プロバイダーの受付結果を返す。 */
                steerAuxiliarySessionTurn: (auxiliarySessionId, request) =>
                  approvalReviewInputs.during(() =>
                    requireAuxiliarySessionService().trackPendingDraftSend(
                      async () => {
                        if (
                          mainWindowRuntime
                            .getSessionWindowBridge()
                            .isQuitPending()
                        )
                          throw new Error(
                            "The app is quitting, so input cannot be sent.",
                          );
                        const service = requireAuxiliarySessionService();
                        const session =
                          await service.getAuxiliarySessionMetadata(
                            auxiliarySessionId,
                          );
                        if (!session)
                          throw new Error(
                            "The Auxiliary Session could not be found.",
                          );
                        if (
                          !request.auxiliaryDraftIncarnation ||
                          request.auxiliaryDraftDurableRevision === undefined
                        )
                          throw new Error(
                            "The Auxiliary draft revision could not be found.",
                          );
                        let accepted:
                          | import("../src-shared/session/runtime-state.js").SteerSessionTurnResult
                          | undefined;
                        await service.runAuxiliaryInputWithDraft({
                          auxiliarySessionId,
                          parentSessionId: session.parentSessionId,
                          incarnation: request.auxiliaryDraftIncarnation,
                          expectedDurableRevision:
                            request.auxiliaryDraftDurableRevision,
                          userMessage: request.userMessage,
                          /** 下書き処理の内側で追加入力を送り、プロバイダーから返る受付結果を保持する。 */
                          run: async () => {
                            accepted =
                              await requireAuxiliarySessionRuntimeService().steerSessionTurn(
                                auxiliarySessionId,
                                request,
                              );
                          },
                        });
                        if (!accepted)
                          throw new Error(
                            "The provider did not confirm the input.",
                          );
                        broadcastSessions([session.parentSessionId]);
                        return accepted;
                      },
                    ),
                  ),
                /** Window の権限を確認する経路で、対象 Auxiliary の実行停止を要求する。 */
                cancelAuxiliarySessionRun: (request, assertAuthorized) =>
                  stopWindowSessionRun(
                    request,
                    requireAuxiliarySessionRuntimeService(),
                    requireMainSessionTurnQueueService(),
                    assertAuthorized,
                    () => approvalReviewInputs.invalidate(),
                  ),
              },
              sessionRuntime: {
                queue: {
                  /** キュー項目を指定した実行中ターンへの追加入力として送り、承認レビュー入力との整合を保つ。 */
                  sendQueuedSessionInput: (sessionId, id, expectedTurnId) =>
                    approvalReviewInputs.during(() =>
                      requireMainSessionTurnQueueFacade().sendQueuedSessionInput(
                        sessionId,
                        id,
                        expectedTurnId,
                      ),
                    ),
                  /** GUI のターン要求を承認レビュー入力と調整してキューへ登録する。 */
                  enqueueSessionTurn: (sessionId, request) =>
                    approvalReviewInputs.during(() =>
                      requireMainSessionTurnQueueFacade().enqueueSessionTurn(
                        sessionId,
                        request,
                      ),
                    ),
                  /** 送信元の現行性を確認する経路で、失敗したターンを再登録する。 */
                  retryFailedSessionTurn: (sessionId, request, assertCurrent) =>
                    approvalReviewInputs.during(() =>
                      requireMainSessionTurnQueueFacade().retryFailedSessionTurn(
                        sessionId,
                        request,
                        assertCurrent,
                      ),
                    ),
                  /** Session とクライアント要求 ID に対応するキュー受領を読む。 */
                  getSessionTurnQueueReceipt: (sessionId, requestId) =>
                    requireMainSessionTurnQueueFacade().getSessionTurnQueueReceipt(
                      sessionId,
                      requestId,
                    ),
                  /** 指定 Session の現在のターンキューを読み取る。 */
                  listSessionTurnQueue: (sessionId) =>
                    requireMainSessionTurnQueueFacade().listSessionTurnQueue(
                      sessionId,
                    ),
                  /** 対象 Session の受領履歴を指定条件で読み取る。 */
                  listSessionTurnQueueReceipts: (sessionId, options) =>
                    requireMainSessionTurnQueueFacade().listSessionTurnQueueReceipts(
                      sessionId,
                      options,
                    ),
                  /** 指定したキュー項目を取り消し、承認レビューの入力との整合を保つ。 */
                  cancelQueuedSessionTurn: (sessionId, id) =>
                    approvalReviewInputs.during(() =>
                      requireMainSessionTurnQueueFacade().cancelQueuedSessionTurn(
                        sessionId,
                        id,
                      ),
                    ),
                  /** キュー項目の編集を開始して編集に必要な状態を取得する。 */
                  beginQueuedSessionTurnEdit: (sessionId, request) =>
                    requireMainSessionTurnQueueFacade().beginQueuedSessionTurnEdit(
                      sessionId,
                      request,
                    ),
                  /** 編集中のキュー入力を承認レビューと調整しながら更新する。 */
                  updateQueuedSessionTurn: (sessionId, request) =>
                    approvalReviewInputs.during(() =>
                      requireMainSessionTurnQueueFacade().updateQueuedSessionTurn(
                        sessionId,
                        request,
                      ),
                    ),
                  /** 指定した編集要求を取り消してキュー項目への編集操作を終了する。 */
                  cancelQueuedSessionTurnEdit: (sessionId, request) =>
                    requireMainSessionTurnQueueFacade().cancelQueuedSessionTurnEdit(
                      sessionId,
                      request,
                    ),
                  /** キューサービスが初期化済みなら Session の編集保持を解放する。 */
                  releaseQueuedSessionTurnEdit: (sessionId) =>
                    sessionTurnQueueService?.releaseQueuedEdit(sessionId) ??
                    Promise.resolve(),
                  /** 指定 Session のキュー項目を要求された順序に並べ替える。 */
                  reorderQueuedSessionTurns: (sessionId, request) =>
                    requireMainSessionTurnQueueFacade().reorderQueuedSessionTurns(
                      sessionId,
                      request,
                    ),
                },
                /** 実行 IPC から Auxiliary の稼働と親の情報を参照できるようにする。 */
                getAuxiliarySessionStatus: (sessionId) =>
                  requireAuxiliarySessionService().getAuxiliarySessionStatus(
                    sessionId,
                  ),
                /** 実行 IPC へ対象 Session のライブ実行状態を返す。 */
                getLiveSessionRun: (sessionId) => getLiveSessionRun(sessionId),
                /** 取得オプションに応じてプロバイダーの利用枠のキャッシュを取得または更新する。 */
                getProviderQuotaTelemetry: (providerId, options) =>
                  getOrRefreshProviderQuotaTelemetry(providerId, options),
                /** 指定 Session のコンテキスト使用量を取得する。 */
                getSessionContextTelemetry: (sessionId) =>
                  getSessionContextTelemetry(sessionId),
                resolveLiveApproval,
                /** 承認レビュー入力と調整しながら、実行中のプロバイダーからの質問に回答する。 */
                resolveLiveElicitation: (...args) =>
                  approvalReviewInputs.during(() =>
                    resolveLiveElicitation(...args),
                  ),
                /** GUI で選んだ起動条件から通常 Session を作成する。 */
                createSession: (input) =>
                  requireMainSessionCommandFacade().createSessionFromRequest(
                    input,
                  ),
                /** 更新を確定した Session を会話表示用に変換して返す。 */
                updateSession: async (session) =>
                  toConversationView(
                    await requireMainSessionCommandFacade().updateSession(
                      session,
                    ),
                  ),
                /** 保存済み Session の追加ディレクトリを要求内容に従って変更する。 */
                changeSessionAdditionalDirectory: async (request) => {
                  await requireSessionPersistenceService().changeAdditionalDirectory(
                    request,
                  );
                },
                /** 対象 incarnation の Session だけにタイトル変更を適用する。 */
                setSessionTitle: (request) =>
                  requireSessionPersistenceService().setSessionTitle(
                    request.sessionId,
                    request.incarnationId,
                    request.title,
                  ),
                /** 指定 incarnation とメッセージ位置に対してブックマーク状態を更新する。 */
                setSessionMessageBookmark: (request) =>
                  requireSessionPersistenceService().setSessionMessageBookmark(
                    request.sessionId,
                    request.incarnationId,
                    request.messageIndex,
                    request.isBookmarked,
                  ),
                /** 対象 incarnation の実行設定を、レビュアー変更の確認情報と承認選択を伴って保存する。 */
                setSessionExecutionOptions: (request) =>
                  requireSessionPersistenceService().setSessionExecutionOptions(
                    request.sessionId,
                    request.incarnationId,
                    request.executionOptions,
                    request.confirmedReviewerChange,
                    request.approvalChoice,
                  ),
                /** 指定した Session のピン状態を更新する。 */
                setSessionPinned: (request) =>
                  requireMainSessionCommandFacade().setSessionPinned(request),
                /** Session の削除が成功した後に、紐づく端末を解放する。 */
                deleteSession: async (sessionId) => {
                  await requireMainSessionCommandFacade().deleteSession(
                    sessionId,
                  );
                  terminalService?.releaseSession(sessionId);
                },
                /** 最終活動時刻を基準に Session をまとめて削除し、実際に削除された分の端末を解放する。 */
                deleteSessionsLastActiveBefore: async (request) => {
                  const result =
                    await requireMainSessionCommandFacade().deleteSessionsLastActiveBefore(
                      request,
                    );
                  for (const sessionId of result.deletedSessionIds)
                    terminalService?.releaseSession(sessionId);
                  return result;
                },
                /** 現行 Session の incarnation を付けてターンをキュー登録し、同じ永続世代から表示用状態を読み直す。 */
                runSessionTurn: (sessionId, request) =>
                  approvalReviewInputs.during(async () => {
                    const owner = requireActivePersistentStoreOwnerForFactory(
                      "Turn result projection",
                    );
                    const current = await getRuntimeSession(sessionId);
                    assertPersistentStoreOwnerIsActive(
                      owner,
                      "Turn result projection",
                    );
                    if (!current)
                      throw new Error("The Session could not be found.");
                    await requireMainSessionTurnQueueFacade().enqueueSessionTurn(
                      sessionId,
                      {
                        ...request,
                        incarnationId: getSessionIncarnationId(current),
                      },
                    );
                    assertPersistentStoreOwnerIsActive(
                      owner,
                      "Turn result projection",
                    );
                    const session = await getDisplaySession(sessionId);
                    assertPersistentStoreOwnerIsActive(
                      owner,
                      "Turn result projection",
                    );
                    if (!session)
                      throw new Error("The saved Session could not be loaded.");
                    return session;
                  }),
                /** 終了中でないことを確かめて実行中ターンに追加入力を送り、Session を再配信する。 */
                steerSessionTurn: (sessionId, request) =>
                  approvalReviewInputs.during(async () => {
                    if (
                      mainWindowRuntime.getSessionWindowBridge().isQuitPending()
                    )
                      throw new Error(
                        "The app is quitting, so input cannot be sent.",
                      );
                    const result =
                      await requireMainSessionCommandFacade().steerSessionTurn(
                        sessionId,
                        request,
                      );
                    broadcastSessions([sessionId]);
                    return result;
                  }),
                /** Window の権限を確認する経路で、通常 Session の実行停止を要求する。 */
                cancelSessionRun: (request, assertAuthorized) =>
                  stopWindowSessionRun(
                    request,
                    requireSessionRuntimeService(),
                    requireMainSessionTurnQueueService(),
                    assertAuthorized,
                    () => approvalReviewInputs.invalidate(),
                  ),
              },
              mate: {
                /** Mate が設定済みかどうかを現在の永続ストアから取得する。 */
                getMateState: () => requireMateStorage().getMateState(),
                /** 現在保存された Mate のプロフィールを読み取る。 */
                getMateProfile: () => requireMateStorage().getMateProfile(),
                createMate,
                updateMate,
                setMateAvatar,
                resetMate,
              },
              character: {
                /** 指定した一覧条件で Character を取得し、条件なしはサービスの既定値を使う。 */
                listCharacters: (options) =>
                  requireCharacterService().listCharacters(
                    options ?? undefined,
                  ),
                /** ID から保存済み Character を取得する。 */
                getCharacter: (characterId) =>
                  requireCharacterService().getCharacter(characterId),
                /** Character の新規登録を永続サービスに委ねる。 */
                createCharacter: (input) =>
                  requireCharacterService().createCharacter(input),
                /** 定義本文とは別に Character のメタデータを更新する。 */
                updateCharacterMetadata: (input) =>
                  requireCharacterService().updateCharacterMetadata(input),
                /** 対象 Character の定義本文を永続サービスで更新する。 */
                updateCharacterDefinition: (input) =>
                  requireCharacterService().updateCharacterDefinition(input),
                /** 指定 Character をアーカイブする。 */
                archiveCharacter: (characterId) =>
                  requireCharacterService().archiveCharacter(characterId),
                /** 起動条件に対応する Character とその実行向け情報を解決する。 */
                resolveLaunchCharacter: (input) =>
                  requireCharacterService().resolveLaunchCharacter(input),
                startCharacterAuthoringSession,
              },
            },
            /** 起動判定に使う Mate の状態を現在のストアから取得する。 */
            getMateState: () => requireMateStorage().getMateState(),
          }),
        ),
    });
  }

  return mainInfrastructureRegistry;
}

/** 現行の通常 Session ストアを返し、未初期化なら照会を拒否する。 */
function requireSessionStorage(): SessionStorageRead {
  if (!mainStoreContext.sessionStorage) {
    throw new Error("Session storage is not initialized.");
  }

  return mainStoreContext.sessionStorage;
}

/** 保存形式が書き込みに対応する場合だけ通常 Session ストアを書き込み用として返す。 */
function requireSessionStorageForWrite(): SessionStorageWrite {
  const storage = requireSessionStorage();
  if (isSessionStorageWritable(storage)) {
    return storage;
  }

  throw new Error(
    "Session storage is read-only for this database and cannot be written.",
  );
}

/** ピンの更新に対応する保存形式かを確認し、未対応なら例外を返す。 */
function requireSessionPinStorage(): SessionPinStorage {
  const storage = requireSessionStorage();
  const candidate = storage as Partial<SessionPinStorage>;
  if (typeof candidate.setSessionPinned === "function") {
    return candidate as SessionPinStorage;
  }
  throw new Error("Pinning is not available for this session format.");
}

/** ファイルピンの取得・登録・解除をすべて使える場合だけストアを返す。 */
function requireSessionFilePinStorage(): SessionFilePinStorage {
  const candidate = requireSessionStorage() as Partial<SessionFilePinStorage>;
  if (
    typeof candidate.listSessionFilePins !== "function" ||
    typeof candidate.pinSessionFile !== "function" ||
    typeof candidate.unpinSessionFile !== "function"
  )
    throw new Error("File Pin storage is not available.");
  return candidate as SessionFilePinStorage;
}

/** 通常 Session の追加、更新、置換、削除に必要なメソッドが揃うことを確認する。 */
function isSessionStorageWritable(
  storage: SessionStorageRead,
): storage is SessionStorageWrite {
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

/** 現在の保存層と実行時依存を使う Main の読み取りサービスを遅延初期化する。 */
function requireMainQueryService(): MainQueryService {
  if (!mainQueryService) {
    mainQueryService = new MainQueryService({
      /** 読み取りサービスに現行ストアの Session 概要一覧を供給する。 */
      getSessionSummaries: () => requireSessionStorage().listSessionSummaries(),
      /** V6 Worker から準備済み Session の概要を読み取り、応答前に世代の継続を確認する。 */
      getReadySessionSummary: async (sessionId) => {
        const owner =
          requireActivePersistentStoreOwnerForFactory("Session query");
        if (!owner.storageWorker)
          throw new Error("Saved Session queries require V6 storage.");
        const summary =
          await owner.storageWorker.stores.session.getReadySessionSummary(
            sessionId,
          );
        assertPersistentStoreOwnerIsActive(owner, "Session query");
        return summary;
      },
      /** ページを扱えるストアから Session の概要を読み、未対応の保存形式は明示的に拒否する。 */
      getSessionSummaryPage: (request) => {
        const storage = requireSessionStorage();
        if (!storage.listSessionSummaryPage) {
          throw new Error(
            "Session summary pages are not available for this database.",
          );
        }
        return storage.listSessionSummaryPage(request);
      },
      /** 対応するストアで Character の利用状況を取得し、未対応なら例外にする。 */
      getSessionCharacterUsage: () => {
        const storage = requireSessionStorage();
        if (!storage.listSessionCharacterUsage) {
          throw new Error(
            "Session Character usage is not available for this database.",
          );
        }
        return storage.listSessionCharacterUsage();
      },
      /** 現行ストアの通常 Session を読み取りビューとして取得する。 */
      getSession: (sessionId) =>
        requireSessionStorage().getSessionView!(sessionId),
      /** メッセージ位置を指定して保存済み成果物を取得する。 */
      getSessionMessageArtifact: (sessionId, messageIndex) =>
        requireSessionStorage().getSessionMessageArtifact(
          sessionId,
          messageIndex,
        ),
      /** ターン専用のストアから Session の最新ターンを読み取る。 */
      getLatestSessionTurn: (sessionId) =>
        requireSessionTurnStorage().getLatestSessionTurn(sessionId),
      /** 読み取りサービスの解決処理に最新のアプリ設定を渡す。 */
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      discoverSessionSkills,
      discoverSessionCustomAgents,
      /** 管理対象のプロバイダー設定を解決したうえで入力欄の送信プレビューを作る。 */
      resolveComposerPreview: async (session, userMessage) =>
        resolveComposerPreview(
          await resolveManagedProviderSession(session),
          userMessage,
        ),
      launchTerminalAtPath,
    });
  }

  return mainQueryService;
}

/** Window 一覧と最新の設定・カタログを使う配信窓口を遅延初期化する。 */
function requireMainBroadcastFacade(): MainBroadcastFacade<BrowserWindow> {
  if (!mainBroadcastFacade) {
    mainBroadcastFacade = new MainBroadcastFacade({
      /** 配信時に現在の Window 配信サービスを解決する。 */
      getWindowBroadcastService: () => requireWindowBroadcastService(),
      /** モデル変更を配信するときに現行カタログを取得する。 */
      getModelCatalog: () => getModelCatalog(),
      /** 設定変更のイベントに載せる現在のアプリ設定を取得する。 */
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      listPromptTemplates,
      /** 配信で参照する開いている Session Window の ID を返す。 */
      listOpenSessionWindowIds: () => listOpenSessionWindowIds(),
    });
  }

  return mainBroadcastFacade;
}

/** 補助 Window と Session Window の操作を束ねる窓口を遅延初期化する。 */
function requireMainWindowFacade(): MainWindowFacade {
  if (!mainWindowFacade) {
    mainWindowFacade = new MainWindowFacade({
      /** Home や設定を扱う補助 Window サービスを操作時に取得する。 */
      getAuxWindowService: () => requireAuxWindowService(),
      /** Session Window の所有とライフサイクルを管理するブリッジを返す。 */
      getSessionWindowBridge: () => requireSessionWindowBridge(),
    });
  }

  return mainWindowFacade;
}

/** ライブ実行とプロバイダー利用枠の照会窓口を遅延初期化する。 */
function requireMainObservabilityFacade(): MainObservabilityFacade {
  if (!mainObservabilityFacade) {
    mainObservabilityFacade = new MainObservabilityFacade({
      /** 照会先となる現在の Session 監視サービスを解決する。 */
      getSessionObservabilityService: () =>
        requireSessionObservabilityService(),
      /** 利用枠の照会に適用する現行のアプリ設定を読み取る。 */
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      /** 指定プロバイダーの実装を監視ファサードへ渡す。 */
      getProviderCodingAdapter: (providerId) =>
        getProviderCodingAdapter(providerId),
      providerQuotaStaleTtlMs: PROVIDER_QUOTA_STALE_TTL_MS,
    });
  }

  return mainObservabilityFacade;
}

/** 現行ストア世代にモデル探索を結び付け、探索結果の変更を Window へ配信する。 */
function requireProviderModelDiscoveryService(): ProviderModelDiscoveryService {
  if (!providerModelDiscoveryService) {
    const owner =
      requireActivePersistentStoreOwnerForFactory("Model discovery");
    providerModelDiscoveryService = new ProviderModelDiscoveryService({
      /** この探索サービスを生成した世代から、プロバイダー設定を読み取る。 */
      getAppSettings: () => owner.appSettingsStorage.getSettings(),
      /** 同じストア世代にキャッシュされたプロバイダー情報を取得する。 */
      getCachedProviders: () => owner.modelCatalogStorage.getCachedProviders(),
      /** 探索結果のプロバイダー項目を、この世代のカタログに追加または更新する。 */
      upsertProvider: (entry) =>
        owner.modelCatalogStorage.upsertProvider(entry),
      getAdapter: getProviderCodingAdapter,
      /** 探索時の作業ディレクトリが未指定なら先頭 Session の場所を使い、それもなければホームを使う。 */
      defaultWorkspace: () =>
        mainStoreContext.sessions[0]?.workspacePath || app.getPath("home"),
      /** 探索結果が変わったらスナップショットを配信し、配信失敗を警告に残す。 */
      onChanged: (snapshot) => {
        void broadcastModelCatalog(snapshot).catch((error: unknown) =>
          writeAppLog({
            level: "warn",
            kind: "model.discovery.broadcast-failed",
            process: "main",
            message: "Model choices could not be updated",
            error: appLogService.errorToLogError(error),
          }),
        );
      },
    });
  }
  return providerModelDiscoveryService;
}

/** モデル探索、各プロバイダーアダプター、実行権限の失効処理をまとめる窓口を遅延初期化する。 */
function requireMainProviderFacade(): MainProviderFacade {
  if (!mainProviderFacade) {
    mainProviderFacade = new MainProviderFacade({
      /** 要求に応じたモデルカタログを現行の探索サービスから取得する。 */
      getModelCatalog: (request) =>
        requireProviderModelDiscoveryService().get(request),
      codexAdapter,
      copilotAdapter,
      claudeAdapter,
      opencodeAdapter,
      /** 指定 Session とプロバイダーの組の実行バインディングだけを失効させる。 */
      revokeProviderExecution: (sessionId, providerId) =>
        agentRuntimeBindingRegistry.revokeProviderExecution(
          sessionId,
          providerId,
        ),
      /** ストアの切替や終了時などに、登録済みの実行バインディングをすべて失効させる。 */
      revokeAllProviderExecutions: () =>
        agentRuntimeBindingRegistry.revokeAll(),
    });
  }

  return mainProviderFacade;
}

/** 通常 Session の起動・更新・削除などを永続ストアとランタイムへつなぐ窓口を初期化する。 */
function requireMainSessionCommandFacade(): MainSessionCommandFacade {
  if (!mainSessionCommandFacade) {
    mainSessionCommandFacade = new MainSessionCommandFacade({
      getSession,
      /** コマンドが扱う現在のインメモリ Session 一覧を返す。 */
      getSessions: () => mainStoreContext.sessions,
      /** コマンドが永続側の一覧を必要とするときに保存済み概要を読み取る。 */
      getStoredSessionSummaries: () =>
        requireSessionStorage().listSessionSummaries(),
      /** コマンド中の世代切替検出に使う通常 Session ストアを返す。 */
      getSessionStorageIdentity: () => requireSessionStorage(),
      /** 指定プロバイダーと作業場所から起動時の選択を解決し、捕捉済みの既定値があれば引き継ぐ。 */
      resolveSessionLaunchSelection: (
        providerId,
        workspacePath,
        capturedDefaults,
      ) =>
        requireSessionLaunchSelectionService().resolve(
          providerId,
          workspacePath,
          capturedDefaults,
        ),
      /** DB メンテナンスが要求されていない場合だけ、プロバイダー操作の排他区間で Session を作成する。 */
      runProviderRuntimeOperationExclusive: (operation) => {
        if (databaseMaintenanceRequested) {
          throw new Error(
            "A database maintenance operation is in progress, so a Session cannot be created.",
          );
        }
        return providerRuntimeOperationCoordinator.runExclusive(() => {
          if (databaseMaintenanceRequested) {
            throw new Error(
              "A database maintenance operation is in progress, so a Session cannot be created.",
            );
          }
          return operation();
        }, "session-create");
      },
      /** Session コマンドの実行時に現在の保存サービスを取得する。 */
      getSessionPersistenceService: () => requireSessionPersistenceService(),
      /** 実行中ターンを扱うコマンドに、通常 Session の現行ランタイムを供給する。 */
      getSessionRuntimeService: () => requireSessionRuntimeService(),
      /** 候補プロバイダーについて現在参照できる利用枠情報を取得する。 */
      getProviderQuotaTelemetry: (providerId) =>
        getProviderQuotaTelemetry(providerId),
      /** 既存の利用枠データを再取得すべきか判定する。 */
      isProviderQuotaTelemetryStale: (telemetry) =>
        isProviderQuotaTelemetryStale(telemetry),
      /** プロバイダーの利用枠データを更新する処理をコマンドへ渡す。 */
      refreshProviderQuotaTelemetry: (providerId) =>
        refreshProviderQuotaTelemetry(providerId),
      initializeCreatedSession: ensureDefaultAuxiliarySession,
      /** 新規 Session の選択対象に、アーカイブされていない Character だけを渡す。 */
      listActiveCharacters: () =>
        requireCharacterService().listCharacters({ includeArchived: false }),
      /** 起動した Session が使う Character の実行スナップショットを作る。 */
      createCharacterRuntimeSnapshot: (characterId) =>
        requireCharacterService().createRuntimeSnapshot(characterId),
      /** 新規 Session ID に対応する個別ファイル保存先を計算する。 */
      resolveSessionFilesDirectory: (sessionId) =>
        resolveSessionFilesDirectory(app.getPath("userData"), sessionId),
      /** Crew のルート ID に対応する共有ファイル保存先を計算する。 */
      resolveCrewFilesDirectory: (rootSessionId) =>
        resolveCrewFilesDirectory(app.getPath("userData"), rootSessionId),
      /** 保存済み Session と衝突しにくい起動 ID を UUID から発行する。 */
      createSessionId: () => `launch-${crypto.randomUUID()}`,
      /** 新規 Session の個別ファイル保存先を実際に作成する。 */
      createSessionFilesDirectory: (sessionId) =>
        createSessionFilesDirectory(app.getPath("userData"), sessionId),
      /** Session の作業場所と個別ファイル保存先が同一ディレクトリかを確認する。 */
      isSessionFilesWorkspace: (session) =>
        areDirectoryPathsEquivalent(
          session.workspacePath,
          resolveSessionFilesDirectory(app.getPath("userData"), session.id),
        ),
      /** Session に紐づくターン完了通知を閉じる。 */
      dismissSessionTurnNotification: (sessionId) =>
        requireSessionTurnNotificationService().dismissSessionNotification(
          sessionId,
        ),
      cleanupSessionFilesDirectory,
      /** 通常 Session に指定されたワークスペースを検証する。 */
      validateWorkspaceDirectory: (targetPath) =>
        workspaceDirectoryValidationService.validate(targetPath),
    });
  }

  return mainSessionCommandFacade;
}

/** 保存設定・カタログ・直近の選択を使って起動条件を解決するサービスを遅延初期化する。 */
function requireSessionLaunchSelectionService(): SessionLaunchSelectionService {
  if (!sessionLaunchSelectionService) {
    sessionLaunchSelectionService = new SessionLaunchSelectionService({
      /** 起動選択を解決する時点の設定を読み取る。 */
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      /** 対象プロバイダーが指定されていれば、そのプロバイダーの探索完了を待ってカタログを取得する。 */
      getModelCatalogSnapshot: (workspacePath, providerId) =>
        providerId
          ? requireProviderModelDiscoveryService().ensure(
              providerId,
              workspacePath,
            )
          : getModelCatalog({ ...(workspacePath ? { workspacePath } : {}) }),
      /** 同じプロバイダーで最後に保存された Session の概要を取得する。 */
      getLatestSessionSummaryForProvider: (providerId) =>
        requireSessionStorage().getLatestSessionSummaryForProvider(providerId),
      /** プロバイダー別に保持された現在の実行オプションを取得する。 */
      getCurrentExecutionOptions: (providerId) =>
        mainStoreContext.executionSelections.latestForProvider(providerId),
    });
  }

  return sessionLaunchSelectionService;
}

/** 生成時の永続世代を保持して通常 Session の保存窓口を遅延初期化する。 */
function requireMainSessionPersistenceFacade(): MainSessionPersistenceFacade {
  if (!mainSessionPersistenceFacade) {
    const owner = requireActivePersistentStoreOwnerForFactory(
      "Main session persistence facade",
    );
    mainSessionPersistenceFacade = new MainSessionPersistenceFacade({
      /** ファサードが作られた永続世代のままであることを検査してから保存サービスを渡す。 */
      getSessionPersistenceService: () => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Main session persistence facade",
        );
        return requireSessionPersistenceService();
      },
    });
  }

  return mainSessionPersistenceFacade;
}

/** モデルカタログの現在のストアを返し、未初期化なら例外にする。 */
function requireModelCatalogStorage(): PersistentStoreBundle["modelCatalogStorage"] {
  if (!mainStoreContext.modelCatalogStorage) {
    throw new Error("Model catalog storage is not initialized.");
  }

  return mainStoreContext.modelCatalogStorage;
}

/** ターン記録の現行ストアを返し、未初期化なら例外にする。 */
function requireSessionTurnStorage(): SessionTurnStorageAccess {
  if (!mainStoreContext.sessionTurnStorage) {
    throw new Error("Session turn storage is not initialized.");
  }
  return mainStoreContext.sessionTurnStorage;
}

/** 現行世代の Auxiliary ストアを取得し、利用できない場合は明示的に拒否する。 */
function requireAuxiliarySessionStorage(): AuxiliarySessionStorageAccess {
  if (!mainStoreContext.auxiliarySessionStorage) {
    throw new Error("Auxiliary Session storage is not initialized.");
  }

  return mainStoreContext.auxiliarySessionStorage;
}

/** Auxiliary の永続操作、実行状態、起動条件の解決を、取得時のストア世代に結び付ける。 */
function requireAuxiliarySessionService(): AuxiliarySessionService {
  if (!auxiliarySessionService) {
    const owner = requireActivePersistentStoreOwnerForFactory(
      "Auxiliary session service",
    );
    const storage = owner.auxiliarySessionStorage;
    auxiliarySessionService = new AuxiliarySessionService({
      /** 直接の実行追跡と Auxiliary ランタイムの両方を使って稼働中かを判定する。 */
      isAuxiliaryRunInFlight: (id) =>
        auxiliaryRunParents.has(id) ||
        auxiliarySessionRuntimeService?.isRunInFlight(id) === true,
      /** 対象 Auxiliary がランタイムで追加の入力を受け付けられるか返す。 */
      canAcceptAuxiliaryInput: (id) =>
        auxiliarySessionRuntimeService?.canAcceptSessionInput(id) === true,
      /** Auxiliary サービスの生成時に取得したストア世代を識別値として返す。 */
      captureStorageIdentity: () => owner,
      /** 操作時に捕捉された世代が現在の永続所有者と一致するか確認する。 */
      isStorageIdentityCurrent: (captured) =>
        mainStoreContext.activePersistentStoreOwner === captured,
      /** メッセージが確定した世代の現行性を確認してから親 Session の更新を配信する。 */
      onRuntimeMessagesCommitted: (parentSessionId) => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary runtime Session broadcast",
        );
        broadcastSessions([parentSessionId]);
      },
      /** 保存済み Auxiliary 表示へインメモリの実行オプション選択を上書きする。 */
      overlayCurrentExecutionOptions: (session) =>
        mainStoreContext.executionSelections.apply(session),
      /** ストアの切替を検知してから、Auxiliary の選択内容をメモリに保持する。 */
      rememberExecutionOptions: (session, options) => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary current execution selection",
        );
        mainStoreContext.executionSelections.remember(session, options);
      },
      /** Auxiliary 作成の状態遷移を、クライアント要求 ID と関連付けて記録する。 */
      onCreationStateChanged: (event) =>
        writeAppLog({
          level: "info",
          kind: "auxiliary.creation",
          process: "main",
          message: `Auxiliary creation: ${event.status}`,
          data: { ...event, correlationId: event.clientRequestId },
        }),
      /** 現行世代と一致する間に Auxiliary の親 Session を取得する。 */
      getParentSession: async (parentSessionId) => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session parent read",
        );
        const parent = await getAuxiliaryParentSession(parentSessionId);
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session parent read",
        );
        return parent;
      },
      /** サービスを生成した永続世代が有効であることを確認してから固定の保存先を渡す。 */
      getStorage: () => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session storage access",
        );
        return storage;
      },
      /** 対象プロバイダーの探索を必要に応じて待ち、取得の前後で Auxiliary のストア世代を確認する。 */
      getModelCatalogSnapshot: async (workspacePath, providerId) => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session catalog read",
        );
        const catalog = providerId
          ? await requireProviderModelDiscoveryService().ensure(
              providerId,
              workspacePath,
            )
          : await getModelCatalog({
              ...(workspacePath ? { workspacePath } : {}),
            });
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session catalog read",
        );
        return catalog;
      },
      /** 現在の永続世代が変わらないことを確認しながら、Auxiliary の起動候補となる Character を取得する。 */
      listActiveCharacters: async () => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session character read",
        );
        const characters = await requireCharacterService().listCharacters();
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session character read",
        );
        return characters;
      },
      /** 指定 Character のスナップショットを作成し、その間に永続世代が変わっていないことを確認する。 */
      createCharacterRuntimeSnapshot: async (characterId) => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session character snapshot",
        );
        const snapshot =
          await requireCharacterService().createRuntimeSnapshot(characterId);
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session character snapshot",
        );
        return snapshot;
      },
      /** Auxiliary の起動条件を解決し、非同期照会中にストアが切り替わった場合は結果を返さない。 */
      resolveSessionLaunchSelection: async (providerId, workspacePath) => {
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session launch selection",
        );
        const selection = await requireSessionLaunchSelectionService().resolve(
          providerId,
          workspacePath,
        );
        assertPersistentStoreOwnerIsActive(
          owner,
          "Auxiliary session launch selection",
        );
        return selection;
      },
      /** 現行世代でメンテナンス外の場合に限り、Auxiliary のプロバイダー操作を排他的に実行する。 */
      runProviderRuntimeOperationExclusive: (operation) =>
        providerRuntimeOperationCoordinator.runExclusive(async () => {
          assertPersistentStoreOwnerIsActive(
            owner,
            "Auxiliary session provider operation",
          );
          if (databaseMaintenanceRequested) {
            throw new Error(
              "A database maintenance operation is in progress, so an Auxiliary Session cannot be created.",
            );
          }
          const result = await operation();
          assertPersistentStoreOwnerIsActive(
            owner,
            "Auxiliary session provider operation",
          );
          return result;
        }),
    });
  }

  return auxiliarySessionService;
}

/** 既存 Auxiliary が一つもない Session に、同じプロバイダーの既定 Auxiliary を作成する。 */
async function ensureDefaultAuxiliarySession(session: Session): Promise<void> {
  const service = requireAuxiliarySessionService();
  if ((await service.listAuxiliarySessions(session.id)).length > 0) {
    return;
  }

  const creationContext = await service.getAuxiliaryCreationContext(session.id);
  await service.createAuxiliarySession({
    parentSessionId: session.id,
    provider: session.provider,
    runtimeSelection: "latest-session",
    clientRequestId: `default:${session.id}`,
    creationContext,
  });
}

/** 現行のターンストアと Window 更新通知をつなぐターンサービスを遅延初期化する。 */
function requireSessionTurnService(): SessionTurnService {
  if (!sessionTurnService) {
    sessionTurnService = new SessionTurnService(
      requireSessionTurnStorage(),
      (turn) => {
        requireWindowBroadcastService().broadcastSessionTurnUpdated(
          turn.sessionId,
        );
      },
    );
  }
  return sessionTurnService;
}

/** Main の Window ランタイムが管理するイベント配信サービスを取得する。 */
function requireWindowBroadcastService(): WindowBroadcastService<BrowserWindow> {
  return mainWindowRuntime.getWindowBroadcastService();
}

/** Main の Window ランタイムが管理する選択ダイアログサービスを取得する。 */
function requireWindowDialogService(): WindowDialogService {
  return mainWindowRuntime.getWindowDialogService();
}

/** 現在の設定ストアを返し、永続データの初期化前なら例外にする。 */
function requireAppSettingsStorage(): PersistentStoreBundle["appSettingsStorage"] {
  if (!mainStoreContext.appSettingsStorage) {
    throw new Error("App settings storage is not initialized.");
  }

  return mainStoreContext.appSettingsStorage;
}

/** 現在の DB にプロンプトテンプレートのストアを遅延初期化する。 */
function requirePromptTemplateStorage(): NonNullable<
  typeof mainStoreContext.promptTemplateStorage
> {
  if (!mainStoreContext.promptTemplateStorage) {
    if (!mainStoreContext.dbPath) {
      throw new Error("Saved data is not initialized.");
    }
    mainStoreContext.setPromptTemplateStorage(
      new PromptTemplateStorage(mainStoreContext.dbPath),
    );
  }
  return mainStoreContext.promptTemplateStorage!;
}

/** 保存済みのプロンプトテンプレート一覧を取得する。 */
async function listPromptTemplates(): Promise<PromptTemplate[]> {
  return requirePromptTemplateStorage().listPromptTemplates();
}

/** 最新のテンプレート一覧を読み直し、対象 Window へ配信した内容を返す。 */
async function publishPromptTemplates(): Promise<PromptTemplate[]> {
  const templates = await listPromptTemplates();
  await requireMainBroadcastFacade().broadcastPromptTemplates(templates);
  return templates;
}

/** 新しいテンプレートを保存して、更新後の一覧を配信する。 */
async function createPromptTemplate(
  input: CreatePromptTemplateInput,
): Promise<PromptTemplate[]> {
  await requirePromptTemplateStorage().createPromptTemplate(input);
  return publishPromptTemplates();
}

/** 既存テンプレートの変更を保存し、最新一覧を配信する。 */
async function updatePromptTemplate(
  input: UpdatePromptTemplateInput,
): Promise<PromptTemplate[]> {
  await requirePromptTemplateStorage().updatePromptTemplate(input);
  return publishPromptTemplates();
}

/** 指定テンプレートを削除した後、残った一覧を配信する。 */
async function deletePromptTemplate(id: string): Promise<PromptTemplate[]> {
  await requirePromptTemplateStorage().deletePromptTemplate(id);
  return publishPromptTemplates();
}

/** 設定を保存し、保存結果に合わせて利用枠監視・ログイン起動・管理 Glossary スキルを同期する。 */
async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
  const savedSettings =
    await requireAppSettingsStorage().updateSettings(settings);
  requireMainObservabilityFacade().configureProviderQuotaPolling(savedSettings);
  applyLaunchAtLoginSetting(
    app,
    savedSettings.launchAtLoginEnabled,
    app.isPackaged,
  );
  await syncManagedGlossarySkillBestEffort();
  return savedSettings;
}

/** チャットのレイアウト差分だけを反映して保存を予約し、アプリ設定全体は再配信しない。 */
async function updateChatLayoutPreference(
  update: ChatLayoutPreferenceUpdate,
): Promise<void> {
  requireSettingsCatalogService().updateChatLayoutPreference(update);
}

/** 設定を既定値に戻し、旧設定に基づく承認レビューと監視・ログイン起動設定を更新する。 */
async function resetAppSettings(): Promise<AppSettings> {
  approvalReviewSettingsRevision++;
  approvalReviewInputs.invalidate();
  const settings = await requireAppSettingsStorage().resetSettings();
  requireMainObservabilityFacade().configureProviderQuotaPolling(settings);
  applyLaunchAtLoginSetting(app, settings.launchAtLoginEnabled, app.isPackaged);
  return settings;
}

/** 現行の Mate ストアを返し、未初期化なら読み書きを拒否する。 */
function requireMateStorage(): PersistentStoreBundle["mateStorage"] {
  if (!mainStoreContext.mateStorage) {
    throw new Error("Mate storage is not initialized.");
  }

  return mainStoreContext.mateStorage;
}

/** 現在の Character ストアを取得し、未初期化なら例外にする。 */
function requireCharacterStorage(): CharacterStorageAccess {
  if (!mainStoreContext.characterStorage) {
    throw new Error("Character storage is not initialized.");
  }

  return mainStoreContext.characterStorage;
}

const characterWorkspaceOperationCoordinator =
  new CharacterWorkspaceOperationCoordinator();

/** Character の保存とワークスペース操作の排他制御をまとめるサービスを遅延初期化する。 */
function requireCharacterService(): CharacterService {
  if (!characterService) {
    characterService = new CharacterService(
      requireCharacterStorage(),
      characterWorkspaceOperationCoordinator,
    );
  }

  return characterService;
}

/** 同梱スキルと通常 Session 作成経路を使い、Character 制作サービスを遅延初期化する。 */
function requireCharacterAuthoringService(): CharacterAuthoringService {
  if (!characterAuthoringService) {
    characterAuthoringService = new CharacterAuthoringService({
      /** 同じ Character のワークスペース操作を直列化する。 */
      runCharacterWorkspaceOperationExclusive: (characterId, operation) =>
        characterWorkspaceOperationCoordinator.runExclusive(
          characterId,
          operation,
        ),
      bundledSkillPath: bundledCharacterAuthoringSkillPath,
      /** Character 制作用の起動条件を通常 Session の作成処理に渡す。 */
      createSession: (input) =>
        requireMainSessionCommandFacade().createSession(input),
      /** 制作対象の保存済み Character を取得する。 */
      getCharacter: (characterId) =>
        requireCharacterService().getCharacter(characterId),
      /** 制作対象の Character が使う専用ディレクトリを取得する。 */
      getCharacterDirectory: (characterId) =>
        requireCharacterService().getCharacterDirectory(characterId),
      /** 制作処理中の切替検出に使う、現行の通常 Session ストアを返す。 */
      getSessionStorageIdentity: () => requireSessionStorage(),
      /** 指定プロバイダーが Character 制作に使えるかを解決する。 */
      resolveProvider: (providerId) =>
        requireSessionPersistenceService().resolveCharacterAuthoringProvider(
          providerId,
        ),
    });
  }

  return characterAuthoringService;
}

const MANAGED_GLOSSARY_SKILL_BUNDLE: ManagedSkillBundleDescriptor = {
  skillName: WITHMATE_GLOSSARY_SKILL_NAME,
  bundledSkillPath: bundledGlossarySkillPath,
  documentationRelativePaths: ["SKILL.md", "agents"],
};

/** 現行の設定・バージョン・配布形態を参照する管理スキル配布サービスを初期化する。 */
function requireManagedSkillDistributionService(): ManagedSkillDistributionService {
  if (!managedSkillDistributionService) {
    managedSkillDistributionService = new ManagedSkillDistributionService({
      /** スキルの同期対象を判断するため、最新のアプリ設定を取得する。 */
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      /** スキル配布に現在のアプリバージョンを渡す。 */
      getAppVersion: () => app.getVersion(),
      /** 配布版と開発実行を区別するため Electron の配布状態を返す。 */
      isPackagedApp: () => app.isPackaged,
    });
  }

  return managedSkillDistributionService;
}

/** Mate の初回プロフィールを保存し、保存結果を返す。 */
async function createMate(
  input: Parameters<MateStorage["createMate"]>[0],
): ReturnType<MateStorage["createMate"]> {
  const profile = await requireMateStorage().createMate(input);
  return profile;
}

/** 現在の Mate プロフィールに指定の変更を適用する。 */
async function updateMate(
  input: Parameters<MateStorage["updateMate"]>[0],
): ReturnType<MateStorage["updateMate"]> {
  return requireMateStorage().updateMate(input);
}

/** Mate のアバター画像を保存する。 */
async function setMateAvatar(
  input: Parameters<MateStorage["setMateAvatar"]>[0],
): ReturnType<MateStorage["setMateAvatar"]> {
  return requireMateStorage().setMateAvatar(input);
}

/** 現在のストアを使って Mate のプロフィールと関連ファイルをリセットする。 */
async function resetMate(): Promise<void> {
  await requireMateStorage().resetMate();
}

/** Character 制作 Session を作成し、その Window を開いて一覧更新を配信する。 */
async function startCharacterAuthoringSession(
  input: StartCharacterAuthoringSessionInput,
): Promise<CharacterAuthoringSessionStartResult> {
  const result = await requireCharacterAuthoringService().startSession(input);
  await openSessionWindow(result.session.id);
  void broadcastSessions([result.session.id]);
  return result;
}

/** 旧保存形式の Mate 項目ストアを必要時に構成し、Worker 世代では利用を拒否する。 */
function requireMateProfileItemStorage(): NonNullable<
  typeof mainStoreContext.mateProfileItemStorage
> {
  if (mainStoreContext.storageWorker) {
    throw new Error("Mate profile items are not available in this runtime.");
  }
  if (!mainStoreContext.dbPath) {
    throw new Error("Saved data is not initialized.");
  }

  if (!mainStoreContext.mateProfileItemStorage) {
    mainStoreContext.setMateProfileItemStorage(
      new MateProfileItemStorage(mainStoreContext.dbPath),
    );
  }

  return mainStoreContext.mateProfileItemStorage!;
}

/** Main Window ランタイムが管理する renderer エントリのローダーを取得する。 */
function requireWindowEntryLoader(): WindowEntryLoader {
  return mainWindowRuntime.getWindowEntryLoader();
}

/** Home や設定などを扱う補助 Window サービスを取得する。 */
function requireAuxWindowService(): AuxWindowService<BrowserWindow> {
  return mainWindowRuntime.getAuxWindowService();
}

/** キュー受理前に Session の作業ディレクトリを検証し、使用不可の理由を例外に含める。 */
async function assertSessionQueueWorkspaceAvailable(
  session: Session,
): Promise<void> {
  const validation = await workspaceDirectoryValidationService.validate(
    session.workspacePath,
  );
  if (!validation.valid)
    throw new Error(
      `Workspace is unavailable. ${resolveWorkspaceDirectoryValidationMessage(validation)}`,
    );
}

/** キューが扱う Session を通常のランタイム用ストアから解決し、なければ Auxiliary を探す。 */
async function getQueueRuntimeSession(
  sessionId: string,
): Promise<Session | null> {
  const main = await getRuntimeSession(sessionId);
  if (main) return main;
  return requireAuxiliarySessionService().getAuxiliaryRuntimeSession(sessionId);
}

/** 送信元 Session の種別・世代・親がなお一致する場合に、送信一覧の更新を正しい Window へ通知する。 */
function publishSentInputChanged(
  origin: SessionTurnQueueOrigin | SessionSteerOrigin | undefined,
): void {
  if (
    origin?.kind !== "session" ||
    !origin.actorSessionId ||
    !origin.actorIncarnationId
  )
    return;
  const owner = mainStoreContext.activePersistentStoreOwner;
  void (async () => {
    const source = await getQueueRuntimeSession(origin.actorSessionId!);
    const auxiliary =
      await requireAuxiliarySessionService().getAuxiliarySessionStatus(
        origin.actorSessionId!,
      );
    if (
      !source ||
      getSessionIncarnationId(source) !== origin.actorIncarnationId ||
      (auxiliary ? "auxiliary" : "main") !== origin.actorKind ||
      (auxiliary &&
        (!("actorMainSessionId" in origin) ||
          auxiliary.parentSessionId !== origin.actorMainSessionId)) ||
      mainStoreContext.activePersistentStoreOwner !== owner
    )
      return;
    requireWindowBroadcastService().broadcastSessionSentDeliveriesChanged(
      source.id,
      auxiliary?.parentSessionId ?? source.id,
    );
  })().catch((error) =>
    writeAppLog({
      level: "warn",
      kind: "session.sent-input.broadcast-failed",
      process: "main",
      message: "Outgoing input change publication failed",
      error: appLogService.errorToLogError(error),
    }),
  );
}

/** Auxiliary の有無を解決し、対象ターンを扱うべきランタイムと一緒に返す。 */
async function resolveQueueSessionRuntime(sessionId: string) {
  const auxiliary =
    await requireAuxiliarySessionService().getAuxiliarySessionStatus(sessionId);
  const runtime = auxiliary
    ? requireAuxiliarySessionRuntimeService()
    : requireSessionRuntimeService();
  return { runtime, auxiliary };
}

/** 実行枠が空いた Session のキューと、そのターンの解放を待つ送信先を再開する。 */
function wakeSessionQueueAfterRunReleased(sessionId: string): void {
  sessionTurnQueueService?.wake(sessionId);
  void sessionTurnQueueService
    ?.wakeSourceTurnDependents(sessionId)
    .catch((error) =>
      writeAppLog({
        level: "warn",
        kind: "session-queue.source-turn-wake-failed",
        process: "main",
        message: "Could not resume messages waiting for the sender Turn.",
        data: {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      }),
    );
}

/** 現行 Worker のキューを通常・Auxiliary ランタイムに接続し、実行結果に応じて依存ターンと Window を更新する。 */
function requireMainSessionTurnQueueService(): SessionTurnQueueService {
  if (!sessionTurnQueueService) {
    const owner =
      requireActivePersistentStoreOwnerForFactory("Session turn queue");
    const store = owner.storageWorker?.stores.queue;
    if (!store)
      throw new Error(
        "The Session turn queue is unavailable for this database.",
      );
    sessionTurnQueueService = new SessionTurnQueueService({
      store,
      /** 送信先をまだ解放していない通常ランタイムのターン ID を返す。 */
      getUnreleasedSourceTurnIds: () =>
        sessionRuntimeService?.getUnreleasedTurnIds() ?? [],
      /** 稼働中だけでなく終了・保守・プロバイダー停止中も、対象 Session の新規キュー実行を待たせる。 */
      isRunInFlight: async (sessionId) => {
        const session = await getQueueRuntimeSession(sessionId);
        return (
          databaseMaintenanceRequested ||
          requireSessionWindowBridge().isQuitPending() ||
          Boolean(
            session &&
            settingsCatalogService &&
            !settingsCatalogService.isProviderAvailableForTurn(
              session.provider,
            ),
          ) ||
          isSessionRunInFlight(sessionId, "self")
        );
      },
      /** 現行ストア世代でターンを適切なランタイムへ配送し、Auxiliary なら親との関係を実行中に追跡する。 */
      dispatch: async (receipt, onStarted, control) => {
        assertPersistentStoreOwnerIsActive(owner, "Queue dispatch");
        const { runtime, auxiliary } = await resolveQueueSessionRuntime(
          receipt.sessionId,
        );
        assertPersistentStoreOwnerIsActive(owner, "Queue dispatch");
        /** 受領内容と開始通知を選定したランタイムに渡してターンを実行する。 */
        const run = () =>
          runtime.runQueuedSessionTurn(receipt, onStarted, control);
        const result = await (auxiliary
          ? auxiliaryLiveRunParents.trackRun(auxiliary, owner, run)
          : run());
        assertPersistentStoreOwnerIsActive(owner, "Queue dispatch");
        return result;
      },
      /** Coordination が固定した種別を優先してランタイムを選び、キュー項目を指定ターンへの追加入力として送る。 */
      sendInput: async (receipt, expectedTurnId) => {
        assertPersistentStoreOwnerIsActive(owner, "Queue input");
        const kind = receipt.captured.coordination?.targetKind;
        const runtime =
          kind === "main"
            ? requireSessionRuntimeService()
            : kind === "auxiliary"
              ? requireAuxiliarySessionRuntimeService()
              : (await resolveQueueSessionRuntime(receipt.sessionId)).runtime;
        const result = await runtime.steerQueuedSessionTurn(
          receipt,
          expectedTurnId,
        );
        assertPersistentStoreOwnerIsActive(owner, "Queue input");
        return result;
      },
      /** 保守・終了中を除き、Coordination が指定したランタイムから現在入力可能なターンを探す。 */
      getCoordinationInputTurnId: async (receipt) => {
        assertPersistentStoreOwnerIsActive(owner, "Coordination input");
        if (
          databaseMaintenanceRequested ||
          requireSessionWindowBridge().isQuitPending()
        )
          return null;
        const kind = receipt.captured.coordination?.targetKind;
        if (!kind) return null;
        const runtime =
          kind === "main"
            ? requireSessionRuntimeService()
            : requireAuxiliarySessionRuntimeService();
        const turnId = await runtime.getCoordinationInputTurnId(receipt);
        assertPersistentStoreOwnerIsActive(owner, "Coordination input");
        return turnId;
      },
      /** 復旧した受領に対応する送信待ちを必要に応じて再開し、同じ incarnation の Session 表示に反映する。 */
      onTurnRecovered: (receipt) => {
        void (async () => {
          // ランタイムのガードが終了した後で、Worker が永続化された受領記録を照合した。
          assertPersistentStoreOwnerIsActive(
            owner,
            "Recovered Turn publication",
          );
          if (receipt.state !== "interrupted")
            await sessionTurnQueueService?.wakeSourceTurnDependents(
              receipt.sessionId,
            );
          const summary = await owner.sessionStorage.getSessionSummary?.(
            receipt.sessionId,
          );
          assertPersistentStoreOwnerIsActive(
            owner,
            "Recovered Turn publication",
          );
          if (summary?.incarnationId === receipt.incarnationId) {
            mainStoreContext.setSessions(
              mainStoreContext.sessions.map((session) =>
                session.id === summary.id &&
                getSessionIncarnationId(session) === receipt.incarnationId
                  ? sessionSummaryToSession(summary)
                  : session,
              ),
            );
            broadcastSessions([summary.id]);
          } else {
            const auxiliary =
              await requireAuxiliarySessionService().getAuxiliarySessionStatus(
                receipt.sessionId,
              );
            assertPersistentStoreOwnerIsActive(
              owner,
              "Recovered Auxiliary Turn publication",
            );
            if (auxiliary?.createdAt === receipt.incarnationId)
              broadcastSessions([auxiliary.parentSessionId]);
          }
        })().catch((error) =>
          writeAppLog({
            level: "warn",
            kind: "session.queue.recovery-publication-failed",
            process: "main",
            message: "Could not publish the recovered Turn",
            error: appLogService.errorToLogError(error),
          }),
        );
      },
      /** 現行世代の更新に限り、送信元の一覧と対象 Session を所有する Window のキュー表示へ通知する。 */
      onChanged: ({ sessionId }, origin) => {
        if (mainStoreContext.activePersistentStoreOwner === owner) {
          publishSentInputChanged(origin);
          void requireAuxiliarySessionService()
            .getAuxiliarySessionStatus(sessionId)
            .then((auxiliary) => {
              if (mainStoreContext.activePersistentStoreOwner === owner) {
                requireWindowBroadcastService().broadcastSessionTurnQueueChanged(
                  sessionId,
                  auxiliary?.parentSessionId ?? sessionId,
                );
              }
            })
            .catch((error) =>
              writeAppLog({
                level: "warn",
                kind: "session.queue.broadcast-failed",
                process: "main",
                message: "Queue change publication failed",
                error: appLogService.errorToLogError(error),
              }),
            );
        }
      },
    });
  }
  return sessionTurnQueueService;
}

/** 返信参照が元の入力またはメッセージを今も指していることを、保存済み実行情報で確認する。 */
async function assertSavedReplyTo(reference: SessionReply): Promise<void> {
  const owner = requireActivePersistentStoreOwnerForFactory(
    "Session reply reference",
  );
  const execution = owner.storageWorker!.stores.execution;
  const { target } = reference;
  if ("receiptId" in reference) {
    const result = await execution.execute({
      target,
      operation: "get_execution_input",
      request: {
        target,
        receiptId: reference.receiptId,
        stage: "original",
        maxChars: 2,
      },
    });
    if (!result.ok)
      throw new Error("The original reply target is no longer available.");
  } else {
    const result = await execution.execute({
      target,
      operation: "get_message",
      request: { target, seq: reference.seq, maxChars: 2 },
    });
    if (
      !result.ok ||
      !("seq" in result) ||
      result.seq !== reference.seq ||
      !("role" in result) ||
      !("turn" in result) ||
      (reference.finalAnswerTurnId &&
        reference.finalAnswerTurnId !==
          savedFinalAnswerTurnId({
            role: String(result.role),
            turn: result.turn,
          }))
    ) {
      throw new Error("The saved reply target no longer matches.");
    }
  }
  assertPersistentStoreOwnerIsActive(owner, "Session reply reference");
}

/** 永続 Worker のキュー受理と、現行の返信先・入力・実行条件の検査を結び付ける窓口を初期化する。 */
function requireMainSessionTurnQueueFacade(): MainSessionTurnQueueFacade {
  if (!mainSessionTurnQueueFacade) {
    const owner = requireActivePersistentStoreOwnerForFactory(
      "Session turn queue facade",
    );
    const store = owner.storageWorker?.stores.queue;
    if (!store)
      throw new Error(
        "The Session turn queue is unavailable for this database.",
      );
    mainSessionTurnQueueFacade = new MainSessionTurnQueueFacade({
      /** 通知の送信元と現在のライブターンが一致する場合だけ、その応答途中のテキストを取得する。 */
      captureSourceDisplayText: (origin) => {
        const live = origin.actorSessionId
          ? getLiveSessionRun(origin.actorSessionId)
          : null;
        return live &&
          origin.actorTurnId &&
          live.sessionTurnId === origin.actorTurnId
          ? live.assistantText
          : undefined;
      },
      rememberSourceDisplay,
      /** 配送を保留すべき通常 Session の未解放ターン ID を取得する。 */
      getUnreleasedSourceTurnIds: () =>
        sessionRuntimeService?.getUnreleasedTurnIds() ?? [],
      /** キュー受理を開始した永続ストア世代がなお現行か確認する。 */
      assertActive: () =>
        assertPersistentStoreOwnerIsActive(owner, "Queue acceptance"),
      /** 永続世代の切替、メンテナンス、終了要求があれば新規キュー受理を拒否する。 */
      assertAccepting: () => {
        assertPersistentStoreOwnerIsActive(owner, "Queue acceptance");
        if (
          databaseMaintenanceRequested ||
          requireSessionWindowBridge().isQuitPending()
        ) {
          throw new Error(
            "The app is quitting or maintaining its database, so a new Turn cannot be queued.",
          );
        }
      },
      getSession: getQueueRuntimeSession,
      assertSavedReplyTo,
      /** Coordination の保存対象で宣言された種別に従い、通常または Auxiliary の実行データを取得する。 */
      getSessionForCoordination: (target) =>
        target.kind === "main"
          ? getRuntimeSession(target.sessionId)
          : requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
              target.sessionId,
            ),
      /** キューのファサードが捕捉した永続世代から設定を取得する。 */
      getAppSettings: async () => owner.appSettingsStorage.getSettings(),
      validateWorkspace: assertSessionQueueWorkspaceAvailable,
      /** 設定で無効なプロバイダーを拒否してから、対象ワークスペースのカタログを解決する。 */
      validateProvider: async (session) => {
        if (
          !getProviderAppSettings(
            await requireAppSettingsStorage().getSettings(),
            session.provider,
          ).enabled
        ) {
          throw new Error("This provider is disabled in Settings.");
        }
        const catalog = await resolveProviderCatalog(
          session.provider,
          session.workspacePath,
        );
        return { provider: catalog.provider };
      },
      /** 対象 Session の管理済みプロバイダー設定と Auxiliary の親を反映して送信前のプレビューを作る。 */
      preview: async (session, message) => {
        const auxiliary =
          await requireAuxiliarySessionService().getAuxiliarySessionStatus(
            session.id,
          );
        const providerSession = await resolveManagedProviderSession(
          session,
          auxiliary?.parentSessionId,
        );
        return resolveComposerPreview(providerSession, message);
      },
      /** 再試行元の保存済み実行を指定受領 ID で読み、成功応答を実行結果スキーマで検証する。 */
      readRetryExecution: async (input) => {
        const result = await owner.storageWorker!.stores.execution.execute({
          target: input.target,
          operation: "get_execution",
          request: { target: input.target, receiptId: input.receiptId },
        });
        assertPersistentStoreOwnerIsActive(owner, "Failed Turn retry");
        if (!result.ok) return result;
        return executionOperationResultSchemas.get_execution.parse(result);
      },
      /** 再試行で元の添付参照を使えることを、現在の管理済みプロバイダー設定で検証する。 */
      validateRetryAttachments: async (session, attachments) => {
        const auxiliary =
          await requireAuxiliarySessionService().getAuxiliarySessionStatus(
            session.id,
          );
        const providerSession = await resolveManagedProviderSession(
          session,
          auxiliary?.parentSessionId,
        );
        await assertCapturedComposerAttachmentsAvailable(
          providerSession,
          attachments,
        );
      },
      store,
      service: requireMainSessionTurnQueueService(),
    });
  }
  return mainSessionTurnQueueFacade;
}

/** 通常 Session のランタイムを、現行永続世代・ターンの受付制御・実行監視へ接続する。 */
function requireSessionRuntimeService(): SessionRuntimeService {
  if (!sessionRuntimeService) {
    const owner = requireActivePersistentStoreOwnerForFactory(
      "Session runtime service",
    );
    sessionRuntimeService = createMainSessionRuntime({
      owner: {
        /** 通常ランタイムの個別操作が開始時と同じ永続世代に属するか検査する。 */
        assertActive: (operation) =>
          assertPersistentStoreOwnerIsActive(
            owner,
            `Session runtime ${operation}`,
          ),
        /** 生成時に捕捉した永続世代が現在も使われているか返す。 */
        isActive: () => mainStoreContext.activePersistentStoreOwner === owner,
      },
      admission: {
        /** 通常 Session として受付前の検証と予約を排他的に実行する。 */
        runSessionAdmissionExclusive: (sessionId, operation, signal) =>
          runSessionTurnAdmission(sessionId, false, operation, signal),
      },
      sessions: {
        /** 通常ランタイムが実行に使う Session のメタデータを永続ストアから取得する。 */
        getSession: (sessionId) => getRuntimeSession(sessionId),
        /** 通常ターンが実行中に受理した追加の入力を保存窓口に渡す。 */
        appendRunningInput: (...args) =>
          requireMainSessionPersistenceFacade().appendRunningInput(...args),
        /** 追加入力の開始を通常 Session の保存窓口に記録する。 */
        beginRunningInput: (...args) =>
          requireMainSessionPersistenceFacade().beginRunningInput(...args),
        /** プロバイダーへの追加入力の成否を通常 Session の保存結果に反映する。 */
        settleRunningInput: (...args) =>
          requireMainSessionPersistenceFacade().settleRunningInput(...args),
        /** 実行開始時に捕捉したキュー記録に対応する受領を Worker から読む。 */
        getQueuedInputReceipt: (receipt) =>
          owner.storageWorker!.stores.queue.getReceipt(
            receipt,
            receipt.requestId,
          ),
        /** 期待条件を指定して通常 Session のランタイムメタデータを保存する。 */
        checkpointRuntimeMetadata: (session, expected) =>
          requireMainSessionPersistenceFacade().checkpointRuntimeMetadata(
            session,
            expected,
          ),
        /** 承認レビュー入力と調整し、メッセージ数を照合して通常 Session のターン開始を保存する。 */
        persistRunningTurnStart: (session, expectedMessageCount) =>
          approvalReviewInputs.during(() =>
            requireMainSessionPersistenceFacade().persistRunningTurnStart(
              session,
              expectedMessageCount,
            ),
          ),
        /** 承認レビュー入力と調整し、キュー ID とターン情報を指定して通常 Session の開始を保存する。 */
        persistQueuedTurnStart: (session, count, queueId, turn) =>
          approvalReviewInputs.during(() =>
            requireMainSessionPersistenceFacade().persistQueuedTurnStart(
              session,
              count,
              queueId,
              turn,
            ),
          ),
        /** Character 制作 Session に残ったランタイム状態を保存窓口でクリアする。 */
        clearCharacterAuthoringRuntimeState: (session) =>
          requireMainSessionPersistenceFacade().clearCharacterAuthoringRuntimeState(
            session,
          ),
        beginSourceDisplayTurn,
        /** 通常ターンの終了を保存してから、送信元表示の位置を検証し未読結果の追跡に登録する。 */
        appendTerminalSession: async (session, terminalCommit) => {
          const persisted =
            await requireMainSessionPersistenceFacade().appendTerminalSession(
              session,
              terminalCommit,
            );
          await verifySourceDisplays(session, String(terminalCommit.turnId));
          sessionResultReadService.recordResult(terminalCommit);
          return persisted;
        },
      },
      resolution: {
        /** 実行直前に Character スナップショットを解決する。Character 制作 Session には専用の解決手順を使う。 */
        resolveRuntimeSessionForTurn: (session) =>
          session.sessionKind === "character-authoring"
            ? resolveCharacterAuthoringRuntimeSessionForTurn(
                session,
                (characterId) =>
                  requireCharacterService().createRuntimeSnapshot(characterId),
              )
            : refreshSessionCharacterRuntimeSnapshot(
                session,
                (characterId, previousSnapshot) =>
                  requireCharacterService().refreshRuntimeSnapshot(
                    characterId,
                    previousSnapshot,
                  ),
              ),
        resolveComposerPreview,
        /** 通常ターンの再実行前にワークスペースと保存済み添付参照を検証する。 */
        assertCapturedComposerAttachmentsAvailable: async (
          session,
          attachments,
        ) => {
          await assertSessionQueueWorkspaceAvailable(session);
          await assertCapturedComposerAttachmentsAvailable(
            session,
            attachments,
          );
        },
        /** 通常 Session の管理スキルなどを解決したプロバイダー向け Session を返す。 */
        resolveProviderSession: (session) =>
          resolveManagedProviderSession(session),
        /** 通常 Session の個別ファイル保存先を作成して返す。 */
        resolveSessionFolderPath: (sessionId) =>
          ensureSessionFilesDirectory(sessionId),
        resolveCrewFolderPath: resolveSavedCrewFolderPath,
        resolveProviderCatalog,
      },
      provider: {
        getProviderCodingAdapter,
        resetProviderSessionThread,
        /** 通常 Session の現在の保存識別情報で、プロバイダー向けのツール権限を発行する。 */
        getProviderAgentRuntimeBinding: ({ session, provider }) =>
          issueProviderAgentRuntimeBinding(session, provider.id),
        /** 通常ターンの開始時に、ターン限定の管理 MCP バインディングを発行する。 */
        beginProviderAgentRuntimeTurn: ({
          session,
          binding,
          signal,
          executionOptions,
        }) =>
          beginManagedProviderTurn(session, binding, signal, executionOptions),
        endProviderAgentRuntimeTurn: endManagedProviderTurn,
      },
      context: {
        /** 通常ランタイムのコンテキストに現行のアプリ設定を渡す。 */
        getAppSettings: () => requireAppSettingsStorage().getSettings(),
        /** ランタイムの生成世代に属する Session 指示を読み取る。 */
        readSessionInstructions: (target) =>
          getSessionInstructions(target, owner),
        assertSavedReplyTo,
        /** 返信対象のメッセージ位置を起点に、保存済み会話スレッドの文脈を取り出す。 */
        readMainMessageThread: async (target, seq) => {
          const result = await owner.storageWorker!.stores.execution.execute({
            target,
            operation: "read_conversation_threads",
            request: { target },
          });
          return result.ok
            ? savedMessageConversationFrame(
                conversationThreadsResultSchema.parse(result),
                seq,
              )
            : undefined;
        },
      },
      turn: {
        /** 通常実行のターン記録を現行ストアへ追加する。 */
        createSessionTurn: (entry) =>
          requireSessionTurnService().createSessionTurn(entry),
        /** 保存済みの通常ターンを指定 ID で更新する。 */
        updateSessionTurn: (id, entry) =>
          requireSessionTurnService().updateSessionTurn(id, entry),
      },
      live: {
        setLiveSessionRun,
        getLiveSessionRun,
        /** 通常実行で受け取った利用枠情報をプロバイダーごとに更新する。 */
        setProviderQuotaTelemetry: (telemetry) =>
          setProviderQuotaTelemetry(telemetry.provider, telemetry),
        /** 通常実行中に観測したコンテキスト使用量を対象 Session に反映する。 */
        setSessionContextTelemetry: (telemetry) =>
          setSessionContextTelemetry(telemetry.sessionId, telemetry),
        scheduleProviderQuotaTelemetryRefresh,
        broadcastLiveSessionRun,
      },
      interaction: {
        waitForApprovalDecision: waitForLiveApprovalDecision,
        startWithMateApprovalReview,
        waitForElicitationResponse: waitForLiveElicitationResponse,
        /** 対象の通常 Session で保留中の承認を取り消す。 */
        resolvePendingApprovalRequest: (sessionId) =>
          requireSessionApprovalService().cancelSession(sessionId),
        /** 通常 Session が返答を待っているプロバイダーの質問を取り消す。 */
        resolvePendingElicitationRequest: (sessionId) =>
          requireSessionElicitationService().cancelSession(sessionId),
        invalidateProviderSessionThread,
      },
      notification: {
        onSentInputChanged: publishSentInputChanged,
        /** 通常ターンの終了結果を OS の通知サービスへ渡す。 */
        notifySessionTurnTerminal: async (notification) => {
          await requireSessionTurnNotificationService().notifyTurnTerminal(
            notification,
          );
        },
        onSessionRunReleased: wakeSessionQueueAfterRunReleased,
      },
      timing: { currentTimestampLabel },
    });
  }
  return sessionRuntimeService;
}

/** OS 通知の可否、アプリ設定、通知先の Window 解決を扱うターン通知サービスを遅延初期化する。 */
function requireSessionTurnNotificationService(): SessionTurnNotificationService<NativeImage> {
  if (!sessionTurnNotificationService) {
    sessionTurnNotificationService = new SessionTurnNotificationService({
      platform: process.platform,
      /** Electron が実行環境で OS 通知をサポートするか返す。 */
      isNotificationSupported: () => Notification.isSupported(),
      /** 通常のターン通知をユーザー設定で有効にしているか取得する。 */
      isNotificationEnabled: async () =>
        (await requireAppSettingsStorage().getSettings())
          .sessionTurnNotificationEnabled,
      /** 承認を求める通知をユーザー設定で有効にしているか取得する。 */
      isApprovalNotificationEnabled: async () =>
        (await requireAppSettingsStorage().getSettings())
          .sessionApprovalNotificationEnabled,
      /** 応答テキストをターン通知へ含める設定か取得する。 */
      isResponsePreviewEnabled: async () =>
        (await requireAppSettingsStorage().getSettings())
          .sessionTurnNotificationResponsePreviewEnabled,
      /** 対象 Session の Window が破棄されておらずフォーカス中かを確認する。 */
      isSessionWindowFocused: (sessionId) => {
        const sessionWindow = requireSessionWindowBridge().getWindow(sessionId);
        return Boolean(
          sessionWindow &&
          !sessionWindow.isDestroyed() &&
          sessionWindow.isFocused(),
        );
      },
      /** 通知判断に使うため、対象 Session の Window が存続しているか返す。 */
      isSessionWindowOpen: (sessionId) => {
        const sessionWindow = requireSessionWindowBridge().getWindow(sessionId);
        return Boolean(sessionWindow && !sessionWindow.isDestroyed());
      },
      /** 絶対パスから通知用画像を読み取り、相対パスや空の画像は使用しない。 */
      loadCharacterIcon: (iconPath) => {
        if (!path.isAbsolute(iconPath)) {
          return null;
        }

        const icon = nativeImage.createFromPath(iconPath);
        return icon.isEmpty() ? null : icon;
      },
      /** Electron 通知を作成し、サービスが必要とする操作とイベント購読を公開する。 */
      createNotification: (options) => {
        const notification = new Notification(options);
        return {
          /** 作成済みの OS 通知を表示する。 */
          show: () => notification.show(),
          /** 表示中の OS 通知を閉じる。 */
          close: () => notification.close(),
          /** 通知のクリックを指定リスナーで受ける。 */
          onClick: (listener) => {
            notification.on("click", listener);
          },
          /** 通知が閉じられた理由をリスナーへ渡す。 */
          onClose: (listener) => {
            notification.on("close", (details) => listener(details.reason));
          },
          /** Electron の表示失敗イベントから通知エラーをリスナーへ渡す。 */
          onFailed: (listener) => {
            notification.on("failed", (_event, error) => listener(error));
          },
        };
      },
      /** 通知内容を解決するため、対象の通常 Session を保存層から読む。 */
      getSession: (sessionId) => requireSessionStorage().getSession(sessionId),
      /** 通知で指定された通常 Session の Window を開く。 */
      openSessionWindow: async (sessionId) => {
        await openSessionWindow(sessionId);
      },
      /** Auxiliary と親の保存情報が今も一致する場合に限り、通知から該当 Auxiliary を表示する。 */
      openAuxiliarySessionWindow: async (
        parentSessionId,
        auxiliarySessionId,
      ) => {
        const auxiliary =
          await requireAuxiliarySessionService().getAuxiliarySession(
            auxiliarySessionId,
          );
        if (
          !auxiliary ||
          auxiliary.parentSessionId !== parentSessionId ||
          !(await requireSessionStorage().getSession(parentSessionId))
        ) {
          throw new Error(
            "The Auxiliary Session notification target could not be found.",
          );
        }
        await requireSessionWindowBridge().openAuxiliarySessionWindow(
          parentSessionId,
          auxiliarySessionId,
        );
      },
      /** 通知サービスの選択に応じて Home を開く。 */
      openHomeWindow: async () => {
        await createHomeWindow();
      },
      /** 通知のイベント種別と Session ID を記録し、原因がある場合はログに含める。 */
      logWarning: (event, sessionId, error) => {
        writeAppLog({
          level: "warn",
          kind: `session.turn-notification.${event}`,
          process: "main",
          message: "Session turn notification warning",
          data: { sessionId },
          ...(error === undefined
            ? {}
            : { error: appLogService.errorToLogError(error) }),
        });
      },
    });
  }

  return sessionTurnNotificationService;
}

/** 親の実行文脈と表示先を利用できるように、Auxiliary 専用ランタイムを現在の永続世代へ結び付ける。 */
function requireAuxiliarySessionRuntimeService(): SessionRuntimeService {
  if (!auxiliarySessionRuntimeService) {
    const owner = requireActivePersistentStoreOwnerForFactory(
      "Auxiliary session runtime service",
    );
    auxiliarySessionRuntimeService = createAuxiliarySessionRuntime({
      owner: {
        /** Auxiliary ランタイムの操作が現在のストア世代で行われていることを確認する。 */
        assertActive: (operation) =>
          assertPersistentStoreOwnerIsActive(owner, operation),
      },
      admission: {
        /** Auxiliary として親の存在も検査する排他区間で、ターンの受付と予約を行う。 */
        runSessionAdmissionExclusive: (sessionId, operation, signal) =>
          runSessionTurnAdmission(sessionId, true, operation, signal),
      },
      auxiliary: {
        /** 対象 Auxiliary をプロバイダー実行用の Session として取得する。 */
        getRuntimeSession: (sessionId) =>
          requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
            sessionId,
          ),
        /** 有効なストア世代で Auxiliary のメタデータを読み、監視表示のために親との関係を保持する。 */
        getSession: async (sessionId) => {
          const auxiliary =
            await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
              sessionId,
            );
          assertPersistentStoreOwnerIsActive(
            owner,
            "Auxiliary live delivery owner",
          );
          if (auxiliary) auxiliaryLiveRunParents.remember(auxiliary, owner);
          return auxiliary;
        },
        /** 承認レビュー入力と調整し、期待メッセージ数で照合した Auxiliary の開始を保存する。 */
        persistRunningTurnStart: (session, expectedMessageCount) =>
          approvalReviewInputs.during(() =>
            requireAuxiliarySessionService().persistRunningTurnStart(
              session,
              expectedMessageCount,
            ),
          ),
        /** 承認レビュー入力と調整し、キューに紐づく Auxiliary ターンの開始を保存する。 */
        persistQueuedTurnStart: (session, count, queueId, turn) =>
          approvalReviewInputs.during(() =>
            requireAuxiliarySessionService().persistQueuedTurnStart(
              session,
              count,
              queueId,
              turn,
            ),
          ),
        /** 実行中に受理した追加入力を Auxiliary の会話に保存する。 */
        appendRunningInput: (...args) =>
          requireAuxiliarySessionService().appendRunningInput(...args),
        /** Auxiliary に対する実行中の追加入力の開始を記録する。 */
        beginRunningInput: (...args) =>
          requireAuxiliarySessionService().beginRunningInput(...args),
        /** Auxiliary への追加入力の成否を保存状態に反映する。 */
        settleRunningInput: (...args) =>
          requireAuxiliarySessionService().settleRunningInput(...args),
        beginSourceDisplayTurn,
        /** Auxiliary のターン終了を保存し、送信元表示を検証して結果の未読追跡に登録する。 */
        appendTerminalSession: async (session, commit, options) => {
          const persisted =
            await requireAuxiliarySessionService().appendTerminalSession(
              session,
              commit,
              options,
            );
          await verifySourceDisplays(session, String(commit.turnId));
          sessionResultReadService.recordResult(commit);
          return persisted;
        },
        /** 期待状態と照合しながら Auxiliary の実行メタデータを保存する。 */
        checkpointRuntimeMetadata: (session, expected) =>
          requireAuxiliarySessionService().checkpointRuntimeMetadata(
            session,
            expected,
          ),
        /** 指定 ID に対応する Auxiliary の保存済み情報が存在するか返す。 */
        isAuxiliarySession: async (sessionId) =>
          Boolean(
            await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
              sessionId,
            ),
          ),
      },
      parent: { getSession: getRuntimeSession },
      resolution: {
        assertSavedReplyTo,
        resolveComposerPreview,
        resolveProviderCatalog,
        /** Auxiliary の再実行に使うワークスペースと元の添付参照を確認する。 */
        assertCapturedComposerAttachmentsAvailable: async (
          session,
          attachments,
        ) => {
          await assertSessionQueueWorkspaceAvailable(session);
          await assertCapturedComposerAttachmentsAvailable(
            session,
            attachments,
          );
        },
        /** Auxiliary のターン開始前に Character の実行スナップショットを更新する。 */
        resolveRuntimeSessionForTurn: (session) =>
          refreshSessionCharacterRuntimeSnapshot(
            session,
            (characterId, previousSnapshot) =>
              requireCharacterService().refreshRuntimeSnapshot(
                characterId,
                previousSnapshot,
              ),
          ),
      },
      provider: {
        getProviderCodingAdapter,
        resetProviderSessionThread,
        endProviderAgentRuntimeTurn: endManagedProviderTurn,
        /** 親の Session ID を伴う管理済みのプロバイダー実行データを解決する。 */
        resolveProviderSession: (session, parentSessionId) =>
          resolveManagedProviderSession(session, parentSessionId),
        /** Auxiliary に提供する親 Session の個別ファイル保存先を作成して返す。 */
        resolveSessionFolderPath: (parentSessionId) =>
          ensureSessionFilesDirectory(parentSessionId),
        resolveCrewFolderPath: resolveSavedCrewFolderPath,
        /** Auxiliary の送信元と親を識別する情報を使い、プロバイダーのツール権限を発行する。 */
        issueRuntimeBinding: async (session, provider, source) =>
          await issueProviderAgentRuntimeBinding(session, provider.id, source),
        /** Auxiliary ターンを管理 MCP に接続し、そのターンに限る実行権限を発行する。 */
        beginRuntimeTurn: ({ session, binding, signal, executionOptions }) =>
          beginManagedProviderTurn(session, binding, signal, executionOptions),
      },
      context: {
        /** Auxiliary 実行へ現在のアプリ設定を渡す。 */
        getAppSettings: () => requireAppSettingsStorage().getSettings(),
        /** Auxiliary のランタイム世代に属する保存済み指示を取得する。 */
        readSessionInstructions: (target) =>
          getSessionInstructions(target, owner),
      },
      turn: {
        /** Auxiliary のターン記録を共通のターンストアに追加する。 */
        createSessionTurn: (entry) =>
          requireSessionTurnService().createSessionTurn(entry),
        /** 指定 ID の Auxiliary ターン記録を共通ストアで更新する。 */
        updateSessionTurn: (id, entry) =>
          requireSessionTurnService().updateSessionTurn(id, entry),
      },
      live: {
        /** Auxiliary のライブ実行状態を共通の監視サービスへ反映する。 */
        setLiveSessionRun: (sessionId, state) =>
          setLiveSessionRun(sessionId, state),
        getLiveSessionRun,
        /** Auxiliary 実行が受け取った利用枠情報をプロバイダー単位で更新する。 */
        setProviderQuotaTelemetry: (telemetry) =>
          setProviderQuotaTelemetry(telemetry.provider, telemetry),
        /** Auxiliary 実行で観測したコンテキスト使用量を Session 単位で更新する。 */
        setSessionContextTelemetry: (telemetry) =>
          setSessionContextTelemetry(telemetry.sessionId, telemetry),
        scheduleProviderQuotaTelemetryRefresh,
        broadcastLiveSessionRun,
      },
      interaction: {
        waitForApprovalDecision: waitForLiveApprovalDecision,
        startWithMateApprovalReview,
        waitForElicitationResponse: waitForLiveElicitationResponse,
        /** 対象 Auxiliary が待っている承認を取り消す。 */
        cancelApprovals: (sessionId) =>
          requireSessionApprovalService().cancelSession(sessionId),
        /** 対象 Auxiliary が待っているプロバイダーからの質問を取り消す。 */
        cancelElicitations: (sessionId) =>
          requireSessionElicitationService().cancelSession(sessionId),
        invalidateProviderSessionThread,
      },
      /** Auxiliary とその親の文脈を伴って、終了結果を通知サービスに渡す。 */
      notification: async (notification, context) => {
        await requireSessionTurnNotificationService().notifyTurnTerminal(
          notification,
          context,
        );
      },
      /** Auxiliary の追加入力に使うキュー受領を、対応する要求 ID で現行 Worker から読み取る。 */
      getQueuedInputReceipt: (receipt) =>
        owner.storageWorker!.stores.queue.getReceipt(
          receipt,
          receipt.requestId,
        ),
      /** Auxiliary の実行枠が空いた後に、対象 ID のキューを再開する。 */
      onSessionRunReleased: (sessionId) =>
        sessionTurnQueueService?.wake(sessionId),
      currentTimestampLabel,
    });
  }

  return auxiliarySessionRuntimeService;
}

/** 現行世代の通常 Session 保存をメモリ上の投影、実行制御、Window 更新に結び付ける。 */
function requireSessionPersistenceService(): SessionPersistenceService {
  if (!sessionPersistenceService) {
    const owner = requireActivePersistentStoreOwnerForFactory(
      "Session persistence service",
    );
    const storage = owner.sessionStorage as SessionStorageWrite;
    const pinStorage = storage as unknown as SessionPinStorage;
    sessionPersistenceService = createSessionPersistenceAssembly({
      owner: {
        /** 通常 Session の保存操作を担当する永続世代が切り替わっていないか検査する。 */
        assertActive: (operation) =>
          assertPersistentStoreOwnerIsActive(owner, operation),
      },
      storage,
      pinStorage,
      cache: {
        /** 保存処理が同期する現在のインメモリ Session 一覧を返す。 */
        getSessions: () => mainStoreContext.sessions,
        /** 保存結果に合わせてメモリに保持する Session 一覧を置き換える。 */
        setSessions: (nextSessions) =>
          mainStoreContext.setSessions(nextSessions),
        getSession,
        /** 保存済みの通常 Session に現在選択中の実行オプションを重ねる。 */
        overlayCurrentExecutionOptions: (session) =>
          mainStoreContext.executionSelections.apply(session),
        /** 通常 Session の実行オプション選択をメモリに記録する。 */
        rememberExecutionOptions: (session, options) =>
          mainStoreContext.executionSelections.remember(session, options),
      },
      runtime: {
        isSessionRunInFlight,
        listRunningActiveAuxiliaryParentIds:
          listRunningActiveAuxiliaryParentSessionIds,
        /** Session の保存経路からプロバイダーの実行状態を変更する際に他操作と直列化する。 */
        runProviderRuntimeOperationExclusive: (operation) =>
          providerRuntimeOperationCoordinator.runExclusive(operation),
      },
      auxiliary: {
        /** 親の配下に保存された Auxiliary を、実行状態の管理に必要な識別情報へ絞って返す。 */
        listAuxiliarySessionRuntimeIdentities: async (parentSessionId) =>
          (
            await requireAuxiliarySessionService().listAuxiliarySessions(
              parentSessionId,
            )
          ).map((auxiliary) => ({
            id: auxiliary.id,
            parentSessionId: auxiliary.parentSessionId,
            provider: auxiliary.provider,
          })),
      },
      settings: {
        /** 保存サービスを作った永続世代の設定ストアを読む。 */
        getAppSettings: () => owner.appSettingsStorage.getSettings(),
        /** 保存操作に必要なモデル候補を取得し、プロバイダーが指定されていれば探索完了を待つ。 */
        getModelCatalogSnapshot: (workspacePath, providerId) =>
          providerId
            ? requireProviderModelDiscoveryService().ensure(
                providerId,
                workspacePath,
              )
            : getModelCatalog({ ...(workspacePath ? { workspacePath } : {}) }),
      },
      character: {
        /** 通常 Session の保存に用いる Character の実行スナップショットを作る。 */
        createCharacterRuntimeSnapshot: (characterId) =>
          requireCharacterService().createRuntimeSnapshot(characterId),
      },
      effects: {
        clearSessionContextTelemetry,
        invalidateProviderSessionThread,
        /** 対象 Session のツール権限を失効させ、同じ世代の Auxiliary 実行追跡も解除する。 */
        revokeSessionAgentRuntimeBindings: (sessionId) => {
          agentRuntimeBindingRegistry.revokeSession(sessionId);
          auxiliaryLiveRunParents.delete(sessionId, owner);
        },
        /** 対象をモニター追跡から除き、Session、Local PR、ファイルプレビューの関連 Window を閉じる。 */
        closeSessionWindow: (sessionId) => {
          requireSessionWindowBridge().forgetSessionForMonitor(sessionId);
          localPrWindowService.close(sessionId);
          requireSessionWindowBridge().closeSessionWindow(sessionId);
          requireMainWindowFacade().closeFilePreviewWindowsForSession(
            sessionId,
          );
        },
        /** Session Window を破棄する際に、関連する Local PR とファイルプレビューの Window も閉じる。 */
        discardSessionWindow: (sessionId) => {
          localPrWindowService.close(sessionId);
          requireSessionWindowBridge().discardSessionWindow(sessionId);
          requireMainWindowFacade().closeFilePreviewWindowsForSession(
            sessionId,
          );
        },
        broadcastSessions,
      },
    });
  }
  return sessionPersistenceService;
}
/** Main Window ランタイムに登録された Session Window 管理ブリッジを返す。 */
function requireSessionWindowBridge(): SessionWindowBridge<BrowserWindow> {
  return mainWindowRuntime.getSessionWindowBridge();
}

/** Session Window の保存と復元を扱うサービスを返す。 */
function requireSessionWindowRestoreService(): SessionWindowRestoreService {
  return mainWindowRuntime.getSessionWindowRestoreService();
}

/** 設定更新・利用枠・保守操作を現行世代と各ランタイムへ接続する設定サービスを初期化する。 */
function requireSettingsCatalogService(): SettingsCatalogService {
  if (!settingsCatalogService) {
    settingsCatalogService = new SettingsCatalogService({
      /** 設定更新を始める時点の永続データ所有者を取得する。 */
      captureStorageIdentity: () =>
        requireActivePersistentStoreOwnerForFactory("Settings catalog"),
      /** 設定操作を始めた世代が現在も有効かを判定する。 */
      isStorageIdentityCurrent: (owner) =>
        mainStoreContext.activePersistentStoreOwner === owner,
      /** プロバイダーで再びターンを実行できるようになったとき、その通常・Auxiliary Session のキューを起こす。 */
      onProviderTurnAvailable: (providerId) => {
        for (const session of mainStoreContext.sessions) {
          if (session.provider === providerId)
            sessionTurnQueueService?.wake(session.id);
        }
        void requireAuxiliarySessionService()
          .listAllAuxiliarySessions()
          .then((sessions) => {
            for (const session of sessions)
              if (session.provider === providerId)
                sessionTurnQueueService?.wake(session.id);
          })
          .catch((error) =>
            writeAppLog({
              level: "warn",
              kind: "session.queue.provider-wake-failed",
              process: "main",
              message: "Auxiliary queue wake failed",
              error: appLogService.errorToLogError(error),
            }),
          );
      },
      /** 設定から行うプロバイダー実行状態の変更を他の実行操作と直列化する。 */
      runProviderRuntimeOperationExclusive: (operation) =>
        providerRuntimeOperationCoordinator.runExclusive(operation),
      hasInFlightSessionRuns,
      isSessionRunInFlight,
      isRunningSession,
      listSessions: listFullStoredSessionsForMaintenance,
      /** 設定操作の影響を調べるため、全 Auxiliary の保存情報を取得する。 */
      listAuxiliarySessions: () =>
        requireAuxiliarySessionStorage().listAllAuxiliarySessions(),
      /** 通常 Session の資格情報に紐づくスレッド一覧を取得し、必要な V6 読み取り機能がなければ拒否する。 */
      listSessionCredentialThreads: () => {
        const storage = requireSessionStorage();
        if (!storage.listSessionCredentialThreads)
          throw new Error("Credential thread projection requires V6 storage.");
        return storage.listSessionCredentialThreads();
      },
      /** Auxiliary の資格情報に紐づくスレッドの投影を読み取る。 */
      listAuxiliaryCredentialThreads: () =>
        requireAuxiliarySessionStorage().listAuxiliaryCredentialThreads(),
      /** 設定サービスへ現在のストアからアプリ設定を供給する。 */
      getAppSettings: () => requireAppSettingsStorage().getSettings(),
      updateAppSettings,
      /** チャットレイアウト設定の変更を現行の設定ストアへ保存する。 */
      updateChatLayoutPreference: (update) =>
        requireAppSettingsStorage().updateChatLayoutPreference(update),
      /** レイアウト設定を保存できなかったとき、操作内容と例外をエラーログに残す。 */
      onChatLayoutPreferenceSaveError: (update, error) =>
        writeAppLog({
          level: "error",
          kind: "chat.layout-preference-save-failed",
          process: "main",
          message: "Chat layout preference save failed",
          data: { update },
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: String(error) },
        }),
      getModelCatalog,
      /** DB 保守に伴う通常 Session 一覧の置換を永続化ファサードへ委ねる。 */
      replaceAllSessions: (nextSessions, options) =>
        requireMainSessionPersistenceFacade().replaceAllSessions(
          nextSessions,
          options,
        ),
      /** 確認済みのスレッドと一致する場合だけ通常 Session の参照を更新する。 */
      updateSessionThreadIfMatches: (input) =>
        requireMainSessionPersistenceFacade().updateSessionThreadIfMatches(
          input,
        ),
      /** 期待するスレッドが保存済みの参照と一致する場合だけ Auxiliary 側を更新する。 */
      updateAuxiliarySessionThreadIfMatches: (input) =>
        requireAuxiliarySessionService().updateAuxiliarySessionThreadIfMatches(
          input,
        ),
      clearProviderQuotaTelemetry,
      clearSessionContextTelemetry,
      invalidateProviderSessionThread,
      resetAppSettings,
      /** 設定初期化などに伴い通常 Session のランタイム状態をリセットする。 */
      resetSessionRuntime: () => requireSessionRuntimeService().reset(),
      clearAllProviderQuotaTelemetry,
      clearAllSessionContextTelemetry,
      invalidateAllProviderSessionThreads,
      closeResetTargetWindows,
      /** 指定 Session に表示中のターン通知を取り下げる。 */
      dismissSessionTurnNotification: (sessionId) =>
        requireSessionTurnNotificationService().dismissSessionNotification(
          sessionId,
        ),
      recreateDatabaseFile,
      /** 設定変更を OS のログイン起動へ反映し、有効なプロバイダーのモデル候補を更新する。 */
      applyAppSettingsSideEffects: (settings) => {
        applyLaunchAtLoginSetting(
          app,
          settings.launchAtLoginEnabled,
          app.isPackaged,
        );
        void requireProviderModelDiscoveryService()
          .refreshEnabled()
          .catch((error: unknown) =>
            writeAppLog({
              level: "warn",
              kind: "model.discovery.refresh-failed",
              process: "main",
              message: "Model choices could not be refreshed",
              error: appLogService.errorToLogError(error),
            }),
          );
      },
      broadcastSessions,
      broadcastAppSettings,
      broadcastModelCatalog,
    });
  }

  return settingsCatalogService;
}

/** プロバイダー利用枠、コンテキスト使用量、ライブ実行を集約する監視サービスを現行世代に作る。 */
function requireSessionObservabilityService(): SessionObservabilityService {
  if (!sessionObservabilityService) {
    const owner = mainStoreContext.activePersistentStoreOwner;
    sessionObservabilityService = new SessionObservabilityService({
      /** 利用枠テレメトリーの更新を該当プロバイダーのイベントとして配信する。 */
      onProviderQuotaTelemetryChanged: (providerId, telemetry) => {
        requireWindowBroadcastService().broadcastProviderQuotaTelemetry(
          providerId,
          telemetry,
        );
      },
      /** コンテキストの更新を該当 Session のテレメトリーとして配信する。 */
      onSessionContextTelemetryChanged: (sessionId, telemetry) => {
        requireWindowBroadcastService().broadcastSessionContextTelemetry(
          sessionId,
          telemetry,
        );
      },
      /** 現在の永続世代を基準に、ライブ更新を Auxiliary の親への配送も扱う経路へ渡す。 */
      onLiveSessionRunChanged: (sessionId, state) => {
        auxiliaryLiveRunParents.publish(sessionId, state, owner);
      },
    });
    copilotAdapter.setBackgroundTasksObserver((sessionId, tasks) => {
      const current =
        sessionObservabilityService?.getLiveSessionRun(sessionId) ?? null;
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

      const threadId =
        mainStoreContext.sessions.find((session) => session.id === sessionId)
          ?.threadId ?? "";
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

/** ライブ実行の承認待ち表示と OS 通知を扱う承認サービスを初期化する。 */
function requireSessionApprovalService(): SessionApprovalService {
  if (!sessionApprovalService) {
    sessionApprovalService = new SessionApprovalService({
      /** 現在の承認要求の通知を発行し、通知の失敗が承認処理に波及しないよう警告に残す。 */
      notifyApproval: (sessionId, requestId, signal) => {
        void notifyLiveApproval(sessionId, requestId, signal).catch(
          (error: unknown) => {
            writeAppLog({
              level: "warn",
              kind: "session.approval-notification.failed",
              process: "main",
              message: "Session approval notification failed",
              data: { sessionId },
              error: appLogService.errorToLogError(error),
            });
          },
        );
      },
      /** 承認サービスが管理する状態をライブ実行の投影へ反映する。 */
      updateLiveSessionRun: (sessionId, recipe) =>
        requireSessionObservabilityService().updateLiveSessionRun(
          sessionId,
          recipe,
        ),
    });
  }

  return sessionApprovalService;
}

/** 質問の通知、ライブ状態更新、ランタイムへの回答送信を扱うサービスを初期化する。 */
function requireSessionElicitationService(): SessionElicitationService {
  if (!sessionElicitationService) {
    sessionElicitationService = new SessionElicitationService({
      /** 対象の通常・Auxiliary ランタイムを解決し、質問とターンの識別情報を指定して回答する。 */
      sendUserMessage: async (
        sessionId,
        turnId,
        message,
        answer,
        requestId,
      ) => {
        const { runtime } = await resolveQueueSessionRuntime(sessionId);
        await runtime.answerSessionQuestion(
          sessionId,
          turnId,
          message,
          answer,
          requestId,
        );
      },
      /** プロバイダーの質問を OS 通知に渡し、通知失敗を Session ID とともに記録する。 */
      notifyQuestion: (sessionId, signal) => {
        void notifyLiveCodexQuestion(sessionId, signal).catch(
          (error: unknown) => {
            writeAppLog({
              level: "warn",
              kind: "session.question-notification.failed",
              process: "main",
              message: "Session question notification failed",
              data: { sessionId },
              error: appLogService.errorToLogError(error),
            });
          },
        );
      },
      /** 質問と回答の状態を対象 Session のライブ実行の投影へ反映する。 */
      updateLiveSessionRun: (sessionId, recipe) =>
        requireSessionObservabilityService().updateLiveSessionRun(
          sessionId,
          recipe,
        ),
    });
  }

  return sessionElicitationService;
}

/** 取消済みの要求は表示せず、通常または親が存続する Auxiliary の質問をその表示先へ通知する。 */
async function notifyLiveCodexQuestion(
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const session = await getRuntimeSession(sessionId);
  if (signal.aborted) return;
  if (session) {
    await requireSessionTurnNotificationService().notifyQuestion(
      session,
      signal,
    );
    return;
  }
  const auxiliary =
    await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
      sessionId,
    );
  if (
    signal.aborted ||
    !auxiliary ||
    !(await getRuntimeSession(auxiliary.parentSessionId))
  )
    return;
  const runtimeSession =
    await requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
      sessionId,
    );
  if (signal.aborted || !runtimeSession) return;
  await requireSessionTurnNotificationService().notifyQuestion(
    runtimeSession,
    signal,
    {
      kind: "auxiliary",
      parentSessionId: auxiliary.parentSessionId,
      auxiliarySessionId: sessionId,
    },
  );
}

/** 取消済みの要求は表示せず、指定承認要求を通常または親付き Auxiliary の通知として送る。 */
async function notifyLiveApproval(
  sessionId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  const session = await getRuntimeSession(sessionId);
  if (signal.aborted) return;
  if (session) {
    await requireSessionTurnNotificationService().notifyApproval(
      session,
      requestId,
      signal,
    );
    return;
  }
  const auxiliary =
    await requireAuxiliarySessionService().getAuxiliarySessionMetadata(
      sessionId,
    );
  if (
    signal.aborted ||
    !auxiliary ||
    !(await getRuntimeSession(auxiliary.parentSessionId))
  )
    return;
  const runtimeSession =
    await requireAuxiliarySessionService().getAuxiliaryRuntimeSession(
      sessionId,
    );
  if (signal.aborted || !runtimeSession) return;
  await requireSessionTurnNotificationService().notifyApproval(
    runtimeSession,
    requestId,
    signal,
    {
      kind: "auxiliary",
      parentSessionId: auxiliary.parentSessionId,
      auxiliarySessionId: sessionId,
    },
  );
}

/** Main のインフラレジストリから永続ストアの生成と終了を扱うサービスを取得する。 */
function requirePersistentStoreLifecycleService(): PersistentStoreLifecycleService {
  return requireMainInfrastructureRegistry().getPersistentStoreLifecycleService();
}

/** 終了の確認、下書きのフラッシュ、ランタイムの解放を扱うアプリ単位のライフサイクルを遅延初期化する。 */
function requireAppLifecycleService(): AppLifecycleService {
  if (!appLifecycleService) {
    appLifecycleService = new AppLifecycleService(
      createAppLifecycleDeps({
        hasInFlightSessionRuns,
        /** 進行中のターンがあっても終了を許可しているか返す。 */
        getAllowQuitWithInFlightRuns: () => allowQuitWithInFlightRuns,
        /** 実行中の終了を許可したかどうかをアプリの状態に保持する。 */
        setAllowQuitWithInFlightRuns: (value) => {
          allowQuitWithInFlightRuns = value;
        },
        /** ライフサイクルから Home Window を開き、開く処理の完了を待つ。 */
        createHomeWindow: async () => {
          await createHomeWindow();
        },
        /** ライフサイクルから Electron の通常の終了経路を起動する。 */
        quitApp: () => {
          app.quit();
        },
        /** 最後の Window が閉じてもアプリのプロセスを終了させない。 */
        shouldQuitWhenAllWindowsClosed: () => false,
        /** 実行中の作業が中断されることを同期ダイアログで知らせ、明示的な終了選択だけを承認とする。 */
        confirmQuitWhileRunning: () => {
          const choice = dialog.showMessageBoxSync({
            type: "warning",
            buttons: ["Go Back", "Quit"],
            defaultId: 0,
            cancelId: 0,
            title: "Session Is Running",
            message: "A session is still running.",
            detail: "Quitting WithMate will interrupt the running work.",
            noLink: true,
          });
          return choice === 1;
        },
        /** 終了前に開いている Session Window の復元情報を保存する準備を行う。 */
        prepareSessionWindowSnapshotForQuit: () =>
          requireSessionWindowBridge().prepareSnapshotForQuit(),
        /** 下書きを保存する間はキューを停止し、フラッシュが完了しなければキューを再開する。 */
        flushSessionWindowDrafts: async () => {
          sessionTurnQueueService?.beginShutdown();
          let flushed = false;
          try {
            flushed =
              await requireSessionWindowBridge().flushSessionWindowDrafts();
            return flushed;
          } finally {
            if (!flushed) sessionTurnQueueService?.resume();
          }
        },
        /** Agent API を停止し、結果にかかわらず初期化された Local PR CI の終了も待つ。 */
        stopAgentRuntime: async () => {
          try {
            await stopAgentRuntimeApiBestEffort();
          } finally {
            await (await localPrCiInitialization)?.shutdown();
          }
        },
        closePersistentStores,
        invalidateAllProviderSessionThreads,
        /** アプリの終了処理でエージェントツールのバインディングをすべて失効させる。 */
        revokeAllAgentRuntimeBindings: () =>
          agentRuntimeBindingRegistry.revokeAll(),
      }),
    );
  }
  return appLifecycleService;
}

/** インフラレジストリから Main の起動処理を組み立てるサービスを取得する。 */
function requireMainBootstrapService(): MainBootstrapService {
  return requireMainInfrastructureRegistry().getMainBootstrapService();
}

/** 新しい永続ストア世代を現在のコンテキストで有効化し、そのカタログを返す。 */
function applyPersistentStoreBundle(
  bundle: PersistentStoreBundle,
): ModelCatalogSnapshot {
  mainStoreContext.activate(bundle);
  return bundle.activeModelCatalog;
}

/** 定期間隔で WAL を保守し、永続ストア所有者がいなければ対象 DB をタイムアウト付きで処理する。 */
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

/** DB の終了・再作成時に定期 WAL 保守を停止する。 */
function stopWalMaintenance(): void {
  mainStoreContext.stopWalMaintenance();
}

/** 旧世代を閉じて永続ストアを初期化し、復旧・診断・保守を始めてからカタログを返す。 */
async function initializePersistentStores(): Promise<ModelCatalogSnapshot> {
  if (!mainStoreContext.dbPath) {
    throw new Error("Saved data is not initialized.");
  }

  await closePersistentStores();
  try {
    const bundle = await requirePersistentStoreLifecycleService().initialize(
      mainStoreContext.dbPath,
      app.getPath("userData"),
    );
    const activeModelCatalog = applyPersistentStoreBundle(bundle);
    await recoverSessionLifecycleOperations();
    mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
    startWalMaintenance();
    const discovery = requireProviderModelDiscoveryService();
    const snapshot = await discovery.get();
    void discovery.refreshEnabled(true).catch((error: unknown) =>
      writeAppLog({
        level: "warn",
        kind: "model.discovery.startup-failed",
        process: "main",
        message: "Model choices could not be refreshed",
        error: appLogService.errorToLogError(error),
      }),
    );
    return snapshot;
  } catch (error) {
    throw error;
  }
}

/** キューや進行中の実行を解放してから永続ストアを閉じ、世代に依存するサービスの参照を破棄する。 */
async function closePersistentStores(): Promise<void> {
  await providerModelDiscoveryService?.close();
  providerModelDiscoveryService = null;
  await sessionTurnQueueService?.close();
  await Promise.all([
    sessionRuntimeService?.waitForPendingRuns(),
    auxiliarySessionRuntimeService?.waitForPendingRuns(),
  ]);
  sessionObservabilityService?.dispose();
  await sessionObservabilityService?.waitForProviderQuotaRefreshes();
  sessionTurnQueueService = null;
  mainSessionTurnQueueFacade = null;
  await mainStoreContext.close((bundle, currentDbPath) =>
    requirePersistentStoreLifecycleService().close(bundle, currentDbPath),
  );
  characterService = null;
  characterAuthoringService = null;
  managedSkillDistributionService = null;
  sessionTurnService = null;
  sessionResultReadService.clear();
  auxiliarySessionService = null;
  auxiliarySessionRuntimeService = null;
  auxiliaryLiveRunParents.clear();
  sessionRuntimeService = null;
  settingsCatalogService = null;
  sessionObservabilityService = null;
  sessionApprovalService = null;
  sessionElicitationService = null;
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

/** キューと Agent API を停止して旧 DB を再作成し、新しい永続世代と関連サービスを起動し直す。 */
async function recreateDatabaseFile(): Promise<ModelCatalogSnapshot> {
  if (!mainStoreContext.dbPath) {
    throw new Error("Saved data is not initialized.");
  }

  await sessionTurnQueueService?.close();
  await Promise.all([
    sessionRuntimeService?.waitForPendingRuns(),
    auxiliarySessionRuntimeService?.waitForPendingRuns(),
  ]);
  sessionObservabilityService?.dispose();
  await sessionObservabilityService?.waitForProviderQuotaRefreshes();
  sessionTurnQueueService = null;
  mainSessionTurnQueueFacade = null;
  mainStoreContext.setActivePersistentStoreOwner(null);
  auxiliaryLiveRunParents.clear();
  const runtimeToStop = agentRuntimeApi;
  agentRuntimeApi = null;
  if (runtimeToStop) {
    // 有効なツール要求が残っている間はデータベースのリセットを進めない。
    await runtimeToStop.stop();
  }

  stopWalMaintenance();
  if (!mainStoreContext.storageWorker) {
    await mainStoreContext.promptTemplateStorage?.close();
    await mainStoreContext.mateProfileItemStorage?.close();
  }
  await requireMateStorage().deleteMateProjectionDirectory();
  mainStoreContext.setMateProfileItemStorage(null);
  await providerModelDiscoveryService?.close();
  providerModelDiscoveryService = null;
  const bundle = await requirePersistentStoreLifecycleService().recreate(
    mainStoreContext.dbPath,
    {
      storageWorker: mainStoreContext.storageWorker,
      modelCatalogStorage: mainStoreContext.modelCatalogStorage,
      characterStorage: mainStoreContext.characterStorage,
      sessionStorage: mainStoreContext.sessionStorage,
      sessionTurnStorage: mainStoreContext.sessionTurnStorage,
      auxiliarySessionStorage: mainStoreContext.auxiliarySessionStorage,
      appSettingsStorage: mainStoreContext.appSettingsStorage,
      mateStorage: mainStoreContext.mateStorage,
    },
    app.getPath("userData"),
  );

  mainStoreContext.setCharacterStorage(null);
  characterService = null;
  characterAuthoringService = null;
  sessionTurnService = null;
  sessionResultReadService.clear();
  auxiliarySessionService = null;
  auxiliarySessionRuntimeService = null;
  sessionRuntimeService = null;
  settingsCatalogService = null;
  sessionObservabilityService = null;
  sessionApprovalService = null;
  sessionElicitationService = null;
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
  await recoverSessionLifecycleOperations();
  mainStoreContext.setDatabaseDiagnostics(await inspectCurrentAppDatabase());
  await recoverInterruptedSessions();
  if (runtimeToStop) {
    await startAgentRuntimeApiBestEffort();
    if (!agentRuntimeApi) {
      throw new Error(
        "Agent tool runtime restart failed after database initialization. Restart the app.",
      );
    }
  }
  startWalMaintenance();
  return activeModelCatalog;
}

/** 要求された作業環境やプロバイダーに対応するモデルカタログを取得する。 */
async function getModelCatalog(
  request?: ModelCatalogRequest,
): Promise<ModelCatalogSnapshot> {
  return requireMainProviderFacade().getModelCatalog(request);
}

/** 作業環境のカタログから実行対象プロバイダーを解決し、両方の情報を返す。 */
async function resolveProviderCatalog(
  providerId: string | null | undefined,
  workspacePath?: string,
): Promise<{ snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider }> {
  return requireMainProviderFacade().resolveProviderCatalog(
    providerId,
    workspacePath,
  );
}

/** 指定プロバイダーのコード実行を担当するアダプターを選ぶ。 */
function getProviderCodingAdapter(providerId: string | null | undefined) {
  return requireMainProviderFacade().getProviderCodingAdapter(providerId);
}

/** 実行バインディングを残したまま、指定 Session のプロバイダースレッドだけを無効にする。 */
async function resetProviderSessionThread(
  providerId: string | null | undefined,
  sessionId: string,
): Promise<void> {
  await requireMainProviderFacade().resetProviderSessionThread(
    providerId,
    sessionId,
  );
}

/** 指定 Session の実行バインディングを失効させてから、そのプロバイダースレッドを無効にする。 */
async function invalidateProviderSessionThread(
  providerId: string | null | undefined,
  sessionId: string,
): Promise<void> {
  await requireMainProviderFacade().invalidateProviderSessionThread(
    providerId,
    sessionId,
  );
}

/** 全プロバイダーのスレッドと対応する実行バインディングを失効させる。 */
async function invalidateAllProviderSessionThreads(): Promise<void> {
  await requireMainProviderFacade().invalidateAllProviderSessionThreads();
}

/** 指定 Session で最も新しい保存済みターンの記録を照会する。 */
async function getLatestSessionTurn(
  sessionId: string,
): Promise<SessionTurnRecord | null> {
  return requireMainQueryService().getLatestSessionTurn(sessionId);
}

/** 指定 Session の環境とプロバイダーを使って利用可能なスキルを探索する。 */
async function listSessionSkills(
  sessionId: string,
): Promise<DiscoveredSkill[]> {
  return requireMainQueryService().listSessionSkills(sessionId);
}

/** 指定 Session の環境とプロバイダーを基準にカスタムエージェントを探索する。 */
async function listSessionCustomAgents(
  sessionId: string,
): Promise<DiscoveredCustomAgent[]> {
  return requireMainQueryService().listSessionCustomAgents(sessionId);
}

/** 通常 Session をメモリから探し、選択中の実行オプションを反映して返す。 */
function getSession(sessionId: string): Session | null {
  const session = mainStoreContext.sessions.find(
    (session) => session.id === sessionId,
  );
  return session ? mainStoreContext.executionSelections.apply(session) : null;
}

/** ファイル探索の認可に必要な通常・Auxiliary の情報を、同じ永続世代から集める。 */
async function getSessionFileExplorerContext(
  sessionId: string,
): Promise<SessionFileExplorerContext | null> {
  const owner = requireActivePersistentStoreOwnerForFactory(
    "Files authorization metadata",
  );
  const auxiliary = requireAuxiliarySessionService();
  return readSessionFileExplorerContext(sessionId, {
    /** 認可用メタデータの非同期読み取り中にストアが変わっていないことを検査する。 */
    assertCurrent: () =>
      assertPersistentStoreOwnerIsActive(owner, "Files authorization metadata"),
    /** ファイル探索の対象が Auxiliary なら、親の解決に必要な保存メタデータを読み取る。 */
    getAuxiliaryMetadata: (id) => auxiliary.getAuxiliarySessionMetadata(id),
    /** 通常 Session の概要を取得し、実行オプションの現行選択を重ねて認可情報の解決に使う。 */
    getSessionSummary: async (id) => {
      if (!owner.sessionStorage.getSessionSummary)
        throw new Error("Session summary reads are unavailable.");
      const summary = await owner.sessionStorage.getSessionSummary(id);
      return summary
        ? mainStoreContext.executionSelections.apply(summary)
        : null;
    },
  });
}

/** 対象 Session のファイル探索を所有する親 Session の ID を、解決できる場合だけ返す。 */
async function getSessionFileExplorerOwnerSessionId(
  sessionId: string,
): Promise<string | null> {
  return (
    (await getSessionFileExplorerContext(sessionId))?.parentSessionId ?? null
  );
}

/** ファイル探索ランタイムからアクセス境界を備えた探索サービスを取得する。 */
function createSessionFileExplorerService(): SessionFileExplorerService {
  return sessionFileExplorerRuntime.getExplorer();
}

/** ファイル探索ランタイムからルート内の Git 変更と履歴を扱うサービスを取得する。 */
function createFileRootGitChangesService(): FileRootGitChangesService {
  return sessionFileExplorerRuntime.getGitChanges();
}

/** Auxiliary が参照する親の保存済みランタイム情報を取得する。 */
async function getAuxiliaryParentSession(
  parentSessionId: string,
): Promise<Session | null> {
  return getRuntimeSession(parentSessionId);
}

/** 会話またはストリームがメモリにあれば表示に優先し、なければ保存ビューから補う。 */
async function getDisplaySession(sessionId: string): Promise<Session | null> {
  const liveSession = getSession(sessionId);
  if (
    liveSession &&
    (liveSession.messages.length > 0 || liveSession.stream.length > 0)
  ) {
    return toConversationView(liveSession);
  }

  const session =
    (await requireMainQueryService().getSession(sessionId)) ??
    liveSession ??
    null;
  return session ? mainStoreContext.executionSelections.apply(session) : null;
}

/** 通常 Session の保存済み概要を読み、メモリ上の実行オプション選択を重ねる。 */
async function getDisplaySessionSummary(sessionId: string) {
  const storage = requireSessionStorage();
  if (!storage.getSessionSummary) {
    throw new Error(
      "Session summary reads are not available for this database.",
    );
  }
  const summary = await storage.getSessionSummary(sessionId);
  return summary ? mainStoreContext.executionSelections.apply(summary) : null;
}

/** 現在の永続世代から通常 Session の実行用メタデータとメッセージ数を取得する。 */
async function getRuntimeSession(sessionId: string): Promise<Session | null> {
  const owner = requireActivePersistentStoreOwnerForFactory(
    "Session runtime metadata",
  );
  if (!owner.sessionStorage.getSessionMetadata)
    throw new Error("Session metadata reads are unavailable.");
  const metadata = await owner.sessionStorage.getSessionMetadata(sessionId);
  assertPersistentStoreOwnerIsActive(owner, "Session runtime metadata");
  return metadata
    ? {
        ...sessionSummaryToSession(metadata.summary),
        characterRuntimeSnapshot: metadata.characterRuntimeSnapshot,
        messageCount: metadata.messageCount,
      }
    : null;
}

/** 詳細まで揃うライブ成果物を優先し、足りなければ通常または Auxiliary の保存先から詳細を読む。 */
async function getSessionMessageArtifact(
  sessionId: string,
  messageIndex: number,
): Promise<MessageArtifact | null> {
  const liveArtifact = getSession(sessionId)?.messages[messageIndex]?.artifact;
  if (liveArtifact && liveArtifact.detailAvailable !== true) {
    return liveArtifact;
  }

  const auxiliary =
    await requireAuxiliarySessionStorage().getAuxiliarySessionSummary(
      sessionId,
    );
  if (auxiliary) {
    return requireAuxiliarySessionStorage().getAuxiliaryMessageArtifactDetail(
      sessionId,
      messageIndex,
    );
  }
  return requireMainQueryService().getSessionMessageArtifact(
    sessionId,
    messageIndex,
  );
}

/** 対象 Session のワークスペースを使う外部端末を開く。 */
async function openSessionTerminal(sessionId: string): Promise<void> {
  await requireMainQueryService().openSessionTerminal(sessionId);
}

/** Session 一覧の更新を配信し、対象 ID や詳細更新の省略が指定されていれば引き継ぐ。 */
function broadcastSessions(
  sessionIds?: Iterable<string>,
  detailChanged?: false,
): void {
  requireMainBroadcastFacade().broadcastSessions(sessionIds, detailChanged);
}

/** 指定されたモデルカタログ、または現行カタログを配信する。 */
async function broadcastModelCatalog(
  snapshot?: ModelCatalogSnapshot | null,
): Promise<void> {
  await requireMainBroadcastFacade().broadcastModelCatalog(snapshot);
}

/** 最新設定で利用枠監視を調整し、Window へ配信した後、モデル候補を非同期で更新する。 */
async function broadcastAppSettings(settings?: AppSettings): Promise<void> {
  const current = settings ?? (await requireAppSettingsStorage().getSettings());
  requireMainObservabilityFacade().configureProviderQuotaPolling(current);
  await requireMainBroadcastFacade().broadcastAppSettings(current);
  if (providerModelDiscoveryService) {
    void providerModelDiscoveryService
      .refreshEnabled()
      .catch((error: unknown) =>
        writeAppLog({
          level: "warn",
          kind: "model.discovery.settings-failed",
          process: "main",
          message: "Model choices could not be refreshed",
          error: appLogService.errorToLogError(error),
        }),
      );
  }
}

/** プロバイダーごとに保持している利用枠テレメトリーを取得する。 */
function getProviderQuotaTelemetry(
  providerId: string,
): ProviderQuotaTelemetry | null {
  return requireMainObservabilityFacade().getProviderQuotaTelemetry(providerId);
}

/** 指定プロバイダーの最新利用枠テレメトリーを監視サービスへ反映する。 */
function setProviderQuotaTelemetry(
  providerId: string,
  telemetry: ProviderQuotaTelemetry | null,
): void {
  requireMainObservabilityFacade().setProviderQuotaTelemetry(
    providerId,
    telemetry,
  );
}

/** 指定プロバイダーの利用枠テレメトリーを消去する。 */
function clearProviderQuotaTelemetry(providerId: string): void {
  requireMainObservabilityFacade().clearProviderQuotaTelemetry(providerId);
}

/** 全プロバイダーの利用枠テレメトリーを監視サービスから消去する。 */
function clearAllProviderQuotaTelemetry(): void {
  requireMainObservabilityFacade().clearAllProviderQuotaTelemetry();
}

/** 利用枠テレメトリーが現行の鮮度条件を満たさないか判定する。 */
function isProviderQuotaTelemetryStale(
  telemetry: ProviderQuotaTelemetry | null,
): boolean {
  return requireMainObservabilityFacade().isProviderQuotaTelemetryStale(
    telemetry,
  );
}

/** 指定プロバイダーの利用枠テレメトリーを取得し直す。 */
async function refreshProviderQuotaTelemetry(
  providerId: string,
): Promise<ProviderQuotaTelemetry | null> {
  return requireMainObservabilityFacade().refreshProviderQuotaTelemetry(
    providerId,
  );
}

/** キャッシュ限定指定、Codex、Claude、OpenCode は保持中の値を返し、その他は鮮度に応じて再取得する。 */
async function getOrRefreshProviderQuotaTelemetry(
  providerId: string,
  options?: { cacheOnly?: boolean },
): Promise<ProviderQuotaTelemetry | null> {
  return requireMainObservabilityFacade().getOrRefreshProviderQuotaTelemetry(
    providerId,
    options,
  );
}

/** 指定プロバイダーの利用枠の再取得を、渡された待機時間に従って予約する。 */
function scheduleProviderQuotaTelemetryRefresh(
  providerId: string,
  delaysMs: number[],
): void {
  requireMainObservabilityFacade().scheduleProviderQuotaTelemetryRefresh(
    providerId,
    delaysMs,
  );
}

/** 現在保持している対象 Session のコンテキスト使用量を取得する。 */
function getSessionContextTelemetry(
  sessionId: string,
): SessionContextTelemetry | null {
  return requireMainObservabilityFacade().getSessionContextTelemetry(sessionId);
}

/** 指定 Session のコンテキスト使用量を監視サービスへ反映する。 */
function setSessionContextTelemetry(
  sessionId: string,
  telemetry: SessionContextTelemetry | null,
): void {
  requireMainObservabilityFacade().setSessionContextTelemetry(
    sessionId,
    telemetry,
  );
}

/** 対象 Session のみ、保持されているコンテキスト使用量を消去する。 */
function clearSessionContextTelemetry(sessionId: string): void {
  requireMainObservabilityFacade().clearSessionContextTelemetry(sessionId);
}

/** 永続世代の切替などで不要になった全 Session のコンテキスト使用量を消去する。 */
function clearAllSessionContextTelemetry(): void {
  requireMainObservabilityFacade().clearAllSessionContextTelemetry();
}

/** 現在開いている Session Window の ID を列挙する。 */
function listOpenSessionWindowIds(): string[] {
  return requireMainWindowFacade().listOpenSessionWindowIds();
}

/** 開いている Session Window の ID を要求されたページに切り出す。 */
function listOpenSessionWindowIdsPage(
  request?: OpenSessionWindowIdsPageRequest | null,
): OpenSessionWindowIdsPageResult {
  return buildOpenSessionWindowIdsPage(listOpenSessionWindowIds(), request);
}

/** 開いている Session Window の構成を配信し直す。 */
function broadcastOpenSessionWindowIds(): void {
  requireMainBroadcastFacade().broadcastOpenSessionWindowIds();
}

/** インメモリ Session 一覧に実行中の状態が残っているかを判定する。 */
function hasRunningSessions(): boolean {
  return mainStoreContext.sessions.some((session) => isRunningSession(session));
}

/** DB をリセットする前に Local PR と永続データに関連する Window を閉じる。 */
function closeResetTargetWindows(): void {
  localPrWindowService.close();
  requireMainWindowFacade().closeResetTargetWindows();
}

/** 指定 Session の最新ライブ実行状態を監視ファサードから取得する。 */
function getLiveSessionRun(sessionId: string): LiveSessionRunState | null {
  return requireMainObservabilityFacade().getLiveSessionRun(sessionId);
}

/** 指定 Session のライブ実行状態を監視ファサードへ反映する。 */
function setLiveSessionRun(
  sessionId: string,
  state: LiveSessionRunState | null,
): void {
  requireMainObservabilityFacade().setLiveSessionRun(sessionId, state);
}

/** 対象 Session のライブ状態に指定の変換を適用し、更新後の状態を返す。 */
function updateLiveSessionRun(
  sessionId: string,
  recipe: (current: LiveSessionRunState) => LiveSessionRunState,
): LiveSessionRunState | null {
  return requireMainObservabilityFacade().updateLiveSessionRun(
    sessionId,
    recipe,
  );
}

/** 対象 Session の現在のライブ実行状態を登録し直して再配信する。 */
function broadcastLiveSessionRun(sessionId: string): void {
  requireMainObservabilityFacade().setLiveSessionRun(
    sessionId,
    getLiveSessionRun(sessionId),
  );
}

/** 指定 Session の承認要求に対する判断を、要求 ID を指定して確定経路へ渡す。 */
function resolveLiveApproval(
  sessionId: string,
  requestId: string,
  decision: LiveApprovalDecision,
): void {
  requireSessionApprovalService().resolveLiveApproval(
    sessionId,
    requestId,
    decision,
  );
}

/** 実行中の承認判断を待ち、取消シグナルと任意の自動レビュー・判断元通知も承認サービスに渡す。 */
function waitForLiveApprovalDecision(
  sessionId: string,
  request: LiveApprovalRequest,
  signal: AbortSignal,
  review?: PendingApprovalReview | null,
  onDecisionSource?: ApprovalDecisionSourceObserver,
): Promise<LiveApprovalDecision> {
  return requireSessionApprovalService().waitForLiveApprovalDecision(
    sessionId,
    request,
    signal,
    review,
    onDecisionSource,
  );
}

/** 指定された Session と要求に対するユーザーの回答を質問サービスへ渡す。 */
function resolveLiveElicitation(
  sessionId: string,
  requestId: string,
  response: LiveElicitationResponse,
): void | Promise<void> {
  return requireSessionElicitationService().resolveLiveElicitation(
    sessionId,
    requestId,
    response,
  );
}

/** 指定 Session に出された質問の回答を、ターンの取消を考慮して待つ。 */
function waitForLiveElicitationResponse(
  sessionId: string,
  request: LiveElicitationRequest,
  signal: AbortSignal,
): Promise<LiveElicitationResponse> {
  return requireSessionElicitationService().waitForLiveElicitationResponse(
    sessionId,
    request,
    signal,
  );
}

/** 通常 Session の登録または更新を永続化ファサードへ渡し、保存結果を返す。 */
async function upsertSession(nextSession: Session): Promise<Session> {
  return requireMainSessionPersistenceFacade().upsertSession(nextSession);
}

/** 通常 Session 一覧を置き換え、配信の指定と失効対象を保存窓口へ渡す。 */
async function replaceAllSessions(
  nextSessions: Session[],
  options?: {
    broadcast?: boolean;
    invalidateSessionIds?: Iterable<string>;
  },
): Promise<Session[]> {
  return requireMainSessionPersistenceFacade().replaceAllSessions(
    nextSessions,
    options,
  );
}

/** Worker のキューを復旧し、配送開始前に概要キャッシュを同期して必要な起動処理を実行する。 */
async function recoverInterruptedSessions(
  beforeDispatch?: () => Promise<void>,
): Promise<void> {
  const owner = mainStoreContext.activePersistentStoreOwner;
  if (!owner?.storageWorker) {
    await beforeDispatch?.();
    return;
  }
  await requireMainSessionTurnQueueService().start(async () => {
    const summaries = await owner.sessionStorage.listSessionSummaries();
    assertPersistentStoreOwnerIsActive(
      owner,
      "Refresh recovered Session summaries",
    );
    mainStoreContext.setSessions(sessionSummariesToSessions(summaries));
    await beforeDispatch?.();
  });
}

/** 未完了の Session ライフサイクル操作を復旧し、完了できない場合はエラーを残す。 */
async function recoverSessionLifecycleOperations(): Promise<void> {
  try {
    await requireMainSessionCommandFacade().recoverPendingSessionLifecycleOperations();
  } catch (error) {
    writeAppLog({
      level: "error",
      kind: "session.lifecycle.recovery-incomplete",
      process: "main",
      message:
        "Pending Session lifecycle recovery remains incomplete; affected operations remain pending",
      error: appLogService.errorToLogError(error),
    });
  }
}

/** Auxiliary なら親の設定を含むプロバイダー文脈で入力プレビューを作り、通常は照会サービスに委ねる。 */
async function previewComposerInput(sessionId: string, userMessage: string) {
  const auxiliaryService = requireAuxiliarySessionService();
  const auxiliarySession =
    await auxiliaryService.getAuxiliarySessionMetadata(sessionId);
  const auxiliaryRuntimeSession = auxiliarySession
    ? await auxiliaryService.getAuxiliaryRuntimeSession(sessionId)
    : null;
  if (auxiliaryRuntimeSession) {
    return resolveComposerPreview(
      await resolveManagedProviderSession(
        auxiliaryRuntimeSession,
        auxiliarySession!.parentSessionId,
      ),
      userMessage,
    );
  }

  return requireMainQueryService().previewComposerInput(sessionId, userMessage);
}

/** 外部から選んだファイルを指定 Session の個別ファイル保存先へコピーする。 */
async function copyFilesToSessionFiles(
  sessionId: string,
  sourcePaths: string[],
): Promise<string[]> {
  return copyFilesToSessionFilesStorage(
    app.getPath("userData"),
    sessionId,
    sourcePaths,
  );
}

/** Session Folder を初期位置に表示し、その配下として判定された複数のファイルだけを返す。 */
async function pickSessionFiles(
  targetWindow: BrowserWindow | null,
  sessionId: string,
): Promise<string[]> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  const selectedPaths = await requireWindowDialogService().pickFiles(
    targetWindow,
    directoryPath,
  );
  return selectedPaths.filter((selectedPath) =>
    isPathInsideOrEqual(directoryPath, selectedPath),
  );
}

/** Session Folder を初期位置に表示し、その範囲内のディレクトリだけを選択結果とする。 */
async function pickSessionFolder(
  targetWindow: BrowserWindow | null,
  sessionId: string,
): Promise<string | null> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  const selectedPath = await requireWindowDialogService().pickDirectory(
    targetWindow,
    directoryPath,
  );
  return selectedPath && isPathInsideOrEqual(directoryPath, selectedPath)
    ? selectedPath
    : null;
}

/** Session Folder を初期位置とする画像選択を開き、その範囲外の結果を採用しない。 */
async function pickSessionImageFile(
  targetWindow: BrowserWindow | null,
  sessionId: string,
): Promise<string | null> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  const selectedPath = await requireWindowDialogService().pickImageFile(
    targetWindow,
    directoryPath,
  );
  return selectedPath && isPathInsideOrEqual(directoryPath, selectedPath)
    ? selectedPath
    : null;
}

/** 貼り付けデータをバイト列にして Session Folder に保存し、上書き照合や別名保存の指定を引き継ぐ。 */
async function savePastedSessionFile(
  request: SavePastedSessionFileRequest,
): Promise<SavePastedSessionFileResult> {
  return saveSessionFile(app.getPath("userData"), {
    sessionId: request.sessionId,
    fileName: request.fileName,
    data: new Uint8Array(request.data),
    replaceExistingHash: request.replaceExistingHash,
    saveAsCopy: request.saveAsCopy,
  });
}

/** 指定 Session の個別ファイル保存先を準備して、パスを返す。 */
function ensureSessionFilesDirectory(sessionId: string): string {
  return ensureManagedSessionFilesDirectory(app.getPath("userData"), sessionId);
}

/** 保存済みの親または通常 Session を確認し、プロバイダーに Session Folder と Crew Folder を追加する。 */
async function resolveManagedProviderSession<T extends SessionSummary>(
  session: T,
  parentSessionId?: string,
): Promise<T> {
  const owner = requireActivePersistentStoreOwnerForFactory(
    "Provider directories",
  );
  const main = await owner.sessionStorage.getSessionSummary?.(
    parentSessionId ?? session.id,
  );
  assertPersistentStoreOwnerIsActive(owner, "Provider directories");
  if (
    !main ||
    (!parentSessionId &&
      getSessionIncarnationId(main) !== getSessionIncarnationId(session))
  ) {
    throw new Error(
      "The saved Main Session identity is unavailable for provider directories.",
    );
  }
  const withSessionFolder = parentSessionId
    ? appendSessionFilesDirectoryForSessionId(
        app.getPath("userData"),
        session,
        parentSessionId,
      )
    : appendSessionFilesDirectory(app.getPath("userData"), session);
  return appendCrewFilesDirectory(
    app.getPath("userData"),
    withSessionFolder,
    main.rootSessionId ?? main.id,
  );
}

/** 保存済み Main Session の所属ルートに対応する Crew Folder を解決する。 */
async function resolveSavedCrewFolderPath(
  mainSessionId: string,
): Promise<string> {
  const owner = requireActivePersistentStoreOwnerForFactory("Crew Folder");
  const main = await owner.sessionStorage.getSessionSummary?.(mainSessionId);
  assertPersistentStoreOwnerIsActive(owner, "Crew Folder");
  if (!main)
    throw new Error(
      "The saved Main Session is unavailable for Crew Folder resolution.",
    );
  return resolveCrewFilesDirectory(
    app.getPath("userData"),
    main.rootSessionId ?? main.id,
  );
}

/** パスを正規化して字句上の包含関係を判定する。シンボリックリンクの解決は行わない。 */
function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = path.relative(
    path.resolve(parentPath),
    path.resolve(targetPath),
  );
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

/** 指定 Session の個別ファイル保存先を削除し、失敗しても他の後処理は中断せず警告を残す。 */
async function cleanupSessionFilesDirectory(sessionId: string): Promise<void> {
  try {
    await deleteSessionFilesDirectory(app.getPath("userData"), sessionId);
  } catch (error) {
    console.warn(
      "Session files directory の cleanup に失敗しました:",
      sessionId,
      error,
    );
  }
}

/** 指定 Session の個別ファイル保存先を準備し、OS で開く。 */
async function openSessionFilesDirectory(sessionId: string): Promise<void> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  await openDirectory(directoryPath);
}

/** 指定 Session の個別ファイル保存先を作業ディレクトリとして外部端末を開く。 */
async function openSessionFilesTerminal(sessionId: string): Promise<void> {
  const directoryPath = ensureSessionFilesDirectory(sessionId);
  await launchTerminalAtPath(directoryPath);
}

/** ローカルパスを検査する共通ルーチンを、Electron の既定アプリ起動へ接続する。 */
async function openLocalPath(targetPath: string): Promise<OpenPathResult> {
  return openLocalPathWithDefaultApp(targetPath, {
    statTarget: stat,
    /** 存在を確認したローカルパスを OS の既定アプリで開く。 */
    openWithDefaultApp: (pathValue) => shell.openPath(pathValue),
  });
}

/** 解決した対象を外部 URL、ローカル起動、場所の表示に振り分け、例外は失敗結果に変換する。 */
async function openPathTarget(
  target: string,
  options?: OpenPathOptions,
): Promise<OpenPathResult> {
  try {
    const resolved = resolveOpenPathTarget(target, options);
    if (resolved.type === "external-url") {
      await shell.openExternal(resolved.target);
      return {
        status: "opened",
        targetType: "external-url",
        target: resolved.target,
      };
    }

    if (options?.reveal) {
      return revealLocalPathInFileManager(resolved.targetPath, {
        statTarget: stat,
        /** 場所の表示処理に、OS の既定アプリへパスを渡す操作を提供する。 */
        openWithDefaultApp: (pathValue) => shell.openPath(pathValue),
        /** 対象項目をファイルマネージャーで表示する。 */
        revealInFileManager: (pathValue) => shell.showItemInFolder(pathValue),
      });
    }

    const localResult = await openLocalPath(resolved.targetPath);
    const externalFallback =
      resolveProtocolRelativeExternalFallbackAfterLocalOpen(
        target,
        localResult,
      );
    if (externalFallback) {
      await shell.openExternal(externalFallback);
      return {
        status: "opened",
        targetType: "external-url",
        target: externalFallback,
      };
    }
    return localResult;
  } catch (error) {
    return {
      status: "failed",
      targetType: "unknown",
      target,
      message:
        error instanceof Error
          ? error.message
          : "The target could not be opened.",
    };
  }
}

/** 起動 Window があれば Home として引き継ぎ、それ以外は通常の Home を開く。 */
async function createHomeWindow(): Promise<BrowserWindow> {
  const bootWindow = mainWindowComposition.getBootWindow();
  if (bootWindow) {
    return requireAuxWindowService().adoptHomeWindow(bootWindow);
  }
  return requireMainWindowFacade().openHomeWindow();
}

/** Session の実行状態を監視する専用 Window を開く。 */
async function openSessionMonitorWindow(): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSessionMonitorWindow();
}

/** アプリ設定用の Window を開く。 */
async function openSettingsWindow(): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSettingsWindow();
}

/** 指定 Character の編集、または未指定時のエディターを開く。 */
async function openCharacterEditorWindow(
  characterId?: string | null,
): Promise<BrowserWindow> {
  return requireMainWindowFacade().openCharacterEditorWindow(characterId);
}

/** 対象 Session の Window を開き、指定されていれば親の Window 内で Auxiliary を表示する。 */
async function openSessionWindow(
  sessionId: string,
  auxiliarySessionId?: string,
): Promise<BrowserWindow> {
  return requireMainWindowFacade().openSessionWindow(
    sessionId,
    auxiliarySessionId,
  );
}

/** 差分表示データを専用 Window に渡して開く。 */
async function openDiffWindow(
  diffPreview: DiffPreviewPayload,
): Promise<BrowserWindow> {
  return requireMainWindowFacade().openDiffWindow(diffPreview);
}

/** 現在指定されている DB と実行環境の診断を専用 Worker で行い、結果にかかわらず Worker を閉じる。 */
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
    registerPdfReaderProtocol(path.join(rendererDistPath, "pdf-reader"));
    if (!isBackgroundLaunch) {
      await openBootWindow();
    }

    try {
      const bootstrapWorker = createAppDatabaseBootstrapWorker();
      try {
        const resolved = await bootstrapWorker.resolveOrMigrate(
          {
            userDataPath: app.getPath("userData"),
            userDataPathOverrideApplied: Boolean(userDataPathOverride),
          },
          (progress) => {
            publishAppBootStatus({
              kind: "running",
              stage: "database",
              title: progress.title,
              detail: progress.detail,
            });
          },
        );
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
      mainStoreContext.setDatabaseDiagnostics(
        await inspectCurrentAppDatabase(),
      );
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
      requireMainObservabilityFacade().configureProviderQuotaPolling(
        await requireAppSettingsStorage().getSettings(),
      );
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
        detail: isBackgroundLaunch
          ? "Started in the background."
          : "Home is ready.",
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
        detail:
          "Database migration or startup initialization failed. See the logs for details.",
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
    localPrWindowService.close();
    sessionObservabilityService?.dispose();
    terminalService?.releaseAll();
    writeAppLog({
      level: "info",
      kind: "app.will-quit",
      process: "main",
      message: "App will quit",
    });
    appTrayService?.dispose();
  });
}
