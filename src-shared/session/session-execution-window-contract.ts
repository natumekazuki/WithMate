import type { z } from "zod";
import type { ExecutionWindowReadOperation, executionWindowRequestSchemas, executionWindowResultSchemas } from "./session-execution-read.js";

export type SessionExecutionReadResult<K extends ExecutionWindowReadOperation> =
  | z.infer<(typeof executionWindowResultSchemas)[K]>
  | { ok: false; code: string; message: string; effect: "none" };

export type SessionExecutionWindowApi = {
  readSessionExecution<K extends ExecutionWindowReadOperation>(ownerSessionId: string, operation: K,
    request: z.infer<(typeof executionWindowRequestSchemas)[K]>): Promise<SessionExecutionReadResult<K>>;
};
