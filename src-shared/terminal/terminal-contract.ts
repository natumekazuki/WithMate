/** node-ptyのWindows実装が符号付きSHORTを使うため、全プラットフォームの端末幅・高さを同じ上限に揃える。 */
export const TERMINAL_MAX_DIMENSION = 32_767;

/** 端末を識別するIDと、起動時の列数・行数。 */
export type CreateTerminalRequest = {
  terminalId: string;
  cols: number;
  rows: number;
};

/** 起動したシェルの表示名と、Windowsで利用できる場合のPTYビルド番号。 */
export type CreateTerminalResult = {
  shellName: string;
  windowsPty?: { buildNumber: number };
};

/** 端末IDに対応する出力・終了と、端末操作または端末自体のエラー通知。 */
export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string }
  | { type: "exit"; terminalId: string; exitCode: number; signal?: number }
  | { type: "operation-error"; terminalId: string; message: string }
  | { type: "error"; terminalId: string; message: string };
