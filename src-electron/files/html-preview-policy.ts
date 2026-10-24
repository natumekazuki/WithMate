import type { HtmlPreviewMountRequest } from "../../src-shared/window/html-preview.js";
import { HTML_PREVIEW_MAX_BYTES } from "../../src-shared/file-explorer/session-html-preview-contract.js";

export const HTML_PREVIEW_CSP = [
  "sandbox allow-scripts", "default-src 'none'", "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:", "media-src data: blob:",
  "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join("; ");

export function assertHtmlPreviewMount(request: HtmlPreviewMountRequest): void {
  if (!request || typeof request.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(request.id)
    || typeof request.html !== "string") throw new TypeError("HTML preview request is invalid.");
  if (Buffer.byteLength(request.html, "utf8") > HTML_PREVIEW_MAX_BYTES) {
    throw new Error("HTML Preview is limited to 50 MiB. Use Source to view this file.");
  }
}
