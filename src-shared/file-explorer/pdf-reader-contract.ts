/** PDFビューアをアプリ内の別オリジンで配信するための独自スキーム。 */
export const PDF_READER_SCHEME = "withmate-pdf";
/** PDFフレームを読み込むオリジン。ホストとの通信でも照合に使う。 */
export const PDF_READER_ORIGIN = `${PDF_READER_SCHEME}://reader`;
/** PDFビューア用フレームの入口ページ。 */
export const PDF_READER_URL = `${PDF_READER_ORIGIN}/index.html`;
/** PDFフレームの通信を他のウィンドウメッセージから区別する値。 */
export const PDF_READER_CHANNEL = "withmate-pdf-reader";

/** ホストからPDFフレームへ引き継ぐ配色とスクロールバーのCSS変数。 */
export const PDF_READER_THEME_TOKENS = [
  "--surface",
  "--surface-strong",
  "--surface-deep",
  "--line",
  "--ink",
  "--muted",
  "--character-main",
  "--character-main-soft",
  "--character-sub",
  "--scrollbar-track",
  "--scrollbar-thumb",
] as const;

/** フレームへ渡すテーマ変数名と適用値の組。 */
export type PdfReaderThemeTokens = Record<string, string>;
/** 通信チャネルと表示インスタンスを照合し、前のフレームの通知と区別する。 */
type PdfReaderEnvelope = {
  channel: typeof PDF_READER_CHANNEL;
  instanceId: string;
};
/** ホストがフレームへ渡すPDFと設定、および検索・選択取得の指示。 */
export type PdfReaderHostMessage = PdfReaderEnvelope &
  (
    | {
        type: "load";
        bytes: ArrayBuffer;
        name: string;
        canQuote: boolean;
        zoomWheelStep: number | null;
        themeTokens: PdfReaderThemeTokens;
      }
    | { type: "theme"; themeTokens: PdfReaderThemeTokens }
    | { type: "settings"; zoomWheelStep: number | null }
    | { type: "find" }
    | { type: "get-selection"; requestId: string }
  );
/** フレームから返す準備・表示結果、選択範囲の本文、またはリンクの開き先。 */
export type PdfReaderFrameMessage = PdfReaderEnvelope &
  (
    | { type: "ready" | "loaded" }
    | { type: "error"; message: string }
    | { type: "selection"; text: string; requestId?: string }
    | { type: "open-link"; target: string }
  );

/** 現在の表示インスタンスと種類を照合し、返却テキストや要求IDの大きさを検証する。 */
export function isPdfReaderFrameMessage(
  value: unknown,
  instanceId: string,
): value is PdfReaderFrameMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (
    message.channel !== PDF_READER_CHANNEL ||
    message.instanceId !== instanceId
  )
    return false;
  switch (message.type) {
    case "ready":
    case "loaded":
      return true;
    case "error":
      return (
        typeof message.message === "string" && message.message.length <= 16_384
      );
    case "selection":
      return (
        typeof message.text === "string" &&
        message.text.length <= 1_000_000 &&
        (message.requestId === undefined ||
          (typeof message.requestId === "string" &&
            message.requestId.length > 0 &&
            message.requestId.length <= 128))
      );
    case "open-link":
      return (
        typeof message.target === "string" &&
        message.target.length > 0 &&
        message.target.length <= 16_384
      );
    default:
      return false;
  }
}
