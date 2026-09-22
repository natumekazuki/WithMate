import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";

import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "../../src-shared/window/markdown-link-context-menu.js";
import type { AppDatabaseDiagnostics } from "../../src-shared/window/app-database-diagnostics-state.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import type {
  MemoryForgetReason,
  MemoryV6ReviewSearchRequest,
} from "../../src-shared/memory/memory-contract.js";
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
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import type {
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
} from "../../src-shared/memory/session-memory-state.js";
import type {
  SessionCharacterUsage,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  StartCharacterAuthoringSessionInput,
  CharacterAuthoringSessionStartResult,
} from "../../src-shared/character/character-authoring.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../../src-shared/character/character-catalog.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../../src-shared/mate/mate-state.js";
import type {
  ModelCatalogDocument,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { type ChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "../../src-shared/prompt-template.js";
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

import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
} from "../../src-shared/session/runtime-state.js";
import type {
  CreateSessionRequest,
  DiffPreviewPayload,
  MessageArtifact,
  Session,
  SetSessionPinnedRequest,
} from "../../src-shared/session/session-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionWindowRestoreResult } from "../../src-shared/window/session-window-restore.js";
import { type WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

import {
  type ImageFilePickerPurpose,
  type OpenPathOptions,
  type OpenPathResult,
  type DeleteSessionsLastActiveBeforeRequest,
  type DeleteSessionsResult,
  type OpenSessionWindowIdsPageRequest,
  type OpenSessionWindowIdsPageResult,
  type ResetAppDatabaseRequest,
  type SavePastedSessionFileRequest,
  type SessionMonitorContextMenuRequest,
  type SessionMonitorContextMenuResult,
} from "../../src-shared/window/withmate-window-types.js";
export type MaybeWindow = BrowserWindow | null | undefined;
export type IpcSenderEvent = Pick<IpcMainInvokeEvent, "sender">;
export type LogIpcErrorInput = {
  channel: string;
  durationMs: number;
  error: unknown;
  clientRequestId?: string;
};
export type IpcHandleRegistrar = {
  handle: IpcMain["handle"];
};
export type MainIpcCommonDeps = {
  acknowledgeSessionDraftFlush(
    event: IpcSenderEvent,
    payload: { requestId: string; success: boolean },
  ): void;
  resolveEventWindow(event: IpcSenderEvent): MaybeWindow;
  logIpcError?(input: LogIpcErrorInput): void;
  reportRendererLog?(input: RendererLogInput, windowId?: number): void;
};

export type MainIpcEventWindowDeps = {
  resolveEventWindow(event: IpcSenderEvent): MaybeWindow;
};
export type MainIpcHomeWindowDeps = {
  resolveHomeWindow(): MaybeWindow;
};
export type MainIpcSessionWindowDeps = {
  resolveSessionWindow(sessionId: string): MaybeWindow;
};
export type MainIpcSettingsWindowDeps = {
  isSettingsWindow(window: BrowserWindow): boolean;
};
export type MainIpcMemoryReviewWindowDeps = {
  isMemoryV6ReviewWindow(window: BrowserWindow): boolean;
};
export type MainIpcSessionMonitorWindowDeps = {
  isSessionMonitorWindow(window: BrowserWindow): boolean;
};
export type MainIpcWorkspaceValidationDeps = {
  validateWorkspaceDirectory(
    targetPath: unknown,
  ): Promise<WorkspaceDirectoryValidationResult>;
};
export type MainIpcAuxiliaryLookupDeps = {
  getAuxiliarySession(
    auxiliarySessionId: string,
  ): Awaitable<AuxiliarySession | null>;
};
export type MainIpcFilePreviewWindowDeps = {
  getFilePreviewWindowResource(
    window: BrowserWindow,
    sessionId: string,
  ): SessionFilePreviewResourceRequest | null;
  isFilePreviewTokenWindow(window: BrowserWindow, token: string): boolean;
};

export type MainIpcWindowDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps &
  MainIpcSessionWindowDeps &
  MainIpcSessionMonitorWindowDeps &
  MainIpcWorkspaceValidationDeps &
  MainIpcAuxiliaryLookupDeps & {
    openSessionWindow(
      sessionId: string,
      auxiliarySessionId?: string,
    ): Promise<void>;
    showSessionMonitorContextMenu(
      event: IpcSenderEvent,
      request: SessionMonitorContextMenuRequest,
    ): Awaitable<SessionMonitorContextMenuResult>;
    getSessionWindowRestoreSet(): Promise<string[]>;
    restoreSessionWindows(): Promise<SessionWindowRestoreResult>;
    openHomeWindow(): Promise<void>;
    openSessionMonitorWindow(): Promise<void>;
    openSettingsWindow(): Promise<void>;
    openMemoryV6ReviewWindow(): Promise<void>;
    openCharacterEditorWindow(characterId?: string | null): Promise<void>;
    openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
    pickDirectory(
      targetWindow: MaybeWindow,
      initialPath: string | null,
    ): Promise<string | null>;
    pickFile(
      targetWindow: MaybeWindow,
      initialPath: string | null,
    ): Promise<string | null>;
    pickFiles(
      targetWindow: MaybeWindow,
      initialPath: string | null,
    ): Promise<string[]>;
    pickSessionFiles(
      targetWindow: MaybeWindow,
      sessionId: string,
    ): Promise<string[]>;
    pickSessionFolder(
      targetWindow: MaybeWindow,
      sessionId: string,
    ): Promise<string | null>;
    pickSessionImageFile(
      targetWindow: MaybeWindow,
      sessionId: string,
    ): Promise<string | null>;
    pickImageFile(
      targetWindow: MaybeWindow,
      initialPath: string | null,
      purpose: ImageFilePickerPurpose,
    ): Promise<string | null>;
    copyFilesToSessionFiles(
      sessionId: string,
      sourcePaths: string[],
    ): Promise<string[]>;
    savePastedSessionFile(request: SavePastedSessionFileRequest): Promise<string>;
    openSessionFilesDirectory(sessionId: string): Promise<void>;
    openSessionFilesTerminal(sessionId: string): Promise<void>;
    openPathTarget(
      target: string,
      options?: OpenPathOptions,
    ): Promise<OpenPathResult>;
    openAppLogFolder(): Promise<void>;
    openCrashDumpFolder(): Promise<void>;
    openSessionTerminal(sessionId: string): Promise<void>;
    openTerminalAtPath(target: string): Promise<void>;
  };

export type MainIpcCatalogDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps & {
    getModelCatalog(
      revision: number | null,
    ): Awaitable<ModelCatalogSnapshot | null>;
    importModelCatalogDocument(
      document: ModelCatalogDocument,
    ): Awaitable<ModelCatalogSnapshot>;
    importModelCatalogFromFile(
      targetWindow?: MaybeWindow,
    ): Promise<ModelCatalogSnapshot | null>;
    exportModelCatalogDocument(
      revision: number | null,
    ): Awaitable<ModelCatalogDocument | null>;
    exportModelCatalogToFile(
      revision: number | null,
      targetWindow?: MaybeWindow,
    ): Promise<string | null>;
  };

export type MainIpcSettingsDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps &
  MainIpcSettingsWindowDeps &
  MainIpcMemoryReviewWindowDeps & {
    getAppSettings(): Awaitable<AppSettings>;
    updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
    updateChatLayoutPreference(
      update: ChatLayoutPreferenceUpdate,
    ): Awaitable<AppSettings>;
    getAppDatabaseDiagnostics(): Awaitable<AppDatabaseDiagnostics>;
    getMemoryV6Diagnostics(): Awaitable<MemoryV6Diagnostics>;
    installMemoryV6CliShim(): Awaitable<MemoryV6Diagnostics>;
    uninstallMemoryV6CliShim(): Awaitable<MemoryV6Diagnostics>;
    getMemoryV6FileUsage(): Awaitable<MemoryFileUsageResponse>;
    exportMemoryV6EntryFiles(
      entryId: string,
      targetWindow?: MaybeWindow,
    ): Awaitable<MemoryV6ReviewExportFilesResult | null>;
    runMemoryV6ProtectedObjectGc(
      request: MemoryV6ProtectedObjectGcRequest,
    ): Awaitable<MemoryV6ProtectedObjectGcResponse>;
    searchMemoryV6Entries(
      request: MemoryV6ReviewSearchRequest | null | undefined,
    ): Awaitable<MemoryV6ReviewSearchResult>;
    getMemoryV6Entry(
      entryId: string,
    ): Awaitable<MemoryV6ReviewEntryDetail | null>;
    forgetMemoryV6Entry(
      entryId: string,
      reason?: MemoryForgetReason | null,
    ): Awaitable<MemoryV6ReviewForgetResult>;
    resetAppDatabase(
      request: ResetAppDatabaseRequest | null | undefined,
    ): Promise<unknown>;
  };

export type MainIpcAuxiliaryDeps = MainIpcEventWindowDeps &
  MainIpcSessionWindowDeps & {
    listAuxiliarySessions?(
      parentSessionId: string,
    ): Awaitable<AuxiliarySessionSummary[]>;
    listOpenActiveAuxiliarySessionSummaries?(): Awaitable<
      AuxiliarySessionSummary[]
    >;
    listOpenAuxiliarySessionSummaries?(): Awaitable<AuxiliarySessionSummary[]>;
    getActiveAuxiliarySession?(
      parentSessionId: string,
    ): Awaitable<AuxiliarySession | null>;
    getAuxiliarySession?(
      auxiliarySessionId: string,
    ): Awaitable<AuxiliarySession | null>;
    getAuxiliaryDraft?(
      auxiliarySessionId: string,
    ): Awaitable<
      | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftRecord
      | null
    >;
    saveAuxiliaryDraft?(
      input: import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveResult
    >;
    getAuxiliarySessionStatus?(
      auxiliarySessionId: string,
    ): Awaitable<
      | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliarySessionStatus
      | null
    >;
    createAuxiliarySession?(
      input: CreateAuxiliarySessionInput,
    ): Awaitable<AuxiliarySession>;
    getAuxiliaryCreationContext?(
      parentSessionId: string,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationContext
    >;
    cancelAuxiliaryCreation?(
      request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
    >;
    getAuxiliaryCreation?(
      request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
    ): Awaitable<
      import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationResult
    >;
    updateAuxiliarySession?(
      session: AuxiliarySession,
    ): Awaitable<AuxiliarySession>;
    closeAuxiliarySession?(
      auxiliarySessionId: string,
    ): Awaitable<AuxiliarySession>;
    runAuxiliarySessionTurn?(
      auxiliarySessionId: string,
      request: RunSessionTurnRequest,
    ): Awaitable<AuxiliarySession>;
    cancelAuxiliarySessionRun?(auxiliarySessionId: string): Awaitable<void>;
  };

export type MainIpcAuxiliaryDepsRequired = {
  listAuxiliarySessions: (
    parentSessionId: string,
  ) => Awaitable<AuxiliarySessionSummary[]>;
  listOpenActiveAuxiliarySessionSummaries: () => Awaitable<
    AuxiliarySessionSummary[]
  >;
  listOpenAuxiliarySessionSummaries: () => Awaitable<AuxiliarySessionSummary[]>;
  getActiveAuxiliarySession: (
    parentSessionId: string,
  ) => Awaitable<AuxiliarySession | null>;
  getAuxiliarySession: (
    auxiliarySessionId: string,
  ) => Awaitable<AuxiliarySession | null>;
  getAuxiliaryDraft: (
    auxiliarySessionId: string,
  ) => Awaitable<
    | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftRecord
    | null
  >;
  saveAuxiliaryDraft: (
    input: import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput,
  ) => Awaitable<
    import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveResult
  >;
  getAuxiliarySessionStatus: (
    auxiliarySessionId: string,
  ) => Awaitable<
    | import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliarySessionStatus
    | null
  >;
  createAuxiliarySession: (
    input: CreateAuxiliarySessionInput,
  ) => Awaitable<AuxiliarySession>;
  updateAuxiliarySession: (
    session: AuxiliarySession,
  ) => Awaitable<AuxiliarySession>;
  closeAuxiliarySession: (
    auxiliarySessionId: string,
  ) => Awaitable<AuxiliarySession>;
  runAuxiliarySessionTurn: (
    auxiliarySessionId: string,
    request: RunSessionTurnRequest,
  ) => Awaitable<AuxiliarySession>;
  cancelAuxiliarySessionRun: (auxiliarySessionId: string) => Awaitable<void>;
};

export type MainIpcSessionQueryDeps = MainIpcEventWindowDeps &
  MainIpcSessionWindowDeps &
  MainIpcWorkspaceValidationDeps &
  MainIpcFilePreviewWindowDeps & {
    listSessionSummaryPage(
      request?: SessionSummaryPageRequest | null,
    ): Awaitable<HomeSessionSummaryPageResult>;
    listSessionCharacterUsage(): Awaitable<SessionCharacterUsage[]>;
    listSessionAuditLogs(sessionId: string): Awaitable<AuditLogEntry[]>;
    listSessionAuditLogSummaries(sessionId: string): Awaitable<AuditLogSummary[]>;
    listSessionAuditLogSummaryPage(
      sessionId: string,
      request?: AuditLogSummaryPageRequest | null,
    ): Awaitable<AuditLogSummaryPageResult>;
    getSessionAuditLogDetail(
      sessionId: string,
      auditLogId: number,
    ): Awaitable<AuditLogDetail | null>;
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
    listWorkspaceSkills(
      providerId: string,
      workspacePath: string,
    ): Promise<DiscoveredSkill[]>;
    listWorkspaceCustomAgents(
      providerId: string,
      workspacePath: string,
    ): Promise<DiscoveredCustomAgent[]>;
    listOpenSessionWindowIdsPage(
      request?: OpenSessionWindowIdsPageRequest | null,
    ): OpenSessionWindowIdsPageResult;
    getSession(sessionId: string): Awaitable<Session | null>;
    getSessionGlossaryProjection(
      sessionId: string,
    ): Awaitable<SessionGlossaryProjection>;
    searchSessionGlossary(
      sessionId: string,
      request: GlossarySearchRequest,
    ): Awaitable<GlossaryOperationResult<GlossaryListResult>>;
    ensureSessionGlossarySubscription(sessionId: string): Awaitable<void>;
    getSessionFileExplorerOwnerSessionId(
      sessionId: string,
    ): Awaitable<string | null>;
    listSessionFileRoots(sessionId: string): Awaitable<SessionFileRoot[]>;
    listSessionDirectory(
      request: SessionDirectoryRequest,
    ): Awaitable<SessionDirectoryEntry[]>;
    inspectSessionFile(
      request: SessionFilePreviewResourceRequest,
    ): Awaitable<SessionFileDescriptor>;
    readSessionFileChunk(
      request: SessionFileChunkRequest,
    ): Awaitable<SessionFileChunkResult>;
    openSessionFile(request: SessionFileOpenRequest): Awaitable<OpenPathResult>;
    openSessionFilePreviewWindow(
      request: SessionFilePreviewWindowOpenRequest,
    ): Awaitable<SessionFilePreviewWindowOpenResult>;
    getSessionFilePreviewWindowPayload(
      token: string,
    ): SessionFilePreviewWindowPayload | null;
    copySessionFilePreviewImage(
      event: IpcSenderEvent,
      request: SessionFilePreviewImageActionRequest,
    ): Awaitable<SessionFilePreviewImageCopyResult>;
    showSessionFilePreviewImageContextMenu(
      event: IpcSenderEvent,
      request: SessionFilePreviewImageActionRequest,
    ): Awaitable<SessionFilePreviewImageContextMenuResult>;
    copySessionFileObject(
      event: IpcSenderEvent,
      request: SessionFileObjectCopyRequest,
    ): Awaitable<SessionFileObjectCopyResult>;
    showSessionFileObjectCopyContextMenu(
      event: IpcSenderEvent,
      request: SessionFileObjectCopyContextMenuRequest,
    ): Awaitable<SessionFileObjectCopyContextMenuResult>;
    showSessionFileTreeContextMenu(
      event: IpcSenderEvent,
      request: SessionFileTreePathActionRequest,
    ): Awaitable<SessionFileTreePathActionContextMenuResult>;
    showMarkdownLinkContextMenu(
      event: IpcSenderEvent,
      request: MarkdownLinkContextMenuRequest,
    ): Awaitable<MarkdownLinkContextMenuResult>;
    listFileRootChanges(
      request: FileRootChangesRequest,
    ): Awaitable<FileRootChangesResult>;
    listFileRootChangesRepositories(
      request: FileRootChangesRepositoriesRequest,
    ): Awaitable<FileRootChangesRepositoriesResult>;
    getFileRootDiff(
      request: FileRootFileDiffRequest,
    ): Awaitable<FileRootFileDiffResult>;
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
    getSessionMessageArtifact(
      sessionId: string,
      messageIndex: number,
    ): Awaitable<MessageArtifact | null>;
    getDiffPreview(token: string): DiffPreviewPayload | null;
    previewComposerInput(
      sessionId: string,
      userMessage: string,
    ): Promise<unknown>;
  };

export type MainIpcSessionRuntimeDeps = MainIpcEventWindowDeps &
  MainIpcHomeWindowDeps &
  MainIpcSessionWindowDeps &
  MainIpcSettingsWindowDeps &
  MainIpcWorkspaceValidationDeps & {
    getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
    getProviderQuotaTelemetry(
      providerId: string,
    ): Promise<ProviderQuotaTelemetry | null>;
    getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null;
    getSessionBackgroundActivity(
      sessionId: string,
      kind: SessionBackgroundActivityKind,
    ): SessionBackgroundActivityState | null;
    resolveLiveApproval(
      sessionId: string,
      requestId: string,
      decision: LiveApprovalDecision,
    ): void;
    resolveLiveElicitation(
      sessionId: string,
      requestId: string,
      response: LiveElicitationResponse,
    ): void;
    createSession(input: CreateSessionRequest): Awaitable<Session>;
    updateSession(session: Session): Awaitable<Session>;
    setSessionPinned(request: SetSessionPinnedRequest): Awaitable<SessionSummary>;
    deleteSession(sessionId: string): Awaitable<void>;
    deleteSessionsLastActiveBefore(
      request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
    ): Awaitable<DeleteSessionsResult>;
    runSessionTurn(
      sessionId: string,
      request: RunSessionTurnRequest,
    ): Promise<Session>;
    cancelSessionRun(sessionId: string): void;
  };

export type MainIpcMateDeps = {
  getMateState(): Awaitable<MateStorageState>;
  getMateProfile(): Awaitable<MateProfile | null>;
  createMate(input: CreateMateInput): Promise<MateProfile>;
  updateMate(input: UpdateMateInput): Promise<MateProfile>;
  setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile>;
  resetMate(): Promise<void>;
};

export type MainIpcCharacterDeps = {
  listCharacters(
    options?: { includeArchived?: boolean } | null,
  ): Awaitable<CharacterCatalogEntry[]>;
  getCharacter(characterId: string): Awaitable<CharacterDetail | null>;
  createCharacter(input: CreateCharacterInput): Awaitable<CharacterDetail>;
  updateCharacterMetadata(
    input: UpdateCharacterMetadataInput,
  ): Awaitable<CharacterDetail>;
  updateCharacterDefinition(
    input: UpdateCharacterDefinitionInput,
  ): Awaitable<CharacterDetail>;
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  resolveLaunchCharacter(
    input?: ResolveLaunchCharacterInput | null,
  ): Awaitable<CharacterDetail | null>;
  startCharacterAuthoringSession(
    input: StartCharacterAuthoringSessionInput,
  ): Awaitable<CharacterAuthoringSessionStartResult>;
};

export type MainIpcPromptTemplateDeps = {
  listPromptTemplates(): Awaitable<PromptTemplate[]>;
  createPromptTemplate(
    input: CreatePromptTemplateInput,
  ): Awaitable<PromptTemplate[]>;
  updatePromptTemplate(
    input: UpdatePromptTemplateInput,
  ): Awaitable<PromptTemplate[]>;
  deletePromptTemplate(id: string): Awaitable<PromptTemplate[]>;
};

/** Feature-owned IPC dependencies assembled before registration. */
export type MainIpcRegistrationDeps = {
  common: MainIpcCommonDeps;
  window: MainIpcWindowDeps;
  catalog: MainIpcCatalogDeps;
  settings: MainIpcSettingsDeps;
  promptTemplates: MainIpcPromptTemplateDeps;
  sessionQuery: MainIpcSessionQueryDeps;
  auxiliary: MainIpcAuxiliaryDeps;
  sessionRuntime: MainIpcSessionRuntimeDeps;
  mate: MainIpcMateDeps;
  character: MainIpcCharacterDeps;
};
