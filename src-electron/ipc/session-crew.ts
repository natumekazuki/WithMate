import type { IpcHandleRegistrar } from "./contracts.js";
import type { CrewDeletionStatus } from "../../src-shared/session/session-crew-deletion.js";

/** Crew の削除状態を照会する IPC を登録する。空の識別子を拒否し、読み取り前と返却前の両方で所有元を確認する。 */
export function registerSessionCrewHandlers(
  ipc: IpcHandleRegistrar,
  deps: {
    /** 指定 Session を所有するウィンドウからの呼び出しでなければ拒否する。 */
    assertOwningSessionWindowSender(
      event: Electron.IpcMainInvokeEvent,
      sessionId: string,
    ): void;
    /** Session と incarnation の組に対する Crew 削除状態を取得する。 */
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
      /** 元のメインフレームと対象 Session の所有関係がまだ有効であることを確認する。 */
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
