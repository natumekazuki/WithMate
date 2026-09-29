export type CreateTerminalRequest = {
  terminalId: string;
  cols: number;
  rows: number;
};

export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number; signal?: number }
  | { type: "error"; terminalId: string; message: string };
