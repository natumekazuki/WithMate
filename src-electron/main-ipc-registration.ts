import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import type { RendererLogInput } from "../src/app-log-types.js";
import type { AppDatabaseDiagnostics } from "../src/app-database-diagnostics-state.js";
import type { MemoryV6Diagnostics } from "../src/memory-v6/memory-diagnostics-state.js";
import type { MemoryForgetReason, MemoryV6ReviewSearchRequest } from "../src/memory-v6/memory-contract.js";
import type {
  MemoryV6ReviewEntryDetail,
  MemoryV6ReviewForgetResult,
  MemoryV6ReviewSearchResult,
} from "../src/memory-v6/memory-review-state.js";
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
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../src/auxiliary-session-state.js";
import type {
  StartCharacterAuthoringSessionInput,
  CharacterAuthoringSessionStartResult,
} from "../src/character/character-authoring.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../src/character/character-catalog.js";
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  SetMateAvatarInput,
  UpdateMateInput,
} from "../src/mate/mate-state.js";
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
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import {
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CANCEL_COMPANION_SESSION_RUN_CHANNEL,
  WITHMATE_ARCHIVE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_UPDATE_MATE_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
  WITHMATE_DISCARD_COMPANION_SESSION_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL,
  WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL,
  WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_COMPANION_MESSAGE_ARTIFACT_CHANNEL,
  WITHMATE_GET_COMPANION_REVIEW_SNAPSHOT_CHANNEL,
  WITHMATE_GET_COMPANION_SESSION_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_GET_MATE_PROFILE_CHANNEL,
  WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
  WITHMATE_GET_COMPANION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
  WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
  WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
  WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL,
  WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_OPEN_COMPANION_REVIEW_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARIES_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
  WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_COMPANION_MERGE_WINDOW_CHANNEL,
  WITHMATE_OPEN_COMPANION_REVIEW_WINDOW_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
  WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
  WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_OPEN_MEMORY_V6_REVIEW_WINDOW_CHANNEL,
  WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
  WITHMATE_MERGE_COMPANION_SELECTED_FILES_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_FILES_CHANNEL,
  WITHMATE_PICK_SESSION_FILES_CHANNEL,
  WITHMATE_PICK_SESSION_FOLDER_CHANNEL,
  WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
  WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESET_MATE_CHANNEL,
  WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL,
  WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
  WITHMATE_SET_MATE_AVATAR_CHANNEL,
  WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL,
  WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
  WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL,
  WITHMATE_SYNC_COMPANION_TARGET_CHANNEL,
  WITHMATE_STASH_COMPANION_TARGET_CHANGES_CHANNEL,
  WITHMATE_RESTORE_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_DROP_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_RENDERER_LOG_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL,
  WITHMATE_UPDATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
} from "../src/withmate-ipc-channels.js";
import type {
  OpenPathOptions,
  DeleteSessionsLastActiveBeforeRequest,
  DeleteSessionsResult,
  ResetAppDatabaseRequest,
  SavePastedSessionFileRequest,
} from "../src/withmate-window-types.js";

type MaybeWindow = BrowserWindow | null | undefined;
type IpcSenderEvent = Pick<IpcMainInvokeEvent, "sender">;
type LogIpcErrorInput = {
  channel: string;
  durationMs: number;
  error: unknown;
};

type IpcHandleRegistrar = {
  handle: IpcMain["handle"];
};

export type MainIpcRegistrationDeps = {
  resolveEventWindow(event: IpcSenderEvent): MaybeWindow;
  resolveHomeWindow(): MaybeWindow;
  openSessionWindow(sessionId: string): Promise<void>;
  openHomeWindow(): Promise<void>;
  openSessionMonitorWindow(): Promise<void>;
  openSettingsWindow(): Promise<void>;
  openMemoryV6ReviewWindow(): Promise<void>;
  isSettingsWindow(window: BrowserWindow): boolean;
  isMemoryV6ReviewWindow(window: BrowserWindow): boolean;
  openCharacterEditorWindow(characterId?: string | null): Promise<void>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
  openCompanionReviewWindow(sessionId: string): Promise<void>;
  openCompanionMergeWindow(sessionId: string): Promise<void>;
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
  listAuxiliarySessions?(parentSessionId: string): Awaitable<AuxiliarySessionSummary[]>;
  getActiveAuxiliarySession?(parentSessionId: string): Awaitable<AuxiliarySession | null>;
  getAuxiliarySession?(auxiliarySessionId: string): Awaitable<AuxiliarySession | null>;
  createAuxiliarySession?(input: CreateAuxiliarySessionInput): Awaitable<AuxiliarySession>;
  updateAuxiliarySession?(session: AuxiliarySession): Awaitable<AuxiliarySession>;
  closeAuxiliarySession?(auxiliarySessionId: string): Awaitable<AuxiliarySession>;
  runAuxiliarySessionTurn?(auxiliarySessionId: string, request: RunSessionTurnRequest): Awaitable<AuxiliarySession>;
  cancelAuxiliarySessionRun?(auxiliarySessionId: string): Awaitable<void>;
  getAppSettings(): AppSettings;
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  getAppDatabaseDiagnostics(): AppDatabaseDiagnostics;
  getMemoryV6Diagnostics(): Awaitable<MemoryV6Diagnostics>;
  installMemoryV6CliShim(): Awaitable<MemoryV6Diagnostics>;
  uninstallMemoryV6CliShim(): Awaitable<MemoryV6Diagnostics>;
  searchMemoryV6Entries(request: MemoryV6ReviewSearchRequest | null | undefined): Awaitable<MemoryV6ReviewSearchResult>;
  getMemoryV6Entry(entryId: string): Awaitable<MemoryV6ReviewEntryDetail | null>;
  forgetMemoryV6Entry(entryId: string, reason?: MemoryForgetReason | null): Awaitable<MemoryV6ReviewForgetResult>;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
  getModelCatalog(revision: number | null): ModelCatalogSnapshot | null;
  importModelCatalogDocument(document: ModelCatalogDocument): Awaitable<ModelCatalogSnapshot>;
  importModelCatalogFromFile(targetWindow?: MaybeWindow): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogDocument(revision: number | null): ModelCatalogDocument | null;
  exportModelCatalogToFile(revision: number | null, targetWindow?: MaybeWindow): Promise<string | null>;
  getSession(sessionId: string): Awaitable<Session | null>;
  getSessionMessageArtifact(sessionId: string, messageIndex: number): Awaitable<MessageArtifact | null>;
  getDiffPreview(token: string): DiffPreviewPayload | null;
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
  runCompanionSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<CompanionSession>;
  cancelCompanionSessionRun(sessionId: string): void;
  updateSession(session: Session): Awaitable<Session>;
  deleteSession(sessionId: string): Awaitable<void>;
  deleteSessionsLastActiveBefore(
    request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
  ): Awaitable<DeleteSessionsResult>;
  previewComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  cancelSessionRun(sessionId: string): void;
  getMateState(): Awaitable<MateStorageState>;
  getMateProfile(): Awaitable<MateProfile | null>;
  createMate(input: CreateMateInput): Promise<MateProfile>;
  updateMate(input: UpdateMateInput): Promise<MateProfile>;
  setMateAvatar(input: SetMateAvatarInput): Promise<MateProfile>;
  resetMate(): Promise<void>;
  listCharacters(options?: { includeArchived?: boolean } | null): Awaitable<CharacterCatalogEntry[]>;
  getCharacter(characterId: string): Awaitable<CharacterDetail | null>;
  createCharacter(input: CreateCharacterInput): Awaitable<CharacterDetail>;
  updateCharacterMetadata(input: UpdateCharacterMetadataInput): Awaitable<CharacterDetail>;
  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): Awaitable<CharacterDetail>;
  archiveCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  setDefaultCharacter(characterId: string): Awaitable<CharacterCatalogEntry>;
  resolveLaunchCharacter(input?: ResolveLaunchCharacterInput | null): Awaitable<CharacterDetail | null>;
  startCharacterAuthoringSession(input: StartCharacterAuthoringSessionInput): Awaitable<CharacterAuthoringSessionStartResult>;
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFiles(targetWindow: MaybeWindow, initialPath: string | null): Promise<string[]>;
  pickSessionFiles(targetWindow: MaybeWindow, sessionId: string): Promise<string[]>;
  pickSessionFolder(targetWindow: MaybeWindow, sessionId: string): Promise<string | null>;
  pickSessionImageFile(targetWindow: MaybeWindow, sessionId: string): Promise<string | null>;
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
  logIpcError?(input: LogIpcErrorInput): void;
  reportRendererLog?(input: RendererLogInput, windowId?: number): void;
};

type MainIpcWindowDeps = Pick<
  MainIpcRegistrationDeps,
  | "resolveEventWindow"
  | "resolveHomeWindow"
  | "openSessionWindow"
  | "openHomeWindow"
  | "openSessionMonitorWindow"
  | "openSettingsWindow"
  | "openMemoryV6ReviewWindow"
  | "openCharacterEditorWindow"
  | "openDiffWindow"
  | "openCompanionReviewWindow"
  | "openCompanionMergeWindow"
  | "openPathTarget"
  | "openAppLogFolder"
  | "openCrashDumpFolder"
  | "openSessionTerminal"
  | "openTerminalAtPath"
  | "pickDirectory"
  | "pickFile"
  | "pickFiles"
  | "pickSessionFiles"
  | "pickSessionFolder"
  | "pickSessionImageFile"
  | "pickImageFile"
  | "copyFilesToSessionFiles"
  | "savePastedSessionFile"
  | "openSessionFilesDirectory"
  | "openSessionFilesTerminal"
>;

type MainIpcCatalogDeps = Pick<
  MainIpcRegistrationDeps,
  | "resolveEventWindow"
  | "resolveHomeWindow"
  | "getModelCatalog"
  | "importModelCatalogDocument"
  | "importModelCatalogFromFile"
  | "exportModelCatalogDocument"
  | "exportModelCatalogToFile"
>;

type MainIpcSettingsDeps = Pick<
  MainIpcRegistrationDeps,
  | "resolveEventWindow"
  | "isSettingsWindow"
  | "isMemoryV6ReviewWindow"
  | "getAppSettings"
  | "updateAppSettings"
  | "getAppDatabaseDiagnostics"
  | "getMemoryV6Diagnostics"
  | "installMemoryV6CliShim"
  | "uninstallMemoryV6CliShim"
  | "searchMemoryV6Entries"
  | "getMemoryV6Entry"
  | "forgetMemoryV6Entry"
  | "resetAppDatabase"
>;

type MainIpcAuxiliaryDeps = Pick<
  MainIpcRegistrationDeps,
  | "listAuxiliarySessions"
  | "getActiveAuxiliarySession"
  | "getAuxiliarySession"
  | "createAuxiliarySession"
  | "updateAuxiliarySession"
  | "closeAuxiliarySession"
  | "runAuxiliarySessionTurn"
  | "cancelAuxiliarySessionRun"
>;

type MainIpcAuxiliaryDepsRequired = {
  listAuxiliarySessions: (parentSessionId: string) => Awaitable<AuxiliarySessionSummary[]>;
  getActiveAuxiliarySession: (parentSessionId: string) => Awaitable<AuxiliarySession | null>;
  getAuxiliarySession: (auxiliarySessionId: string) => Awaitable<AuxiliarySession | null>;
  createAuxiliarySession: (input: CreateAuxiliarySessionInput) => Awaitable<AuxiliarySession>;
  updateAuxiliarySession: (session: AuxiliarySession) => Awaitable<AuxiliarySession>;
  closeAuxiliarySession: (auxiliarySessionId: string) => Awaitable<AuxiliarySession>;
  runAuxiliarySessionTurn: (
    auxiliarySessionId: string,
    request: RunSessionTurnRequest,
  ) => Awaitable<AuxiliarySession>;
  cancelAuxiliarySessionRun: (auxiliarySessionId: string) => Awaitable<void>;
};

type MainIpcSessionQueryDeps = Pick<
  MainIpcRegistrationDeps,
  | "listSessionSummaries"
  | "listCompanionSessionSummaries"
  | "listSessionAuditLogs"
  | "listSessionAuditLogSummaries"
  | "listSessionAuditLogSummaryPage"
  | "getSessionAuditLogDetail"
  | "getSessionAuditLogDetailSection"
  | "getSessionAuditLogOperationDetail"
  | "listCompanionAuditLogs"
  | "listCompanionAuditLogSummaries"
  | "listCompanionAuditLogSummaryPage"
  | "getCompanionAuditLogDetail"
  | "getCompanionAuditLogDetailSection"
  | "getCompanionAuditLogOperationDetail"
  | "listSessionSkills"
  | "listSessionCustomAgents"
  | "listWorkspaceSkills"
  | "listWorkspaceCustomAgents"
  | "listOpenSessionWindowIds"
  | "listOpenCompanionReviewWindowIds"
  | "getSession"
  | "getSessionMessageArtifact"
  | "getDiffPreview"
  | "previewComposerInput"
>;

type MainIpcCompanionDeps = Pick<
  MainIpcRegistrationDeps,
  | "createCompanionSession"
  | "getCompanionSession"
  | "getCompanionMessageArtifact"
  | "getCompanionReviewSnapshot"
  | "mergeCompanionSelectedFiles"
  | "syncCompanionTarget"
  | "stashCompanionTargetChanges"
  | "restoreCompanionTargetStash"
  | "dropCompanionTargetStash"
  | "discardCompanionSession"
  | "updateCompanionSession"
  | "previewCompanionComposerInput"
  | "runCompanionSessionTurn"
  | "cancelCompanionSessionRun"
>;

type MainIpcSessionRuntimeDeps = Pick<
  MainIpcRegistrationDeps,
  | "getLiveSessionRun"
  | "getProviderQuotaTelemetry"
  | "getSessionContextTelemetry"
  | "getSessionBackgroundActivity"
  | "resolveLiveApproval"
  | "resolveLiveElicitation"
  | "createSession"
  | "updateSession"
  | "deleteSession"
  | "deleteSessionsLastActiveBefore"
  | "runSessionTurn"
  | "cancelSessionRun"
>;

type MainIpcMateDeps = Pick<
  MainIpcRegistrationDeps,
  | "getMateState"
  | "getMateProfile"
  | "createMate"
  | "updateMate"
  | "setMateAvatar"
  | "resetMate"
>;

type MainIpcCharacterDeps = Pick<
  MainIpcRegistrationDeps,
  | "resolveEventWindow"
  | "resolveHomeWindow"
  | "listCharacters"
  | "getCharacter"
  | "createCharacter"
  | "updateCharacterMetadata"
  | "updateCharacterDefinition"
  | "archiveCharacter"
  | "setDefaultCharacter"
  | "resolveLaunchCharacter"
  | "startCharacterAuthoringSession"
>;

function resolveTargetWindow(
  event: IpcMainInvokeEvent,
  deps: Pick<MainIpcRegistrationDeps, "resolveEventWindow" | "resolveHomeWindow">,
): BrowserWindow | undefined {
  return deps.resolveEventWindow(event) ?? deps.resolveHomeWindow() ?? undefined;
}

function assertMemoryV6ReviewSender(
  event: IpcMainInvokeEvent,
  deps: Pick<MainIpcRegistrationDeps, "resolveEventWindow" | "isMemoryV6ReviewWindow">,
): void {
  const window = deps.resolveEventWindow(event);
  if (window && deps.isMemoryV6ReviewWindow(window)) {
    return;
  }
  throw new Error("Memory V6 Review IPC is only available from the Memory Review window.");
}

function assertSettingsWindowSender(
  event: IpcMainInvokeEvent,
  deps: Pick<MainIpcRegistrationDeps, "resolveEventWindow" | "isSettingsWindow">,
): void {
  const window = deps.resolveEventWindow(event);
  if (window && deps.isSettingsWindow(window)) {
    return;
  }
  throw new Error("Settings IPC is only available from the Settings window.");
}

function registerWindowHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcWindowDeps): void {
  ipcMain.handle(WITHMATE_OPEN_SESSION_CHANNEL, async (_event, sessionId: string) => {
    if (!sessionId) {
      return;
    }
    await deps.openSessionWindow(sessionId);
  });
  ipcMain.handle(WITHMATE_OPEN_HOME_WINDOW_CHANNEL, async () => {
    await deps.openHomeWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL, async () => {
    await deps.openSessionMonitorWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL, async () => {
    await deps.openSettingsWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_MEMORY_V6_REVIEW_WINDOW_CHANNEL, async () => {
    await deps.openMemoryV6ReviewWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_CHARACTER_EDITOR_WINDOW_CHANNEL, async (_event, characterId?: string | null) => {
    await deps.openCharacterEditorWindow(characterId ?? null);
  });
  ipcMain.handle(WITHMATE_OPEN_DIFF_WINDOW_CHANNEL, async (_event, diffPreview: DiffPreviewPayload) => {
    await deps.openDiffWindow(diffPreview);
  });
  ipcMain.handle(WITHMATE_OPEN_COMPANION_REVIEW_WINDOW_CHANNEL, async (_event, sessionId: string) => {
    await deps.openCompanionReviewWindow(sessionId);
  });
  ipcMain.handle(WITHMATE_OPEN_COMPANION_MERGE_WINDOW_CHANNEL, async (_event, sessionId: string) => {
    await deps.openCompanionMergeWindow(sessionId);
  });
  ipcMain.handle(WITHMATE_PICK_DIRECTORY_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickDirectory(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(WITHMATE_PICK_FILE_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickFile(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(WITHMATE_PICK_FILES_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickFiles(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(WITHMATE_PICK_SESSION_FILES_CHANNEL, async (event, sessionId: string) =>
    deps.pickSessionFiles(resolveTargetWindow(event, deps), sessionId),
  );
  ipcMain.handle(WITHMATE_PICK_SESSION_FOLDER_CHANNEL, async (event, sessionId: string) =>
    deps.pickSessionFolder(resolveTargetWindow(event, deps), sessionId),
  );
  ipcMain.handle(WITHMATE_PICK_SESSION_IMAGE_FILE_CHANNEL, async (event, sessionId: string) =>
    deps.pickSessionImageFile(resolveTargetWindow(event, deps), sessionId),
  );
  ipcMain.handle(WITHMATE_PICK_IMAGE_FILE_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickImageFile(resolveTargetWindow(event, deps), initialPath),
  );
  ipcMain.handle(
    WITHMATE_COPY_FILES_TO_SESSION_FILES_CHANNEL,
    async (_event, sessionId: string, sourcePaths: string[]) =>
      deps.copyFilesToSessionFiles(sessionId, sourcePaths),
  );
  ipcMain.handle(
    WITHMATE_SAVE_PASTED_SESSION_FILE_CHANNEL,
    async (_event, request: SavePastedSessionFileRequest) => deps.savePastedSessionFile(request),
  );
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_FILES_DIRECTORY_CHANNEL,
    async (_event, sessionId: string) => deps.openSessionFilesDirectory(sessionId),
  );
  ipcMain.handle(
    WITHMATE_OPEN_SESSION_FILES_TERMINAL_CHANNEL,
    async (_event, sessionId: string) => deps.openSessionFilesTerminal(sessionId),
  );
  ipcMain.handle(WITHMATE_OPEN_PATH_CHANNEL, async (_event, target: string, options: OpenPathOptions | null) =>
    deps.openPathTarget(target, options ?? undefined),
  );
  ipcMain.handle(WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL, async () => deps.openAppLogFolder());
  ipcMain.handle(WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL, async () => deps.openCrashDumpFolder());
  ipcMain.handle(WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL, async (_event, sessionId: string) =>
    deps.openSessionTerminal(sessionId),
  );
  ipcMain.handle(WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL, async (_event, target: string) =>
    deps.openTerminalAtPath(target),
  );
}

function registerAuxiliaryHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcAuxiliaryDeps): void {
  const getAuxiliaryDeps = (deps: MainIpcAuxiliaryDeps): MainIpcAuxiliaryDepsRequired => {
    if (
      !deps.listAuxiliarySessions ||
      !deps.getActiveAuxiliarySession ||
      !deps.getAuxiliarySession ||
      !deps.createAuxiliarySession ||
      !deps.updateAuxiliarySession ||
      !deps.closeAuxiliarySession ||
      !deps.runAuxiliarySessionTurn ||
      !deps.cancelAuxiliarySessionRun
    ) {
      throw new Error(
        "Auxiliary session IPC is not wired. listAuxiliarySessions, getActiveAuxiliarySession, getAuxiliarySession, "
        + "createAuxiliarySession, updateAuxiliarySession, closeAuxiliarySession, runAuxiliarySessionTurn, "
        + "and cancelAuxiliarySessionRun are required.",
      );
    }

    return {
      listAuxiliarySessions: deps.listAuxiliarySessions,
      getActiveAuxiliarySession: deps.getActiveAuxiliarySession,
      getAuxiliarySession: deps.getAuxiliarySession,
      createAuxiliarySession: deps.createAuxiliarySession,
      updateAuxiliarySession: deps.updateAuxiliarySession,
      closeAuxiliarySession: deps.closeAuxiliarySession,
      runAuxiliarySessionTurn: deps.runAuxiliarySessionTurn,
      cancelAuxiliarySessionRun: deps.cancelAuxiliarySessionRun,
    };
  };

  ipcMain.handle(WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL, (_event, parentSessionId: string) => {
    const auxiliaryDeps = getAuxiliaryDeps(deps);
    if (!parentSessionId) {
      return [];
    }
    return auxiliaryDeps.listAuxiliarySessions(parentSessionId);
  });
  ipcMain.handle(WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL, (_event, parentSessionId: string) => {
    const auxiliaryDeps = getAuxiliaryDeps(deps);
    if (!parentSessionId) {
      return null;
    }
    return auxiliaryDeps.getActiveAuxiliarySession(parentSessionId);
  });
  ipcMain.handle(WITHMATE_GET_AUXILIARY_SESSION_CHANNEL, (_event, auxiliarySessionId: string) => {
    const auxiliaryDeps = getAuxiliaryDeps(deps);
    if (!auxiliarySessionId) {
      return null;
    }
    return auxiliaryDeps.getAuxiliarySession(auxiliarySessionId);
  });
  ipcMain.handle(WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL, (_event, input: CreateAuxiliarySessionInput) =>
    getAuxiliaryDeps(deps).createAuxiliarySession(input),
  );
  ipcMain.handle(WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL, (_event, session: AuxiliarySession) =>
    getAuxiliaryDeps(deps).updateAuxiliarySession(session),
  );
  ipcMain.handle(WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL, (_event, auxiliarySessionId: string) =>
    getAuxiliaryDeps(deps).closeAuxiliarySession(auxiliarySessionId),
  );
  ipcMain.handle(
    WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
    (_event, auxiliarySessionId: string, request: RunSessionTurnRequest) =>
      getAuxiliaryDeps(deps).runAuxiliarySessionTurn(auxiliarySessionId, request),
  );
  ipcMain.handle(WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL, (_event, auxiliarySessionId: string) =>
    getAuxiliaryDeps(deps).cancelAuxiliarySessionRun(auxiliarySessionId),
  );
}

function registerCatalogHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcCatalogDeps): void {
  ipcMain.handle(WITHMATE_GET_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) => deps.getModelCatalog(revision));
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL, (_event, document: ModelCatalogDocument) =>
    deps.importModelCatalogDocument(document),
  );
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL, async (event) =>
    deps.importModelCatalogFromFile(resolveTargetWindow(event, deps)),
  );
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) =>
    deps.exportModelCatalogDocument(revision),
  );
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL, async (event, revision: number | null) =>
    deps.exportModelCatalogToFile(revision, resolveTargetWindow(event, deps)),
  );
}

function registerSettingsHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcSettingsDeps): void {
  ipcMain.handle(WITHMATE_GET_APP_SETTINGS_CHANNEL, () => deps.getAppSettings());
  ipcMain.handle(WITHMATE_UPDATE_APP_SETTINGS_CHANNEL, (_event, settings) => deps.updateAppSettings(settings));
  ipcMain.handle(WITHMATE_GET_APP_DATABASE_DIAGNOSTICS_CHANNEL, () => deps.getAppDatabaseDiagnostics());
  ipcMain.handle(WITHMATE_GET_MEMORY_V6_DIAGNOSTICS_CHANNEL, () => deps.getMemoryV6Diagnostics());
  ipcMain.handle(WITHMATE_INSTALL_MEMORY_V6_CLI_SHIM_CHANNEL, (event) => {
    assertSettingsWindowSender(event, deps);
    return deps.installMemoryV6CliShim();
  });
  ipcMain.handle(WITHMATE_UNINSTALL_MEMORY_V6_CLI_SHIM_CHANNEL, (event) => {
    assertSettingsWindowSender(event, deps);
    return deps.uninstallMemoryV6CliShim();
  });
  ipcMain.handle(WITHMATE_SEARCH_MEMORY_V6_ENTRIES_CHANNEL, (event, request: MemoryV6ReviewSearchRequest | null | undefined) => {
    assertMemoryV6ReviewSender(event, deps);
    return deps.searchMemoryV6Entries(request);
  });
  ipcMain.handle(WITHMATE_GET_MEMORY_V6_ENTRY_CHANNEL, (event, entryId: string) => {
    assertMemoryV6ReviewSender(event, deps);
    return deps.getMemoryV6Entry(entryId);
  });
  ipcMain.handle(WITHMATE_FORGET_MEMORY_V6_ENTRY_CHANNEL, (event, entryId: string, reason?: MemoryForgetReason | null) => {
    assertMemoryV6ReviewSender(event, deps);
    return deps.forgetMemoryV6Entry(entryId, reason);
  });
  ipcMain.handle(WITHMATE_RESET_APP_DATABASE_CHANNEL, (_event, request: ResetAppDatabaseRequest | null | undefined) =>
    deps.resetAppDatabase(request),
  );
}

function registerSessionQueryHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcSessionQueryDeps): void {
  ipcMain.handle(WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL, () => deps.listSessionSummaries());
  ipcMain.handle(WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL, () => deps.listCompanionSessionSummaries());
  ipcMain.handle(WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL, (_event, sessionId: string) => deps.listSessionAuditLogs(sessionId));
  ipcMain.handle(WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL, (_event, sessionId: string) =>
    deps.listSessionAuditLogSummaries(sessionId),
  );
  ipcMain.handle(
    WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
    (_event, sessionId: string, request: AuditLogSummaryPageRequest | null | undefined) =>
      deps.listSessionAuditLogSummaryPage(sessionId, request),
  );
  ipcMain.handle(WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_CHANNEL, (_event, sessionId: string, auditLogId: number) =>
    deps.getSessionAuditLogDetail(sessionId, auditLogId),
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
    (_event, sessionId: string, auditLogId: number, section: AuditLogDetailSection) =>
      deps.getSessionAuditLogDetailSection(sessionId, auditLogId, section),
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
    (_event, sessionId: string, auditLogId: number, operationIndex: number) =>
      deps.getSessionAuditLogOperationDetail(sessionId, auditLogId, operationIndex),
  );
  ipcMain.handle(WITHMATE_LIST_COMPANION_AUDIT_LOGS_CHANNEL, (_event, sessionId: string) => deps.listCompanionAuditLogs(sessionId));
  ipcMain.handle(WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARIES_CHANNEL, (_event, sessionId: string) =>
    deps.listCompanionAuditLogSummaries(sessionId),
  );
  ipcMain.handle(
    WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
    (_event, sessionId: string, request: AuditLogSummaryPageRequest | null | undefined) =>
      deps.listCompanionAuditLogSummaryPage(sessionId, request),
  );
  ipcMain.handle(WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_CHANNEL, (_event, sessionId: string, auditLogId: number) =>
    deps.getCompanionAuditLogDetail(sessionId, auditLogId),
  );
  ipcMain.handle(
    WITHMATE_GET_COMPANION_AUDIT_LOG_DETAIL_SECTION_CHANNEL,
    (_event, sessionId: string, auditLogId: number, section: AuditLogDetailSection) =>
      deps.getCompanionAuditLogDetailSection(sessionId, auditLogId, section),
  );
  ipcMain.handle(
    WITHMATE_GET_COMPANION_AUDIT_LOG_OPERATION_DETAIL_CHANNEL,
    (_event, sessionId: string, auditLogId: number, operationIndex: number) =>
      deps.getCompanionAuditLogOperationDetail(sessionId, auditLogId, operationIndex),
  );
  ipcMain.handle(WITHMATE_LIST_SESSION_SKILLS_CHANNEL, async (_event, sessionId: string) => deps.listSessionSkills(sessionId));
  ipcMain.handle(WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL, async (_event, sessionId: string) =>
    deps.listSessionCustomAgents(sessionId),
  );
  ipcMain.handle(WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL, async (_event, providerId: string, workspacePath: string) =>
    deps.listWorkspaceSkills(providerId, workspacePath),
  );
  ipcMain.handle(
    WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
    async (_event, providerId: string, workspacePath: string) =>
      deps.listWorkspaceCustomAgents(providerId, workspacePath),
  );
  ipcMain.handle(WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL, () => deps.listOpenSessionWindowIds());
  ipcMain.handle(WITHMATE_LIST_OPEN_COMPANION_REVIEW_WINDOW_IDS_CHANNEL, () => deps.listOpenCompanionReviewWindowIds());
  ipcMain.handle(WITHMATE_GET_SESSION_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getSession(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_SESSION_MESSAGE_ARTIFACT_CHANNEL, (_event, sessionId: string, messageIndex: number) => {
    if (!sessionId || !Number.isInteger(messageIndex) || messageIndex < 0) {
      return null;
    }
    return deps.getSessionMessageArtifact(sessionId, messageIndex);
  });
  ipcMain.handle(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, (_event, token: string) => {
    if (!token) {
      return null;
    }
    return deps.getDiffPreview(token);
  });
  ipcMain.handle(WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL, (_event, sessionId: string, userMessage: string) =>
    deps.previewComposerInput(sessionId, userMessage),
  );
}

function registerCompanionHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcCompanionDeps): void {
  ipcMain.handle(WITHMATE_GET_COMPANION_SESSION_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getCompanionSession(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_COMPANION_MESSAGE_ARTIFACT_CHANNEL, (_event, sessionId: string, messageIndex: number) => {
    if (!sessionId || !Number.isInteger(messageIndex) || messageIndex < 0) {
      return null;
    }
    return deps.getCompanionMessageArtifact(sessionId, messageIndex);
  });
  ipcMain.handle(WITHMATE_GET_COMPANION_REVIEW_SNAPSHOT_CHANNEL, async (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getCompanionReviewSnapshot(sessionId);
  });
  ipcMain.handle(WITHMATE_MERGE_COMPANION_SELECTED_FILES_CHANNEL, async (_event, request: CompanionMergeSelectedFilesRequest) =>
    deps.mergeCompanionSelectedFiles(request),
  );
  ipcMain.handle(WITHMATE_SYNC_COMPANION_TARGET_CHANNEL, async (_event, sessionId: string) =>
    deps.syncCompanionTarget(sessionId),
  );
  ipcMain.handle(WITHMATE_STASH_COMPANION_TARGET_CHANGES_CHANNEL, async (_event, sessionId: string) =>
    deps.stashCompanionTargetChanges(sessionId),
  );
  ipcMain.handle(WITHMATE_RESTORE_COMPANION_TARGET_STASH_CHANNEL, async (_event, sessionId: string) =>
    deps.restoreCompanionTargetStash(sessionId),
  );
  ipcMain.handle(WITHMATE_DROP_COMPANION_TARGET_STASH_CHANNEL, async (_event, sessionId: string) =>
    deps.dropCompanionTargetStash(sessionId),
  );
  ipcMain.handle(WITHMATE_DISCARD_COMPANION_SESSION_CHANNEL, async (_event, sessionId: string) =>
    deps.discardCompanionSession(sessionId),
  );
  ipcMain.handle(WITHMATE_UPDATE_COMPANION_SESSION_CHANNEL, async (_event, session: CompanionSession) =>
    deps.updateCompanionSession(session),
  );
  ipcMain.handle(WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL, async (_event, sessionId: string, userMessage: string) =>
    deps.previewCompanionComposerInput(sessionId, userMessage),
  );
  ipcMain.handle(WITHMATE_CREATE_COMPANION_SESSION_CHANNEL, async (_event, input: CreateCompanionSessionInput) =>
    deps.createCompanionSession(input),
  );
  ipcMain.handle(WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL, async (_event, sessionId: string, request: RunSessionTurnRequest) =>
    deps.runCompanionSessionTurn(sessionId, request),
  );
  ipcMain.handle(WITHMATE_CANCEL_COMPANION_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    deps.cancelCompanionSessionRun(sessionId);
  });
}

function registerSessionRuntimeHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcSessionRuntimeDeps): void {
  ipcMain.handle(WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getLiveSessionRun(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL, async (_event, providerId: string) => {
    if (!providerId) {
      return null;
    }
    return deps.getProviderQuotaTelemetry(providerId);
  });
  ipcMain.handle(WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    return deps.getSessionContextTelemetry(sessionId);
  });
  ipcMain.handle(
    WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
    (_event, sessionId: string, kind: SessionBackgroundActivityKind) => {
      if (!sessionId || !kind) {
        return null;
      }
      return deps.getSessionBackgroundActivity(sessionId, kind);
    },
  );
  ipcMain.handle(
    WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
    (_event, sessionId: string, requestId: string, decision: LiveApprovalDecision) => {
      deps.resolveLiveApproval(sessionId, requestId, decision);
    },
  );
  ipcMain.handle(
    WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
    (_event, sessionId: string, requestId: string, response: LiveElicitationResponse) => {
      deps.resolveLiveElicitation(sessionId, requestId, response);
    },
  );
  ipcMain.handle(WITHMATE_CREATE_SESSION_CHANNEL, (_event, input: CreateSessionInput) => deps.createSession(input));
  ipcMain.handle(WITHMATE_UPDATE_SESSION_CHANNEL, (_event, session: Session) => deps.updateSession(session));
  ipcMain.handle(WITHMATE_DELETE_SESSION_CHANNEL, (_event, sessionId: string) => deps.deleteSession(sessionId));
  ipcMain.handle(
    WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
    (_event, request: DeleteSessionsLastActiveBeforeRequest | null | undefined) =>
      deps.deleteSessionsLastActiveBefore(request),
  );
  ipcMain.handle(WITHMATE_RUN_SESSION_TURN_CHANNEL, async (_event, sessionId: string, request: RunSessionTurnRequest) =>
    deps.runSessionTurn(sessionId, request),
  );
  ipcMain.handle(WITHMATE_CANCEL_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    deps.cancelSessionRun(sessionId);
  });
}

function registerMateHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcMateDeps): void {
  ipcMain.handle(WITHMATE_GET_MATE_STATE_CHANNEL, () => deps.getMateState());
  ipcMain.handle(WITHMATE_GET_MATE_PROFILE_CHANNEL, () => deps.getMateProfile());
  ipcMain.handle(WITHMATE_CREATE_MATE_CHANNEL, (_event, input: CreateMateInput) => deps.createMate(input));
  ipcMain.handle(WITHMATE_UPDATE_MATE_CHANNEL, (_event, input: UpdateMateInput) => deps.updateMate(input));
  ipcMain.handle(WITHMATE_SET_MATE_AVATAR_CHANNEL, (_event, input: SetMateAvatarInput) => deps.setMateAvatar(input));
  ipcMain.handle(WITHMATE_RESET_MATE_CHANNEL, () => deps.resetMate());
}

function registerCharacterHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcCharacterDeps): void {
  ipcMain.handle(WITHMATE_LIST_CHARACTERS_CHANNEL, (_event, options: { includeArchived?: boolean } | null) =>
    deps.listCharacters(options ?? undefined),
  );
  ipcMain.handle(WITHMATE_GET_CHARACTER_CHANNEL, (_event, characterId: string) => {
    if (!characterId) {
      return null;
    }
    return deps.getCharacter(characterId);
  });
  ipcMain.handle(WITHMATE_CREATE_CHARACTER_CHANNEL, (_event, input: CreateCharacterInput) =>
    deps.createCharacter(input),
  );
  ipcMain.handle(WITHMATE_UPDATE_CHARACTER_METADATA_CHANNEL, (_event, input: UpdateCharacterMetadataInput) =>
    deps.updateCharacterMetadata(input),
  );
  ipcMain.handle(WITHMATE_UPDATE_CHARACTER_DEFINITION_CHANNEL, (_event, input: UpdateCharacterDefinitionInput) =>
    deps.updateCharacterDefinition(input),
  );
  ipcMain.handle(WITHMATE_ARCHIVE_CHARACTER_CHANNEL, (_event, characterId: string) =>
    deps.archiveCharacter(characterId),
  );
  ipcMain.handle(WITHMATE_SET_DEFAULT_CHARACTER_CHANNEL, (_event, characterId: string) =>
    deps.setDefaultCharacter(characterId),
  );
  ipcMain.handle(WITHMATE_RESOLVE_LAUNCH_CHARACTER_CHANNEL, (_event, input: ResolveLaunchCharacterInput | null) =>
    deps.resolveLaunchCharacter(input),
  );
  ipcMain.handle(WITHMATE_START_CHARACTER_AUTHORING_SESSION_CHANNEL, (_event, input: StartCharacterAuthoringSessionInput) =>
    deps.startCharacterAuthoringSession(input),
  );
}

export function registerMainIpcHandlers(ipcMain: IpcMain, deps: MainIpcRegistrationDeps): void {
  const wrappedIpcMain = createErrorLoggingIpcMain(ipcMain, deps);
  registerWindowHandlers(wrappedIpcMain, deps);
  registerAuxiliaryHandlers(wrappedIpcMain, deps);
  registerCatalogHandlers(wrappedIpcMain, deps);
  registerSettingsHandlers(wrappedIpcMain, deps);
  registerSessionQueryHandlers(wrappedIpcMain, deps);
  registerCompanionHandlers(wrappedIpcMain, deps);
  registerSessionRuntimeHandlers(wrappedIpcMain, deps);
  registerMateHandlers(wrappedIpcMain, deps);
  registerCharacterHandlers(wrappedIpcMain, deps);
  ipcMain.on(WITHMATE_RENDERER_LOG_CHANNEL, (event, input: RendererLogInput) => {
    const windowId = deps.resolveEventWindow(event)?.id;
    deps.reportRendererLog?.(input, windowId);
  });
}

function createErrorLoggingIpcMain(ipcMain: IpcMain, deps: MainIpcRegistrationDeps): IpcHandleRegistrar {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (event, ...args) => {
        const startedAt = Date.now();
        try {
          return await handler(event, ...args);
        } catch (error) {
          deps.logIpcError?.({
            channel,
            durationMs: Date.now() - startedAt,
            error,
          });
          throw error;
        }
      });
    },
  };
}
