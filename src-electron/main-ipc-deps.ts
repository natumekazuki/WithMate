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
  CharacterProfile,
  LiveApprovalDecision,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  RunSessionTurnRequest,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
  SessionSummary,
} from "../src/app-state.js";
import type { CreateCharacterInput } from "../src/character-state.js";
import type { CharacterUpdateMemoryExtract, CharacterUpdateWorkspace } from "../src/character-update-state.js";
import type { CompanionSession, CompanionSessionSummary, CreateCompanionSessionInput } from "../src/companion-state.js";
import type {
  CompanionMergeSelectedFilesRequest,
  CompanionMergeSelectedFilesResult,
  CompanionReviewSnapshot,
  CompanionSyncTargetResult,
  CompanionTargetWorkspaceStashResult,
} from "../src/companion-review-state.js";
import type {
  MemoryManagementPageRequest,
  MemoryManagementPageResult,
  MemoryManagementSnapshot,
} from "../src/memory-management-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../src/runtime-state.js";
import type { CreateSessionInput, DiffPreviewPayload, MessageArtifact, Session } from "../src/session-state.js";
import type { OpenPathOptions, ResetAppDatabaseRequest } from "../src/withmate-window-types.js";
import type { WorkspacePathCandidate } from "../src/workspace-path-candidate.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import type { MainIpcRegistrationDeps } from "./main-ipc-registration.js";

type MaybeWindow = BrowserWindow | null | undefined;

export type MainIpcWindowDepsArgs = {
  resolveEventWindow(event: IpcMainInvokeEvent): MaybeWindow;
  resolveHomeWindow(): MaybeWindow;
  openSessionWindow(sessionId: string): Promise<BrowserWindow>;
  openHomeWindow(): Promise<BrowserWindow>;
  openSessionMonitorWindow(): Promise<BrowserWindow>;
  openSettingsWindow(): Promise<BrowserWindow>;
  openMemoryManagementWindow(): Promise<BrowserWindow>;
  openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow>;
  openCompanionReviewWindow(sessionId: string): Promise<BrowserWindow>;
  openCompanionMergeWindow(sessionId: string): Promise<BrowserWindow>;
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickImageFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  openPathTarget(target: string, options?: OpenPathOptions): Promise<void>;
  openAppLogFolder(): Promise<void>;
  openCrashDumpFolder(): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
  openTerminalAtPath(target: string): Promise<void>;
  logIpcError?: MainIpcRegistrationDeps["logIpcError"];
  reportRendererLog?: MainIpcRegistrationDeps["reportRendererLog"];
};

export type MainIpcCatalogDepsArgs = {
  getModelCatalog(revision: number | null): ModelCatalogSnapshot | null;
  importModelCatalogDocument(document: ModelCatalogDocument): Awaitable<ModelCatalogSnapshot>;
  importModelCatalogFromFile(targetWindow?: MaybeWindow): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogDocument(revision: number | null): ModelCatalogDocument | null;
  exportModelCatalogToFile(revision: number | null, targetWindow?: MaybeWindow): Promise<string | null>;
};

export type MainIpcSettingsDepsArgs = {
  getAppSettings(): AppSettings;
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
  getMemoryManagementSnapshot(): MemoryManagementSnapshot;
  getMemoryManagementPage(request: MemoryManagementPageRequest): MemoryManagementPageResult;
  deleteSessionMemory(sessionId: string): void;
  deleteProjectMemoryEntry(entryId: string): void;
  deleteCharacterMemoryEntry(entryId: string): void;
};

export type MainIpcSessionQueryDepsArgs = {
  listSessionSummaries(): Awaitable<SessionSummary[]>;
  listCompanionSessionSummaries(): Awaitable<CompanionSessionSummary[]>;
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
  listCompanionAuditLogs(sessionId: string): Awaitable<AuditLogEntry[]>;
  listCompanionAuditLogSummaries(sessionId: string): Awaitable<AuditLogSummary[]>;
  listCompanionAuditLogSummaryPage(
    sessionId: string,
    request?: AuditLogSummaryPageRequest | null,
  ): Awaitable<AuditLogSummaryPageResult>;
  getCompanionAuditLogDetail(sessionId: string, auditLogId: number): Awaitable<AuditLogDetail | null>;
  getCompanionAuditLogDetailSection(
    sessionId: string,
    auditLogId: number,
    section: AuditLogDetailSection,
  ): Awaitable<AuditLogDetailFragment | null>;
  getCompanionAuditLogOperationDetail(
    sessionId: string,
    auditLogId: number,
    operationIndex: number,
  ): Awaitable<AuditLogOperationDetailFragment | null>;
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  listWorkspaceSkills(providerId: string, workspacePath: string): Promise<DiscoveredSkill[]>;
  listWorkspaceCustomAgents(providerId: string, workspacePath: string): Promise<DiscoveredCustomAgent[]>;
  listOpenSessionWindowIds(): string[];
  listOpenCompanionReviewWindowIds(): string[];
  getSession(sessionId: string): Awaitable<Session | null>;
  getSessionMessageArtifact(sessionId: string, messageIndex: number): Awaitable<MessageArtifact | null>;
  getDiffPreview(token: string): DiffPreviewPayload | null;
  previewComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]>;
};

export type MainIpcCompanionDepsArgs = {
  createCompanionSession(input: CreateCompanionSessionInput): Promise<CompanionSession>;
  getCompanionSession(sessionId: string): Awaitable<CompanionSession | null>;
  getCompanionMessageArtifact(sessionId: string, messageIndex: number): Awaitable<MessageArtifact | null>;
  getCompanionReviewSnapshot(sessionId: string): Promise<CompanionReviewSnapshot | null>;
  mergeCompanionSelectedFiles(request: CompanionMergeSelectedFilesRequest): Promise<CompanionMergeSelectedFilesResult>;
  syncCompanionTarget(sessionId: string): Promise<CompanionSyncTargetResult>;
  stashCompanionTargetChanges(sessionId: string): Promise<CompanionTargetWorkspaceStashResult>;
  restoreCompanionTargetStash(sessionId: string): Promise<CompanionTargetWorkspaceStashResult>;
  dropCompanionTargetStash(sessionId: string): Promise<CompanionTargetWorkspaceStashResult>;
  discardCompanionSession(sessionId: string): Promise<CompanionSession>;
  updateCompanionSession(session: CompanionSession): Promise<CompanionSession>;
  previewCompanionComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
  searchCompanionWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]>;
  runCompanionSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<CompanionSession>;
  cancelCompanionSessionRun(sessionId: string): void;
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
  createSession(input: CreateSessionInput): Awaitable<Session>;
  updateSession(session: Session): Awaitable<Session>;
  deleteSession(sessionId: string): Awaitable<void>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  cancelSessionRun(sessionId: string): void;
};

export type MainIpcCharacterDepsArgs = {
  listCharacters(): Promise<CharacterProfile[]>;
  getCharacter(characterId: string): Promise<CharacterProfile | null>;
  getCharacterUpdateWorkspace(characterId: string): Promise<CharacterUpdateWorkspace | null>;
  extractCharacterUpdateMemory(characterId: string): Promise<CharacterUpdateMemoryExtract>;
  createCharacterUpdateSession(characterId: string, providerId: string): Promise<Session>;
  createCharacter(input: CreateCharacterInput): Promise<CharacterProfile>;
  updateCharacter(character: CharacterProfile): Promise<CharacterProfile>;
  deleteCharacter(characterId: string): Promise<void>;
};

export type CreateMainIpcRegistrationDepsArgs = {
  window: MainIpcWindowDepsArgs;
  catalog: MainIpcCatalogDepsArgs;
  settings: MainIpcSettingsDepsArgs;
  sessionQuery: MainIpcSessionQueryDepsArgs;
  companion: MainIpcCompanionDepsArgs;
  sessionRuntime: MainIpcSessionRuntimeDepsArgs;
  character: MainIpcCharacterDepsArgs;
};

export function createMainIpcRegistrationDeps(
  args: CreateMainIpcRegistrationDepsArgs,
): MainIpcRegistrationDeps {
  return {
    resolveEventWindow: args.window.resolveEventWindow,
    resolveHomeWindow: args.window.resolveHomeWindow,
    openSessionWindow: async (sessionId) => {
      await args.window.openSessionWindow(sessionId);
    },
    openHomeWindow: async () => {
      await args.window.openHomeWindow();
    },
    openSessionMonitorWindow: async () => {
      await args.window.openSessionMonitorWindow();
    },
    openSettingsWindow: async () => {
      await args.window.openSettingsWindow();
    },
    openMemoryManagementWindow: async () => {
      await args.window.openMemoryManagementWindow();
    },
    openCharacterEditorWindow: async (characterId) => {
      await args.window.openCharacterEditorWindow(characterId);
    },
    openDiffWindow: async (diffPreview) => {
      await args.window.openDiffWindow(diffPreview);
    },
    openCompanionReviewWindow: async (sessionId) => {
      await args.window.openCompanionReviewWindow(sessionId);
    },
    openCompanionMergeWindow: async (sessionId) => {
      await args.window.openCompanionMergeWindow(sessionId);
    },
    pickDirectory: args.window.pickDirectory,
    pickFile: args.window.pickFile,
    pickImageFile: args.window.pickImageFile,
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
    resetAppDatabase: args.settings.resetAppDatabase,
    getMemoryManagementSnapshot: args.settings.getMemoryManagementSnapshot,
    getMemoryManagementPage: args.settings.getMemoryManagementPage,
    deleteSessionMemory: args.settings.deleteSessionMemory,
    deleteProjectMemoryEntry: args.settings.deleteProjectMemoryEntry,
    deleteCharacterMemoryEntry: args.settings.deleteCharacterMemoryEntry,
    listSessionSummaries: args.sessionQuery.listSessionSummaries,
    listCompanionSessionSummaries: args.sessionQuery.listCompanionSessionSummaries,
    listSessionAuditLogs: args.sessionQuery.listSessionAuditLogs,
    listSessionAuditLogSummaries: args.sessionQuery.listSessionAuditLogSummaries,
    listSessionAuditLogSummaryPage: args.sessionQuery.listSessionAuditLogSummaryPage,
    getSessionAuditLogDetail: args.sessionQuery.getSessionAuditLogDetail,
    getSessionAuditLogDetailSection: args.sessionQuery.getSessionAuditLogDetailSection,
    getSessionAuditLogOperationDetail: args.sessionQuery.getSessionAuditLogOperationDetail,
    listCompanionAuditLogs: args.sessionQuery.listCompanionAuditLogs,
    listCompanionAuditLogSummaries: args.sessionQuery.listCompanionAuditLogSummaries,
    listCompanionAuditLogSummaryPage: args.sessionQuery.listCompanionAuditLogSummaryPage,
    getCompanionAuditLogDetail: args.sessionQuery.getCompanionAuditLogDetail,
    getCompanionAuditLogDetailSection: args.sessionQuery.getCompanionAuditLogDetailSection,
    getCompanionAuditLogOperationDetail: args.sessionQuery.getCompanionAuditLogOperationDetail,
    listSessionSkills: args.sessionQuery.listSessionSkills,
    listSessionCustomAgents: args.sessionQuery.listSessionCustomAgents,
    listWorkspaceSkills: args.sessionQuery.listWorkspaceSkills,
    listWorkspaceCustomAgents: args.sessionQuery.listWorkspaceCustomAgents,
    listOpenSessionWindowIds: args.sessionQuery.listOpenSessionWindowIds,
    listOpenCompanionReviewWindowIds: args.sessionQuery.listOpenCompanionReviewWindowIds,
    getSession: args.sessionQuery.getSession,
    getSessionMessageArtifact: args.sessionQuery.getSessionMessageArtifact,
    getDiffPreview: args.sessionQuery.getDiffPreview,
    previewComposerInput: args.sessionQuery.previewComposerInput,
    searchWorkspaceFiles: args.sessionQuery.searchWorkspaceFiles,
    createCompanionSession: args.companion.createCompanionSession,
    getCompanionSession: args.companion.getCompanionSession,
    getCompanionMessageArtifact: args.companion.getCompanionMessageArtifact,
    getCompanionReviewSnapshot: args.companion.getCompanionReviewSnapshot,
    mergeCompanionSelectedFiles: args.companion.mergeCompanionSelectedFiles,
    syncCompanionTarget: args.companion.syncCompanionTarget,
    stashCompanionTargetChanges: args.companion.stashCompanionTargetChanges,
    restoreCompanionTargetStash: args.companion.restoreCompanionTargetStash,
    dropCompanionTargetStash: args.companion.dropCompanionTargetStash,
    discardCompanionSession: args.companion.discardCompanionSession,
    updateCompanionSession: args.companion.updateCompanionSession,
    previewCompanionComposerInput: args.companion.previewCompanionComposerInput,
    searchCompanionWorkspaceFiles: args.companion.searchCompanionWorkspaceFiles,
    runCompanionSessionTurn: args.companion.runCompanionSessionTurn,
    cancelCompanionSessionRun: args.companion.cancelCompanionSessionRun,
    getLiveSessionRun: args.sessionRuntime.getLiveSessionRun,
    getProviderQuotaTelemetry: args.sessionRuntime.getProviderQuotaTelemetry,
    getSessionContextTelemetry: args.sessionRuntime.getSessionContextTelemetry,
    getSessionBackgroundActivity: args.sessionRuntime.getSessionBackgroundActivity,
    resolveLiveApproval: args.sessionRuntime.resolveLiveApproval,
    resolveLiveElicitation: args.sessionRuntime.resolveLiveElicitation,
    createSession: args.sessionRuntime.createSession,
    updateSession: args.sessionRuntime.updateSession,
    deleteSession: args.sessionRuntime.deleteSession,
    runSessionTurn: args.sessionRuntime.runSessionTurn,
    cancelSessionRun: args.sessionRuntime.cancelSessionRun,
    listCharacters: args.character.listCharacters,
    getCharacter: args.character.getCharacter,
    getCharacterUpdateWorkspace: args.character.getCharacterUpdateWorkspace,
    extractCharacterUpdateMemory: args.character.extractCharacterUpdateMemory,
    createCharacterUpdateSession: args.character.createCharacterUpdateSession,
    createCharacter: args.character.createCharacter,
    updateCharacter: args.character.updateCharacter,
    deleteCharacter: args.character.deleteCharacter,
  };
}
