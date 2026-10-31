import {
  detectSessionFileEncoding,
  isLikelyBinarySessionFile,
} from "../../src-shared/file-explorer/file-content-detection.js";
import {
  HTML_PREVIEW_MAX_BYTES,
  type SessionHtmlPreviewRequest,
  type SessionHtmlPreviewResult,
} from "../../src-shared/file-explorer/session-html-preview-contract.js";
import type { SessionFileExplorerService } from "./session-file-explorer-service.js";

const READ_CHUNK_BYTES = 1024 * 1024;

export async function readSessionHtmlPreview(
  explorer: Pick<SessionFileExplorerService, "resolvePreviewTarget" | "inspectFile" | "readFileChunk">,
  request: SessionHtmlPreviewRequest,
): Promise<SessionHtmlPreviewResult> {
  if (!request || typeof request.sessionId !== "string" || !request.sessionId
    || typeof request.target !== "string" || !request.target.trim()) {
    throw new TypeError("HTML preview request is invalid.");
  }
  const resolved = await explorer.resolvePreviewTarget(request.sessionId, request.target, request.baseResource);
  if (resolved.type !== "file") {
    throw new Error("message" in resolved ? resolved.message : "HTML preview requires a local HTML file.");
  }
  const descriptor = await explorer.inspectFile(resolved.resource);
  if (!/\.html?$/i.test(descriptor.name) || descriptor.kind !== "text") {
    throw new Error("HTML preview requires a text .html or .htm file.");
  }
  if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0
    || descriptor.byteLength > HTML_PREVIEW_MAX_BYTES) {
    throw new Error("HTML preview exceeds the 50 MiB size limit.");
  }
  const bytes = new Uint8Array(descriptor.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset);
    const chunk = await explorer.readFileChunk({
      ...resolved.resource,
      offset,
      length,
      expectedRevision: descriptor.revision,
    });
    if (chunk.offset !== offset || chunk.totalBytes !== bytes.byteLength
      || chunk.revision !== descriptor.revision || chunk.nextOffset <= offset
      || chunk.data.byteLength > length || chunk.nextOffset !== offset + chunk.data.byteLength
      || chunk.nextOffset > bytes.byteLength || chunk.done !== (chunk.nextOffset === bytes.byteLength)) {
      throw new Error("HTML contents changed while they were being read.");
    }
    bytes.set(new Uint8Array(chunk.data), offset);
    offset = chunk.nextOffset;
  }
  if (isLikelyBinarySessionFile(bytes)) {
    throw new Error("HTML preview requires a text .html or .htm file.");
  }
  return { html: new TextDecoder(detectSessionFileEncoding(bytes)).decode(bytes), fileName: descriptor.name };
}
