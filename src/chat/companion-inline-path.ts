import type { WithMateWindowApi } from "../withmate-window-api.js";
import { resolveOpenPathFeedback } from "../open-path-result.js";

export function openCompanionInlinePath(
  api: WithMateWindowApi | null | undefined,
  target: string,
  worktreePath: string,
): Promise<string> {
  if (!api) {
    return Promise.resolve("");
  }
  return resolveOpenPathFeedback(
    () => api.openPath(target, { baseDirectory: worktreePath }),
    "The path could not be opened.",
  );
}
