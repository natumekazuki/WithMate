import type { SessionFilePreviewResourceRequest } from "./file-explorer-contract.js";

export const HTML_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

export type SessionHtmlPreviewRequest = {
  sessionId: string;
  target: string;
  baseResource?: SessionFilePreviewResourceRequest;
};

export type SessionHtmlPreviewResult = {
  html: string;
  fileName: string;
};
