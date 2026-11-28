import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import {
  WITHMATE_GET_SESSION_INSTRUCTIONS_CHANNEL,
  WITHMATE_SET_SESSION_INSTRUCTIONS_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";
import type { SessionInstructionsTarget } from "../../src-shared/session/session-instructions.js";
import { sessionTargetSchema } from "../../src-shared/session/session-target.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { IpcHandleRegistrar, MainIpcEventWindowDeps } from "./contracts.js";

/** Storage operations verify the exact saved identity and Auxiliary membership before accessing the body. */
export type SessionInstructionsServiceDeps = {
  getSessionInstructions(target: SessionInstructionsTarget): Awaitable<string>;
  setSessionInstructions(target: SessionInstructionsTarget, body: unknown): Awaitable<{ byteLength: number }>;
};

/** Session Window authorization and storage delegates for Instructions IPC. */
export type MainIpcSessionInstructionsDeps = MainIpcEventWindowDeps & SessionInstructionsServiceDeps & {
  /** Resolves only the Window registered for this exact Main Session incarnation. */
  resolveOwningSessionWindow(sessionId: string, incarnationId: string): BrowserWindow | null;
};

/** Registers private body reads and replacements for the owning Session Window's main frame. */
export function registerSessionInstructionsHandlers(ipc: IpcHandleRegistrar, deps: MainIpcSessionInstructionsDeps): void {
  /** Binds the request to the original frame as well as the actual owning Window. */
  const authorize = (event: IpcMainInvokeEvent, input: unknown) => {
    const target: SessionInstructionsTarget = sessionTargetSchema.parse(input);
    const ownerId = target.kind === "main" ? target.sessionId : target.mainSessionId;
    const ownerIncarnation = target.kind === "main" ? target.incarnationId : target.mainIncarnationId;
    const frame = event.senderFrame;
    const assertCurrent = () => {
      // Do not accept a subframe, an orphan sender, or another Window's target.
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
    // A pending read must not return private text to a replaced frame or Window.
    assertCurrent();
    return body;
  });
  ipc.handle(WITHMATE_SET_SESSION_INSTRUCTIONS_CHANNEL, (event, input: unknown, body: unknown) => {
    const { target } = authorize(event, input);
    return deps.setSessionInstructions(target, body);
  });
}
