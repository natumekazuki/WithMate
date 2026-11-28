import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  SessionMonitorContextMenuRequest,
  SessionMonitorContextMenuResult,
} from "../../src-shared/window/withmate-window-types.js";

/** Monitor のメニュー操作で実行に失敗した場合だけ、結果の理由を表示する。 */
export function buildSessionMonitorContextMenuFeedback(
  result: SessionMonitorContextMenuResult,
): string {
  return result.status === "failed" ? result.message : "";
}

/** Monitor の対象と位置を指定してネイティブのメニューを開く API。 */
type SessionMonitorContextMenuApi = Pick<
  WithMateWindowApi,
  "showSessionMonitorContextMenu"
>;

/** メニューを開く前に以前の通知を消し、操作の失敗や呼び出しの例外を表示へ返す。 */
export function runSessionMonitorContextMenu(
  api: SessionMonitorContextMenuApi | null,
  request: SessionMonitorContextMenuRequest,
  setFeedback: (feedback: string) => void,
): void {
  if (!api) {
    return;
  }

  setFeedback("");
  void api
    .showSessionMonitorContextMenu(request)
    .then((result) => {
      setFeedback(buildSessionMonitorContextMenuFeedback(result));
    })
    .catch((error) => {
      console.error(error);
      setFeedback(
        error instanceof Error
          ? error.message
          : "Could not complete session monitor action.",
      );
    });
}
