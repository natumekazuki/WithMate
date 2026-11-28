import type { CoordinationWindowApi } from "../../src-shared/coordination/coordination-window-contract.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

/** 相談表示・操作の IPC と、相談ウィンドウへのナビゲーション通知を renderer に接続する。 */
export function createCoordinationApi(
  ipc: IpcRendererLike,
): CoordinationWindowApi {
  return {
    /** 保存された相談主体の識別情報を、表示用情報に解決する。 */
    getCoordinationIdentity: (identity) =>
      ipc.invoke("withmate:coordination:identity", identity),
    /** 相談の状態と回答の有無を、回答本文を取得せず照会する。 */
    getCoordinationStatus: (request) =>
      ipc.invoke("withmate:coordination:status", request),
    /** GUI からの一覧・取得・変更要求を相談の受付へ渡す。 */
    executeCoordination: (request) =>
      ipc.invoke("withmate:coordination:execute", request),
    /** 確定した相談状態の変更を購読し、その登録の解除手段を返す。 */
    subscribeCoordinationChanged: (listener) =>
      subscribe(ipc, "withmate:coordination:changed", listener),
    /** 指定された相談を開くよう Main に要求する。 */
    openCoordination: (request) =>
      ipc.invoke("withmate:coordination:open", request),
    /** 到着したナビゲーションを受け取り確認を返す。通知が先着していなければ保留中の要求も読む。 */
    subscribeOpenCoordination: (listener) => {
      let live = true;
      let receivedEvent = false;
      const unsubscribe = subscribe<Parameters<typeof listener>>(
        ipc,
        "withmate:coordination:navigate",
        (request) => {
          receivedEvent = true;
          listener(request);
          void ipc
            .invoke("withmate:coordination:ack-navigation", request)
            .catch(() => {});
        },
      );
      void ipc
        .invoke("withmate:coordination:pending-navigation")
        .then((request) => {
          if (live && !receivedEvent && request) listener(request);
        })
        .catch(() => {
          /* 画面遷移の失敗は、明示的に開く要求の結果として報告される。 */
        });
      return () => {
        live = false;
        unsubscribe();
      };
    },
  };
}
