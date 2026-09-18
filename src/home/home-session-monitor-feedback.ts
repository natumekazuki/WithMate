import type { WithMateWindowApi } from "../withmate-window-api.js";
import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../withmate-window-types.js";

export function buildSessionMonitorContextMenuFeedback(result: SessionMonitorContextMenuResult): string {
  return result.status === "failed" ? result.message : "";
}

type SessionMonitorContextMenuApi = Pick<WithMateWindowApi, "showSessionMonitorContextMenu">;

export function runSessionMonitorContextMenu(
  api: SessionMonitorContextMenuApi | null,
  request: SessionMonitorContextMenuRequest,
  setFeedback: (feedback: string) => void,
): void {
  if (!api) {
    return;
  }

  setFeedback("");
  void api.showSessionMonitorContextMenu(request)
    .then((result) => {
      setFeedback(buildSessionMonitorContextMenuFeedback(result));
    })
    .catch((error) => {
      console.error(error);
      setFeedback(error instanceof Error ? error.message : "Session Monitorの操作に失敗しました。");
    });
}
