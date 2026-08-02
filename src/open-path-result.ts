import type { OpenPathResult } from "./withmate-window-types.js";

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

export function showOpenPathFeedback(message: string): void {
  if (message) {
    window.alert(message);
  }
}
