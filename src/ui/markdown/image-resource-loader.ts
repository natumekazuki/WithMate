import { useLayoutEffect, useMemo, useState } from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionImageResourceRequest } from "../../../src-shared/file-explorer/file-explorer-contract.js";
import { PreviewByteAccumulator, SESSION_FILE_READ_CHUNK_BYTES } from "../../file-explorer/file-preview-utils.js";
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
  const accumulators = new Set<PreviewByteAccumulator>();
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
      const accumulator = new PreviewByteAccumulator();
      accumulators.add(accumulator);
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
            || chunk.nextOffset !== offset + chunk.data.byteLength) {
            throw new Error("Image contents changed while they were being read.");
          }
          accumulator.append(new Uint8Array(chunk.data));
          offset = chunk.nextOffset;
          if (chunk.done) break;
        }
        const bytes = accumulator.finish(descriptor.byteLength);
        if (!isCurrent()) return null;
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        return URL.createObjectURL(new Blob([buffer], { type: descriptor.mimeType }));
      } finally {
        accumulators.delete(accumulator);
        accumulator.release();
      }
    });
  };
  return {
    resolve,
    invalidate() {
      queue.invalidate();
      for (const accumulator of accumulators) accumulator.release();
      accumulators.clear();
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
