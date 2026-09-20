import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

import type {
  AuditLogDetail,
  AuditLogDetailFragment,
  AuditLogDetailSection,
  AuditLogEntry,
  AuditLogOperationDetailFragment,
  AuditLogSummary,
  AuditLogSummaryPageRequest,
  AuditLogSummaryPageResult,
  LiveApprovalDecision,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  RunSessionTurnRequest,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
  SessionCharacterUsage,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
  SessionSummary,
} from "../src/app-state.js";
import type { AppDatabaseDiagnostics } from "../src/app-database-diagnostics-state.js";
import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../src/markdown-link-context-menu.js";
import type { MemoryV6Diagnostics } from "../src/memory-v6/memory-diagnostics-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest } from "../src/memory-v6/memory-contract.js";
import type { MemoryFileUsageResponse } from "../src/memory-v6/memory-response-contract.js";
import type {
  MemoryV6ReviewEntryDetail,
  MemoryV6ReviewExportFilesResult,
  MemoryV6ReviewForgetResult,
  MemoryV6ProtectedObjectGcRequest,
  MemoryV6ProtectedObjectGcResponse,
  MemoryV6ReviewSearchResult,
} from "../src/memory-v6/memory-review-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../src/auxiliary-session-state.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "../src/character/character-authoring.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../src/character/character-catalog.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { ChatLayoutPreferenceUpdate } from "../src/chat/chat-layout-preference.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type {
  SessionDirectoryEntry,
  SessionDirectoryRequest,
  SessionFileChunkRequest,
  SessionFileChunkResult,
  SessionFileDescriptor,
  SessionFilePreviewImageActionRequest,
  SessionFilePreviewImageContextMenuResult,
  SessionFilePreviewImageCopyResult,
  SessionFileOpenRequest,
  SessionFilePreviewWindowOpenRequest,
  SessionFilePreviewWindowOpenResult,
  SessionFilePreviewWindowPayload,
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
  SessionFileRoot,
  SessionFileTreePathActionContextMenuResult,
  SessionFileTreePathActionRequest,
  FileRootChangesRequest,
  FileRootChangesRepositoriesRequest,
  FileRootChangesRepositoriesResult,
  FileRootChangesResult,
  FileRootFileDiffRequest,
  FileRootFileDiffResult,
  FileRootGitHistoryCommitDetailRequest,
  FileRootGitHistoryCommitDetailResult,
  FileRootGitHistoryCommitsRequest,
  FileRootGitHistoryCommitsResult,
  FileRootGitHistoryComparisonRequest,
  FileRootGitHistoryComparisonResult,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryDiffResult,
  FileRootGitHistoryRepositoriesRequest,
  FileRootGitHistoryRepositoriesResult,
} from "../src/file-explorer/file-explorer-contract.js";
import type {
  SessionFileObjectCopyContextMenuRequest,
  SessionFileObjectCopyContextMenuResult,
  SessionFileObjectCopyRequest,
  SessionFileObjectCopyResult,
} from "../src/file-explorer/session-file-object-copy-contract.js";
import type {
  GlossaryListResult,
  GlossaryOperationResult,
  GlossarySearchRequest,
  SessionGlossaryProjection,
} from "../src/glossary-contract.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../src/runtime-state.js";
import type {
  CreateSessionRequest,
  DiffPreviewPayload,
  MessageArtifact,
  Session,
  SetSessionPinnedRequest,
} from "../src/session-state.js";
import type {
  ImageFilePickerPurpose,
  OpenPathOptions,
  DeleteSessionsLastActiveBeforeRequest,
  DeleteSessionsResult,
  ResetAppDatabaseRequest,
  SavePastedSessionFileRequest,
  OpenPathResult,
  OpenSessionWindowIdsPageRequest,
  OpenSessionWindowIdsPageResult,
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../src/withmate-window-types.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../src/mate/mate-state.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import type { WorkspaceDirectoryValidationResult } from "../src/workspace-directory-validation.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../src/prompt-template.js";
import type { MainIpcRegistrationDeps } from "./main-ipc-registration.js";
import type { SessionWindowRestoreResult } from "../src/session-window-restore.js";

type MaybeWindow = BrowserWindow | null | undefined;

export type MainIpcWindowDepsArgs = {
  acknowledgeSessionDraftFlush(event: Pick<IpcMainInvokeEvent, "sender">, payload: { requestId: string; success: boolean }): void;
  resolveEventWindow(event: IpcMainInvokeEvent): MaybeWindow;
  resolveHomeWindow(): MaybeWindow;
  resolveSessionWindow(sessionId: string): MaybeWindow;
  openSessionWindow(sessionId: string, auxiliarySessionId?: string): Promise<BrowserWindow>;
  showSessionMonitorContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionMonitorContextMenuRequest,
  ): Awaitable<SessionMonitorContextMenuResult>;
  getSessionWindowRestoreSet(): Promise<string[]>;
  restoreSessionWindows(): Promise<SessionWindowRestoreResult>;
  openHomeWindow(): Promise<BrowserWindow>;
  openSessionMonitorWindow(): Promise<BrowserWindow>;
  openSettingsWindow(): Promise<BrowserWindow>;
  openMemoryV6ReviewWindow(): Promise<BrowserWindow>;
  isSessionMonitorWindow(window: BrowserWindow): boolean;
  isSettingsWindow(window: BrowserWindow): boolean;
  isMemoryV6ReviewWindow(window: BrowserWindow): boolean;
  openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow>;
  isFilePreviewWindow(window: BrowserWindow, sessionId: string): boolean;
  getFilePreviewWindowResource(window: BrowserWindow, sessionId: string): SessionFilePreviewResourceRequest | null;
  isFilePreviewTokenWindow(window: BrowserWindow, token: string): boolean;
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  validateWorkspaceDirectory(targetPath: unknown): Promise<WorkspaceDirectoryValidationResult>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFiles(targetWindow: MaybeWindow, initialPath: string | null): Promise<string[]>;
  pickSessionFiles(targetWindow: MaybeWindow, sessionId: string): Promise<string[]>;
  pickSessionFolder(targetWindow: MaybeWindow, sessionId: string): Promise<string | null>;
  pickSessionImageFile(targetWindow: MaybeWindow, sessionId: string): Promise<string | null>;
  pickImageFile(
    targetWindow: MaybeWindow,
    initialPath: string | null,
    purpose: ImageFilePickerPurpose,
  ): Promise<string | null>;
  copyFilesToSessionFiles(sessionId: string, sourcePaths: string[]): Promise<string[]>;
  savePastedSessionFile(request: SavePastedSessionFileRequest): Promise<string>;
  openSessionFilesDirectory(sessionId: string): Promise<void>;
  openSessionFilesTerminal(sessionId: string): Promise<void>;
  copySessionFilePreviewImage(
    event: IpcMainInvokeEvent,
    request: SessionFilePreviewImageActionRequest,
  ): Awaitable<SessionFilePreviewImageCopyResult>;
  showSessionFilePreviewImageContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionFilePreviewImageActionRequest,
  ): Awaitable<SessionFilePreviewImageContextMenuResult>;
  copySessionFileObject(
    event: IpcMainInvokeEvent,
    request: SessionFileObjectCopyRequest,
  ): Awaitable<SessionFileObjectCopyResult>;
  showSessionFileObjectCopyContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionFileObjectCopyContextMenuRequest,
  ): Awaitable<SessionFileObjectCopyContextMenuResult>;
  showSessionFileTreeContextMenu(
    event: IpcMainInvokeEvent,
    request: SessionFileTreePathActionRequest,
  ): Awaitable<SessionFileTreePathActionContextMenuResult>;
  showMarkdownLinkContextMenu(
    event: IpcMainInvokeEvent,
    request: MarkdownLinkContextMenuRequest,
  ): Awaitable<MarkdownLinkContextMenuResult>;
  openPathTarget(target: string, options?: OpenPathOptions): Promise<OpenPathResult>;
  openAppLogFolder(): Promise<void>;
  openCrashDumpFolder(): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
  openTerminalAtPath(target: string): Promise<void>;
  logIpcError?: MainIpcRegistrationDeps["logIpcError"];
  reportRendererLog?: MainIpcRegistrationDeps["reportRendererLog"];
};

export type MainIpcCatalogDepsArgs = {
  getModelCatalog(revision: number | null): Awaitable<ModelCatalogSnapshot | null>;
  importModelCatalogDocument(document: ModelCatalogDocument): Awaitable<ModelCatalogSnapshot>;
  importModelCatalogFromFile(targetWindow?: MaybeWindow): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogDocument(revision: number | null): Awaitable<ModelCatalogDocument | null>;
  exportModelCatalogToFile(revision: number | null, targetWindow?: MaybeWindow): Promise<string | null>;
};

export type MainIpcSettingsDepsArgs = {
  getAppSettings(): Awaitable<AppSettings>;
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): Awaitable<AppSettings>;
  getAppDatabaseDiagnostics(): Awaitable<AppDatabaseDiagnostics>;
  getMemoryV6Diagnostics(): Awaitable<MemoryV6Diagnostics>;
  installMemoryV6CliShim(): Awaitable<MemoryV6Diagnostics>;
  uninstallMemoryV6CliShim(): Awaitable<MemoryV6Diagnostics>;
  getMemoryV6FileUsage(): Awaitable<MemoryFileUsageResponse>;
  exportMemoryV6EntryFiles(entryId: string, targetWindow?: MaybeWindow): Awaitable<MemoryV6ReviewExportFilesResult | null>;
  runMemoryV6ProtectedObjectGc(request: MemoryV6ProtectedObjectGcRequest): Awaitable<MemoryV6ProtectedObjectGcResponse>;
  searchMemoryV6Entries(request: MemoryV6ReviewSearchRequest | null | undefined): Awaitable<MemoryV6ReviewSearchResult>;
  getMemoryV6Entry(entryId: string): Awaitable<MemoryV6ReviewEntryDetail | null>;
  forgetMemoryV6Entry(entryId: string, reason?: MemoryForgetReason | null): Awaitable<MemoryV6ReviewForgetResult>;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
};

export type MainIpcPromptTemplateDepsArgs = {
  listPromptTemplates(): Awaitable<PromptTemplate[]>;
  createPromptTemplate(input: CreatePromptTemplateInput): Awaitable<PromptTemplate[]>;
  updatePromptTemplate(input: UpdatePromptTemplateInput): Awaitable<PromptTemplate[]>;
  deletePromptTemplate(id: string): Awaitable<PromptTemplate[]>;
};

export type MainIpcSessionQueryDepsArgs = {
  listSessionSummaryPage(request?: SessionSummaryPageRequest | null): Awaitable<HomeSessionSummaryPageResult>;
  listSessionCharacterUsage(): Awaitable<SessionCharacterUsage[]>;
  listSessionAuditLogs(sessionId: string): Awaitable<AuditLogEntry[]>;
  listSessionAuditLogSummaries(sessionId: string): Awaitable<AuditLogSummary[]>;
  listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): Awaitable<AuditLogSummaryPageResult>;
  getSessionAuditLogDetail(sessionId: string, auditLogId: number): Awaitable<AuditLogDetail | null>;
  getSessionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): Awaitable<AuditLogDetailFragment | null>;
  getSessionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): Awaitable<AuditLogOperationDetailFragment | null>;
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  listWorkspaceSkills(providerId: string, workspacePath: string): Promise<DiscoveredSkill[]>;
  listWorkspaceCustomAgents(providerId: string, workspacePath: string): Promise<DiscoveredCustomAgent[]>;
  listOpenSessionWindowIdsPage(
    request?: OpenSessionWindowIdsPageRequest | null,
  ): OpenSessionWindowIdsPageResult;
  getSession(sessionId: string): Awaitable<Session | null>;
  getSessionGlossaryProjection(sessionId: string): Awaitable<SessionGlossaryProjection>;
  searchSessionGlossary(
    sessionId: string,
    request: GlossarySearchRequest,
  ): Awaitable<GlossaryOperationResult<GlossaryListResult>>;
  ensureSessionGlossarySubscription(sessionId: string): Awaitable<void>;
  getSessionFileExplorerOwnerSessionId(sessionId: string): Awaitable<string | null>;
  listSessionFileRoots(sessionId: string): Awaitable<SessionFileRoot[]>;
  listSessionDirectory(request: SessionDirectoryRequest): Awaitable<SessionDirectoryEntry[]>;
  inspectSessionFile(request: SessionFilePreviewResourceRequest): Awaitable<SessionFileDescriptor>;
  readSessionFileChunk(request: SessionFileChunkRequest): Awaitable<SessionFileChunkResult>;
  openSessionFile(request: SessionFileOpenRequest): Awaitable<OpenPathResult>;
  openSessionFilePreviewWindow(
    request: SessionFilePreviewWindowOpenRequest,
  ): Awaitable<SessionFilePreviewWindowOpenResult>;
  getSessionFilePreviewWindowPayload(token: string): SessionFilePreviewWindowPayload | null;
  listFileRootChanges(request: FileRootChangesRequest): Awaitable<FileRootChangesResult>;
  listFileRootChangesRepositories(
    request: FileRootChangesRepositoriesRequest,
  ): Awaitable<FileRootChangesRepositoriesResult>;
  getFileRootDiff(request: FileRootFileDiffRequest): Awaitable<FileRootFileDiffResult>;
  listFileRootGitHistoryRepositories(
    request: FileRootGitHistoryRepositoriesRequest,
  ): Awaitable<FileRootGitHistoryRepositoriesResult>;
  listFileRootGitHistoryCommits(
    request: FileRootGitHistoryCommitsRequest,
  ): Awaitable<FileRootGitHistoryCommitsResult>;
  getFileRootGitHistoryCommitDetail(
    request: FileRootGitHistoryCommitDetailRequest,
  ): Awaitable<FileRootGitHistoryCommitDetailResult>;
  getFileRootGitHistoryComparison(
    request: FileRootGitHistoryComparisonRequest,
  ): Awaitable<FileRootGitHistoryComparisonResult>;
  getFileRootGitHistoryDiff(
    request: FileRootGitHistoryDiffRequest,
  ): Awaitable<FileRootGitHistoryDiffResult>;
  getSessionMessageArtifact(sessionId: string, messageIndex: number): Awaitable<MessageArtifact | null>;
  getDiffPreview(token: string): DiffPreviewPayload | null;
  previewComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
};

export type MainIpcAuxiliaryDepsArgs = {
  listAuxiliarySessions(parentSessionId: string): Awaitable<AuxiliarySessionSummary[]>;
  listAuxiliarySessionSummaries(parentSessionIds: readonly string[]): Awaitable<AuxiliarySessionSummary[]>;
  listOpenActiveAuxiliarySessionSummaries(): Awaitable<AuxiliarySessionSummary[]>;
  listOpenAuxiliarySessionSummaries(): Awaitable<AuxiliarySessionSummary[]>;
  getActiveAuxiliarySession(parentSessionId: string): Awaitable<AuxiliarySession | null>;
  getAuxiliarySession(auxiliarySessionId: string): Awaitable<AuxiliarySession | null>;
  getAuxiliaryDraft(auxiliarySessionId: string): Awaitable<import("../src/auxiliary-draft-contract.js").AuxiliaryDraftRecord | null>;
  saveAuxiliaryDraft(input: import("../src/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput): Awaitable<import("../src/auxiliary-draft-contract.js").AuxiliaryDraftSaveResult>;
  getAuxiliarySessionStatus(auxiliarySessionId: string): Awaitable<import("../src/auxiliary-draft-contract.js").AuxiliarySessionStatus | null>;
  createAuxiliarySession(input: CreateAuxiliarySessionInput): Awaitable<AuxiliarySession>;
  getAuxiliaryCreationContext(parentSessionId: string): Awaitable<import("../src/auxiliary-session-state.js").AuxiliaryCreationContext>;
  cancelAuxiliaryCreation(request: import("../src/auxiliary-session-state.js").AuxiliaryCreationRequest): Awaitable<import("../src/auxiliary-session-state.js").AuxiliaryCreationResult>;
  getAuxiliaryCreation(request: import("../src/auxiliary-session-state.js").AuxiliaryCreationRequest): Awaitable<import("../src/auxiliary-session-state.js").AuxiliaryCreationResult>;
  updateAuxiliarySession(session: AuxiliarySession): Awaitable<AuxiliarySession>;
  closeAuxiliarySession(auxiliarySessionId: string): Awaitable<AuxiliarySession>;
  runAuxiliarySessionTurn(auxiliarySessionId: string, request: RunSessionTurnRequest): Awaitable<AuxiliarySession>;
  cancelAuxiliarySessionRun(auxiliarySessionId: string): Awaitable<void>;
};

export type MainIpcSessionRuntimeDepsArgs = {
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  getProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null;
  getSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
  ): SessionBackgroundActivityState | null;
  resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void;
  resolveLiveElicitation(sessionId: string, requestId: string, response: LiveElicitationResponse): void;
  createSession(input: CreateSessionRequest): Awaitable<Session>;
  updateSession(session: Session): Awaitable<Session>;
  setSessionPinned(request: SetSessionPinnedRequest): Awaitable<SessionSummary>;
  deleteSession(sessionId: string): Awaitable<void>;
  deleteSessionsLastActiveBefore(
    request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
  ): Awaitable<DeleteSessionsResult>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  cancelSessionRun(sessionId: string): void;
};

export type MainIpcMateDepsArgs = {
  getMateState(): Awaitable<MateStorageState>;
  getMateProfile(): Awaitable<MateProfile | null>;
  createMate(input: CreateMateInput): Promise<MateProfile>;
  updateMate(input: UpdateMateInput): Promise<MateProfile>;
  setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile>;
  resetMate(): Promise<void>;
};

export type MainIpcCharacterDepsArgs = {
  listCharacters(options?: { includeArchived?: boolean } | null): Awaitable<CharacterCatalogEntry[]>;
  getCharacter(characterId: string): Awaitable<CharacterDetail | null>;
  createCharacter(input: CreateCharacterInput): Awaitable<CharacterDetail>;
  updateCharacterMetadata(input: UpdateCharacterMetadataInput): Awaitable<CharacterDetail>;
  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): Awaitable<CharacterDetail>;
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  resolveLaunchCharacter(input?: ResolveLaunchCharacterInput | null): Awaitable<CharacterDetail | null>;
  startCharacterAuthoringSession(input: StartCharacterAuthoringSessionInput): Awaitable<CharacterAuthoringSessionStartResult>;
};

export type CreateMainIpcRegistrationDepsArgs = {
  window: MainIpcWindowDepsArgs;
  catalog: MainIpcCatalogDepsArgs;
  settings: MainIpcSettingsDepsArgs;
  promptTemplates: MainIpcPromptTemplateDepsArgs;
  sessionQuery: MainIpcSessionQueryDepsArgs;
  auxiliary?: MainIpcAuxiliaryDepsArgs;
  sessionRuntime: MainIpcSessionRuntimeDepsArgs;
  mate: MainIpcMateDepsArgs;
  character: MainIpcCharacterDepsArgs;
};

function createUnavailableAuxiliaryDeps(): MainIpcAuxiliaryDepsArgs {
  const throwUnavailable = (): never => {
    throw new Error("Auxiliary Session dependency is not configured.");
  };

  return {
    listAuxiliarySessions: () => [],
    listAuxiliarySessionSummaries: () => [],
    listOpenActiveAuxiliarySessionSummaries: () => [],
    listOpenAuxiliarySessionSummaries: () => [],
    getActiveAuxiliarySession: () => null,
    getAuxiliarySession: () => null,
    getAuxiliaryDraft: () => null,
    saveAuxiliaryDraft: throwUnavailable,
    getAuxiliarySessionStatus: () => null,
    createAuxiliarySession: throwUnavailable,
    getAuxiliaryCreationContext: throwUnavailable,
    cancelAuxiliaryCreation: throwUnavailable,
    getAuxiliaryCreation: throwUnavailable,
    updateAuxiliarySession: throwUnavailable,
    closeAuxiliarySession: throwUnavailable,
    runAuxiliarySessionTurn: throwUnavailable,
    cancelAuxiliarySessionRun: throwUnavailable,
  };
}

export function createMainIpcRegistrationDeps(
  args: CreateMainIpcRegistrationDepsArgs,
): MainIpcRegistrationDeps {
  const auxiliary = args.auxiliary ?? createUnavailableAuxiliaryDeps();

  return {
    acknowledgeSessionDraftFlush: args.window.acknowledgeSessionDraftFlush,
    resolveEventWindow: args.window.resolveEventWindow,
    resolveHomeWindow: args.window.resolveHomeWindow,
    resolveSessionWindow: args.window.resolveSessionWindow,
    openSessionWindow: async (sessionId, auxiliarySessionId) => {
      await args.window.openSessionWindow(sessionId, auxiliarySessionId);
    },
    showSessionMonitorContextMenu: args.window.showSessionMonitorContextMenu,
    getSessionWindowRestoreSet: () => args.window.getSessionWindowRestoreSet(),
    restoreSessionWindows: () => args.window.restoreSessionWindows(),
    openHomeWindow: async () => {
      await args.window.openHomeWindow();
    },
    openSessionMonitorWindow: async () => {
      await args.window.openSessionMonitorWindow();
    },
    openSettingsWindow: async () => {
      await args.window.openSettingsWindow();
    },
    openMemoryV6ReviewWindow: async () => {
      await args.window.openMemoryV6ReviewWindow();
    },
    isSessionMonitorWindow: args.window.isSessionMonitorWindow,
    isSettingsWindow: args.window.isSettingsWindow,
    isMemoryV6ReviewWindow: args.window.isMemoryV6ReviewWindow,
    openCharacterEditorWindow: async (characterId) => {
      await args.window.openCharacterEditorWindow(characterId);
    },
    openDiffWindow: async (diffPreview) => {
      await args.window.openDiffWindow(diffPreview);
    },
    isFilePreviewWindow: args.window.isFilePreviewWindow,
    getFilePreviewWindowResource: args.window.getFilePreviewWindowResource,
    isFilePreviewTokenWindow: args.window.isFilePreviewTokenWindow,
    pickDirectory: args.window.pickDirectory,
    validateWorkspaceDirectory: args.window.validateWorkspaceDirectory,
    pickFile: args.window.pickFile,
    pickFiles: args.window.pickFiles,
    pickSessionFiles: args.window.pickSessionFiles,
    pickSessionFolder: args.window.pickSessionFolder,
    pickSessionImageFile: args.window.pickSessionImageFile,
    pickImageFile: args.window.pickImageFile,
    copyFilesToSessionFiles: args.window.copyFilesToSessionFiles,
    savePastedSessionFile: args.window.savePastedSessionFile,
    openSessionFilesDirectory: args.window.openSessionFilesDirectory,
    openSessionFilesTerminal: args.window.openSessionFilesTerminal,
    copySessionFilePreviewImage: args.window.copySessionFilePreviewImage,
    showSessionFilePreviewImageContextMenu: args.window.showSessionFilePreviewImageContextMenu,
    copySessionFileObject: args.window.copySessionFileObject,
    showSessionFileObjectCopyContextMenu: args.window.showSessionFileObjectCopyContextMenu,
    showSessionFileTreeContextMenu: args.window.showSessionFileTreeContextMenu,
    showMarkdownLinkContextMenu: args.window.showMarkdownLinkContextMenu,
    openPathTarget: args.window.openPathTarget,
    openAppLogFolder: args.window.openAppLogFolder,
    openCrashDumpFolder: args.window.openCrashDumpFolder,
    openSessionTerminal: args.window.openSessionTerminal,
    openTerminalAtPath: args.window.openTerminalAtPath,
    logIpcError: args.window.logIpcError,
    reportRendererLog: args.window.reportRendererLog,
    getModelCatalog: args.catalog.getModelCatalog,
    importModelCatalogDocument: args.catalog.importModelCatalogDocument,
    importModelCatalogFromFile: args.catalog.importModelCatalogFromFile,
    exportModelCatalogDocument: args.catalog.exportModelCatalogDocument,
    exportModelCatalogToFile: args.catalog.exportModelCatalogToFile,
    getAppSettings: args.settings.getAppSettings,
    updateAppSettings: args.settings.updateAppSettings,
    updateChatLayoutPreference: args.settings.updateChatLayoutPreference,
    getAppDatabaseDiagnostics: args.settings.getAppDatabaseDiagnostics,
    getMemoryV6Diagnostics: args.settings.getMemoryV6Diagnostics,
    installMemoryV6CliShim: args.settings.installMemoryV6CliShim,
    uninstallMemoryV6CliShim: args.settings.uninstallMemoryV6CliShim,
    getMemoryV6FileUsage: args.settings.getMemoryV6FileUsage,
    exportMemoryV6EntryFiles: args.settings.exportMemoryV6EntryFiles,
    runMemoryV6ProtectedObjectGc: args.settings.runMemoryV6ProtectedObjectGc,
    searchMemoryV6Entries: args.settings.searchMemoryV6Entries,
    getMemoryV6Entry: args.settings.getMemoryV6Entry,
    forgetMemoryV6Entry: args.settings.forgetMemoryV6Entry,
    resetAppDatabase: args.settings.resetAppDatabase,
    listPromptTemplates: args.promptTemplates.listPromptTemplates,
    createPromptTemplate: args.promptTemplates.createPromptTemplate,
    updatePromptTemplate: args.promptTemplates.updatePromptTemplate,
    deletePromptTemplate: args.promptTemplates.deletePromptTemplate,
    listSessionSummaryPage: args.sessionQuery.listSessionSummaryPage,
    listSessionCharacterUsage: args.sessionQuery.listSessionCharacterUsage,
    listSessionAuditLogs: args.sessionQuery.listSessionAuditLogs,
    listSessionAuditLogSummaries: args.sessionQuery.listSessionAuditLogSummaries,
    listSessionAuditLogSummaryPage: args.sessionQuery.listSessionAuditLogSummaryPage,
    getSessionAuditLogDetail: args.sessionQuery.getSessionAuditLogDetail,
    getSessionAuditLogDetailSection: args.sessionQuery.getSessionAuditLogDetailSection,
    getSessionAuditLogOperationDetail: args.sessionQuery.getSessionAuditLogOperationDetail,
    listSessionSkills: args.sessionQuery.listSessionSkills,
    listSessionCustomAgents: args.sessionQuery.listSessionCustomAgents,
    listWorkspaceSkills: args.sessionQuery.listWorkspaceSkills,
    listWorkspaceCustomAgents: args.sessionQuery.listWorkspaceCustomAgents,
    listOpenSessionWindowIdsPage: args.sessionQuery.listOpenSessionWindowIdsPage,
    getSession: args.sessionQuery.getSession,
    getSessionGlossaryProjection: args.sessionQuery.getSessionGlossaryProjection,
    searchSessionGlossary: args.sessionQuery.searchSessionGlossary,
    ensureSessionGlossarySubscription: args.sessionQuery.ensureSessionGlossarySubscription,
    getSessionFileExplorerOwnerSessionId: args.sessionQuery.getSessionFileExplorerOwnerSessionId,
    listSessionFileRoots: args.sessionQuery.listSessionFileRoots,
    listSessionDirectory: args.sessionQuery.listSessionDirectory,
    inspectSessionFile: args.sessionQuery.inspectSessionFile,
    readSessionFileChunk: args.sessionQuery.readSessionFileChunk,
    openSessionFile: args.sessionQuery.openSessionFile,
    openSessionFilePreviewWindow: args.sessionQuery.openSessionFilePreviewWindow,
    getSessionFilePreviewWindowPayload: args.sessionQuery.getSessionFilePreviewWindowPayload,
    listFileRootChanges: args.sessionQuery.listFileRootChanges,
    listFileRootChangesRepositories: args.sessionQuery.listFileRootChangesRepositories,
    getFileRootDiff: args.sessionQuery.getFileRootDiff,
    listFileRootGitHistoryRepositories: args.sessionQuery.listFileRootGitHistoryRepositories,
    listFileRootGitHistoryCommits: args.sessionQuery.listFileRootGitHistoryCommits,
    getFileRootGitHistoryCommitDetail: args.sessionQuery.getFileRootGitHistoryCommitDetail,
    getFileRootGitHistoryComparison: args.sessionQuery.getFileRootGitHistoryComparison,
    getFileRootGitHistoryDiff: args.sessionQuery.getFileRootGitHistoryDiff,
    getSessionMessageArtifact: args.sessionQuery.getSessionMessageArtifact,
    getDiffPreview: args.sessionQuery.getDiffPreview,
    previewComposerInput: args.sessionQuery.previewComposerInput,
    listAuxiliarySessions: auxiliary.listAuxiliarySessions,
    listOpenActiveAuxiliarySessionSummaries: auxiliary.listOpenActiveAuxiliarySessionSummaries,
    listOpenAuxiliarySessionSummaries: auxiliary.listOpenAuxiliarySessionSummaries,
    getActiveAuxiliarySession: auxiliary.getActiveAuxiliarySession,
    getAuxiliarySession: auxiliary.getAuxiliarySession,
    getAuxiliaryDraft: auxiliary.getAuxiliaryDraft,
    saveAuxiliaryDraft: auxiliary.saveAuxiliaryDraft,
    getAuxiliarySessionStatus: auxiliary.getAuxiliarySessionStatus,
    createAuxiliarySession: auxiliary.createAuxiliarySession,
    getAuxiliaryCreationContext: auxiliary.getAuxiliaryCreationContext,
    cancelAuxiliaryCreation: auxiliary.cancelAuxiliaryCreation,
    getAuxiliaryCreation: auxiliary.getAuxiliaryCreation,
    updateAuxiliarySession: auxiliary.updateAuxiliarySession,
    closeAuxiliarySession: auxiliary.closeAuxiliarySession,
    runAuxiliarySessionTurn: auxiliary.runAuxiliarySessionTurn,
    cancelAuxiliarySessionRun: auxiliary.cancelAuxiliarySessionRun,
    getLiveSessionRun: args.sessionRuntime.getLiveSessionRun,
    getProviderQuotaTelemetry: args.sessionRuntime.getProviderQuotaTelemetry,
    getSessionContextTelemetry: args.sessionRuntime.getSessionContextTelemetry,
    getSessionBackgroundActivity: args.sessionRuntime.getSessionBackgroundActivity,
    resolveLiveApproval: args.sessionRuntime.resolveLiveApproval,
    resolveLiveElicitation: args.sessionRuntime.resolveLiveElicitation,
    createSession: args.sessionRuntime.createSession,
    updateSession: args.sessionRuntime.updateSession,
    setSessionPinned: args.sessionRuntime.setSessionPinned,
    deleteSession: args.sessionRuntime.deleteSession,
    deleteSessionsLastActiveBefore: args.sessionRuntime.deleteSessionsLastActiveBefore,
    runSessionTurn: args.sessionRuntime.runSessionTurn,
    cancelSessionRun: args.sessionRuntime.cancelSessionRun,
    getMateState: args.mate.getMateState,
    getMateProfile: args.mate.getMateProfile,
    createMate: args.mate.createMate,
    updateMate: args.mate.updateMate,
    setMateAvatar: args.mate.setMateAvatar,
    resetMate: args.mate.resetMate,
    listCharacters: args.character.listCharacters,
    getCharacter: args.character.getCharacter,
    createCharacter: args.character.createCharacter,
    updateCharacterMetadata: args.character.updateCharacterMetadata,
    updateCharacterDefinition: args.character.updateCharacterDefinition,
    archiveCharacter: args.character.archiveCharacter,
    resolveLaunchCharacter: args.character.resolveLaunchCharacter,
    startCharacterAuthoringSession: args.character.startCharacterAuthoringSession,
  };
}
