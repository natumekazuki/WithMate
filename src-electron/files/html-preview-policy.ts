import type { HtmlPreviewMountRequest } from "../../src-shared/window/html-preview.js";
import { HTML_PREVIEW_MAX_BYTES } from "../../src-shared/file-explorer/session-html-preview-contract.js";

export function assertHtmlPreviewMount(request: HtmlPreviewMountRequest): void {
  if (!request || typeof request.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(request.id)
    || typeof request.html !== "string" || !request.source
    || (request.source.kind !== "resource" && request.source.kind !== "link")) {
    throw new TypeError("HTML preview request is invalid.");
  }
  if (Buffer.byteLength(request.html, "utf8") > HTML_PREVIEW_MAX_BYTES) {
    throw new Error("HTML Preview is limited to 50 MiB. Use Source to view this file.");
  }
}
