import type { WithMateWindowAuxiliaryApi } from "../../src-shared/ipc/withmate-window-api.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

export function createAuxiliaryApi(
  ipcRenderer: IpcRendererLike,
): WithMateWindowAuxiliaryApi {
  return {
    listAuxiliarySessions(parentSessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_AUXILIARY_SESSIONS_CHANNEL,
        parentSessionId,
      );
    },
    listOpenActiveAuxiliarySessionSummaries() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_OPEN_ACTIVE_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
      );
    },
    listOpenAuxiliarySessionSummaries() {
      return ipcRenderer.invoke(
        channels.WITHMATE_LIST_OPEN_AUXILIARY_SESSION_SUMMARIES_CHANNEL,
      );
    },
    getActiveAuxiliarySession(parentSessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_ACTIVE_AUXILIARY_SESSION_CHANNEL,
        parentSessionId,
      );
    },
    getAuxiliarySession(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_SESSION_CHANNEL,
        auxiliarySessionId,
      );
    },
    getAuxiliaryDraft(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_DRAFT_CHANNEL,
        auxiliarySessionId,
      );
    },
    saveAuxiliaryDraft(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_SAVE_AUXILIARY_DRAFT_CHANNEL,
        input,
      );
    },
    getAuxiliarySessionStatus(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_SESSION_STATUS_CHANNEL,
        auxiliarySessionId,
      );
    },
    createAuxiliarySession(input) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CREATE_AUXILIARY_SESSION_CHANNEL,
        input,
      );
    },
    getAuxiliaryCreationContext(parentSessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_CREATION_CONTEXT_CHANNEL,
        parentSessionId,
      );
    },
    cancelAuxiliaryCreation(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_AUXILIARY_CREATION_CHANNEL,
        request,
      );
    },
    getAuxiliaryCreation(request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_GET_AUXILIARY_CREATION_CHANNEL,
        request,
      );
    },
    updateAuxiliarySession(session) {
      return ipcRenderer.invoke(
        channels.WITHMATE_UPDATE_AUXILIARY_SESSION_CHANNEL,
        session,
      );
    },
    closeAuxiliarySession(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CLOSE_AUXILIARY_SESSION_CHANNEL,
        auxiliarySessionId,
      );
    },
    runAuxiliarySessionTurn(auxiliarySessionId, request) {
      return ipcRenderer.invoke(
        channels.WITHMATE_RUN_AUXILIARY_SESSION_TURN_CHANNEL,
        auxiliarySessionId,
        request,
      );
    },
    cancelAuxiliarySessionRun(auxiliarySessionId) {
      return ipcRenderer.invoke(
        channels.WITHMATE_CANCEL_AUXILIARY_SESSION_RUN_CHANNEL,
        auxiliarySessionId,
      );
    },
  };
}
