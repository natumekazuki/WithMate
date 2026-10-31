import { useLayoutEffect, useMemo, useState } from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionImageResourceRequest } from "../../../src-shared/file-explorer/file-explorer-contract.js";
import { SESSION_FILE_READ_CHUNK_BYTES } from "../../file-explorer/file-preview-utils.js";
import { PreviewResourceQueue } from "../../file-explorer/preview-resource-queue.js";
import { resolveMarkdownImageTarget } from "./image-resource-source.js";

export type MarkdownImageResolver = (target: string, signal?: AbortSignal) => Promise<string | null>;
export type MarkdownImageApi = Pick<WithMateWindowApi, "inspectSessionImage" | "readSessionImageChunk">;
export type MarkdownImageContext = Omit<SessionImageResourceRequest, "target">;

export function createMarkdownImageLoader(
  api: MarkdownImageApi | null,
  context: MarkdownImageContext,
  queue = new PreviewResourceQueue(4),
) {
  const activeParts = new Set<ArrayBuffer[]>();
  const resolve: MarkdownImageResolver = async (target, signal) => {
    if (signal?.aborted) return null;
    const imageTarget = resolveMarkdownImageTarget(target);
    if (imageTarget.kind === "external") return imageTarget.source;
    if (imageTarget.kind === "unsupported" || !api) return null;
    const request = { ...context, target: imageTarget.target };
    return queue.run(async (isQueueCurrent) => {
      const isCurrent = () => isQueueCurrent() && !signal?.aborted;
      if (!isCurrent()) return null;
      const descriptor = await api.inspectSessionImage(request);
      if (!isCurrent()) return null;
      if (descriptor.kind !== "image" && descriptor.kind !== "svg") {
        throw new Error("The file is not a supported image.");
      }
      const parts: ArrayBuffer[] = [];
      const release = () => { parts.length = 0; };
      activeParts.add(parts);
      signal?.addEventListener("abort", release, { once: true });
      try {
        let offset = 0;
        while (offset < descriptor.byteLength) {
          const chunk = await api.readSessionImageChunk({
            ...request,
            offset,
            length: Math.min(SESSION_FILE_READ_CHUNK_BYTES, descriptor.byteLength - offset),
            expectedRevision: descriptor.revision,
          });
          if (!isCurrent()) return null;
          if (chunk.offset !== offset || chunk.totalBytes !== descriptor.byteLength
            || chunk.revision !== descriptor.revision || chunk.nextOffset <= offset
            || chunk.nextOffset !== offset + chunk.data.byteLength
            || chunk.nextOffset > descriptor.byteLength) {
            throw new Error("Image contents changed while they were being read.");
          }
          parts.push(chunk.data);
          offset = chunk.nextOffset;
          if (chunk.done) break;
        }
        if (offset !== descriptor.byteLength) {
          throw new Error("Image contents changed while they were being read.");
        }
        if (!isCurrent()) return null;
        // IPC supplies exact ArrayBuffers. Blob snapshots their bytes in order;
        // no concatenated buffer or backing-buffer view is needed.
        return URL.createObjectURL(new Blob(parts, { type: descriptor.mimeType }));
      } finally {
        signal?.removeEventListener("abort", release);
        activeParts.delete(parts);
        release();
      }
    });
  };
  return {
    resolve,
    invalidate() {
      queue.invalidate();
      for (const parts of activeParts) parts.length = 0;
      activeParts.clear();
    },
  };
}

export function useMarkdownImageResolver(
  api: MarkdownImageApi | null,
  context: MarkdownImageContext,
  revision: string | number = "",
): MarkdownImageResolver {
  const [queue] = useState(() => new PreviewResourceQueue(4));
  const loader = useMemo(() => createMarkdownImageLoader(api, context, queue), [api, context, revision, queue]);
  useLayoutEffect(() => () => loader.invalidate(), [loader]);
  return loader.resolve;
}
