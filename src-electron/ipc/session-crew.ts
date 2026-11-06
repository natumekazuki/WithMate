import type { IpcHandleRegistrar } from "./contracts.js";
import type { CrewDeletionStatus } from "../../src-shared/session/session-crew-deletion.js";

export function registerSessionCrewHandlers(
  ipc: IpcHandleRegistrar,
  deps: {
    assertOwningSessionWindowSender(
      event: Electron.IpcMainInvokeEvent,
      sessionId: string,
    ): void;
    getCrewDeletionStatus(
      sessionId: string,
      incarnationId: string,
    ): Promise<CrewDeletionStatus>;
  },
) {
  ipc.handle(
    "withmate:get-crew-deletion-status",
    async (event, sessionId, incarnationId) => {
      if (
        typeof sessionId !== "string" ||
        !sessionId ||
        typeof incarnationId !== "string" ||
        !incarnationId
      )
        throw new TypeError("Invalid Crew identity.");
      const frame = event.senderFrame;
      const assertCurrent = () => {
        if (
          !frame ||
          frame !== event.sender.mainFrame ||
          event.sender.isDestroyed()
        )
          throw new Error("Invalid Crew status sender.");
        deps.assertOwningSessionWindowSender(event, sessionId);
      };
      assertCurrent();
      const result = await deps.getCrewDeletionStatus(sessionId, incarnationId);
      assertCurrent();
      return result;
    },
  );
}
