import type {
  AuditLogEntry,
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
    RunSessionTurnRequest,
    Session,
    SessionSummary,
  } from "./app-state.js";
import type { CharacterUpdateMemoryExtract, CharacterUpdateWorkspace } from "./character-update-state.js";
import type { MemoryManagementSnapshot } from "./memory-management-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "./model-catalog.js";
import type { OpenPathOptions, ResetAppDatabaseRequest, ResetAppDatabaseResult } from "./withmate-window-types.js";

export type WithMateWindowNavigationApi = {
  openSession(sessionId: string): Promise<void>;
  openHomeWindow(): Promise<void>;
  openSessionMonitorWindow(): Promise<void>;
  openSettingsWindow(): Promise<void>;
  openMemoryManagementWindow(): Promise<void>;
  openCharacterEditor(characterId?: string | null): Promise<void>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
  openPath(target: string, options?: OpenPathOptions): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
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
  createSession(input: CreateSessionInput): Promise<Session>;
  updateSession(session: Session): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  previewComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]>;
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  runSessionMemoryExtraction(sessionId: string): Promise<void>;
  cancelSessionRun(sessionId: string): Promise<void>;
  listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]>;
  getLiveSessionRun(sessionId: string): Promise<LiveSessionRunState | null>;
  resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): Promise<void>;
  resolveLiveElicitation(sessionId: string, requestId: string, response: LiveElicitationResponse): Promise<void>;
};

export type WithMateWindowObservabilityApi = {
  getProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  getSessionContextTelemetry(sessionId: string): Promise<SessionContextTelemetry | null>;
  getSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
  ): Promise<SessionBackgroundActivityState | null>;
  listOpenSessionWindowIds(): Promise<string[]>;
};

export type WithMateWindowSettingsApi = {
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
  resetAppDatabase(request: ResetAppDatabaseRequest): Promise<ResetAppDatabaseResult>;
  getMemoryManagementSnapshot(): Promise<MemoryManagementSnapshot>;
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
};

export type WithMateWindowApi =
  & WithMateWindowNavigationApi
  & WithMateWindowCatalogApi
  & WithMateWindowSessionApi
  & WithMateWindowObservabilityApi
  & WithMateWindowSettingsApi
  & WithMateWindowCharacterApi
  & WithMateWindowPickerApi
  & WithMateWindowSubscriptionApi;
