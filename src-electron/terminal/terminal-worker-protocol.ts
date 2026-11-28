/** シェルが入力待ちか、処理中か、まだどちらとも判定できないかを表す状態。 */
export type TerminalActivity = "idle" | "busy" | "unknown";

/** Main から端末の子プロセスへ渡す起動、入出力制御、停止の要求。 */
export type TerminalWorkerCommand =
  | { type: "start"; file: string; cwd: string; cols: number; rows: number }
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" };

/** 端末の子プロセスから Main に返す起動・終了結果、端末出力、シェル状態の通知。 */
export type TerminalWorkerEvent =
  | { type: "started" }
  | { type: "activity"; activity: TerminalActivity }
  | { type: "data"; data: string }
  | { type: "terminal-exit"; exitCode: number; signal?: number }
  | { type: "failed"; message: string };
