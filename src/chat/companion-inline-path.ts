import type { WithMateWindowApi } from "../withmate-window-api.js";

export function openCompanionInlinePath(
  api: WithMateWindowApi | null | undefined,
  target: string,
  worktreePath: string,
): void {
  void api?.openPath(target, { baseDirectory: worktreePath });
}
