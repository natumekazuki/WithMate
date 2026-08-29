import type {
  AuditLogEntry,
  AuditLogDetail,
  AuditLogDetailFragment,
  AuditLogDetailSection,
  AuditLogSummary,
  AuditLogOperationDetailFragment,
  AuditLogSummaryPageRequest,
  AuditLogSummaryPageResult,
  AppSettings,
  CharacterProfile,
  ComposerPreview,
  CreateSessionRequest,
  DiscoveredCustomAgent,
  DiscoveredSkill,
  DiffPreviewPayload,
  LiveApprovalDecision,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
  MessageArtifact,
  SessionCharacterUsage,
  RunSessionTurnRequest,
  Session,
  SessionSummaryInvalidation,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
  SessionSummary,
  SetSessionPinnedRequest,
} from "./app-state.js";
import type { CompanionSession, CompanionSessionSummary, CreateCompanionSessionInput } from "./companion-state.js";
import type { ChatLayoutPreferenceUpdate } from "./chat/chat-layout-preference.js";
import type { RelatedSessionSummary } from "./related-session-details.js";
import type {
  CreatePromptTemplateInput,
  PromptTemplate,
  UpdatePromptTemplateInput,
} from "./prompt-template.js";
import type {
  CompanionMergeSelectedFilesRequest,
  CompanionMergeSelectedFilesResult,
  CompanionReviewSnapshot,
  CompanionSyncTargetResult,
  CompanionTargetWorkspaceStashResult,
} from "./companion-review-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "./model-catalog.js";
import type { RendererLogInput } from "./app-log-types.js";
import type {
  MarkdownLinkContextMenuRequest,
  MarkdownLinkContextMenuResult,
} from "./markdown-link-context-menu.js";
import type { AppBootStatus } from "./app-boot-state.js";
import type { WorkspaceDirectoryValidationResult } from "./workspace-directory-validation.js";
import type {
  CreateSessionScheduleInput,
  RunSessionScheduleNowInput,
  SessionScheduleProjection,
  SessionScheduleSummary,
  SessionScheduleChangedEvent,
  SessionScheduleRevisionRequest,
  UpdateSessionScheduleInput,
} from "./session-schedule.js";
import type {
  CancelSessionExecutionRequest,
  CancelSessionExecutionResult,
  EnqueueSessionTurnResult,
  SessionExecutionChangedEvent,
  SessionTurnExecutionProjection,
} from "./session-turn-execution.js";
import type { AppDatabaseDiagnostics } from "./app-database-diagnostics-state.js";
import type { MemoryV6Diagnostics } from "./memory-v6/memory-diagnostics-state.js";
import type { SessionIntegrationDiagnostics } from "./session-integration-diagnostics-state.js";
import type { MemoryV6ReviewApi } from "./memory-v6/memory-review-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "./auxiliary-session-state.js";
import type {
  ImageFilePickerPurpose,
  OpenPathOptions,
  OpenPathResult,
  DeleteSessionsLastActiveBeforeRequest,
  DeleteSessionsResult,
  ResetAppDatabaseRequest,
  ResetAppDatabaseResult,
  SavePastedSessionFileRequest,
} from "./withmate-window-types.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "./mate/mate-state.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "./character/character-catalog.js";
import type {
  CharacterAuthoringSessionStartResult,
  StartCharacterAuthoringSessionInput,
} from "./character/character-authoring.js";
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
  SessionFileResourceRequest,
  SessionFileRoot,
  FileRootChangesRequest,
  FileRootChangesResult,
  FileRootFileDiffRequest,
  FileRootFileDiffResult,
} from "./file-explorer/file-explorer-contract.js";
import type {
  CoordinationEvent,
  CoordinationEventCancelInput,
  CoordinationEventTrustedResolveInput,
  CoordinationEventInvalidation,
  CoordinationEventSummary,
  CoordinationEventTrustedListInput,
  CoordinationEventListResult,
} from "./coordination-event.js";
import type { RootWorkItem, WorkItemEvent } from "./work-item.js";

export type RootWorkItemRevisionRequest = Readonly<{
  goal: string;
  scope: string;
  completionCriteria: string;
  authority: string;
  expectedRevision: number;
  idempotencyKey: string;
}>;

export type RootWorkItemHistoryAppendRequest = Readonly<{
  type: "progress" | "handoff";
  summary: string;
  blockers: readonly string[];
  nextAction: string;
  expectedRevision: number;
  idempotencyKey: string;
}>;

export type WithMateWindowNavigationApi = {
  openSession(sessionId: string): Promise<void>;
  openHomeWindow(): Promise<void>;
  openSessionMonitorWindow(): Promise<void>;
  openSettingsWindow(): Promise<void>;
  openMemoryV6ReviewWindow(): Promise<void>;
  openCoordinationWindow(): Promise<void>;
  openCharacterEditorWindow(characterId?: string | null): Promise<void>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
  openSessionFilePreviewWindow(
    request: SessionFilePreviewWindowOpenRequest,
  ): Promise<SessionFilePreviewWindowOpenResult>;
  openCompanionReviewWindow(sessionId: string): Promise<void>;
  openCompanionMergeWindow(sessionId: string): Promise<void>;
  openPath(target: string, options?: OpenPathOptions): Promise<OpenPathResult>;
  showMarkdownLinkContextMenu(
    request: MarkdownLinkContextMenuRequest,
  ): Promise<MarkdownLinkContextMenuResult>;
  openAppLogFolder(): Promise<void>;
  openCrashDumpFolder(): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
  openTerminalAtPath(target: string): Promise<void>;
};

export type WithMateWindowCoordinationApi = {
  listCoordinationEvents(input: CoordinationEventTrustedListInput): Promise<CoordinationEventListResult>;
  getCoordinationEvent(eventId: string): Promise<CoordinationEvent>;
  resolveCoordinationEvent(input: CoordinationEventTrustedResolveInput): Promise<CoordinationEvent>;
  cancelCoordinationEvent(input: CoordinationEventCancelInput): Promise<CoordinationEvent>;
};

export type WithMateWindowCatalogApi = {
  getModelCatalog(revision?: number | null): Promise<ModelCatalogSnapshot | null>;
  importModelCatalog(document: ModelCatalogDocument): Promise<ModelCatalogSnapshot>;
  exportModelCatalog(revision?: number | null): Promise<ModelCatalogDocument | null>;
  importModelCatalogFile(): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogFile(revision?: number | null): Promise<string | null>;
  getDiffPreview(token: string): Promise<DiffPreviewPayload | null>;
};

export type WithMateWindowSessionApi = {
  listSessionSummaryPage(request?: SessionSummaryPageRequest | null): Promise<HomeSessionSummaryPageResult>;
  listRelatedSessionSummaries(sessionIds: readonly string[]): Promise<RelatedSessionSummary[]>;
  listSessionCharacterUsage(): Promise<SessionCharacterUsage[]>;
  getSession(sessionId: string): Promise<Session | null>;
  getRootWorkItem(sessionId: string): Promise<RootWorkItem | null>;
  listRootWorkItemHistory(sessionId: string, limit: number): Promise<readonly WorkItemEvent[]>;
  reviseRootWorkItem(sessionId: string, request: RootWorkItemRevisionRequest): Promise<RootWorkItem>;
  appendRootWorkItemHistory(
    sessionId: string,
    request: RootWorkItemHistoryAppendRequest,
  ): Promise<RootWorkItem>;
  validateSessionWorkspace(sessionId: string): Promise<WorkspaceDirectoryValidationResult>;
  listSessionFileRoots(sessionId: string): Promise<SessionFileRoot[]>;
  listSessionDirectory(request: SessionDirectoryRequest): Promise<SessionDirectoryEntry[]>;
  inspectSessionFile(request: SessionFileResourceRequest): Promise<SessionFileDescriptor>;
  readSessionFileChunk(request: SessionFileChunkRequest): Promise<SessionFileChunkResult>;
  openSessionFile(request: SessionFileOpenRequest): Promise<OpenPathResult>;
  getSessionFilePreviewWindowPayload(token: string): Promise<SessionFilePreviewWindowPayload | null>;
  copySessionFilePreviewImage(
    request: SessionFilePreviewImageActionRequest,
  ): Promise<SessionFilePreviewImageCopyResult>;
  showSessionFilePreviewImageContextMenu(
    request: SessionFilePreviewImageActionRequest,
  ): Promise<SessionFilePreviewImageContextMenuResult>;
  listFileRootChanges(request: FileRootChangesRequest): Promise<FileRootChangesResult>;
  getFileRootDiff(request: FileRootFileDiffRequest): Promise<FileRootFileDiffResult>;
  getSessionMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null>;
  createSession(input: CreateSessionRequest): Promise<Session>;
  updateSession(session: Session): Promise<Session>;
  setSessionPinned(request: SetSessionPinnedRequest): Promise<SessionSummary>;
  deleteSession(sessionId: string): Promise<void>;
  previewComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview>;
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  listWorkspaceSkills(providerId: string, workspacePath: string): Promise<DiscoveredSkill[]>;
  listWorkspaceCustomAgents(providerId: string, workspacePath: string): Promise<DiscoveredCustomAgent[]>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  enqueueSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<EnqueueSessionTurnResult>;
  listSessionTurnExecutions(sessionId: string): Promise<SessionTurnExecutionProjection[]>;
  cancelSessionExecution(
    sessionId: string,
    request: CancelSessionExecutionRequest,
  ): Promise<CancelSessionExecutionResult>;
  cancelSessionRun(sessionId: string): Promise<void>;
  listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]>;
  listSessionAuditLogSummaries(sessionId: string): Promise<AuditLogSummary[]>;
  listSessionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): Promise<AuditLogSummaryPageResult>;
  getSessionAuditLogDetail(sessionId: string, auditLogId: number): Promise<AuditLogDetail | null>;
  getSessionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): Promise<AuditLogDetailFragment | null>;
  getSessionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): Promise<AuditLogOperationDetailFragment | null>;
  getLiveSessionRun(sessionId: string): Promise<LiveSessionRunState | null>;
  resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): Promise<void>;
  resolveLiveElicitation(sessionId: string, requestId: string, response: LiveElicitationResponse): Promise<void>;
  listSessionSchedules(sessionId?: string | null): Promise<SessionScheduleSummary[]>;
  getSessionSchedule(sessionId: string, scheduleId: string): Promise<SessionScheduleProjection | null>;
  createSessionSchedule(sessionId: string, input: CreateSessionScheduleInput): Promise<SessionScheduleProjection>;
  updateSessionSchedule(sessionId: string, input: UpdateSessionScheduleInput): Promise<SessionScheduleProjection>;
  pauseSessionSchedule(sessionId: string, request: SessionScheduleRevisionRequest): Promise<SessionScheduleProjection>;
  resumeSessionSchedule(sessionId: string, request: SessionScheduleRevisionRequest): Promise<SessionScheduleProjection>;
  deleteSessionSchedule(sessionId: string, request: SessionScheduleRevisionRequest): Promise<void>;
  runSessionScheduleNow(sessionId: string, request: RunSessionScheduleNowInput): Promise<SessionScheduleProjection>;
};

export type WithMateWindowAuxiliaryApi = {
  listAuxiliarySessions(parentSessionId: string): Promise<AuxiliarySessionSummary[]>;
  listOpenActiveAuxiliarySessionSummaries(): Promise<AuxiliarySessionSummary[]>;
  getActiveAuxiliarySession(parentSessionId: string): Promise<AuxiliarySession | null>;
  getAuxiliarySession(auxiliarySessionId: string): Promise<AuxiliarySession | null>;
  createAuxiliarySession(input: CreateAuxiliarySessionInput): Promise<AuxiliarySession>;
  updateAuxiliarySession(session: AuxiliarySession): Promise<AuxiliarySession>;
  closeAuxiliarySession(auxiliarySessionId: string): Promise<AuxiliarySession>;
  runAuxiliarySessionTurn(auxiliarySessionId: string, request: RunSessionTurnRequest): Promise<AuxiliarySession>;
  cancelAuxiliarySessionRun(auxiliarySessionId: string): Promise<void>;
};

export type WithMateWindowCompanionApi = {
  listCompanionSessionSummaries(): Promise<CompanionSessionSummary[]>;
  getCompanionSession(sessionId: string): Promise<CompanionSession | null>;
  getCompanionMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null>;
  getCompanionReviewSnapshot(sessionId: string): Promise<CompanionReviewSnapshot | null>;
  mergeCompanionSelectedFiles(request: CompanionMergeSelectedFilesRequest): Promise<CompanionMergeSelectedFilesResult>;
  syncCompanionTarget(sessionId: string): Promise<CompanionSyncTargetResult>;
  stashCompanionTargetChanges(sessionId: string): Promise<CompanionTargetWorkspaceStashResult>;
  restoreCompanionTargetStash(sessionId: string): Promise<CompanionTargetWorkspaceStashResult>;
  dropCompanionTargetStash(sessionId: string): Promise<CompanionTargetWorkspaceStashResult>;
  discardCompanionSession(sessionId: string): Promise<CompanionSession>;
  createCompanionSession(input: CreateCompanionSessionInput): Promise<CompanionSession>;
  updateCompanionSession(session: CompanionSession): Promise<CompanionSession>;
  previewCompanionComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview>;
  runCompanionSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<CompanionSession>;
  cancelCompanionSessionRun(sessionId: string): Promise<void>;
  listCompanionAuditLogs(sessionId: string): Promise<AuditLogEntry[]>;
  listCompanionAuditLogSummaries(sessionId: string): Promise<AuditLogSummary[]>;
  listCompanionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): Promise<AuditLogSummaryPageResult>;
  getCompanionAuditLogDetail(sessionId: string, auditLogId: number): Promise<AuditLogDetail | null>;
  getCompanionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): Promise<AuditLogDetailFragment | null>;
  getCompanionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): Promise<AuditLogOperationDetailFragment | null>;
};

export type WithMateWindowObservabilityApi = {
  reportRendererLog(input: RendererLogInput): void;
  getProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  getSessionContextTelemetry(sessionId: string): Promise<SessionContextTelemetry | null>;
  getSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
  ): Promise<SessionBackgroundActivityState | null>;
  listOpenSessionWindowIds(): Promise<string[]>;
  listOpenCompanionReviewWindowIds(): Promise<string[]>;
};

export type WithMateWindowSettingsApi = {
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
  updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): Promise<AppSettings>;
  getAppDatabaseDiagnostics(): Promise<AppDatabaseDiagnostics>;
  getMemoryV6Diagnostics(): Promise<MemoryV6Diagnostics>;
  getSessionIntegrationDiagnostics(): Promise<SessionIntegrationDiagnostics>;
  registerCodexSessionMcp(): Promise<SessionIntegrationDiagnostics>;
  installMemoryV6CliShim(): Promise<MemoryV6Diagnostics>;
  uninstallMemoryV6CliShim(): Promise<MemoryV6Diagnostics>;
  resetAppDatabase(request: ResetAppDatabaseRequest): Promise<ResetAppDatabaseResult>;
  deleteSessionsLastActiveBefore(request: DeleteSessionsLastActiveBeforeRequest): Promise<DeleteSessionsResult>;
};

export type WithMateWindowPromptTemplateApi = {
  listPromptTemplates(): Promise<PromptTemplate[]>;
  createPromptTemplate(input: CreatePromptTemplateInput): Promise<PromptTemplate[]>;
  updatePromptTemplate(input: UpdatePromptTemplateInput): Promise<PromptTemplate[]>;
  deletePromptTemplate(id: string): Promise<PromptTemplate[]>;
  subscribePromptTemplates(listener: (templates: PromptTemplate[]) => void): () => void;
};

export type WithMateWindowPickerApi = {
  validateWorkspaceDirectory(targetPath: string): Promise<WorkspaceDirectoryValidationResult>;
  pickDirectory(initialPath?: string | null): Promise<string | null>;
  pickFile(initialPath?: string | null): Promise<string | null>;
  pickFiles(initialPath?: string | null): Promise<string[]>;
  pickSessionFiles(sessionId: string): Promise<string[]>;
  pickSessionFolder(sessionId: string): Promise<string | null>;
  pickSessionImageFile(sessionId: string): Promise<string | null>;
  pickImageFile(
    initialPath?: string | null,
    purpose?: ImageFilePickerPurpose,
  ): Promise<string | null>;
  copyFilesToSessionFiles(sessionId: string, sourcePaths: string[]): Promise<string[]>;
  savePastedSessionFile(request: SavePastedSessionFileRequest): Promise<string>;
  openSessionFilesDirectory(sessionId: string): Promise<void>;
  openSessionFilesTerminal(sessionId: string): Promise<void>;
};

export type WithMateWindowSubscriptionApi = {
  getAppBootStatus(): Promise<AppBootStatus>;
  subscribeAppBootStatus(listener: (status: AppBootStatus) => void): () => void;
  subscribeSessionFilePreviewNavigation(
    listener: (payload: SessionFilePreviewWindowPayload) => void,
  ): () => void;
  subscribeSessionInvalidation(listener: (payload: SessionSummaryInvalidation) => void): () => void;
  subscribeSessionExecutionsChanged(listener: (event: SessionExecutionChangedEvent) => void): () => void;
  subscribeCoordinationEventsChanged(listener: (invalidation: CoordinationEventInvalidation) => void): () => void;
  subscribeModelCatalog(listener: (catalog: ModelCatalogSnapshot) => void): () => void;
  subscribeAppSettings(listener: (settings: AppSettings) => void): () => void;
  subscribeLiveSessionRun(listener: (sessionId: string, state: LiveSessionRunState | null) => void): () => void;
  subscribeProviderQuotaTelemetry(listener: (providerId: string, telemetry: ProviderQuotaTelemetry | null) => void): () => void;
  subscribeSessionContextTelemetry(listener: (sessionId: string, telemetry: SessionContextTelemetry | null) => void): () => void;
  subscribeSessionBackgroundActivity(
    listener: (
      sessionId: string,
      kind: SessionBackgroundActivityKind,
      state: SessionBackgroundActivityState | null,
    ) => void,
  ): () => void;
  subscribeOpenSessionWindowIds(listener: (sessionIds: string[]) => void): () => void;
  subscribeOpenCompanionReviewWindowIds(listener: (sessionIds: string[]) => void): () => void;
  subscribeCompanionSessionSummaries(listener: (sessions: CompanionSessionSummary[]) => void): () => void;
  subscribeSessionSchedules(listener: (event: SessionScheduleChangedEvent) => void): () => void;
};

export type WithMateWindowMateApi = {
  getMateState(): Promise<MateStorageState>;
  getMateProfile(): Promise<MateProfile | null>;
  createMate(input: CreateMateInput): Promise<MateProfile>;
  updateMate(input: UpdateMateInput): Promise<MateProfile>;
  setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile>;
  resetMate(): Promise<void>;
};

export type WithMateWindowCharacterApi = {
  listCharacters(options?: { includeArchived?: boolean }): Promise<CharacterCatalogEntry[]>;
  getCharacter(characterId: string): Promise<CharacterDetail | null>;
  createCharacter(input: CreateCharacterInput): Promise<CharacterDetail>;
  updateCharacterMetadata(input: UpdateCharacterMetadataInput): Promise<CharacterDetail>;
  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): Promise<CharacterDetail>;
  archiveCharacter(characterId: string): Promise<CharacterCatalogEntry>;
  resolveLaunchCharacter(input?: ResolveLaunchCharacterInput | null): Promise<CharacterDetail | null>;
  startCharacterAuthoringSession(input: StartCharacterAuthoringSessionInput): Promise<CharacterAuthoringSessionStartResult>;
};

export type WithMateWindowApi =
  & WithMateWindowNavigationApi
  & WithMateWindowCoordinationApi
  & MemoryV6ReviewApi
  & WithMateWindowCatalogApi
  & WithMateWindowAuxiliaryApi
  & WithMateWindowSessionApi
  & WithMateWindowCompanionApi
  & WithMateWindowObservabilityApi
  & WithMateWindowSettingsApi
  & WithMateWindowPromptTemplateApi
  & WithMateWindowPickerApi
  & WithMateWindowSubscriptionApi
  & WithMateWindowMateApi
  & WithMateWindowCharacterApi;
