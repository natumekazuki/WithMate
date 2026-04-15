import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

import type {
  AuditLogEntry,
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
import type { MemoryManagementSnapshot } from "../src/memory-management-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../src/runtime-state.js";
import type { CreateSessionInput, DiffPreviewPayload, Session } from "../src/session-state.js";
import type { OpenPathOptions, ResetAppDatabaseRequest } from "../src/withmate-window-types.js";
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
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickImageFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  openPathTarget(target: string, options?: OpenPathOptions): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
};

export type MainIpcCatalogDepsArgs = {
  getModelCatalog(revision: number | null): ModelCatalogSnapshot | null;
  importModelCatalogDocument(document: ModelCatalogDocument): ModelCatalogSnapshot;
  importModelCatalogFromFile(targetWindow?: MaybeWindow): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogDocument(revision: number | null): ModelCatalogDocument | null;
  exportModelCatalogToFile(revision: number | null, targetWindow?: MaybeWindow): Promise<string | null>;
};

export type MainIpcSettingsDepsArgs = {
  getAppSettings(): AppSettings;
  updateAppSettings(settings: AppSettings): AppSettings;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
  getMemoryManagementSnapshot(): MemoryManagementSnapshot;
  deleteSessionMemory(sessionId: string): void;
  deleteProjectMemoryEntry(entryId: string): void;
  deleteCharacterMemoryEntry(entryId: string): void;
};

export type MainIpcSessionQueryDepsArgs = {
  listSessionSummaries(): SessionSummary[];
  listSessionAuditLogs(sessionId: string): AuditLogEntry[];
  listSessionSkills(sessionId: string): DiscoveredSkill[];
  listSessionCustomAgents(sessionId: string): DiscoveredCustomAgent[];
  listOpenSessionWindowIds(): string[];
  getSession(sessionId: string): Session | null;
  getDiffPreview(token: string): DiffPreviewPayload | null;
  previewComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]>;
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
  createSession(input: CreateSessionInput): Session;
  updateSession(session: Session): Session;
  deleteSession(sessionId: string): void;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  runSessionMemoryExtraction(sessionId: string): void;
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
    pickDirectory: args.window.pickDirectory,
    pickFile: args.window.pickFile,
    pickImageFile: args.window.pickImageFile,
    openPathTarget: args.window.openPathTarget,
    openSessionTerminal: args.window.openSessionTerminal,
    getModelCatalog: args.catalog.getModelCatalog,
    importModelCatalogDocument: args.catalog.importModelCatalogDocument,
    importModelCatalogFromFile: args.catalog.importModelCatalogFromFile,
    exportModelCatalogDocument: args.catalog.exportModelCatalogDocument,
    exportModelCatalogToFile: args.catalog.exportModelCatalogToFile,
    getAppSettings: args.settings.getAppSettings,
    updateAppSettings: args.settings.updateAppSettings,
    resetAppDatabase: args.settings.resetAppDatabase,
    getMemoryManagementSnapshot: args.settings.getMemoryManagementSnapshot,
    deleteSessionMemory: args.settings.deleteSessionMemory,
    deleteProjectMemoryEntry: args.settings.deleteProjectMemoryEntry,
    deleteCharacterMemoryEntry: args.settings.deleteCharacterMemoryEntry,
    listSessionSummaries: args.sessionQuery.listSessionSummaries,
    listSessionAuditLogs: args.sessionQuery.listSessionAuditLogs,
    listSessionSkills: args.sessionQuery.listSessionSkills,
    listSessionCustomAgents: args.sessionQuery.listSessionCustomAgents,
    listOpenSessionWindowIds: args.sessionQuery.listOpenSessionWindowIds,
    getSession: args.sessionQuery.getSession,
    getDiffPreview: args.sessionQuery.getDiffPreview,
    previewComposerInput: args.sessionQuery.previewComposerInput,
    searchWorkspaceFiles: args.sessionQuery.searchWorkspaceFiles,
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
    runSessionMemoryExtraction: args.sessionRuntime.runSessionMemoryExtraction,
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
