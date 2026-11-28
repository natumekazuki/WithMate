import type { SessionFilePreviewResourceRequest } from "../file-explorer/file-explorer-contract.js";
import type { SessionHtmlPreviewRequest } from "../file-explorer/session-html-preview-contract.js";

/** プレビューの依存リソースを解決するときに使う、ファイル参照またはリンクの出所。 */
export type HtmlPreviewSource =
  | { kind: "resource"; resource: SessionFilePreviewResourceRequest }
  | { kind: "link"; request: SessionHtmlPreviewRequest };
/** 表示する HTML 本文、元の参照先、後続のイベントや解放処理で使うマウント ID。 */
export type HtmlPreviewMountRequest = {
  id: string;
  html: string;
  source: HtmlPreviewSource;
};
/** renderer がゲストを開く際に組で指定する、プレビュー URL と Electron の分離区画。 */
export type HtmlPreviewMountResult = { url: string; partition: string };
/** プレビュー側から利用者に提示する選択肢と、応答を対応させる要求 ID。 */
export type HtmlPreviewPrompt = {
  requestId: string;
  title: string;
  detail: string;
  choices: string[];
};
/** マウント ID ごとの表示状態・操作・確認要求を Main から通知する。確認要求が null の場合は表示を取り下げる。 */
export type HtmlPreviewEvent =
  | { id: string; type: "warning" | "error"; message: string }
  | { id: string; type: "ready" | "return-focus" | "find" }
  | { id: string; type: "prompt"; prompt: HtmlPreviewPrompt | null };

/** 隔離したゲストへプレビュー用の文書とリソースを配信する専用スキーム。 */
export const HTML_PREVIEW_SCHEME = "withmate-html-preview";
/** HTML 本文を隔離した表示先へ登録する IPC チャネル。 */
export const HTML_PREVIEW_MOUNT = "withmate:html-preview:mount";
/** 使い終えたプレビューをマウント ID で解放する IPC チャネル。 */
export const HTML_PREVIEW_DISPOSE = "withmate:html-preview:dispose";
/** Main からホスト renderer へマウントごとの状態や操作を通知する IPC チャネル。 */
export const HTML_PREVIEW_EVENT = "withmate:html-preview:event";
/** ホスト renderer から保留中の確認要求へ回答する IPC チャネル。 */
export const HTML_PREVIEW_RESPOND = "withmate:html-preview:respond";
/** セッション内のリンクで参照した HTML 本文を取得する IPC チャネル。 */
export const READ_SESSION_HTML_PREVIEW = "withmate:session:read-html-preview";

/** preload がホスト renderer に公開する、隔離 HTML プレビューの管理 API。 */
export type WithMateHtmlPreviewApi = {
  /** 本文を登録して、ゲストの作成に必要な URL と分離区画を取得する。 */
  mountHtmlPreview(
    request: HtmlPreviewMountRequest,
  ): Promise<HtmlPreviewMountResult>;
  /** 表示の終了時に、指定マウントを Main で解放する。 */
  disposeHtmlPreview(id: string): Promise<void>;
  /** マウントと確認要求を指定し、選択肢の番号またはキャンセルを表す null を返す。 */
  respondHtmlPreview(
    id: string,
    requestId: string,
    choice: number | null,
  ): Promise<void>;
  /** プレビューの状態や確認要求を購読し、購読解除の関数を返す。 */
  subscribeHtmlPreviewEvents(
    listener: (event: HtmlPreviewEvent) => void,
  ): () => void;
};
