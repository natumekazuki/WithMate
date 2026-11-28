import { z } from "zod";
import { mainSessionTargetSchema } from "../session/session-target.js";

/** 所有元 Session のメインフレームだけが、そのリポジトリの Pull Requests ウィンドウを開ける。 */
export const openLocalPrWindowInput = mainSessionTargetSchema;

/** 対象SessionのリポジトリでローカルPRウィンドウを開く要求チャネル。 */
export const LOCAL_PR_OPEN_WINDOW = "withmate:local-pr:open-window";
/** ローカルPRウィンドウが操作名と検証対象の引数を送るチャネル。 */
export const LOCAL_PR_EXECUTE = "withmate:local-pr:execute";
/** 対象のリポジトリでPRが変わり、一覧や詳細の再取得が必要なことを伝える通知。 */
export const LOCAL_PR_CHANGED = "withmate:local-pr:changed";
/** レビューコメントに添えるファイルをシステムの選択画面で指定するチャネル。 */
export const LOCAL_PR_PICK_ATTACHMENT = "withmate:local-pr:pick-attachment";
/** クリップボード由来の画像を添付として保存する要求チャネル。 */
export const LOCAL_PR_SAVE_CLIPBOARD_IMAGE =
  "withmate:local-pr:save-clipboard-image";
/** コメントの添付対象を開く要求チャネル。 */
export const LOCAL_PR_OPEN_ATTACHMENT = "withmate:local-pr:open-attachment";
/** 添付できる画像のMIME型に限り、バイナリ本体をArrayBufferで受け取る。 */
export const localPrClipboardImageInput = z.strictObject({
  mimeType: z.enum([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/svg+xml",
  ]),
  data: z.instanceof(ArrayBuffer),
});
/** 添付画像の取得前に形式・サイズ等の記述子を問い合わせるチャネル。 */
export const LOCAL_PR_INSPECT_IMAGE = "withmate:local-pr:inspect-image";
/** 調査時の版に対応する添付画像の一部を取得するチャネル。 */
export const LOCAL_PR_READ_IMAGE_CHUNK = "withmate:local-pr:read-image-chunk";

/** 画像添付を識別する空でない対象を受け取る。 */
export const localPrImageInput = z.strictObject({
  target: z.string().trim().min(1).max(32768),
});
/** 画像の対象に加え、取得するバイト範囲と、事前に照会した版を要求する。 */
export const localPrImageChunkInput = localPrImageInput.extend({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  expectedRevision: z.string(),
});
