import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { PDF_READER_SCHEME, PDF_READER_URL } from "../../src-shared/file-explorer/pdf-reader-contract.js";

export const PDF_READER_DOCUMENT_URL = PDF_READER_URL;

export function shouldBlockPdfReaderNavigation(details: { url: string; isMainFrame: boolean; frameUrl?: string; initiatorUrl?: string }): boolean {
  const isReaderUrl = (url: string | undefined) => url?.startsWith(`${PDF_READER_SCHEME}:`) ?? false;
  if (!isReaderUrl(details.url) && !isReaderUrl(details.frameUrl) && !isReaderUrl(details.initiatorUrl)) return false;
  return details.isMainFrame || details.url.split("#", 1)[0] !== PDF_READER_DOCUMENT_URL;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pfb": "application/octet-stream",
  ".bcmap": "application/octet-stream",
  ".icc": "application/octet-stream",
};

const readerCsp = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function servePdfReaderAsset(request: { url: string; method: string }, root: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  try {
    const url = new URL(request.url);
    if (url.protocol !== `${PDF_READER_SCHEME}:` || url.hostname !== "reader" || url.username || url.password || url.port || url.search) {
      return new Response(null, { status: 404 });
    }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.includes(":")) {
      return new Response(null, { status: 404 });
    }
    const target = path.resolve(root, `.${pathname}`);
    const contentType = contentTypes[path.extname(target).toLowerCase()];
    if (!isWithin(root, target) || !contentType) {
      return new Response(null, { status: 404 });
    }
    const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!isWithin(resolvedRoot, resolvedTarget) || !(await stat(resolvedTarget)).isFile()) {
      return new Response(null, { status: 404 });
    }
    const bytes = request.method === "HEAD" ? null : new Uint8Array(await readFile(resolvedTarget));
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Content-Security-Policy": readerCsp,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
