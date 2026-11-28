import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import {
  WITHMATE_GET_SESSION_INSTRUCTIONS_CHANNEL,
  WITHMATE_SET_SESSION_INSTRUCTIONS_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { SessionInstructionsTarget } from "../../src-shared/session/session-instructions.js";
import { sessionTargetSchema } from "../../src-shared/session/session-target.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { IpcHandleRegistrar, MainIpcEventWindowDeps } from "./contracts.js";

/** ストレージ操作は、本文にアクセスする前に保存済みの識別情報の完全一致と Auxiliary の所属を検証する。 */
export type SessionInstructionsServiceDeps = {
  getSessionInstructions(target: SessionInstructionsTarget): Awaitable<string>;
  setSessionInstructions(target: SessionInstructionsTarget, body: unknown): Awaitable<{ byteLength: number }>;
};

/** Instructions IPC で使う Session ウィンドウの認可とストレージの委譲先。 */
export type MainIpcSessionInstructionsDeps = MainIpcEventWindowDeps & SessionInstructionsServiceDeps & {
  /** この Main Session の正確な incarnation に対して登録されたウィンドウだけを解決する。 */
  resolveOwningSessionWindow(sessionId: string, incarnationId: string): BrowserWindow | null;
};

/** 所有する Session ウィンドウのメインフレームに、非公開の本文の読み取りと置き換えを登録する。 */
export function registerSessionInstructionsHandlers(ipc: IpcHandleRegistrar, deps: MainIpcSessionInstructionsDeps): void {
  /** 要求を実際の所有ウィンドウと、要求を送信した元のフレームの両方に結び付ける。 */
  const authorize = (event: IpcMainInvokeEvent, input: unknown) => {
    const target: SessionInstructionsTarget = sessionTargetSchema.parse(input);
    const ownerId = target.kind === "main" ? target.sessionId : target.mainSessionId;
    const ownerIncarnation = target.kind === "main" ? target.incarnationId : target.mainIncarnationId;
    const frame = event.senderFrame;
    const assertCurrent = () => {
      // サブフレーム、所有ウィンドウのない送信元、別ウィンドウの対象は受け付けない。
      const owner = deps.resolveOwningSessionWindow(ownerId, ownerIncarnation);
      if (!frame || event.sender.isDestroyed() || frame !== event.sender.mainFrame
        || !owner || owner.isDestroyed() || owner.webContents !== event.sender || deps.resolveEventWindow(event) !== owner) {
        throw new Error("Session Instructions require the owning Session Window's main frame.");
      }
    };
    assertCurrent();
    return { target, assertCurrent };
  };

  ipc.handle(WITHMATE_GET_SESSION_INSTRUCTIONS_CHANNEL, async (event, input: unknown) => {
    const { target, assertCurrent } = authorize(event, input);
    const body = await deps.getSessionInstructions(target);
    // 読み取り待ちの間にフレームやウィンドウが置き換わった場合、非公開の本文を返さない。
    assertCurrent();
    return body;
  });
  ipc.handle(WITHMATE_SET_SESSION_INSTRUCTIONS_CHANNEL, (event, input: unknown, body: unknown) => {
    const { target } = authorize(event, input);
    return deps.setSessionInstructions(target, body);
  });
}
