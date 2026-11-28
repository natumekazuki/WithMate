// node-pty は Windows で符号付き SHORT の座標を使うため、全プラットフォームで同じ範囲を使う。
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
