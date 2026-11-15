import type { SessionExecutionWindowApi } from "../../src-shared/session/session-execution-window-contract.js";
import { WITHMATE_READ_SESSION_EXECUTION_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

export function createSessionExecutionApi(ipc: IpcRendererLike): SessionExecutionWindowApi {
  return { readSessionExecution: (ownerSessionId, operation, request) => ipc.invoke(WITHMATE_READ_SESSION_EXECUTION_CHANNEL, ownerSessionId, operation, request) };
}
