import type { SessionGraphWindowApi } from "../../src-shared/session-graph/session-graph-window-contract.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";
export function createSessionGraphWindowApi(ipc: IpcRendererLike): SessionGraphWindowApi {
  return {
    openSessionGraphWindow: (request) => ipc.invoke(channels.WITHMATE_OPEN_SESSION_GRAPH_WINDOW_CHANNEL, request),
    getSessionGraphWindowPayload: (token) => ipc.invoke(channels.WITHMATE_GET_SESSION_GRAPH_WINDOW_PAYLOAD_CHANNEL, token),
    readSessionGraphWindow: (token, operation, request) => ipc.invoke(channels.WITHMATE_READ_SESSION_GRAPH_WINDOW_CHANNEL, token, operation, request),
    updateSessionGraphWindowState: (token, state) => ipc.invoke(channels.WITHMATE_UPDATE_SESSION_GRAPH_WINDOW_STATE_CHANNEL, token, state),
    openSessionGraphWindowReference: (token, target) => ipc.invoke(channels.WITHMATE_OPEN_SESSION_GRAPH_WINDOW_REFERENCE_CHANNEL, token, target),
  };
}
