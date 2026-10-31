import type { SessionFilePreviewResourceRequest } from "../file-explorer/file-explorer-contract.js";
import type { SessionHtmlPreviewRequest } from "../file-explorer/session-html-preview-contract.js";

export type HtmlPreviewSource =
  | { kind: "resource"; resource: SessionFilePreviewResourceRequest }
  | { kind: "link"; request: SessionHtmlPreviewRequest };
export type HtmlPreviewMountRequest = { id: string; html: string; source: HtmlPreviewSource };
export type HtmlPreviewMountResult = { url: string; partition: string };
export type HtmlPreviewPrompt = { requestId: string; title: string; detail: string; choices: string[] };
export type HtmlPreviewEvent =
  | { id: string; type: "warning" | "error"; message: string }
  | { id: string; type: "ready" | "return-focus" | "find" }
  | { id: string; type: "prompt"; prompt: HtmlPreviewPrompt | null };

export const HTML_PREVIEW_SCHEME = "withmate-html-preview";
export const HTML_PREVIEW_MOUNT = "withmate:html-preview:mount";
export const HTML_PREVIEW_DISPOSE = "withmate:html-preview:dispose";
export const HTML_PREVIEW_EVENT = "withmate:html-preview:event";
export const HTML_PREVIEW_RESPOND = "withmate:html-preview:respond";
export const READ_SESSION_HTML_PREVIEW = "withmate:session:read-html-preview";

export type WithMateHtmlPreviewApi = {
  mountHtmlPreview(request: HtmlPreviewMountRequest): Promise<HtmlPreviewMountResult>;
  disposeHtmlPreview(id: string): Promise<void>;
  respondHtmlPreview(id: string, requestId: string, choice: number | null): Promise<void>;
  subscribeHtmlPreviewEvents(listener: (event: HtmlPreviewEvent) => void): () => void;
};
