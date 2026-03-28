import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import type {
  AuditLogEntry,
  CharacterProfile,
  LiveApprovalDecision,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  RunSessionTurnRequest,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
} from "../src/app-state.js";
import type { CreateCharacterInput } from "../src/character-state.js";
import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill } from "../src/runtime-state.js";
import type { CreateSessionInput, DiffPreviewPayload, Session } from "../src/session-state.js";
import type { OpenPathOptions, ResetAppDatabaseRequest } from "../src/withmate-window.js";
import { createMainIpcRegistrationDeps } from "./main-ipc-deps.js";
import type { registerMainIpcHandlers } from "./main-ipc-registration.js";
import type { MainBootstrapService } from "./main-bootstrap-service.js";

type MaybeWindow = BrowserWindow | null | undefined;

type CreateMainBootstrapDepsArgs = {
  ipcMain: IpcMain;
  registerMainIpcHandlers: typeof registerMainIpcHandlers;
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  recoverInterruptedSessions(): void;
  refreshCharactersFromStorage(): Promise<void>;
  createHomeWindow(): Promise<BrowserWindow>;
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  resolveEventWindow(event: IpcMainInvokeEvent): MaybeWindow;
  resolveHomeWindow(): MaybeWindow;
  openSessionWindow(sessionId: string): Promise<BrowserWindow>;
  openSessionMonitorWindow(): Promise<BrowserWindow>;
  openSettingsWindow(): Promise<BrowserWindow>;
  openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow>;
  openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow>;
  listSessions(): Session[];
  listSessionAuditLogs(sessionId: string): AuditLogEntry[];
  listSessionSkills(sessionId: string): DiscoveredSkill[];
  listSessionCustomAgents(sessionId: string): DiscoveredCustomAgent[];
  listOpenSessionWindowIds(): string[];
  getAppSettings(): AppSettings;
  updateAppSettings(settings: AppSettings): AppSettings;
  resetAppDatabase(request: ResetAppDatabaseRequest | null | undefined): Promise<unknown>;
  listCharacters(): Promise<CharacterProfile[]>;
  getModelCatalog(revision: number | null): ModelCatalogSnapshot | null;
  importModelCatalogDocument(document: ModelCatalogDocument): ModelCatalogSnapshot;
  importModelCatalogFromFile(targetWindow?: MaybeWindow): Promise<ModelCatalogSnapshot | null>;
  exportModelCatalogDocument(revision: number | null): ModelCatalogDocument | null;
  exportModelCatalogToFile(revision: number | null, targetWindow?: MaybeWindow): Promise<string | null>;
  getSession(sessionId: string): Session | null;
  getDiffPreview(token: string): DiffPreviewPayload | null;
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  getProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  getSessionContextTelemetry(sessionId: string): SessionContextTelemetry | null;
  getSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
  ): SessionBackgroundActivityState | null;
  resolveLiveApproval(sessionId: string, requestId: string, decision: LiveApprovalDecision): void;
  getCharacter(characterId: string): Promise<CharacterProfile | null>;
  createSession(input: CreateSessionInput): Session;
  updateSession(session: Session): Session;
  deleteSession(sessionId: string): void;
  previewComposerInput(sessionId: string, userMessage: string): Promise<unknown>;
  searchWorkspaceFiles(sessionId: string, query: string): Promise<string[]>;
  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session>;
  cancelSessionRun(sessionId: string): void;
  createCharacter(input: CreateCharacterInput): Promise<CharacterProfile>;
  updateCharacter(character: CharacterProfile): Promise<CharacterProfile>;
  deleteCharacter(characterId: string): Promise<void>;
  pickDirectory(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  pickImageFile(targetWindow: MaybeWindow, initialPath: string | null): Promise<string | null>;
  openPathTarget(target: string, options?: OpenPathOptions): Promise<void>;
  openSessionTerminal(sessionId: string): Promise<void>;
};

export function createMainBootstrapDeps(
  args: CreateMainBootstrapDepsArgs,
): ConstructorParameters<typeof MainBootstrapService>[0] {
  return {
    initializePersistentStores: args.initializePersistentStores,
    recoverInterruptedSessions: args.recoverInterruptedSessions,
    refreshCharactersFromStorage: args.refreshCharactersFromStorage,
    registerIpcHandlers: () => {
      args.registerMainIpcHandlers(
        args.ipcMain,
        createMainIpcRegistrationDeps({
          resolveEventWindow: args.resolveEventWindow,
          resolveHomeWindow: args.resolveHomeWindow,
          openSessionWindow: args.openSessionWindow,
          openHomeWindow: args.createHomeWindow,
          openSessionMonitorWindow: args.openSessionMonitorWindow,
          openSettingsWindow: args.openSettingsWindow,
          openCharacterEditorWindow: args.openCharacterEditorWindow,
          openDiffWindow: args.openDiffWindow,
          listSessions: args.listSessions,
          listSessionAuditLogs: args.listSessionAuditLogs,
          listSessionSkills: args.listSessionSkills,
          listSessionCustomAgents: args.listSessionCustomAgents,
          listOpenSessionWindowIds: args.listOpenSessionWindowIds,
          getAppSettings: args.getAppSettings,
          updateAppSettings: args.updateAppSettings,
          resetAppDatabase: args.resetAppDatabase,
          listCharacters: args.listCharacters,
          getModelCatalog: args.getModelCatalog,
          importModelCatalogDocument: args.importModelCatalogDocument,
          importModelCatalogFromFile: args.importModelCatalogFromFile,
          exportModelCatalogDocument: args.exportModelCatalogDocument,
          exportModelCatalogToFile: args.exportModelCatalogToFile,
          getSession: args.getSession,
          getDiffPreview: args.getDiffPreview,
          getLiveSessionRun: args.getLiveSessionRun,
          getProviderQuotaTelemetry: args.getProviderQuotaTelemetry,
          getSessionContextTelemetry: args.getSessionContextTelemetry,
          getSessionBackgroundActivity: args.getSessionBackgroundActivity,
          resolveLiveApproval: args.resolveLiveApproval,
          getCharacter: args.getCharacter,
          createSession: args.createSession,
          updateSession: args.updateSession,
          deleteSession: args.deleteSession,
          previewComposerInput: args.previewComposerInput,
          searchWorkspaceFiles: args.searchWorkspaceFiles,
          runSessionTurn: args.runSessionTurn,
          cancelSessionRun: args.cancelSessionRun,
          createCharacter: args.createCharacter,
          updateCharacter: args.updateCharacter,
          deleteCharacter: args.deleteCharacter,
          pickDirectory: args.pickDirectory,
          pickFile: args.pickFile,
          pickImageFile: args.pickImageFile,
          openPathTarget: args.openPathTarget,
          openSessionTerminal: args.openSessionTerminal,
        }),
      );
    },
    createHomeWindow: async () => {
      await args.createHomeWindow();
    },
    broadcastModelCatalog: args.broadcastModelCatalog,
  };
}
