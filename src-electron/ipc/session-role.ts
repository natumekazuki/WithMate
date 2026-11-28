import { WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { SessionSummary } from "../../src-shared/session/session-state.js";
import type {
  IpcHandleRegistrar,
  MainIpcEventWindowDeps,
  MainIpcSessionWindowDeps,
} from "./contracts.js";
import { assertOwningSessionWindowSender } from "./shared.js";

/** 所有ウィンドウを照合し、指定した Session の Role 昇格を実行するための依存。 */
export type MainIpcSessionRoleDeps = MainIpcEventWindowDeps &
  MainIpcSessionWindowDeps & {
    /** 対象の incarnation を指定して全体統括へ昇格する。非同期処理中の所有失効を検出するための再検証を受け取る。 */
    promoteSessionToOverallCoordinator(
      sessionId: string,
      incarnationId: string,
      assertCurrent: () => void,
    ): Promise<SessionSummary>;
  };

/** Role 昇格 IPC を登録し、対象の識別子と要求元の所有を確認してから更新を委ねる。 */
export function registerSessionRoleHandlers(
  ipc: IpcHandleRegistrar,
  deps: MainIpcSessionRoleDeps,
): void {
  ipc.handle(
    WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL,
    (event, sessionId: unknown, incarnationId: unknown) => {
      if (
        typeof sessionId !== "string" ||
        !sessionId.trim() ||
        typeof incarnationId !== "string" ||
        !incarnationId.trim()
      ) {
        throw new Error("Session identity is required to change its Role.");
      }
      const frame = event.senderFrame;
      /** 元のメインフレームと Session の所有を再確認し、待機中に実行元が失われた更新を拒否する。 */
      const assertCurrent = () => {
        if (
          !frame ||
          event.sender.isDestroyed() ||
          event.sender.mainFrame !== frame
        ) {
          throw new Error(
            "Session Role changes require the owning main application frame.",
          );
        }
        assertOwningSessionWindowSender(event, sessionId, deps);
      };
      assertCurrent();
      return deps.promoteSessionToOverallCoordinator(
        sessionId,
        incarnationId,
        assertCurrent,
      );
    },
  );
}
