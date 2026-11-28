import type { SessionFilePreviewResourceRequest } from "./file-explorer-contract.js";

/** HTMLプレビュー用に受け付けるファイルまたはUTF-8本文のサイズ上限。 */
export const HTML_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

/** 所有するSessionと対象リンク。相対参照に使う元のリソースも任意で指定する。 */
export type SessionHtmlPreviewRequest = {
  sessionId: string;
  target: string;
  baseResource?: SessionFilePreviewResourceRequest;
};

/** プレビューに渡す読み取り済みHTML本文と表示名に使うファイル名。 */
export type SessionHtmlPreviewResult = {
  html: string;
  fileName: string;
};
