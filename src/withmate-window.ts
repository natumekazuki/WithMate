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
  LiveSessionRunState,
  RunSessionTurnRequest,
  Session,
} from "./app-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "./model-catalog.js";

export const WITHMATE_OPEN_SESSION_CHANNEL = "withmate:open-session";
export const WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL = "withmate:open-character-editor";
export const WITHMATE_OPEN_DIFF_WINDOW_CHANNEL = "withmate:open-diff-window";
export const WITHMATE_LIST_SESSIONS_CHANNEL = "withmate:list-sessions";
export const WITHMATE_GET_SESSION_CHANNEL = "withmate:get-session";
export const WITHMATE_GET_MODEL_CATALOG_CHANNEL = "withmate:get-model-catalog";
export const WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL = "withmate:import-model-catalog";
export const WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL = "withmate:export-model-catalog";
export const WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL = "withmate:import-model-catalog-file";
export const WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL = "withmate:export-model-catalog-file";
export const WITHMATE_GET_DIFF_PREVIEW_CHANNEL = "withmate:get-diff-preview";
export const WITHMATE_CREATE_SESSION_CHANNEL = "withmate:create-session";
export const WITHMATE_UPDATE_SESSION_CHANNEL = "withmate:update-session";
export const WITHMATE_DELETE_SESSION_CHANNEL = "withmate:delete-session";
export const WITHMATE_LIST_CHARACTERS_CHANNEL = "withmate:list-characters";
export const WITHMATE_GET_CHARACTER_CHANNEL = "withmate:get-character";
export const WITHMATE_CREATE_CHARACTER_CHANNEL = "withmate:create-character";
export const WITHMATE_UPDATE_CHARACTER_CHANNEL = "withmate:update-character";
export const WITHMATE_DELETE_CHARACTER_CHANNEL = "withmate:delete-character";
export const WITHMATE_PICK_DIRECTORY_CHANNEL = "withmate:pick-directory";
export const WITHMATE_PICK_FILE_CHANNEL = "withmate:pick-file";
export const WITHMATE_PICK_IMAGE_FILE_CHANNEL = "withmate:pick-image-file";
export const WITHMATE_OPEN_PATH_CHANNEL = "withmate:open-path";
export const WITHMATE_OPEN_SESSION_TERMINAL_CHANNEL = "withmate:open-session-terminal";
export const WITHMATE_PREVIEW_COMPOSER_INPUT_CHANNEL = "withmate:preview-composer-input";
export const WITHMATE_SEARCH_WORKSPACE_FILES_CHANNEL = "withmate:search-workspace-files";
export const WITHMATE_LIST_SESSION_SKILLS_CHANNEL = "withmate:list-session-skills";
export const WITHMATE_LIST_SESSION_CUSTOM_AGENTS_CHANNEL = "withmate:list-session-custom-agents";
export const WITHMATE_RUN_SESSION_TURN_CHANNEL = "withmate:run-session-turn";
export const WITHMATE_CANCEL_SESSION_RUN_CHANNEL = "withmate:cancel-session-run";
export const WITHMATE_LIST_SESSION_AUDIT_LOGS_CHANNEL = "withmate:list-session-audit-logs";
export const WITHMATE_GET_APP_SETTINGS_CHANNEL = "withmate:get-app-settings";
export const WITHMATE_UPDATE_APP_SETTINGS_CHANNEL = "withmate:update-app-settings";
export const WITHMATE_RESET_APP_DATABASE_CHANNEL = "withmate:reset-app-database";
export const WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL = "withmate:get-live-session-run";
export const WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL = "withmate:resolve-live-approval";
export const WITHMATE_LIST_OPEN_SESSION_WINDOW_IDS_CHANNEL = "withmate:list-open-session-window-ids";
export const WITHMATE_SESSIONS_CHANGED_EVENT = "withmate:sessions-changed";
export const WITHMATE_CHARACTERS_CHANGED_EVENT = "withmate:characters-changed";
export const WITHMATE_MODEL_CATALOG_CHANGED_EVENT = "withmate:model-catalog-changed";
export const WITHMATE_APP_SETTINGS_CHANGED_EVENT = "withmate:app-settings-changed";
export const WITHMATE_LIVE_SESSION_RUN_EVENT = "withmate:live-session-run";
export const WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT = "withmate:open-session-windows-changed";

export type OpenPathOptions = {
  baseDirectory?: string | null;
};

export const ALL_RESET_APP_DATABASE_TARGETS = ["sessions", "auditLogs", "appSettings", "modelCatalog"] as const;

export type ResetAppDatabaseTarget = (typeof ALL_RESET_APP_DATABASE_TARGETS)[number];

export type ResetAppDatabaseRequest = {
  targets: ResetAppDatabaseTarget[];
};

export function normalizeResetAppDatabaseTargets(
  targets: readonly ResetAppDatabaseTarget[] | null | undefined,
): ResetAppDatabaseTarget[] {
  const selected = new Set<ResetAppDatabaseTarget>(targets ?? ALL_RESET_APP_DATABASE_TARGETS);
  if (selected.has("sessions")) {
    selected.add("auditLogs");
  }

  return ALL_RESET_APP_DATABASE_TARGETS.filter((target) => selected.has(target));
}

export function areAllResetAppDatabaseTargetsSelected(
  targets: readonly ResetAppDatabaseTarget[] | null | undefined,
): boolean {
  const normalized = normalizeResetAppDatabaseTargets(targets);
  return normalized.length === ALL_RESET_APP_DATABASE_TARGETS.length;
}

export type ResetAppDatabaseResult = {
  resetTargets: ResetAppDatabaseTarget[];
  sessions: Session[];
  appSettings: AppSettings;
  modelCatalog: ModelCatalogSnapshot;
};

export type WithMateWindowApi = {
  openSession(sessionId: string): Promise<void>;
  openCharacterEditor(characterId?: string | null): Promise<void>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<void>;
  listSessions(): Promise<Session[]>;
  getSession(sessionId: string): Promise<Session | null>;
  getModelCatalog(revision?: number | null): Promise<ModelCatalogSnapshot | null>;
  importModelCatalog(document: ModelCatalogDocument): Promise<ModelCatalogSnapshot>;
  exportModelCatalog(revision?: number | null): Promise<ModelCatalogDocument | null>;
  importModelCatalogFile(): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogFile(revision?: number | null): Promise<string | null>;
  getDiffPreview(token: string): Promise<DiffPreviewPayload | null>;
  createSession(input: CreateSessionInput): Promise<Session>;
  updateSession(session: Session): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  previewComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]>;
  listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]>;
  listSessionCustomAgents(sessionId: string): Promise<DiscoveredCustomAgent[]>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  cancelSessionRun(sessionId: string): Promise<void>;
  listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]>;
  getLiveSessionRun(sessionId: string): Promise<LiveSessionRunState | null>;
  resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): Promise<void>;
  listOpenSessionWindowIds(): Promise<string[]>;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
  resetAppDatabase(request: ResetAppDatabaseRequest): Promise<ResetAppDatabaseResult>;
  listCharacters(): Promise<CharacterProfile[]>;
  getCharacter(characterId: string): Promise<CharacterProfile | null>;
  createCharacter(input: CreateCharacterInput): Promise<CharacterProfile>;
  updateCharacter(character: CharacterProfile): Promise<CharacterProfile>;
  deleteCharacter(characterId: string): Promise<void>;
  pickDirectory(initialPath?: string | null): Promise<string | null>;
  pickFile(initialPath?: string | null): Promise<string | null>;
  pickImageFile(initialPath?: string | null): Promise<string | null>;
  openPath(target: string, options?: OpenPathOptions): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
  subscribeSessions(listener: (sessions: Session[]) => void): () => void;
  subscribeCharacters(listener: (characters: CharacterProfile[]) => void): () => void;
  subscribeModelCatalog(listener: (catalog: ModelCatalogSnapshot) => void): () => void;
  subscribeAppSettings(listener: (settings: AppSettings) => void): () => void;
  subscribeLiveSessionRun(listener: (sessionId: string, state: LiveSessionRunState | null) => void): () => void;
  subscribeOpenSessionWindowIds(listener: (sessionIds: string[]) => void): () => void;
};

