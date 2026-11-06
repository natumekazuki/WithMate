import type { CoordinationWindowApi } from "../../src-shared/coordination/coordination-window-contract.js";
import type { IpcRendererLike } from "./ipc.js";
import { subscribe } from "./ipc.js";

export function createCoordinationApi(
  ipc: IpcRendererLike,
): CoordinationWindowApi {
  return {
    getCoordinationIdentity: (identity) =>
      ipc.invoke("withmate:coordination:identity", identity),
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
          /* Navigation failures are reported by the explicit open request. */
        });
      return () => {
        live = false;
        unsubscribe();
      };
    },
  };
}
