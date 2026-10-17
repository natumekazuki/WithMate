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
import { SessionTurnQueuePreflightRejectedError } from "../app/main-session-turn-queue-facade.js";

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
  WITHMATE_STEER_SESSION_TURN_CHANNEL,
  WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL,
  WITHMATE_GET_SESSION_TURN_QUEUE_RECEIPT_CHANNEL,
  WITHMATE_LIST_SESSION_TURN_QUEUE_CHANNEL,
  WITHMATE_LIST_SESSION_TURN_QUEUE_RECEIPTS_CHANNEL,
  WITHMATE_CANCEL_QUEUED_SESSION_TURN_CHANNEL,
  WITHMATE_SEND_QUEUED_SESSION_INPUT_CHANNEL,
  WITHMATE_RELEASE_INTERRUPTED_SESSION_TURN_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
  WITHMATE_SET_SESSION_EXECUTION_OPTIONS_CHANNEL,
  WITHMATE_SET_SESSION_TITLE_CHANNEL,
  WITHMATE_SET_SESSION_MESSAGE_BOOKMARK_CHANNEL,
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
import type {
  SetSessionExecutionOptionsRequest,
  SetSessionMessageBookmarkRequest,
  SetSessionTitleRequest,
} from "../../src-shared/session/session-mutation-contract.js";
import {
  assertHomeWindowSender,
  assertOwningSessionWindowSender,
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
  const queue = () => {
    if (!deps.queue) throw new Error("The session turn queue is unavailable.");
    return deps.queue;
  };
  const assertQueueSender = async (event: import("electron").IpcMainInvokeEvent, sessionId: string) => {
    const auxiliary = await deps.getAuxiliarySessionStatus?.(sessionId);
    const parentId = auxiliary?.parentSessionId ?? sessionId;
    assertOwningSessionWindowSender(event, parentId, deps);
    return parentId;
  };
  ipcMain.handle(WITHMATE_ENQUEUE_SESSION_TURN_CHANNEL, async (event, sessionId: string, request: RunSessionTurnRequest & { incarnationId: string }) => {
    const parentId = await assertQueueSender(event, sessionId);
    assertOwningSessionWindowSender(event, parentId, deps);
    try {
      return await queue().enqueueSessionTurn(sessionId, request);
    } catch (error) {
      if (error instanceof SessionTurnQueuePreflightRejectedError) return { state: "rejected", reason: error.message };
      throw error;
    }
  });
  ipcMain.handle(WITHMATE_GET_SESSION_TURN_QUEUE_RECEIPT_CHANNEL, async (event, sessionId: string, requestId: string) => {
    const parentId = await assertQueueSender(event, sessionId);
    const receipt = await queue().getSessionTurnQueueReceipt(sessionId, requestId);
    assertOwningSessionWindowSender(event, parentId, deps);
    return receipt;
  });
  ipcMain.handle(WITHMATE_LIST_SESSION_TURN_QUEUE_CHANNEL, async (event, sessionId: string) => {
    const parentId = await assertQueueSender(event, sessionId);
    const receipts = await queue().listSessionTurnQueue(sessionId);
    assertOwningSessionWindowSender(event, parentId, deps);
    return receipts;
  });
  ipcMain.handle(WITHMATE_LIST_SESSION_TURN_QUEUE_RECEIPTS_CHANNEL, async (event, sessionId: string, options?: { cursor?: number; limit?: number }) => {
    const parentId = await assertQueueSender(event, sessionId);
    const page = await queue().listSessionTurnQueueReceipts(sessionId, options);
    assertOwningSessionWindowSender(event, parentId, deps);
    return page;
  });
  ipcMain.handle(WITHMATE_CANCEL_QUEUED_SESSION_TURN_CHANNEL, async (event, sessionId: string, id: string) => {
    await assertQueueSender(event, sessionId);
    return queue().cancelQueuedSessionTurn(sessionId, id);
  });
  ipcMain.handle(WITHMATE_RELEASE_INTERRUPTED_SESSION_TURN_CHANNEL, async (event, sessionId: string, id: string) => {
    await assertQueueSender(event, sessionId);
    return queue().releaseInterruptedSessionTurn(sessionId, id);
  });
  ipcMain.handle(WITHMATE_SEND_QUEUED_SESSION_INPUT_CHANNEL, async (event, sessionId: string, id: string, expectedTurnId: string) => {
    await assertQueueSender(event, sessionId);
    return queue().sendQueuedSessionInput(sessionId, id, expectedTurnId);
  });
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
    async (_event, providerId: string, options?: { cacheOnly?: boolean }) => {
      if (!providerId) {
        return null;
      }
      return deps.getProviderQuotaTelemetry(providerId, { cacheOnly: options?.cacheOnly === true });
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
    async (
      event,
      sessionId: string,
      requestId: string,
      response: LiveElicitationResponse,
    ) => {
      await assertQueueSender(event, sessionId);
      return deps.resolveLiveElicitation(sessionId, requestId, response);
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
    WITHMATE_SET_SESSION_EXECUTION_OPTIONS_CHANNEL,
    (event, request: SetSessionExecutionOptionsRequest) => {
      assertOwningSessionWindowSender(event, request.sessionId, deps);
      return deps.setSessionExecutionOptions(request);
    },
  );
  ipcMain.handle(
    WITHMATE_SET_SESSION_TITLE_CHANNEL,
    (event, request: SetSessionTitleRequest) => {
      assertOwningSessionWindowSender(event, request.sessionId, deps);
      return deps.setSessionTitle(request);
    },
  );
  ipcMain.handle(
    WITHMATE_SET_SESSION_MESSAGE_BOOKMARK_CHANNEL,
    (event, request: SetSessionMessageBookmarkRequest) => {
      assertOwningSessionWindowSender(event, request.sessionId, deps);
      return deps.setSessionMessageBookmark(request);
    },
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
    async (event, sessionId: string, request: RunSessionTurnRequest) => {
      assertOwningSessionWindowSender(event, sessionId, deps);
      return deps.runSessionTurn(sessionId, request);
    },
  );
  ipcMain.handle(
    WITHMATE_CANCEL_SESSION_RUN_CHANNEL,
    (_event, sessionId: string) => {
      deps.cancelSessionRun(sessionId);
    },
  );
  ipcMain.handle(WITHMATE_STEER_SESSION_TURN_CHANNEL, (event, sessionId: string, request: import("../../src-shared/session/runtime-state.js").SteerSessionTurnRequest) => {
    assertOwningSessionWindowSender(event, sessionId, deps);
    if (!deps.steerSessionTurn) throw new Error("Session input is unavailable.");
    return deps.steerSessionTurn(sessionId, request);
  });
}
