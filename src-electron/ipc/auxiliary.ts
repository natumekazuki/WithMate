import type { IpcMainInvokeEvent } from "electron";
import { toConversationView } from "../storage/conversation-query.js";
import type { RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";

import type {
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";

import {
  WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
  WITHMATE_LIST_OPEN_ACTIVE_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_LIST_OPEN_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
  WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL,
  WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL,
  WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL,
  WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL,
  WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL,
  WITHMATE_GET_AUXILIARY_CREATION_CHANNEL,
  WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_SET_AUXILIARY_EXECUTION_OPTIONS_CHANNEL,
  WITHMATE_SET_AUXILIARY_TITLE_CHANNEL,
  WITHMATE_SET_AUXILIARY_MESSAGE_BOOKMARK_CHANNEL,
  WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL,
  WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
  WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
  WITHMATE_STEER_AUXILIARY_SESSION_TURN_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

import type {
  MainIpcEventWindowDeps,
  IpcHandleRegistrar,
  MainIpcAuxiliaryDeps,
  MainIpcAuxiliaryDepsRequired,
  MainIpcSessionWindowDeps,
} from "./contracts.js";
import {
  resolveAuxiliaryOwnerWindowSender,
  assertAuxiliaryOwnerWindowSender,
  assertAuxiliaryCreateModeForOwner,
  getAuxiliarySessionForMutation,
} from "./shared.js";
import type {
  SetAuxiliaryExecutionOptionsRequest,
  SetAuxiliaryMessageBookmarkRequest,
  SetAuxiliaryTitleRequest,
} from "../../src-shared/session/session-mutation-contract.js";

export type MainIpcAuxiliaryServiceDeps = Omit<
  MainIpcAuxiliaryDeps,
  keyof MainIpcEventWindowDeps | keyof MainIpcSessionWindowDeps
>;

export function createAuxiliaryIpcDeps(
  services: MainIpcAuxiliaryServiceDeps,
  context: MainIpcEventWindowDeps & MainIpcSessionWindowDeps,
): MainIpcAuxiliaryDeps {
  return { ...context, ...services };
}

export function registerAuxiliaryHandlers(
  ipcMain: IpcHandleRegistrar,
  deps: MainIpcAuxiliaryDeps,
): void {
  const getAuxiliaryDeps = (
    deps: MainIpcAuxiliaryDeps,
  ): MainIpcAuxiliaryDepsRequired => {
    if (
      !deps.listAuxiliarySessions ||
      !deps.listOpenActiveAuxiliarySessionSummaries ||
      !deps.listOpenAuxiliarySessionSummaries ||
      !deps.getActiveAuxiliarySession ||
      !deps.getAuxiliarySession ||
      !deps.createAuxiliarySession ||
      !deps.updateAuxiliarySession ||
      !deps.closeAuxiliarySession ||
      !deps.runAuxiliarySessionTurn ||
      !deps.cancelAuxiliarySessionRun ||
      !deps.getAuxiliaryDraft ||
      !deps.saveAuxiliaryDraft ||
      !deps.getAuxiliarySessionStatus
    ) {
      throw new Error(
        "Auxiliary session IPC is not wired. listAuxiliarySessions, listOpenActiveAuxiliarySessionSummaries, " +
          "listOpenAuxiliarySessionSummaries, " +
          "getActiveAuxiliarySession, getAuxiliarySession, createAuxiliarySession, updateAuxiliarySession, " +
          "closeAuxiliarySession, runAuxiliarySessionTurn, cancelAuxiliarySessionRun, " +
          "getAuxiliaryDraft, saveAuxiliaryDraft, and getAuxiliarySessionStatus are required.",
      );
    }

    return {
      listAuxiliarySessions: deps.listAuxiliarySessions,
      listOpenActiveAuxiliarySessionSummaries:
        deps.listOpenActiveAuxiliarySessionSummaries,
      listOpenAuxiliarySessionSummaries: deps.listOpenAuxiliarySessionSummaries,
      getActiveAuxiliarySession: deps.getActiveAuxiliarySession,
      getAuxiliarySession: deps.getAuxiliarySession,
      createAuxiliarySession: deps.createAuxiliarySession,
      updateAuxiliarySession: deps.updateAuxiliarySession,
      closeAuxiliarySession: deps.closeAuxiliarySession,
      runAuxiliarySessionTurn: deps.runAuxiliarySessionTurn,
      cancelAuxiliarySessionRun: deps.cancelAuxiliarySessionRun,
      getAuxiliaryDraft: deps.getAuxiliaryDraft,
      saveAuxiliaryDraft: deps.saveAuxiliaryDraft,
      getAuxiliarySessionStatus: deps.getAuxiliarySessionStatus,
    };
  };

  ipcMain.handle(
    WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
    (_event, parentSessionId: string) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      if (!parentSessionId) {
        return [];
      }
      return auxiliaryDeps.listAuxiliarySessions(parentSessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_LIST_OPEN_ACTIVE_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
    () => getAuxiliaryDeps(deps).listOpenActiveAuxiliarySessionSummaries(),
  );
  ipcMain.handle(WITHMATE_LIST_OPEN_AUXILIARY_SESSION_SUMMARIES_CHANNEL, () =>
    getAuxiliaryDeps(deps).listOpenAuxiliarySessionSummaries(),
  );
  ipcMain.handle(
    WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL,
    (event, parentSessionId: string) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      if (!parentSessionId) {
        return null;
      }
      assertAuxiliaryOwnerWindowSender(event, parentSessionId, deps);
      return Promise.resolve(auxiliaryDeps.getActiveAuxiliarySession(parentSessionId)).then((session) => session ? toConversationView(session) : null);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
    async (event, auxiliarySessionId: string) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      if (!auxiliarySessionId) {
        return null;
      }
      const status = await auxiliaryDeps.getAuxiliarySessionStatus(auxiliarySessionId);
      if (!status) return null;
      assertAuxiliaryOwnerWindowSender(event, status.parentSessionId, deps);
      return auxiliaryDeps.getAuxiliarySession(auxiliarySessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL,
    async (event, auxiliarySessionId: string) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      const status =
        await auxiliaryDeps.getAuxiliarySessionStatus(auxiliarySessionId);
      if (!status) return null;
      assertAuxiliaryOwnerWindowSender(event, status.parentSessionId, deps);
      return auxiliaryDeps.getAuxiliaryDraft(auxiliarySessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL,
    async (event, auxiliarySessionId: string) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      const status =
        await auxiliaryDeps.getAuxiliarySessionStatus(auxiliarySessionId);
      if (!status) return null;
      assertAuxiliaryOwnerWindowSender(event, status.parentSessionId, deps);
      return status;
    },
  );
  ipcMain.handle(
    WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL,
    async (
      event,
      input: import("../../src-shared/auxiliary/auxiliary-draft-contract.js").AuxiliaryDraftSaveInput,
    ) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      const status = await auxiliaryDeps.getAuxiliarySessionStatus(
        input.auxiliarySessionId,
      );
      if (!status || status.parentSessionId !== input.parentSessionId)
        return { outcome: "not-found" };
      assertAuxiliaryOwnerWindowSender(event, status.parentSessionId, deps);
      return auxiliaryDeps.saveAuxiliaryDraft(input);
    },
  );
  ipcMain.handle(
    WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
    (event, input: CreateAuxiliarySessionInput) => {
      const ownerWindowKind = resolveAuxiliaryOwnerWindowSender(
        event,
        input.parentSessionId,
        deps,
      );
      assertAuxiliaryCreateModeForOwner(ownerWindowKind, input);
      if (!input.clientRequestId?.trim() || !input.creationContext) {
        throw new Error(
          "Auxiliary Session creation requires clientRequestId and creationContext.",
        );
      }
      return getAuxiliaryDeps(deps).createAuxiliarySession(input);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL,
    (event, parentSessionId: string) => {
      assertAuxiliaryOwnerWindowSender(event, parentSessionId, deps);
      if (!deps.getAuxiliaryCreationContext) {
        throw new Error(
          "Auxiliary creation context dependency is not configured.",
        );
      }
      return deps.getAuxiliaryCreationContext(parentSessionId);
    },
  );
  ipcMain.handle(
    WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL,
    (
      event,
      request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
    ) => {
      assertAuxiliaryOwnerWindowSender(event, request.parentSessionId, deps);
      if (!deps.cancelAuxiliaryCreation) {
        throw new Error(
          "Auxiliary creation cancellation dependency is not configured.",
        );
      }
      return deps.cancelAuxiliaryCreation(request);
    },
  );
  ipcMain.handle(
    WITHMATE_GET_AUXILIARY_CREATION_CHANNEL,
    (
      event,
      request: import("../../src-shared/auxiliary/auxiliary-session-state.js").AuxiliaryCreationRequest,
    ) => {
      assertAuxiliaryOwnerWindowSender(event, request.parentSessionId, deps);
      if (!deps.getAuxiliaryCreation) {
        throw new Error(
          "Auxiliary creation query dependency is not configured.",
        );
      }
      return deps.getAuxiliaryCreation(request);
    },
  );
  ipcMain.handle(
    WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
    async (event, session: AuxiliarySession) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      const existingSession = await getAuxiliarySessionForMutation(
        auxiliaryDeps,
        session.id,
      );
      if (existingSession.parentSessionId !== session.parentSessionId) {
        throw new Error("Auxiliary Session parent mismatch.");
      }
      assertAuxiliaryOwnerWindowSender(
        event,
        existingSession.parentSessionId,
        deps,
      );
      return toConversationView(await auxiliaryDeps.updateAuxiliarySession(session));
    },
  );
  const assertAuxiliaryMutationOwner = async (
    event: IpcMainInvokeEvent,
    request: { auxiliarySessionId: string; parentSessionId: string; createdAt: string },
  ): Promise<void> => {
    const auxiliaryDeps = getAuxiliaryDeps(deps);
    const status = await auxiliaryDeps.getAuxiliarySessionStatus(
      request.auxiliarySessionId,
    );
    if (
      !status ||
      status.parentSessionId !== request.parentSessionId ||
      status.createdAt !== request.createdAt
    ) {
      throw new Error("The Auxiliary Session identity is stale or invalid.");
    }
    assertAuxiliaryOwnerWindowSender(event, status.parentSessionId, deps);
  };
  ipcMain.handle(
    WITHMATE_SET_AUXILIARY_EXECUTION_OPTIONS_CHANNEL,
    async (event, request: SetAuxiliaryExecutionOptionsRequest) => {
      if (!deps.setAuxiliaryExecutionOptions) {
        throw new Error("Auxiliary execution options mutation is not configured.");
      }
      await assertAuxiliaryMutationOwner(event, request);
      return deps.setAuxiliaryExecutionOptions(request);
    },
  );
  ipcMain.handle(
    WITHMATE_SET_AUXILIARY_TITLE_CHANNEL,
    async (event, request: SetAuxiliaryTitleRequest) => {
      if (!deps.setAuxiliaryTitle) {
        throw new Error("Auxiliary title mutation is not configured.");
      }
      await assertAuxiliaryMutationOwner(event, request);
      return deps.setAuxiliaryTitle(request);
    },
  );
  ipcMain.handle(
    WITHMATE_SET_AUXILIARY_MESSAGE_BOOKMARK_CHANNEL,
    async (event, request: SetAuxiliaryMessageBookmarkRequest) => {
      if (!deps.setAuxiliaryMessageBookmark) {
        throw new Error("Auxiliary bookmark mutation is not configured.");
      }
      await assertAuxiliaryMutationOwner(event, request);
      return deps.setAuxiliaryMessageBookmark(request);
    },
  );
  ipcMain.handle(
    WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL,
    async (event, auxiliarySessionId: string) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      const session = await getAuxiliarySessionForMutation(
        auxiliaryDeps,
        auxiliarySessionId,
      );
      assertAuxiliaryOwnerWindowSender(event, session.parentSessionId, deps);
      return toConversationView(await auxiliaryDeps.closeAuxiliarySession(auxiliarySessionId));
    },
  );
  ipcMain.handle(
    WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
    async (
      event,
      auxiliarySessionId: string,
      request: RunSessionTurnRequest,
    ) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      const session = await getAuxiliarySessionForMutation(
        auxiliaryDeps,
        auxiliarySessionId,
      );
      assertAuxiliaryOwnerWindowSender(event, session.parentSessionId, deps);
      return toConversationView(await auxiliaryDeps.runAuxiliarySessionTurn(auxiliarySessionId, request));
    },
  );
  ipcMain.handle(
    WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
    async (event, auxiliarySessionId: string) => {
      const auxiliaryDeps = getAuxiliaryDeps(deps);
      const session = await getAuxiliarySessionForMutation(
        auxiliaryDeps,
        auxiliarySessionId,
      );
      assertAuxiliaryOwnerWindowSender(event, session.parentSessionId, deps);
      return auxiliaryDeps.cancelAuxiliarySessionRun(auxiliarySessionId);
    },
  );
  ipcMain.handle(WITHMATE_STEER_AUXILIARY_SESSION_TURN_CHANNEL, async (event, auxiliarySessionId: string, request: import("../../src-shared/session/runtime-state.js").SteerSessionTurnRequest) => {
    const session = await getAuxiliarySessionForMutation(getAuxiliaryDeps(deps), auxiliarySessionId);
    assertAuxiliaryOwnerWindowSender(event, session.parentSessionId, deps);
    if (!deps.steerAuxiliarySessionTurn) throw new Error("Auxiliary input is unavailable.");
    return deps.steerAuxiliarySessionTurn(auxiliarySessionId, request);
  });
}
