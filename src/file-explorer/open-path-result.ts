import type { OpenPathResult } from "../../src-shared/window/withmate-window-types.js";

/** パスを開けた場合は空文字列とし、それ以外は結果または例外から利用者向けの理由を得る。 */
export async function resolveOpenPathFeedback(
  operation: () => Promise<OpenPathResult>,
  fallbackMessage: string,
): Promise<string> {
  try {
    const result = await operation();
    return result.status === "opened" ? "" : result.message;
  } catch (error) {
    return error instanceof Error ? error.message : fallbackMessage;
  }
}

/** 開く操作から失敗の案内が返った場合だけ警告を表示する。 */
export function showOpenPathFeedback(message: string): void {
  if (message) {
    window.alert(message);
  }
}
