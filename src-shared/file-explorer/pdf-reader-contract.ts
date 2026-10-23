export const PDF_READER_SCHEME = "withmate-pdf";
export const PDF_READER_ORIGIN = `${PDF_READER_SCHEME}://reader`;
export const PDF_READER_URL = `${PDF_READER_ORIGIN}/index.html`;
export const PDF_READER_CHANNEL = "withmate-pdf-reader";

export const PDF_READER_THEME_TOKENS = [
  "--surface", "--surface-strong", "--surface-deep", "--line", "--ink", "--muted",
  "--character-main", "--character-main-soft", "--character-sub", "--scrollbar-track", "--scrollbar-thumb",
] as const;

export type PdfReaderThemeTokens = Record<string, string>;
type PdfReaderEnvelope = { channel: typeof PDF_READER_CHANNEL; instanceId: string };
export type PdfReaderHostMessage = PdfReaderEnvelope & (
  | { type: "load"; bytes: ArrayBuffer; name: string; canQuote: boolean; zoomWheelStep: number | null; themeTokens: PdfReaderThemeTokens }
  | { type: "theme"; themeTokens: PdfReaderThemeTokens }
  | { type: "settings"; zoomWheelStep: number | null }
  | { type: "find" }
);
export type PdfReaderFrameMessage = PdfReaderEnvelope & (
  | { type: "ready" | "loaded" }
  | { type: "error"; message: string }
  | { type: "selection"; text: string }
  | { type: "open-link"; target: string }
);

export function isPdfReaderFrameMessage(value: unknown, instanceId: string): value is PdfReaderFrameMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.channel !== PDF_READER_CHANNEL || message.instanceId !== instanceId) return false;
  switch (message.type) {
    case "ready":
    case "loaded": return true;
    case "error": return typeof message.message === "string" && message.message.length <= 16_384;
    case "selection": return typeof message.text === "string" && message.text.length <= 1_000_000;
    case "open-link": return typeof message.target === "string" && message.target.length > 0 && message.target.length <= 16_384;
    default: return false;
  }
}
