import type { z } from "zod";
import type { ExecutionReadOperation, executionOperationRequestSchemas, executionOperationResultSchemas } from "./session-execution-read.js";

export type SessionExecutionReadResult<K extends ExecutionReadOperation> =
  | z.infer<(typeof executionOperationResultSchemas)[K]>
  | { ok: false; code: string; message: string; effect: "none" };

export type SessionExecutionWindowApi = {
  readSessionExecution<K extends ExecutionReadOperation>(ownerSessionId: string, operation: K,
    request: z.infer<(typeof executionOperationRequestSchemas)[K]>): Promise<SessionExecutionReadResult<K>>;
};
