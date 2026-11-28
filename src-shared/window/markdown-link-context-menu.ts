import type {
  SessionFileObjectCopyLinkRequest,
  SessionFileObjectCopyResult,
} from "../file-explorer/session-file-object-copy-contract.js";

/** Markdownのリンク位置をメニューに渡すための座標。 */
export type MarkdownLinkContextMenuPoint = {
  x: number;
  y: number;
};

/** メニューに渡すリンクと座標。ファイルのコピーが可能な場合はその解決情報も持つ。 */
export type MarkdownLinkContextMenuRequest = {
  target: string;
  point: MarkdownLinkContextMenuPoint;
  fileContext?: Omit<SessionFileObjectCopyLinkRequest, "target">;
};

/** リンクのコピー、ファイルのコピー結果、取消、失敗を呼び出し元へ区別して返す。 */
export type MarkdownLinkContextMenuResult =
  | { status: "link-copied" }
  | { status: "file-copy"; result: SessionFileObjectCopyResult }
  | { status: "dismissed" }
  | { status: "failed"; message: string };
