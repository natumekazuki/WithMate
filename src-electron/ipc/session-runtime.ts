import type {
  LiveApprovalDecision,
  LiveElicitationResponse,
  RunSessionTurnRequest,
} from "../../src-shared/session/runtime-state.js";
import type { SessionBackgroundActivityKind } from "../../src-shared/memory/session-memory-state.js";

import type {
  CreateSessionRequest,
  Session,
  SetSessionPinnedRequest,
} from "../../src-shared/session/session-state.js";

import { parseCreateSessionRequest } from "../session/create-session-request.js";

import {
  WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
  WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
  WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
  WITHMATE_GET_SESSION_BACKGROUND_ACTIVITY_CHANNEL,
  WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
  WITHMATE_RESOLVE_LIVE_APPROVAL_CHANNEL,
  WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
  WITHMATE_SET_SESSION_PINNED_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import { type DeleteSessionsLastActiveBeforeRequest } from "../../src-shared/window/withmate-window-types.js";

import type {
  IpcHandleRegistrar,
  MainIpcEventWindowDeps,
  MainIpcHomeWindowDeps,
  MainIpcSessionRuntimeDeps,
  MainIpcSessionWindowDeps,
  MainIpcSettingsWindowDeps,
  MainIpcWorkspaceValidationDeps,
} from "./contracts.js";
import {
  assertHomeWindowSender,
  assertSessionDeleteSender,
  assertSettingsWindowSender,
  assertUsableWorkspaceDirectory,
} from "./shared.js";

export type MainIpcSessionRuntimeServiceDeps = Omit<
  MainIpcSessionRuntimeDeps,
  keyof MainIpcEventWindowDeps | keyof MainIpcHomeWindowDeps |
    keyof MainIpcSessionWindowDeps | keyof MainIpcSettingsWindowDeps |
    keyof MainIpcWorkspaceValidationDeps
>;

export function createSessionRuntimeIpcDeps(
  services: MainIpcSessionRuntimeServiceDeps,
  context: MainIpcEventWindowDeps &
    MainIpcHomeWindowDeps &
    MainIpcSessionWindowDeps &
    MainIpcSettingsWindowDeps &
    MainIpcWorkspaceValidationDeps,
): MainIpcSessionRuntimeDeps {
  return { ...context, ...services };
}

export function registerSessionRuntimeHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcSessionRuntimeDeps,
): void {
  ipcMain.handle(
    WITHMATE_GET_LIVE_SESSION_RUN_CHANNEL,
    (_event, sessionId: string) => {
      if (!sessionId) {
        return null;
      }
      return deps.getLiveSessionRun(sessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_PROVIDER_QUOTA_TELEMETRY_CHANNEL,
    async (_event, providerId: string) => {
      if (!providerId) {
        return null;
      }
      return deps.getProviderQuotaTelemetry(providerId);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_SESSION_CONTEXT_TELEMETRY_CHANNEL,
    (_event, sessionId: string) => {
      if (!sessionId) {
        return null;
      }
      return deps.getSessionContextTelemetry(sessionId);
    },
  );
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
    (
      _event,
      sessionId: string,
      requestId: string,
      decision: LiveApprovalDecision,
    ) => {
      deps.resolveLiveApproval(sessionId, requestId, decision);
    },
  );
  ipcMain.handle(
    WITHMATE_RESOLVE_LIVE_ELICITATION_CHANNEL,
    (
      _event,
      sessionId: string,
      requestId: string,
      response: LiveElicitationResponse,
    ) => {
      deps.resolveLiveElicitation(sessionId, requestId, response);
    },
  );
  ipcMain.handle(
    WITHMATE_CREATE_SESSION_CHANNEL,
    async (event, input: CreateSessionRequest) => {
      assertHomeWindowSender(event, deps);
      const { workspace } = parseCreateSessionRequest(input);
      if (workspace.kind === "directory") {
        await assertUsableWorkspaceDirectory(workspace.path, deps);
      }
      return deps.createSession(input);
    },
  );
  ipcMain.handle(WITHMATE_UPDATE_SESSION_CHANNEL, (_event, session: Session) =>
    deps.updateSession(session),
  );
  ipcMain.handle(
    WITHMATE_SET_SESSION_PINNED_CHANNEL,
    (_event, request: SetSessionPinnedRequest) =>
      deps.setSessionPinned(request),
  );
  ipcMain.handle(
    WITHMATE_DELETE_SESSION_CHANNEL,
    (event, sessionId: string) => {
      assertSessionDeleteSender(event, sessionId, deps);
      return deps.deleteSession(sessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_DELETE_SESSIONS_LAST_ACTIVE_BEFORE_CHANNEL,
    (
      event,
      request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
    ) => {
      assertSettingsWindowSender(event, deps);
      return deps.deleteSessionsLastActiveBefore(request);
    },
  );
  ipcMain.handle(
    WITHMATE_RUN_SESSION_TURN_CHANNEL,
    async (_event, sessionId: string, request: RunSessionTurnRequest) =>
      deps.runSessionTurn(sessionId, request),
  );
  ipcMain.handle(
    WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
    (_event, sessionId: string) => {
      deps.cancelSessionRun(sessionId);
    },
  );
}
