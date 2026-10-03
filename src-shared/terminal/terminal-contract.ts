// node-pty uses signed SHORT coordinates on Windows; use that range on all platforms.
export const TERMINAL_MAX_DIMENSION = 32_767;

export type CreateTerminalRequest = {
  terminalId: string;
  cols: number;
  rows: number;
};

export type CreateTerminalResult = {
  shellName: string;
  windowsPty?: { buildNumber: number };
};

export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number; signal?: number }
  | { type: "operation-error"; terminalId: string; message: string }
  | { type: "error"; terminalId: string; message: string };
