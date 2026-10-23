export type HtmlPreviewRect = { x: number; y: number; width: number; height: number };
export type HtmlPreviewLayout = { bounds: HtmlPreviewRect; clip: HtmlPreviewRect; visible: boolean };
export type HtmlPreviewMountRequest = { id: string; html: string };
export type HtmlPreviewEvent =
  | { id: string; type: "warning" | "error"; message: string }
  | { id: string; type: "return-focus" | "find" };

export const HTML_PREVIEW_MOUNT = "withmate:html-preview:mount";
export const HTML_PREVIEW_LAYOUT = "withmate:html-preview:layout";
export const HTML_PREVIEW_DISPOSE = "withmate:html-preview:dispose";
export const HTML_PREVIEW_FOCUS = "withmate:html-preview:focus";
export const HTML_PREVIEW_EVENT = "withmate:html-preview:event";
export const READ_SESSION_HTML_PREVIEW = "withmate:session:read-html-preview";

export type WithMateHtmlPreviewApi = {
  mountHtmlPreview(request: HtmlPreviewMountRequest): Promise<void>;
  layoutHtmlPreview(id: string, layout: HtmlPreviewLayout): void;
  disposeHtmlPreview(id: string): Promise<void>;
  focusHtmlPreview(id: string): void;
  subscribeHtmlPreviewEvents(listener: (event: HtmlPreviewEvent) => void): () => void;
};
