import type { SessionExecutionWindowApi } from "../../src-shared/session/session-execution-window-contract.js";
import { WITHMATE_READ_SESSION_EXECUTION_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { IpcRendererLike } from "./ipc.js";

/** 保存済み実行情報を、Main 側で認可する読み取り専用の IPC に接続する。 */
export function createSessionExecutionApi(
  ipc: IpcRendererLike,
): SessionExecutionWindowApi {
  return {
    /** ウィンドウの所有 Session と、読み取り操作・対象を区別して Main へ渡す。 */
    readSessionExecution: (ownerSessionId, operation, request) =>
      ipc.invoke(
        WITHMATE_READ_SESSION_EXECUTION_CHANNEL,
        ownerSessionId,
        operation,
        request,
      ),
  };
}
