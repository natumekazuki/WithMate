import type {
  SessionFilePreviewResourceRequest,
  SessionFileResourceRequest,
} from "./file-explorer-contract.js";

/** クリップボードへのコピー成功・対象外・失敗・作用不明を区別する。 */
export type SessionFileObjectCopyResult =
  | { status: "copied"; message: string }
  | { status: "not-copyable"; message: string }
  | { status: "failed"; message: string }
  | { status: "effect-unknown"; message: string };

/** ファイル自体のコピー元として解決する、識別済みのSessionリソース。 */
export type SessionFileObjectCopyRequest = {
  resource: SessionFileResourceRequest;
};

/** リンクからコピー元を探す入力。相対リンクには元のプレビューを渡せる。 */
export type SessionFileObjectCopyLinkRequest = {
  sessionId: string;
  target: string;
  baseResource?: SessionFilePreviewResourceRequest;
};

/** ファイル操作メニューを出す位置。 */
export type SessionFileObjectCopyPoint = {
  x: number;
  y: number;
};

/** コピー対象のリソースを固定し、コンテキストメニューを指定座標に出す入力。 */
export type SessionFileObjectCopyContextMenuRequest =
  SessionFileObjectCopyRequest & {
    point: SessionFileObjectCopyPoint;
  };

/** コピーの結果に加え、メニューを閉じて操作しなかった場合を表す。 */
export type SessionFileObjectCopyContextMenuResult =
  SessionFileObjectCopyResult | { status: "dismissed" };

/** コピー済みだけを成功表示とし、対象外や作用不明を含む残りはエラー表示にする。 */
export function getSessionFileObjectCopyFeedbackTone(
  result: SessionFileObjectCopyResult,
): "success" | "error" {
  return result.status === "copied" ? "success" : "error";
}
