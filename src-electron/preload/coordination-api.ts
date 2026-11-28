import type { CoordinationWindowApi } from "../../src-shared/coordination/coordination-window-contract.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

export function createCoordinationApi(
  ipc: IpcRendererLike,
): CoordinationWindowApi {
  return {
    getCoordinationIdentity: (identity) =>
      ipc.invoke("withmate:coordination:identity", identity),
    getCoordinationStatus: (request) =>
      ipc.invoke("withmate:coordination:status", request),
    executeCoordination: (request) =>
      ipc.invoke("withmate:coordination:execute", request),
    subscribeCoordinationChanged: (listener) =>
      subscribe(ipc, "withmate:coordination:changed", listener),
    openCoordination: (request) =>
      ipc.invoke("withmate:coordination:open", request),
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
