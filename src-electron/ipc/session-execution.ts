import { WITHMATE_READ_SESSION_EXECUTION_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";
import { executionWindowRequestSchemas, executionWindowResultSchemas, type ExecutionReadInput, type ExecutionWindowReadOperation } from "../../src-shared/session/session-execution-read.js";
import type { IpcHandleRegistrar, MainIpcEventWindowDeps, MainIpcSessionWindowDeps } from "./contracts.js";
import { assertOwningSessionWindowSender } from "./shared.js";
import { conversationThreadsResultSchema } from "../../src-shared/session/conversation-threads.js";
import { z } from "zod";

const readFailure = z.object({ ok: z.literal(false), code: z.string(), message: z.string(), effect: z.literal("none") });

export function registerSessionExecutionHandlers(ipc: IpcHandleRegistrar, deps: MainIpcEventWindowDeps & MainIpcSessionWindowDeps & {
  readExecution(input: ExecutionReadInput): Promise<unknown>;
  hasUnreadResult(sessionId: string): boolean;
}): void {
  ipc.handle(WITHMATE_READ_SESSION_EXECUTION_CHANNEL, async (event, ownerSessionId, operation, request) => {
    if (typeof ownerSessionId !== "string" || !ownerSessionId) throw new TypeError("Session Window owner is required.");
    const frame = event.senderFrame;
    const assertCurrent = () => {
      if (!frame || event.sender.isDestroyed() || event.sender.mainFrame !== frame) throw new Error("Saved execution reads require the owning main application frame.");
      assertOwningSessionWindowSender(event, ownerSessionId, deps);
    };
    assertCurrent();
    if (typeof operation !== "string" || !Object.hasOwn(executionWindowRequestSchemas, operation)) throw new TypeError("Invalid execution read operation.");
    const readOperation = operation as ExecutionWindowReadOperation;
    const parsed = executionWindowRequestSchemas[readOperation].parse(request);
    if (readOperation === "read_conversation_threads" && (parsed.target.kind !== "main" || parsed.target.sessionId !== ownerSessionId)) {
      throw new Error("Main conversation projection requires the owning Session.");
    }
    // 共通の読み取り処理は、保存された対象と incarnation、および Auxiliary の親を検証する。
    // GUI の Session ウィンドウは、どの Crew の公開保存情報でも読み取れる。
    const result = await deps.readExecution({ target: parsed.target, operation: readOperation, request: parsed });
    assertCurrent();
    if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) return readFailure.parse(result);
    if (readOperation === "read_conversation_threads") {
      const projection = conversationThreadsResultSchema.parse(result);
      return { ...projection, children: projection.children.map((child) => ({
        ...child, hasUnreadResult: deps.hasUnreadResult(child.target.sessionId),
      })) };
    }
    return executionWindowResultSchemas[readOperation].parse(result);
  });
}
