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
  SessionSummary,
} from "../src/app-state.js";
import type { AppDatabaseDiagnostics } from "../src/app-database-diagnostics-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../src/auxiliary-session-state.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ImportCharacterFilesResult,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../src/character/character-catalog.js";
import type { CompanionSession, CompanionSessionSummary, CreateCompanionSessionInput } from "../src/companion-state.js";
import type {
  CompanionMergeSelectedFilesRequest,
  CompanionMergeSelectedFilesResult,
  CompanionReviewSnapshot,
  CompanionSyncTargetResult,
  CompanionTargetWorkspaceStashResult,
} from "../src/companion-review-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../src/runtime-state.js";
import type { CreateSessionInput, DiffPreviewPayload, MessageArtifact, Session } from "../src/session-state.js";
import type {
  OpenPathOptions,
  ResetAppDatabaseRequest,
  SavePastedSessionFileRequest,
} from "../src/withmate-window-types.js";
import type { WorkspacePathCandidate } from "../src/workspace-path-candidate.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../src/mate/mate-state.js";
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
  openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow>;
  openCompanionReviewWindow(sessionId: string): Promise<BrowserWindow>;
  openCompanionMergeWindow(sessionId: string): Promise<BrowserWindow>;
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFiles(targetWindow: MaybeWindow, initialPath: string | null): Promise<string[]>;
  pickSessionFiles(targetWindow: MaybeWindow, sessionId: string): Promise<string[]>;
  pickImageFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  copyFilesToSessionFiles(sessionId: string, sourcePaths: string[]): Promise<string[]>;
  savePastedSessionFile(request: SavePastedSessionFileRequest): Promise<string>;
  openSessionFilesDirectory(sessionId: string): Promise<void>;
  openSessionFilesTerminal(sessionId: string): Promise<void>;
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
  getAppDatabaseDiagnostics(): AppDatabaseDiagnostics;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
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

export type MainIpcAuxiliaryDepsArgs = {
  listAuxiliarySessions(parentSessionId: string): Awaitable<AuxiliarySessionSummary[]>;
  getActiveAuxiliarySession(parentSessionId: string): Awaitable<AuxiliarySession | null>;
  getAuxiliarySession(auxiliarySessionId: string): Awaitable<AuxiliarySession | null>;
  createAuxiliarySession(input: CreateAuxiliarySessionInput): Awaitable<AuxiliarySession>;
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
  createSession(input: CreateSessionInput): Awaitable<Session>;
  updateSession(session: Session): Awaitable<Session>;
  deleteSession(sessionId: string): Awaitable<void>;
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
  importCharacterFiles(targetWindow?: MaybeWindow): Awaitable<ImportCharacterFilesResult | null>;
  updateCharacterMetadata(input: UpdateCharacterMetadataInput): Awaitable<CharacterDetail>;
  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): Awaitable<CharacterDetail>;
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  setDefaultCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  resolveLaunchCharacter(input?: ResolveLaunchCharacterInput | null): Awaitable<CharacterDetail | null>;
};

export type CreateMainIpcRegistrationDepsArgs = {
  window: MainIpcWindowDepsArgs;
  catalog: MainIpcCatalogDepsArgs;
  settings: MainIpcSettingsDepsArgs;
  sessionQuery: MainIpcSessionQueryDepsArgs;
  auxiliary?: MainIpcAuxiliaryDepsArgs;
  companion: MainIpcCompanionDepsArgs;
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
    getActiveAuxiliarySession: () => null,
    getAuxiliarySession: () => null,
    createAuxiliarySession: throwUnavailable,
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
    pickFiles: args.window.pickFiles,
    pickSessionFiles: args.window.pickSessionFiles,
    pickImageFile: args.window.pickImageFile,
    copyFilesToSessionFiles: args.window.copyFilesToSessionFiles,
    savePastedSessionFile: args.window.savePastedSessionFile,
    openSessionFilesDirectory: args.window.openSessionFilesDirectory,
    openSessionFilesTerminal: args.window.openSessionFilesTerminal,
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
    getAppDatabaseDiagnostics: args.settings.getAppDatabaseDiagnostics,
    resetAppDatabase: args.settings.resetAppDatabase,
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
    listAuxiliarySessions: auxiliary.listAuxiliarySessions,
    getActiveAuxiliarySession: auxiliary.getActiveAuxiliarySession,
    getAuxiliarySession: auxiliary.getAuxiliarySession,
    createAuxiliarySession: auxiliary.createAuxiliarySession,
    updateAuxiliarySession: auxiliary.updateAuxiliarySession,
    closeAuxiliarySession: auxiliary.closeAuxiliarySession,
    runAuxiliarySessionTurn: auxiliary.runAuxiliarySessionTurn,
    cancelAuxiliarySessionRun: auxiliary.cancelAuxiliarySessionRun,
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
    getMateState: args.mate.getMateState,
    getMateProfile: args.mate.getMateProfile,
    createMate: args.mate.createMate,
    updateMate: args.mate.updateMate,
    setMateAvatar: args.mate.setMateAvatar,
    resetMate: args.mate.resetMate,
    listCharacters: args.character.listCharacters,
    getCharacter: args.character.getCharacter,
    createCharacter: args.character.createCharacter,
    importCharacterFiles: args.character.importCharacterFiles,
    updateCharacterMetadata: args.character.updateCharacterMetadata,
    updateCharacterDefinition: args.character.updateCharacterDefinition,
    archiveCharacter: args.character.archiveCharacter,
    setDefaultCharacter: args.character.setDefaultCharacter,
    resolveLaunchCharacter: args.character.resolveLaunchCharacter,
  };
}
