export type TerminalWorkerCommand =
  | { type: "start"; file: string; cwd: string; cols: number; rows: number }
  | { type: "write"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" };

export type TerminalWorkerEvent =
  | { type: "started" }
  | { type: "data"; data: string }
  | { type: "terminal-exit"; exitCode: number; signal?: number }
  | { type: "failed"; message: string };
