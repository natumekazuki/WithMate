import type {
  IpcHandleRegistrar,
  MainIpcRegistrationDeps,
} from "./contracts.js";
import type { IpcMain } from "electron";

import { registerWindowHandlers } from "./window.js";
import { registerAuxiliaryHandlers } from "./auxiliary.js";
import { registerCatalogHandlers } from "./catalog.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerPromptTemplateHandlers } from "./prompt-template.js";
import { registerSessionQueryHandlers } from "./session-query.js";
import { registerSessionRuntimeHandlers } from "./session-runtime.js";
import { registerMateHandlers } from "./mate.js";
import { registerCharacterHandlers } from "./character.js";

import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";
import { normalizeSessionTurnCorrelation } from "../../src-shared/session/runtime-state.js";

import type { RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";

import {
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_RENDERER_LOG_CHANNEL,
  WITHMATE_SESSION_DRAFT_FLUSH_ACK_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

export function registerMainIpcHandlers(
  ipcMain: IpcMain,
  deps: MainIpcRegistrationDeps,
): void {
  const wrappedIpcMain = createErrorLoggingIpcMain(ipcMain, deps);
  registerWindowHandlers(wrappedIpcMain, {
    acknowledgeSessionDraftFlush: deps.acknowledgeSessionDraftFlush,
    resolveEventWindow: deps.resolveEventWindow,
    resolveHomeWindow: deps.resolveHomeWindow,
    resolveSessionWindow: deps.resolveSessionWindow,
    openSessionWindow: deps.openSessionWindow,
    getAuxiliarySession: deps.getAuxiliarySession,
    getAuxiliaryDraft: deps.getAuxiliaryDraft,
    saveAuxiliaryDraft: deps.saveAuxiliaryDraft,
    getAuxiliarySessionStatus: deps.getAuxiliarySessionStatus,
    showSessionMonitorContextMenu: deps.showSessionMonitorContextMenu,
    getSessionWindowRestoreSet: deps.getSessionWindowRestoreSet,
    restoreSessionWindows: deps.restoreSessionWindows,
    openHomeWindow: deps.openHomeWindow,
    openSessionMonitorWindow: deps.openSessionMonitorWindow,
    openSettingsWindow: deps.openSettingsWindow,
    openMemoryV6ReviewWindow: deps.openMemoryV6ReviewWindow,
    isSessionMonitorWindow: deps.isSessionMonitorWindow,
    openCharacterEditorWindow: deps.openCharacterEditorWindow,
    openDiffWindow: deps.openDiffWindow,
    isFilePreviewWindow: deps.isFilePreviewWindow,
    isFilePreviewTokenWindow: deps.isFilePreviewTokenWindow,
    openPathTarget: deps.openPathTarget,
    openAppLogFolder: deps.openAppLogFolder,
    openCrashDumpFolder: deps.openCrashDumpFolder,
    openSessionTerminal: deps.openSessionTerminal,
    openTerminalAtPath: deps.openTerminalAtPath,
    pickDirectory: deps.pickDirectory,
    validateWorkspaceDirectory: deps.validateWorkspaceDirectory,
    pickFile: deps.pickFile,
    pickFiles: deps.pickFiles,
    pickSessionFiles: deps.pickSessionFiles,
    pickSessionFolder: deps.pickSessionFolder,
    pickSessionImageFile: deps.pickSessionImageFile,
    pickImageFile: deps.pickImageFile,
    copyFilesToSessionFiles: deps.copyFilesToSessionFiles,
    savePastedSessionFile: deps.savePastedSessionFile,
    openSessionFilesDirectory: deps.openSessionFilesDirectory,
    openSessionFilesTerminal: deps.openSessionFilesTerminal,
  });
  registerAuxiliaryHandlers(wrappedIpcMain, {
    resolveEventWindow: deps.resolveEventWindow,
    resolveSessionWindow: deps.resolveSessionWindow,
    listAuxiliarySessions: deps.listAuxiliarySessions,
    listOpenActiveAuxiliarySessionSummaries:
      deps.listOpenActiveAuxiliarySessionSummaries,
    listOpenAuxiliarySessionSummaries: deps.listOpenAuxiliarySessionSummaries,
    getActiveAuxiliarySession: deps.getActiveAuxiliarySession,
    getAuxiliarySession: deps.getAuxiliarySession,
    getAuxiliaryDraft: deps.getAuxiliaryDraft,
    saveAuxiliaryDraft: deps.saveAuxiliaryDraft,
    getAuxiliarySessionStatus: deps.getAuxiliarySessionStatus,
    createAuxiliarySession: deps.createAuxiliarySession,
    getAuxiliaryCreationContext: deps.getAuxiliaryCreationContext,
    cancelAuxiliaryCreation: deps.cancelAuxiliaryCreation,
    getAuxiliaryCreation: deps.getAuxiliaryCreation,
    updateAuxiliarySession: deps.updateAuxiliarySession,
    closeAuxiliarySession: deps.closeAuxiliarySession,
    runAuxiliarySessionTurn: deps.runAuxiliarySessionTurn,
    cancelAuxiliarySessionRun: deps.cancelAuxiliarySessionRun,
  });
  registerCatalogHandlers(wrappedIpcMain, {
    resolveEventWindow: deps.resolveEventWindow,
    resolveHomeWindow: deps.resolveHomeWindow,
    getModelCatalog: deps.getModelCatalog,
    importModelCatalogDocument: deps.importModelCatalogDocument,
    importModelCatalogFromFile: deps.importModelCatalogFromFile,
    exportModelCatalogDocument: deps.exportModelCatalogDocument,
    exportModelCatalogToFile: deps.exportModelCatalogToFile,
  });
  registerSettingsHandlers(wrappedIpcMain, {
    resolveEventWindow: deps.resolveEventWindow,
    resolveHomeWindow: deps.resolveHomeWindow,
    isSettingsWindow: deps.isSettingsWindow,
    isMemoryV6ReviewWindow: deps.isMemoryV6ReviewWindow,
    getAppSettings: deps.getAppSettings,
    updateAppSettings: deps.updateAppSettings,
    updateChatLayoutPreference: deps.updateChatLayoutPreference,
    getAppDatabaseDiagnostics: deps.getAppDatabaseDiagnostics,
    getMemoryV6Diagnostics: deps.getMemoryV6Diagnostics,
    installMemoryV6CliShim: deps.installMemoryV6CliShim,
    uninstallMemoryV6CliShim: deps.uninstallMemoryV6CliShim,
    getMemoryV6FileUsage: deps.getMemoryV6FileUsage,
    exportMemoryV6EntryFiles: deps.exportMemoryV6EntryFiles,
    runMemoryV6ProtectedObjectGc: deps.runMemoryV6ProtectedObjectGc,
    searchMemoryV6Entries: deps.searchMemoryV6Entries,
    getMemoryV6Entry: deps.getMemoryV6Entry,
    forgetMemoryV6Entry: deps.forgetMemoryV6Entry,
    resetAppDatabase: deps.resetAppDatabase,
  });
  registerPromptTemplateHandlers(wrappedIpcMain, {
    listPromptTemplates: deps.listPromptTemplates,
    createPromptTemplate: deps.createPromptTemplate,
    updatePromptTemplate: deps.updatePromptTemplate,
    deletePromptTemplate: deps.deletePromptTemplate,
  });
  registerSessionQueryHandlers(wrappedIpcMain, {
    resolveEventWindow: deps.resolveEventWindow,
    resolveSessionWindow: deps.resolveSessionWindow,
    isFilePreviewWindow: deps.isFilePreviewWindow,
    getFilePreviewWindowResource: deps.getFilePreviewWindowResource,
    isFilePreviewTokenWindow: deps.isFilePreviewTokenWindow,
    listSessionSummaryPage: deps.listSessionSummaryPage,
    listSessionCharacterUsage: deps.listSessionCharacterUsage,
    listSessionAuditLogs: deps.listSessionAuditLogs,
    listSessionAuditLogSummaries: deps.listSessionAuditLogSummaries,
    listSessionAuditLogSummaryPage: deps.listSessionAuditLogSummaryPage,
    getSessionAuditLogDetail: deps.getSessionAuditLogDetail,
    getSessionAuditLogDetailSection: deps.getSessionAuditLogDetailSection,
    getSessionAuditLogOperationDetail: deps.getSessionAuditLogOperationDetail,
    listSessionSkills: deps.listSessionSkills,
    listSessionCustomAgents: deps.listSessionCustomAgents,
    listWorkspaceSkills: deps.listWorkspaceSkills,
    listWorkspaceCustomAgents: deps.listWorkspaceCustomAgents,
    listOpenSessionWindowIdsPage: deps.listOpenSessionWindowIdsPage,
    getSession: deps.getSession,
    getSessionGlossaryProjection: deps.getSessionGlossaryProjection,
    searchSessionGlossary: deps.searchSessionGlossary,
    ensureSessionGlossarySubscription: deps.ensureSessionGlossarySubscription,
    validateWorkspaceDirectory: deps.validateWorkspaceDirectory,
    getSessionFileExplorerOwnerSessionId:
      deps.getSessionFileExplorerOwnerSessionId,
    listSessionFileRoots: deps.listSessionFileRoots,
    listSessionDirectory: deps.listSessionDirectory,
    inspectSessionFile: deps.inspectSessionFile,
    readSessionFileChunk: deps.readSessionFileChunk,
    openSessionFile: deps.openSessionFile,
    openSessionFilePreviewWindow: deps.openSessionFilePreviewWindow,
    getSessionFilePreviewWindowPayload: deps.getSessionFilePreviewWindowPayload,
    copySessionFilePreviewImage: deps.copySessionFilePreviewImage,
    showSessionFilePreviewImageContextMenu:
      deps.showSessionFilePreviewImageContextMenu,
    copySessionFileObject: deps.copySessionFileObject,
    showSessionFileObjectCopyContextMenu:
      deps.showSessionFileObjectCopyContextMenu,
    showSessionFileTreeContextMenu: deps.showSessionFileTreeContextMenu,
    showMarkdownLinkContextMenu: deps.showMarkdownLinkContextMenu,
    listFileRootChanges: deps.listFileRootChanges,
    listFileRootChangesRepositories: deps.listFileRootChangesRepositories,
    getFileRootDiff: deps.getFileRootDiff,
    listFileRootGitHistoryRepositories: deps.listFileRootGitHistoryRepositories,
    listFileRootGitHistoryCommits: deps.listFileRootGitHistoryCommits,
    getFileRootGitHistoryCommitDetail: deps.getFileRootGitHistoryCommitDetail,
    getFileRootGitHistoryComparison: deps.getFileRootGitHistoryComparison,
    getFileRootGitHistoryDiff: deps.getFileRootGitHistoryDiff,
    getSessionMessageArtifact: deps.getSessionMessageArtifact,
    getDiffPreview: deps.getDiffPreview,
    previewComposerInput: deps.previewComposerInput,
  });
  registerSessionRuntimeHandlers(wrappedIpcMain, {
    resolveEventWindow: deps.resolveEventWindow,
    resolveHomeWindow: deps.resolveHomeWindow,
    validateWorkspaceDirectory: deps.validateWorkspaceDirectory,
    resolveSessionWindow: deps.resolveSessionWindow,
    isSettingsWindow: deps.isSettingsWindow,
    getLiveSessionRun: deps.getLiveSessionRun,
    getProviderQuotaTelemetry: deps.getProviderQuotaTelemetry,
    getSessionContextTelemetry: deps.getSessionContextTelemetry,
    getSessionBackgroundActivity: deps.getSessionBackgroundActivity,
    resolveLiveApproval: deps.resolveLiveApproval,
    resolveLiveElicitation: deps.resolveLiveElicitation,
    createSession: deps.createSession,
    updateSession: deps.updateSession,
    setSessionPinned: deps.setSessionPinned,
    deleteSession: deps.deleteSession,
    deleteSessionsLastActiveBefore: deps.deleteSessionsLastActiveBefore,
    runSessionTurn: deps.runSessionTurn,
    cancelSessionRun: deps.cancelSessionRun,
  });
  registerMateHandlers(wrappedIpcMain, {
    getMateState: deps.getMateState,
    getMateProfile: deps.getMateProfile,
    createMate: deps.createMate,
    updateMate: deps.updateMate,
    setMateAvatar: deps.setMateAvatar,
    resetMate: deps.resetMate,
  });
  registerCharacterHandlers(wrappedIpcMain, {
    resolveEventWindow: deps.resolveEventWindow,
    resolveHomeWindow: deps.resolveHomeWindow,
    listCharacters: deps.listCharacters,
    getCharacter: deps.getCharacter,
    createCharacter: deps.createCharacter,
    updateCharacterMetadata: deps.updateCharacterMetadata,
    updateCharacterDefinition: deps.updateCharacterDefinition,
    archiveCharacter: deps.archiveCharacter,
    resolveLaunchCharacter: deps.resolveLaunchCharacter,
    startCharacterAuthoringSession: deps.startCharacterAuthoringSession,
  });
  ipcMain.on(
    WITHMATE_RENDERER_LOG_CHANNEL,
    (event, input: RendererLogInput) => {
      const windowId = deps.resolveEventWindow(event)?.id;
      deps.reportRendererLog?.(input, windowId);
    },
  );
  ipcMain.on(
    WITHMATE_SESSION_DRAFT_FLUSH_ACK_CHANNEL,
    (event, payload: { requestId: string; success: boolean }) => {
      deps.acknowledgeSessionDraftFlush(event, payload);
    },
  );
}

function createErrorLoggingIpcMain(
  ipcMain: IpcMain,
  deps: MainIpcRegistrationDeps,
): IpcHandleRegistrar {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, async (event, ...args) => {
        const startedAt = Date.now();
        try {
          return await handler(event, ...args);
        } catch (error) {
          const clientRequestId =
            channel === WITHMATE_RUN_SESSION_TURN_CHANNEL
              ? (normalizeSessionTurnCorrelation(
                  args[1] as RunSessionTurnRequest,
                ).clientRequestId ?? undefined)
              : undefined;
          deps.logIpcError?.({
            channel,
            durationMs: Date.now() - startedAt,
            error,
            clientRequestId,
          });
          throw error;
        }
      });
    },
  };
}
