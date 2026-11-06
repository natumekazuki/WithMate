import { WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { SessionSummary } from "../../src-shared/session/session-state.js";
import type { IpcHandleRegistrar, MainIpcEventWindowDeps, MainIpcSessionWindowDeps } from "./contracts.js";
import { assertOwningSessionWindowSender } from "./shared.js";

export type MainIpcSessionRoleDeps = MainIpcEventWindowDeps & MainIpcSessionWindowDeps & {
  promoteSessionToOverallCoordinator(sessionId: string, incarnationId: string, assertCurrent: () => void): Promise<SessionSummary>;
};

export function registerSessionRoleHandlers(ipc: IpcHandleRegistrar, deps: MainIpcSessionRoleDeps): void {
  ipc.handle(WITHMATE_PROMOTE_SESSION_ROLE_CHANNEL, (event, sessionId: unknown, incarnationId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()
      || typeof incarnationId !== "string" || !incarnationId.trim()) {
      throw new Error("Session identity is required to change its Role.");
    }
    const frame = event.senderFrame;
    const assertCurrent = () => {
      if (!frame || event.sender.isDestroyed() || event.sender.mainFrame !== frame) {
        throw new Error("Session Role changes require the owning main application frame.");
      }
      assertOwningSessionWindowSender(event, sessionId, deps);
    };
    assertCurrent();
    return deps.promoteSessionToOverallCoordinator(sessionId, incarnationId, assertCurrent);
  });
}
