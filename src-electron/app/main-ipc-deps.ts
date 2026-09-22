import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";

import type { AuditLogDetail, AuditLogDetailFragment, AuditLogDetailSection, AuditLogEntry, AuditLogOperationDetailFragment, AuditLogSummary, AuditLogSummaryPageRequest, AuditLogSummaryPageResult, LiveApprovalDecision, LiveElicitationResponse, LiveSessionRunState, ProviderQuotaTelemetry, RunSessionTurnRequest, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { SessionBackgroundActivityKind, SessionBackgroundActivityState } from "../../src-shared/memory/session-memory-state.js";
import type { SessionCharacterUsage, SessionSummaryPageRequest, HomeSessionSummaryPageResult, SessionSummary } from "../../src-shared/session/session-state.js";
import type { AppDatabaseDiagnostics } from "../../src-shared/window/app-database-diagnostics-state.js";
import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../src-shared/window/markdown-link-context-menu.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest } from "../../src-shared/memory/memory-contract.js";
import type { MemoryFileUsageResponse } from "../../src-shared/memory/memory-response-contract.js";
import type {
  MemoryV6ReviewEntryDetail,
  MemoryV6ReviewExportFilesResult,
  MemoryV6ReviewForgetResult,
  MemoryV6ProtectedObjectGcRequest,
  MemoryV6ProtectedObjectGcResponse,
  MemoryV6ReviewSearchResult,
} from "../../src-shared/memory/memory-review-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "../../src-shared/character/character-authoring.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../../src-shared/character/character-catalog.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { ChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
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
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type {
  SessionFileObjectCopyContextMenuRequest,
  SessionFileObjectCopyContextMenuResult,
  SessionFileObjectCopyRequest,
  SessionFileObjectCopyResult,
} from "../../src-shared/file-explorer/session-file-object-copy-contract.js";
import type {
  GlossaryListResult,
  GlossaryOperationResult,
  GlossarySearchRequest,
  SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../../src-shared/session/runtime-state.js";
import type {
  CreateSessionRequest,
  DiffPreviewPayload,
  MessageArtifact,
  Session,
  SetSessionPinnedRequest,
} from "../../src-shared/session/session-state.js";
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
} from "../../src-shared/window/withmate-window-types.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../../src-shared/mate/mate-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../../src-shared/prompt-template.js";
import type {
  LogIpcErrorInput,
  MainIpcRegistrationDeps,
} from "../ipc/contracts.js";
import { createAuxiliaryIpcDeps } from "../ipc/auxiliary.js";
import { createCatalogIpcDeps } from "../ipc/catalog.js";
import { createSessionQueryIpcDeps } from "../ipc/session-query.js";
import { createSessionRuntimeIpcDeps } from "../ipc/session-runtime.js";
import { createSettingsIpcDeps } from "../ipc/settings.js";
import { createWindowIpcDeps } from "../ipc/window.js";
import type { SessionWindowRestoreResult } from "../../src-shared/window/session-window-restore.js";

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
  logIpcError?: (input: LogIpcErrorInput) => void;
  reportRendererLog?: (input: RendererLogInput, windowId?: number) => void;
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
  getAuxiliaryDraft(auxiliarySessionId: string): Awaitable<import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftRecord | null>;
  saveAuxiliaryDraft(input: import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput): Awaitable<import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveResult>;
  getAuxiliarySessionStatus(auxiliarySessionId: string): Awaitable<import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliarySessionStatus | null>;
  createAuxiliarySession(input: CreateAuxiliarySessionInput): Awaitable<AuxiliarySession>;
  getAuxiliaryCreationContext(parentSessionId: string): Awaitable<import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationContext>;
  cancelAuxiliaryCreation(request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest): Awaitable<import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult>;
  getAuxiliaryCreation(request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest): Awaitable<import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult>;
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
  const eventWindow = {
    resolveEventWindow: args.window.resolveEventWindow,
  };
  const homeWindow = {
    resolveHomeWindow: args.window.resolveHomeWindow,
  };
  const sessionWindow = {
    resolveSessionWindow: args.window.resolveSessionWindow,
  };
  const windowContext = {
    ...eventWindow,
    ...homeWindow,
    ...sessionWindow,
    isSessionMonitorWindow: args.window.isSessionMonitorWindow,
    validateWorkspaceDirectory: args.window.validateWorkspaceDirectory,
    getAuxiliarySession: auxiliary.getAuxiliarySession,
  };
  const settingsContext = {
    ...eventWindow,
    ...homeWindow,
    isSettingsWindow: args.window.isSettingsWindow,
    isMemoryV6ReviewWindow: args.window.isMemoryV6ReviewWindow,
  };
  const sessionQueryContext = {
    ...eventWindow,
    ...sessionWindow,
    validateWorkspaceDirectory: args.window.validateWorkspaceDirectory,
    getFilePreviewWindowResource: args.window.getFilePreviewWindowResource,
    isFilePreviewTokenWindow: args.window.isFilePreviewTokenWindow,
  };
  const sessionRuntimeContext = {
    ...eventWindow,
    ...homeWindow,
    ...sessionWindow,
    validateWorkspaceDirectory: args.window.validateWorkspaceDirectory,
    isSettingsWindow: args.window.isSettingsWindow,
  };

  return {
    common: {
      acknowledgeSessionDraftFlush: args.window.acknowledgeSessionDraftFlush,
      resolveEventWindow: args.window.resolveEventWindow,
      logIpcError: args.window.logIpcError,
      reportRendererLog: args.window.reportRendererLog,
    },
    window: createWindowIpcDeps(args.window, windowContext),
    catalog: createCatalogIpcDeps(args.catalog, {
      ...eventWindow,
      ...homeWindow,
    }),
    settings: createSettingsIpcDeps(args.settings, settingsContext),
    promptTemplates: args.promptTemplates,
    sessionQuery: createSessionQueryIpcDeps(
      {
        ...args.sessionQuery,
        copySessionFilePreviewImage: args.window.copySessionFilePreviewImage,
        showSessionFilePreviewImageContextMenu:
          args.window.showSessionFilePreviewImageContextMenu,
        copySessionFileObject: args.window.copySessionFileObject,
        showSessionFileObjectCopyContextMenu:
          args.window.showSessionFileObjectCopyContextMenu,
        showSessionFileTreeContextMenu:
          args.window.showSessionFileTreeContextMenu,
        showMarkdownLinkContextMenu: args.window.showMarkdownLinkContextMenu,
      },
      sessionQueryContext,
    ),
    auxiliary: createAuxiliaryIpcDeps(auxiliary, {
      ...eventWindow,
      ...sessionWindow,
    }),
    sessionRuntime: createSessionRuntimeIpcDeps(
      args.sessionRuntime,
      sessionRuntimeContext,
    ),
    mate: args.mate,
    character: args.character,
  };
}
