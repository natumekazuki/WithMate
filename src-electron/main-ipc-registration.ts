import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import type { RendererLogInput } from "../src/app-log-types.js";
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
import type {
  CreateMateInput,
  MateProfile,
  MateStorageState,
  MateTalkTurnInput,
  MateTalkTurnResult,
} from "../src/mate-state.js";
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
import type {
  ProviderInstructionTarget,
  ProviderInstructionTargetInput,
} from "../src/provider-instruction-target-state.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../src/runtime-state.js";
import type { CreateSessionInput, DiffPreviewPayload, MessageArtifact, Session } from "../src/session-state.js";
import type { MateEmbeddingSettings } from "../src/mate-embedding-settings.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import {
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CANCEL_COMPANION_SESSION_RUN_CHANNEL,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_CHARACTER_UPDATE_SESSION_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_CREATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_DELETE_CHARACTER_CHANNEL,
  WITHMATE_DELETE_CHARACTER_MEMORY_ENTRY_CHANNEL,
  WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL,
  WITHMATE_DELETE_SESSION_MEMORY_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DISCARD_COMPANION_SESSION_CHANNEL,
  WITHMATE_EXTRACT_CHARACTER_UPDATE_MEMORY_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_CHARACTER_UPDATE_WORKSPACE_CHANNEL,
  WITHMATE_GET_COMPANION_MESSAGE_ARTIFACT_CHANNEL,
  WITHMATE_GET_COMPANION_REVIEW_SNAPSHOT_CHANNEL,
  WITHMATE_GET_COMPANION_SESSION_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_GET_MATE_PROFILE_CHANNEL,
  WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
  WITHMATE_GET_MEMORY_MANAGEMENT_PAGE_CHANNEL,
  WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL,
  WITHMATE_GET_MATE_EMBEDDING_SETTINGS_CHANNEL,
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
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_COMPANION_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_OPEN_COMPANION_REVIEW_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_PROVIDER_INSTRUCTION_TARGETS_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARIES_CHANNEL,
  WITHMATE_LIST_COMPANION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARIES_CHANNEL,
  WITHMATE_LIST_SESSION_AUDIT_LOG_SUMMARY_PAGE_CHANNEL,
  WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_SESSION_SKILLS_CHANNEL,
  WITHMATE_LIST_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_WORKSPACE_CUSTOM_AGENTS_CHANNEL,
  WITHMATE_LIST_WORKSPACE_SKILLS_CHANNEL,
  WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_COMPANION_MERGE_WINDOW_CHANNEL,
  WITHMATE_OPEN_COMPANION_REVIEW_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
  WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
  WITHMATE_OPEN_MEMORY_MANAGEMENT_WINDOW_CHANNEL,
  WITHMATE_OPEN_PATH_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_OPEN_SESSION_MONITOR_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_OPEN_TERMINAL_AT_PATH_CHANNEL,
  WITHMATE_MERGE_COMPANION_SELECTED_FILES_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_PREVIEW_COMPANION_COMPOSER_INPUT_CHANNEL,
  WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_RESET_MATE_CHANNEL,
  WITHMATE_APPLY_MATE_GROWTH_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_RUN_MATE_TALK_TURN_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_RUN_COMPANION_SESSION_TURN_CHANNEL,
  WITHMATE_SEARCH_COMPANION_WORKSPACE_FILES_CHANNEL,
  WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL,
  WITHMATE_SYNC_COMPANION_TARGET_CHANNEL,
  WITHMATE_STASH_COMPANION_TARGET_CHANGES_CHANNEL,
  WITHMATE_RESTORE_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_DROP_COMPANION_TARGET_STASH_CHANNEL,
  WITHMATE_RENDERER_LOG_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_UPSERT_PROVIDER_INSTRUCTION_TARGET_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_CHANNEL,
  WITHMATE_UPDATE_COMPANION_SESSION_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
  WITHMATE_START_MATE_EMBEDDING_DOWNLOAD_CHANNEL,
} from "../src/withmate-ipc-channels.js";
import type { OpenPathOptions, ResetAppDatabaseRequest } from "../src/withmate-window-types.js";
import type { WorkspacePathCandidate } from "../src/workspace-path-candidate.js";

type MaybeWindow = BrowserWindow | null | undefined;
type IpcSenderEvent = Pick<IpcMainInvokeEvent, "sender">;
type LogIpcErrorInput = {
  channel: string;
  durationMs: number;
  error: unknown;
};

export const MATE_NOT_CREATED_ERROR_MESSAGE = "Mate が作成されるまでは本機能を実行できません。";

const MATE_CREATED_REQUIRED_CHANNEL_WHITELIST = new Set<string>([
  WITHMATE_GET_MATE_STATE_CHANNEL,
  WITHMATE_GET_MATE_PROFILE_CHANNEL,
  WITHMATE_CREATE_MATE_CHANNEL,
  WITHMATE_RESET_MATE_CHANNEL,
  WITHMATE_GET_APP_SETTINGS_CHANNEL,
  WITHMATE_UPDATE_APP_SETTINGS_CHANNEL,
  WITHMATE_GET_MATE_EMBEDDING_SETTINGS_CHANNEL,
  WITHMATE_LIST_PROVIDER_INSTRUCTION_TARGETS_CHANNEL,
  WITHMATE_UPSERT_PROVIDER_INSTRUCTION_TARGET_CHANNEL,
  WITHMATE_START_MATE_EMBEDDING_DOWNLOAD_CHANNEL,
  WITHMATE_RESET_APP_DATABASE_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_OPEN_SETTINGS_WINDOW_CHANNEL,
  WITHMATE_OPEN_HOME_WINDOW_CHANNEL,
  WITHMATE_OPEN_APP_LOG_FOLDER_CHANNEL,
  WITHMATE_OPEN_CRASH_DUMP_FOLDER_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_PICK_FILE_CHANNEL,
  WITHMATE_PICK_IMAGE_FILE_CHANNEL,
  WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL,
  WITHMATE_LIST_OPEN_COMPANION_REVIEW_WINDOW_IDS_CHANNEL,
  WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL,
  WITHMATE_GET_MEMORY_MANAGEMENT_PAGE_CHANNEL,
  WITHMATE_DELETE_SESSION_MEMORY_CHANNEL,
  WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL,
  WITHMATE_DELETE_CHARACTER_MEMORY_ENTRY_CHANNEL,
]);

async function ensureMateCreated(deps: Pick<MainIpcRegistrationDeps, "getMateState">, channel: string): Promise<void> {
  if (MATE_CREATED_REQUIRED_CHANNEL_WHITELIST.has(channel)) {
    return;
  }

  const mateState = await deps.getMateState();
  if (mateState === "not_created") {
    throw new Error(MATE_NOT_CREATED_ERROR_MESSAGE);
  }
}

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
  openMemoryManagementWindow(): Promise<void>;
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
  getAppSettings(): AppSettings;
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  getMateEmbeddingSettings(): MateEmbeddingSettings | null;
  listProviderInstructionTargets(): Awaitable<ProviderInstructionTarget[]>;
  upsertProviderInstructionTarget(input: ProviderInstructionTargetInput): Awaitable<ProviderInstructionTarget>;
  startMateEmbeddingDownload(): Awaitable<void>;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
  getMemoryManagementSnapshot(): MemoryManagementSnapshot;
  getMemoryManagementPage(request: MemoryManagementPageRequest): MemoryManagementPageResult;
  deleteSessionMemory(sessionId: string): void;
  deleteProjectMemoryEntry(entryId: string): void;
  deleteCharacterMemoryEntry(entryId: string): void;
  listCharacters(): Promise<CharacterProfile[]>;
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
  getCharacter(characterId: string): Promise<CharacterProfile | null>;
  getCharacterUpdateWorkspace(characterId: string): Promise<CharacterUpdateWorkspace | null>;
  extractCharacterUpdateMemory(characterId: string): Promise<CharacterUpdateMemoryExtract>;
  createCharacterUpdateSession(characterId: string, providerId: string): Promise<Session>;
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
  searchCompanionWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]>;
  runCompanionSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<CompanionSession>;
  cancelCompanionSessionRun(sessionId: string): void;
  updateSession(session: Session): Awaitable<Session>;
  deleteSession(sessionId: string): Awaitable<void>;
  previewComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<WorkspacePathCandidate[]>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  cancelSessionRun(sessionId: string): void;
  createCharacter(input: CreateCharacterInput): Promise<CharacterProfile>;
  updateCharacter(character: CharacterProfile): Promise<CharacterProfile>;
  deleteCharacter(characterId: string): Promise<void>;
  getMateState(): Awaitable<MateStorageState>;
  getMateProfile(): Awaitable<MateProfile | null>;
  createMate(input: CreateMateInput): Promise<MateProfile>;
  applyPendingGrowth(): Promise<unknown>;
  runMateTalkTurn(input: MateTalkTurnInput): Promise<MateTalkTurnResult>;
  resetMate(): Promise<void>;
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickImageFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
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
  | "openMemoryManagementWindow"
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
  | "pickImageFile"
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
  | "getAppSettings"
  | "updateAppSettings"
  | "getMateEmbeddingSettings"
  | "listProviderInstructionTargets"
  | "upsertProviderInstructionTarget"
  | "startMateEmbeddingDownload"
  | "resetAppDatabase"
  | "getMemoryManagementSnapshot"
  | "getMemoryManagementPage"
  | "deleteSessionMemory"
  | "deleteProjectMemoryEntry"
  | "deleteCharacterMemoryEntry"
>;

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
  | "searchWorkspaceFiles"
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
  | "searchCompanionWorkspaceFiles"
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
  | "runSessionTurn"
  | "cancelSessionRun"
>;

type MainIpcCharacterDeps = Pick<
  MainIpcRegistrationDeps,
  | "listCharacters"
  | "getCharacter"
  | "getCharacterUpdateWorkspace"
  | "extractCharacterUpdateMemory"
  | "createCharacterUpdateSession"
  | "createCharacter"
  | "updateCharacter"
  | "deleteCharacter"
>;

type MainIpcMateDeps = Pick<
  MainIpcRegistrationDeps,
  | "getMateState"
  | "getMateProfile"
  | "createMate"
  | "applyPendingGrowth"
  | "runMateTalkTurn"
  | "resetMate"
>;

function resolveTargetWindow(
  event: IpcMainInvokeEvent,
  deps: Pick<MainIpcRegistrationDeps, "resolveEventWindow" | "resolveHomeWindow">,
): BrowserWindow | undefined {
  return deps.resolveEventWindow(event) ?? deps.resolveHomeWindow() ?? undefined;
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
  ipcMain.handle(WITHMATE_OPEN_MEMORY_MANAGEMENT_WINDOW_CHANNEL, async () => {
    await deps.openMemoryManagementWindow();
  });
  ipcMain.handle(WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL, async (_event, characterId: string | null) => {
    await deps.openCharacterEditorWindow(characterId);
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
  ipcMain.handle(WITHMATE_PICK_IMAGE_FILE_CHANNEL, async (event, initialPath: string | null) =>
    deps.pickImageFile(resolveTargetWindow(event, deps), initialPath),
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
  ipcMain.handle(WITHMATE_GET_MATE_EMBEDDING_SETTINGS_CHANNEL, () => deps.getMateEmbeddingSettings());
  ipcMain.handle(WITHMATE_LIST_PROVIDER_INSTRUCTION_TARGETS_CHANNEL, () => deps.listProviderInstructionTargets());
  ipcMain.handle(WITHMATE_UPSERT_PROVIDER_INSTRUCTION_TARGET_CHANNEL, (_event, input: ProviderInstructionTargetInput) =>
    deps.upsertProviderInstructionTarget(input),
  );
  ipcMain.handle(WITHMATE_START_MATE_EMBEDDING_DOWNLOAD_CHANNEL, () => deps.startMateEmbeddingDownload());
  ipcMain.handle(WITHMATE_RESET_APP_DATABASE_CHANNEL, (_event, request: ResetAppDatabaseRequest | null | undefined) =>
    deps.resetAppDatabase(request),
  );
  ipcMain.handle(WITHMATE_GET_MEMORY_MANAGEMENT_SNAPSHOT_CHANNEL, () => deps.getMemoryManagementSnapshot());
  ipcMain.handle(WITHMATE_GET_MEMORY_MANAGEMENT_PAGE_CHANNEL, (_event, request: MemoryManagementPageRequest) =>
    deps.getMemoryManagementPage(request),
  );
  ipcMain.handle(WITHMATE_DELETE_SESSION_MEMORY_CHANNEL, (_event, sessionId: string) => deps.deleteSessionMemory(sessionId));
  ipcMain.handle(WITHMATE_DELETE_PROJECT_MEMORY_ENTRY_CHANNEL, (_event, entryId: string) =>
    deps.deleteProjectMemoryEntry(entryId),
  );
  ipcMain.handle(WITHMATE_DELETE_CHARACTER_MEMORY_ENTRY_CHANNEL, (_event, entryId: string) =>
    deps.deleteCharacterMemoryEntry(entryId),
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
  ipcMain.handle(WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL, (_event, sessionId: string, query: string) =>
    deps.searchWorkspaceFiles(sessionId, query),
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
  ipcMain.handle(WITHMATE_SEARCH_COMPANION_WORKSPACE_FILES_CHANNEL, async (_event, sessionId: string, query: string) =>
    deps.searchCompanionWorkspaceFiles(sessionId, query),
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
  ipcMain.handle(WITHMATE_RUN_SESSION_TURN_CHANNEL, async (_event, sessionId: string, request: RunSessionTurnRequest) =>
    deps.runSessionTurn(sessionId, request),
  );
  ipcMain.handle(WITHMATE_CANCEL_SESSION_RUN_CHANNEL, (_event, sessionId: string) => {
    deps.cancelSessionRun(sessionId);
  });
}

function registerCharacterHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcCharacterDeps): void {
  ipcMain.handle(WITHMATE_LIST_CHARACTERS_CHANNEL, async () => deps.listCharacters());
  ipcMain.handle(WITHMATE_GET_CHARACTER_CHANNEL, async (_event, characterId: string) => {
    if (!characterId) {
      return null;
    }
    return deps.getCharacter(characterId);
  });
  ipcMain.handle(WITHMATE_GET_CHARACTER_UPDATE_WORKSPACE_CHANNEL, async (_event, characterId: string) => {
    if (!characterId) {
      return null;
    }
    return deps.getCharacterUpdateWorkspace(characterId);
  });
  ipcMain.handle(WITHMATE_EXTRACT_CHARACTER_UPDATE_MEMORY_CHANNEL, async (_event, characterId: string) =>
    deps.extractCharacterUpdateMemory(characterId),
  );
  ipcMain.handle(
    WITHMATE_CREATE_CHARACTER_UPDATE_SESSION_CHANNEL,
    async (_event, characterId: string, providerId: string) => deps.createCharacterUpdateSession(characterId, providerId),
  );
  ipcMain.handle(WITHMATE_CREATE_CHARACTER_CHANNEL, async (_event, input: CreateCharacterInput) => deps.createCharacter(input));
  ipcMain.handle(WITHMATE_UPDATE_CHARACTER_CHANNEL, async (_event, character: CharacterProfile) => deps.updateCharacter(character));
  ipcMain.handle(WITHMATE_DELETE_CHARACTER_CHANNEL, async (_event, characterId: string) => deps.deleteCharacter(characterId));
}

function registerMateHandlers(ipcMain: IpcHandleRegistrar, deps: MainIpcMateDeps): void {
  ipcMain.handle(WITHMATE_GET_MATE_STATE_CHANNEL, () => deps.getMateState());
  ipcMain.handle(WITHMATE_GET_MATE_PROFILE_CHANNEL, () => deps.getMateProfile());
  ipcMain.handle(WITHMATE_CREATE_MATE_CHANNEL, (_event, input: CreateMateInput) => deps.createMate(input));
  ipcMain.handle(WITHMATE_APPLY_MATE_GROWTH_CHANNEL, () => deps.applyPendingGrowth());
  ipcMain.handle(WITHMATE_RUN_MATE_TALK_TURN_CHANNEL, (_event, input: MateTalkTurnInput) =>
    deps.runMateTalkTurn(input),
  );
  ipcMain.handle(WITHMATE_RESET_MATE_CHANNEL, () => deps.resetMate());
}

export function registerMainIpcHandlers(ipcMain: IpcMain, deps: MainIpcRegistrationDeps): void {
  const wrappedIpcMain = createErrorLoggingIpcMain(ipcMain, deps);
  registerWindowHandlers(wrappedIpcMain, deps);
  registerCatalogHandlers(wrappedIpcMain, deps);
  registerSettingsHandlers(wrappedIpcMain, deps);
  registerSessionQueryHandlers(wrappedIpcMain, deps);
  registerCompanionHandlers(wrappedIpcMain, deps);
  registerSessionRuntimeHandlers(wrappedIpcMain, deps);
  registerCharacterHandlers(wrappedIpcMain, deps);
  registerMateHandlers(wrappedIpcMain, deps);
  ipcMain.on(WITHMATE_RENDERER_LOG_CHANNEL, (event, input: RendererLogInput) => {
    const windowId = deps.resolveEventWindow(event)?.id;
    deps.reportRendererLog?.(input, windowId);
  });
}

function createErrorLoggingIpcMain(ipcMain: IpcMain, deps: MainIpcRegistrationDeps): IpcHandleRegistrar {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (event, ...args) => {
        await ensureMateCreated(deps, channel);
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
