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
  CreateCharacterInput,
  CreateSessionInput,
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
    RunSessionTurnRequest,
    Session,
    SessionSummary,
} from "./app-state.js";
import type { CompanionSession, CompanionSessionSummary, CreateCompanionSessionInput } from "./companion-state.js";
import type {
  CompanionMergeSelectedFilesRequest,
  CompanionMergeSelectedFilesResult,
  CompanionReviewSnapshot,
  CompanionSyncTargetResult,
  CompanionTargetWorkspaceStashResult,
} from "./companion-review-state.js";
import type { CharacterUpdateMemoryExtract, CharacterUpdateWorkspace } from "./character-update-state.js";
import type {
  MemoryManagementPageRequest,
  MemoryManagementPageResult,
  MemoryManagementSnapshot,
} from "./memory-management-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "./model-catalog.js";
import type { RendererLogInput } from "./app-log-types.js";
import type { WorkspacePathCandidate } from "./workspace-path-candidate.js";
import type { OpenPathOptions, ResetAppDatabaseRequest, ResetAppDatabaseResult } from "./withmate-window-types.js";

export type WithMateWindowNavigationApi = {
  openSession(sessionId: string): Promise<void>;
  openHomeWindow(): Promise<void>;
  openSessionMonitorWindow(): Promise<void>;
  openSettingsWindow(): Promise<void>;
  openMemoryManagementWindow(): Promise<void>;
  openCharacterEditor(characterId?: string | null): Promise<void>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
  openCompanionReviewWindow(sessionId: string): Promise<void>;
  openCompanionMergeWindow(sessionId: string): Promise<void>;
  openPath(target: string, options?: OpenPathOptions): Promise<void>;
  openAppLogFolder(): Promise<void>;
  openCrashDumpFolder(): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
  openTerminalAtPath(target: string): Promise<void>;
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
  listSessionSummaries(): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<Session | null>;
  getSessionMessageArtifact(sessionId: string, messageIndex: number): Promise<MessageArtifact | null>;
  createSession(input: CreateSessionInput): Promise<Session>;
  updateSession(session: Session): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  previewComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]>;
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  listWorkspaceSkills(providerId: string, workspacePath: string): Promise<DiscoveredSkill[]>;
  listWorkspaceCustomAgents(providerId: string, workspacePath: string): Promise<DiscoveredCustomAgent[]>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
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
  searchCompanionWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]>;
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
  resetAppDatabase(request: ResetAppDatabaseRequest): Promise<ResetAppDatabaseResult>;
  getMemoryManagementSnapshot(): Promise<MemoryManagementSnapshot>;
  getMemoryManagementPage(request: MemoryManagementPageRequest): Promise<MemoryManagementPageResult>;
  deleteSessionMemory(sessionId: string): Promise<void>;
  deleteProjectMemoryEntry(entryId: string): Promise<void>;
  deleteCharacterMemoryEntry(entryId: string): Promise<void>;
};

export type WithMateWindowCharacterApi = {
  listCharacters(): Promise<CharacterProfile[]>;
  getCharacter(characterId: string): Promise<CharacterProfile | null>;
  getCharacterUpdateWorkspace(characterId: string): Promise<CharacterUpdateWorkspace | null>;
  extractCharacterUpdateMemory(characterId: string): Promise<CharacterUpdateMemoryExtract>;
  createCharacterUpdateSession(characterId: string, providerId: string): Promise<Session>;
  createCharacter(input: CreateCharacterInput): Promise<CharacterProfile>;
  updateCharacter(character: CharacterProfile): Promise<CharacterProfile>;
  deleteCharacter(characterId: string): Promise<void>;
};

export type WithMateWindowPickerApi = {
  pickDirectory(initialPath?: string | null): Promise<string | null>;
  pickFile(initialPath?: string | null): Promise<string | null>;
  pickImageFile(initialPath?: string | null): Promise<string | null>;
};

export type WithMateWindowSubscriptionApi = {
  subscribeSessionSummaries(listener: (sessions: SessionSummary[]) => void): () => void;
  subscribeSessionInvalidation(listener: (sessionIds: string[]) => void): () => void;
  subscribeCharacters(listener: (characters: CharacterProfile[]) => void): () => void;
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
};

export type WithMateWindowApi =
  & WithMateWindowNavigationApi
  & WithMateWindowCatalogApi
  & WithMateWindowSessionApi
  & WithMateWindowCompanionApi
  & WithMateWindowObservabilityApi
  & WithMateWindowSettingsApi
  & WithMateWindowCharacterApi
  & WithMateWindowPickerApi
  & WithMateWindowSubscriptionApi;
