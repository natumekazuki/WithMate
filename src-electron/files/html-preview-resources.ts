import path from "node:path";
import {
  isSessionFileGitCommitResource,
  type SessionFilePreviewResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { SessionFileExplorerService } from "./session-file-explorer-service.js";
import type { FileRootGitChangesService } from "./file-root-git-changes-service.js";

export type HtmlPreviewResources = {
  pathname: string;
  read(pathname: string, request: Request): Promise<Response>;
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".txt": "text/plain", ".vtt": "text/vtt", ".pdf": "application/pdf",
};

function decodeAssetPath(pathname: string): string {
  if (!pathname.startsWith("/")) throw new Error("Invalid HTML resource path.");
  const segments = pathname.slice(1).split("/").map((segment) => decodeURIComponent(segment));
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[\\/\u0000-\u001f:]/u.test(segment))) {
    throw new Error("Invalid HTML resource path.");
  }
  return segments.join("/");
}

function encodeAssetPath(relativePath: string): string {
  return `/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function rangeFor(request: Request, size: number): { start: number; end: number; partial: boolean } | null {
  const range = request.headers.get("range");
  if (!range) return { start: 0, end: size, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size, Number(match[2]) + 1) : size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end <= start) return null;
  return { start, end, partial: true };
}

/** The caller authorizes this source and rechecks its owner before every read. */
export async function createHtmlPreviewResources(
  explorer: Pick<SessionFileExplorerService, "createHtmlPreviewResourceRoot">,
  git: Pick<FileRootGitChangesService, "readHtmlPreviewHistoryFile">,
  source: SessionFilePreviewResourceRequest,
): Promise<HtmlPreviewResources> {
  const local = isSessionFileGitCommitResource(source) ? null : await explorer.createHtmlPreviewResourceRoot(source);
  const sourcePath = isSessionFileGitCommitResource(source) ? source.relativePath.replaceAll("\\", "/") : local!.relativePath;
  const pathname = encodeAssetPath(sourcePath);
  decodeAssetPath(pathname);
  return {
    pathname,
    async read(assetPath, request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const relativePath = decodeAssetPath(assetPath);
      const historical = isSessionFileGitCommitResource(source)
        ? await git.readHtmlPreviewHistoryFile({ ...source, relativePath }) : null;
      const opened = local ? await local.open(relativePath) : null;
      const size = historical?.byteLength ?? opened!.byteLength;
      const range = rangeFor(request, size);
      if (!range) {
        await opened?.handle.close();
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      const headers = new Headers({
        "Content-Type": MIME_TYPES[path.posix.extname(relativePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(range.end - range.start),
        "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      });
      if (range.partial) headers.set("Content-Range", `bytes ${range.start}-${range.end - 1}/${size}`);
      const status = range.partial ? 206 : 200;
      if (request.method === "HEAD") {
        await opened?.handle.close();
        return new Response(null, { status, headers });
      }
      if (historical) return new Response(historical.slice(range.start, range.end).buffer, { status, headers });
      const file = opened!;
      let offset = range.start;
      let closed = false;
      const close = async () => { if (!closed) { closed = true; await file.handle.close(); } };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (offset === range.end) { await close(); controller.close(); return; }
            const bytes = new Uint8Array(Math.min(64 * 1024, range.end - offset));
            const { bytesRead } = await file.handle.read(bytes, 0, bytes.byteLength, offset);
            if (!bytesRead) throw new Error("HTML resource changed while being read.");
            offset += bytesRead;
            controller.enqueue(bytes.subarray(0, bytesRead));
          } catch (error) { await close(); controller.error(error); }
        },
        cancel: close,
      });
      return new Response(body, { status, headers });
    },
  };
}
