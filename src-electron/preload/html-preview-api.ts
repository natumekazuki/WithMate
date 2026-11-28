import type { WithMateHtmlPreviewApi } from "../../src-shared/window/html-preview.js";
import {
  HTML_PREVIEW_DISPOSE,
  HTML_PREVIEW_EVENT,
  HTML_PREVIEW_MOUNT,
  HTML_PREVIEW_RESPOND,
} from "../../src-shared/window/html-preview.js";
import { subscribe, type IpcRendererLike } from "./ipc.js";

/** HTML プレビューの作成・解放と、ゲストから生じた確認要求の応答を Main へ接続する。 */
export function createHtmlPreviewApi(
  ipc: IpcRendererLike,
): WithMateHtmlPreviewApi {
  return {
    /** 指定ファイルの隔離プレビューを用意し、表示に必要な情報を取得する。 */
    mountHtmlPreview: (request) => ipc.invoke(HTML_PREVIEW_MOUNT, request),
    /** 指定したマウントと、それに紐付く保留中の処理の解放を要求する。 */
    disposeHtmlPreview: (id) => ipc.invoke(HTML_PREVIEW_DISPOSE, id),
    /** マウントと個別の確認要求を指定し、ユーザーの選択を Main に返す。 */
    respondHtmlPreview: (id, requestId, choice) =>
      ipc.invoke(HTML_PREVIEW_RESPOND, id, requestId, choice),
    /** HTML プレビューから通知される確認要求やイベントを購読する。 */
    subscribeHtmlPreviewEvents: (listener) =>
      subscribe(ipc, HTML_PREVIEW_EVENT, listener),
  };
}
