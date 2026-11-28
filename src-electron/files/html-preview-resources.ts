import path from "node:path";
import {
  isSessionFileGitCommitResource,
  type SessionFilePreviewResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { SessionFileExplorerService } from "./session-file-explorer-service.js";
import type { FileRootGitChangesService } from "./file-root-git-changes-service.js";

/** プレビュー本文の URL パスと、同一参照元から関連ファイルを提供する読み取り口。 */
export type HtmlPreviewResources = {
  pathname: string;
  /** 指定パスの関連ファイルを、要求のメソッドとバイト範囲に応じて返す。 */
  read(pathname: string, request: Request): Promise<Response>;
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".txt": "text/plain",
  ".vtt": "text/vtt",
  ".pdf": "application/pdf",
};

/** URL パスをセグメントごとに復号し、階層移動や区切り文字を含むセグメントを拒否する。 */
function decodeAssetPath(pathname: string): string {
  if (!pathname.startsWith("/")) throw new Error("Invalid HTML resource path.");
  const segments = pathname
    .slice(1)
    .split("/")
    .map((segment) => decodeURIComponent(segment));
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\\/\u0000-\u001f:]/u.test(segment),
    )
  ) {
    throw new Error("Invalid HTML resource path.");
  }
  return segments.join("/");
}

/** ディレクトリ階層を保ったまま、ファイルパスの各セグメントを URL 用に符号化する。 */
function encodeAssetPath(relativePath: string): string {
  return `/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

/** 単一のバイト範囲を終端を含まない区間に変換し、不正または満たせない要求では null を返す。 */
function rangeFor(
  request: Request,
  size: number,
): { start: number; end: number; partial: boolean } | null {
  const range = request.headers.get("range");
  if (!range) return { start: 0, end: size, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size, Number(match[2]) + 1) : size;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end <= start
  )
    return null;
  return { start, end, partial: true };
}

/** 呼び出し元がこの参照元を認可し、読み取るたびにその所有者を再確認する。 */
export async function createHtmlPreviewResources(
  explorer: Pick<SessionFileExplorerService, "createHtmlPreviewResourceRoot">,
  git: Pick<
    FileRootGitChangesService,
    "readHtmlPreviewHistoryFile" | "resolveHistoryFilePreview"
  >,
  source: SessionFilePreviewResourceRequest,
): Promise<HtmlPreviewResources> {
  const local = isSessionFileGitCommitResource(source)
    ? null
    : await explorer.createHtmlPreviewResourceRoot(source);
  const sourcePath = isSessionFileGitCommitResource(source)
    ? source.relativePath.replaceAll("\\", "/")
    : local!.relativePath;
  let rootPath: string;
  if (isSessionFileGitCommitResource(source)) {
    rootPath = (await git.resolveHistoryFilePreview(source)).absoluteFilePath;
    for (const _segment of sourcePath.split("/"))
      rootPath = path.dirname(rootPath);
  } else {
    rootPath = local!.rootRealPath;
  }
  const volumeRoot = path.parse(rootPath).root;
  const pathname = encodeAssetPath(
    path
      .relative(volumeRoot, path.join(rootPath, ...sourcePath.split("/")))
      .split(path.sep)
      .join("/"),
  );
  decodeAssetPath(pathname);
  return {
    pathname,
    /** ファイルルートから外れない関連ファイルを、作業ツリーまたは選択コミットから読み取る。 */
    async read(assetPath, request) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405 });
      const absolutePath = path.join(
        volumeRoot,
        ...decodeAssetPath(assetPath).split("/"),
      );
      const relativePath = path
        .relative(rootPath, absolutePath)
        .split(path.sep)
        .join("/");
      if (
        !relativePath ||
        relativePath === ".." ||
        relativePath.startsWith("../") ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error("The HTML resource is outside the file root.");
      }
      const historical = isSessionFileGitCommitResource(source)
        ? await git.readHtmlPreviewHistoryFile({ ...source, relativePath })
        : null;
      const opened = local ? await local.open(relativePath) : null;
      const size = historical?.byteLength ?? opened!.byteLength;
      const range = rangeFor(request, size);
      if (!range) {
        await opened?.handle.close();
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      const headers = new Headers({
        "Content-Type":
          MIME_TYPES[path.posix.extname(relativePath).toLowerCase()] ??
          "application/octet-stream",
        "Content-Length": String(range.end - range.start),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      if (range.partial)
        headers.set(
          "Content-Range",
          `bytes ${range.start}-${range.end - 1}/${size}`,
        );
      const status = range.partial ? 206 : 200;
      if (request.method === "HEAD") {
        await opened?.handle.close();
        return new Response(null, { status, headers });
      }
      if (historical)
        return new Response(historical.slice(range.start, range.end).buffer, {
          status,
          headers,
        });
      const file = opened!;
      let offset = range.start;
      let closed = false;
      /** 読み取りの完了・失敗・取消のいずれからも、ファイルハンドルを一度だけ閉じる。 */
      const close = async () => {
        if (!closed) {
          closed = true;
          await file.handle.close();
        }
      };
      const body = new ReadableStream<Uint8Array>({
        /** 要求範囲を小分けで読み進め、途中で必要なデータを取得できなくなった場合はストリームを失敗させる。 */
        async pull(controller) {
          try {
            if (offset === range.end) {
              await close();
              controller.close();
              return;
            }
            const bytes = new Uint8Array(
              Math.min(64 * 1024, range.end - offset),
            );
            const { bytesRead } = await file.handle.read(
              bytes,
              0,
              bytes.byteLength,
              offset,
            );
            if (!bytesRead)
              throw new Error("HTML resource changed while being read.");
            offset += bytesRead;
            controller.enqueue(bytes.subarray(0, bytesRead));
          } catch (error) {
            await close();
            controller.error(error);
          }
        },
        cancel: close,
      });
      return new Response(body, { status, headers });
    },
  };
}
