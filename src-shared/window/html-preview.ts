export type HtmlPreviewMountRequest = { id: string; html: string };
export type HtmlPreviewEvent =
  | { id: string; type: "warning" | "error"; message: string }
  | { id: string; type: "ready" | "return-focus" | "find" };

export const HTML_PREVIEW_SCHEME = "withmate-html-preview";
export const HTML_PREVIEW_MOUNT = "withmate:html-preview:mount";
export const HTML_PREVIEW_DISPOSE = "withmate:html-preview:dispose";
export const HTML_PREVIEW_EVENT = "withmate:html-preview:event";
export const READ_SESSION_HTML_PREVIEW = "withmate:session:read-html-preview";

export type WithMateHtmlPreviewApi = {
  mountHtmlPreview(request: HtmlPreviewMountRequest): Promise<string>;
  disposeHtmlPreview(id: string): Promise<void>;
  subscribeHtmlPreviewEvents(listener: (event: HtmlPreviewEvent) => void): () => void;
};
