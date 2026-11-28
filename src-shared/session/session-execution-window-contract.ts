import type { z } from "zod";
import type {
  ExecutionWindowReadOperation,
  executionWindowRequestSchemas,
  executionWindowResultSchemas,
} from "./session-execution-read.js";

/** 操作に対応した実行履歴、または作用がなかったことを示す読み取り失敗。 */
export type SessionExecutionReadResult<K extends ExecutionWindowReadOperation> =
  | z.infer<(typeof executionWindowResultSchemas)[K]>
  | { ok: false; code: string; message: string; effect: "none" };

/** 実行情報を表示するウィンドウへ公開する、操作別の読み取りAPI。 */
export type SessionExecutionWindowApi = {
  /** ウィンドウ所有Sessionと操作を指定し、操作に対応する型の入力と結果を受け渡す。 */
  readSessionExecution<K extends ExecutionWindowReadOperation>(
    ownerSessionId: string,
    operation: K,
    request: z.infer<(typeof executionWindowRequestSchemas)[K]>,
  ): Promise<SessionExecutionReadResult<K>>;
};
