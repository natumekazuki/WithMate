import type { HtmlPreviewLayout, HtmlPreviewMountRequest, HtmlPreviewRect } from "../../src-shared/window/html-preview.js";
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

function validRect(rect: HtmlPreviewRect): boolean {
  return !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width >= 0 && rect.height >= 0
    && [rect.x, rect.y, rect.width, rect.height].every((value) => Math.abs(value) <= 100_000);
}

export function clipHtmlPreviewLayout(layout: HtmlPreviewLayout, viewport: { width: number; height: number }): HtmlPreviewLayout {
  if (!layout || typeof layout.visible !== "boolean" || !validRect(layout.bounds) || !validRect(layout.clip)) {
    throw new TypeError("HTML preview layout is invalid.");
  }
  const bounds = {
    x: Math.round(layout.bounds.x), y: Math.round(layout.bounds.y),
    width: Math.round(layout.bounds.width), height: Math.round(layout.bounds.height),
  };
  const x = Math.max(0, Math.ceil(layout.clip.x), bounds.x);
  const y = Math.max(0, Math.ceil(layout.clip.y), bounds.y);
  const right = Math.min(viewport.width, Math.floor(layout.clip.x + layout.clip.width), bounds.x + bounds.width);
  const bottom = Math.min(viewport.height, Math.floor(layout.clip.y + layout.clip.height), bounds.y + bounds.height);
  const clip = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  return { bounds, clip, visible: layout.visible && clip.width > 0 && clip.height > 0 };
}
