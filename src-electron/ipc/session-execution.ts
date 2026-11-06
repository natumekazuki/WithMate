import { WITHMATE_READ_SESSION_EXECUTION_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { executionOperationRequestSchemas, executionOperationResultSchemas, type ExecutionReadInput, type ExecutionReadOperation } from "../../src-shared/session/session-execution-read.js";
import type { IpcHandleRegistrar, MainIpcEventWindowDeps, MainIpcSessionWindowDeps } from "./contracts.js";
import { assertOwningSessionWindowSender } from "./shared.js";
import { z } from "zod";

const readFailure = z.object({ ok: z.literal(false), code: z.string(), message: z.string(), effect: z.literal("none") });

export function registerSessionExecutionHandlers(ipc: IpcHandleRegistrar, deps: MainIpcEventWindowDeps & MainIpcSessionWindowDeps & {
  readExecution(input: ExecutionReadInput): Promise<unknown>;
}): void {
  ipc.handle(WITHMATE_READ_SESSION_EXECUTION_CHANNEL, async (event, ownerSessionId, operation, request) => {
    if (typeof ownerSessionId !== "string" || !ownerSessionId) throw new TypeError("Session Window owner is required.");
    const frame = event.senderFrame;
    const assertCurrent = () => {
      if (!frame || event.sender.isDestroyed() || event.sender.mainFrame !== frame) throw new Error("Saved execution reads require the owning main application frame.");
      assertOwningSessionWindowSender(event, ownerSessionId, deps);
    };
    assertCurrent();
    if (typeof operation !== "string" || !Object.hasOwn(executionOperationRequestSchemas, operation)) throw new TypeError("Invalid execution read operation.");
    const readOperation = operation as ExecutionReadOperation;
    const parsed = executionOperationRequestSchemas[readOperation].parse(request);
    // The common reader validates the saved target/incarnation and Auxiliary parent.
    // A GUI Session Window may read public saved information in any Crew.
    const result = await deps.readExecution({ target: parsed.target, operation: readOperation, request: parsed });
    assertCurrent();
    if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) return readFailure.parse(result);
    return executionOperationResultSchemas[readOperation].parse(result);
  });
}
