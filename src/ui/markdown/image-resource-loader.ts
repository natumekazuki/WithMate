import { useLayoutEffect, useMemo, useState } from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionImageResourceRequest } from "../../../src-shared/file-explorer/file-explorer-contract.js";
import { SESSION_FILE_READ_CHUNK_BYTES } from "../../file-explorer/file-preview-utils.js";
import { PreviewResourceQueue } from "../../file-explorer/preview-resource-queue.js";
import { resolveMarkdownImageTarget } from "./image-resource-source.js";

/** 指定画像の表示用URLを返す。未対応や取消時はnullで、入力とは別に生成されたBlob URLは呼び出し側が解放する。 */
export type MarkdownImageResolver = (
  target: string,
  signal?: AbortSignal,
) => Promise<string | null>;
/** ローカル画像のメタデータ取得と同一リビジョンの分割読込に使うIPC境界。 */
export type MarkdownImageApi = Pick<
  WithMateWindowApi,
  "inspectSessionImage" | "readSessionImageChunk"
>;
/** 各画像のtargetと組み合わせてIPCへ渡すセッション文脈。 */
export type MarkdownImageContext = Omit<SessionImageResourceRequest, "target">;

/** 外部画像はURLを返し、ローカル画像はキューで同時読込を制限しつつ同一リビジョンの全バイトからBlob URLを作る。 */
export function createMarkdownImageLoader(
  api: MarkdownImageApi | null,
  context: MarkdownImageContext,
  queue = new PreviewResourceQueue(4),
) {
  const activeParts = new Set<ArrayBuffer[]>();
  /** 画像形式や分割データの整合性を確かめ、読み込み途中に無効になった要求にはURLを発行しない。 */
  const resolve: MarkdownImageResolver = async (target, signal) => {
    if (signal?.aborted) return null;
    const imageTarget = resolveMarkdownImageTarget(target);
    if (imageTarget.kind === "external") return imageTarget.source;
    if (imageTarget.kind === "unsupported" || !api) return null;
    const request = { ...context, target: imageTarget.target };
    return queue.run(async (isQueueCurrent) => {
      /** キュー世代と個別要求の両方が有効な間だけ、待機後の結果を使う。 */
      const isCurrent = () => isQueueCurrent() && !signal?.aborted;
      if (!isCurrent()) return null;
      const descriptor = await api.inspectSessionImage(request);
      if (!isCurrent()) return null;
      if (descriptor.kind !== "image" && descriptor.kind !== "svg") {
        throw new Error("The file is not a supported image.");
      }
      const parts: ArrayBuffer[] = [];
      /** 中断時や読込終了時に、この要求の分割バッファーへの参照を外す。 */
      const release = () => {
        parts.length = 0;
      };
      activeParts.add(parts);
      signal?.addEventListener("abort", release, { once: true });
      try {
        let offset = 0;
        while (offset < descriptor.byteLength) {
          const chunk = await api.readSessionImageChunk({
            ...request,
            offset,
            length: Math.min(
              SESSION_FILE_READ_CHUNK_BYTES,
              descriptor.byteLength - offset,
            ),
            expectedRevision: descriptor.revision,
          });
          if (!isCurrent()) return null;
          if (
            chunk.offset !== offset ||
            chunk.totalBytes !== descriptor.byteLength ||
            chunk.revision !== descriptor.revision ||
            chunk.nextOffset <= offset ||
            chunk.nextOffset !== offset + chunk.data.byteLength ||
            chunk.nextOffset > descriptor.byteLength
          ) {
            throw new Error(
              "Image contents changed while they were being read.",
            );
          }
          parts.push(chunk.data);
          offset = chunk.nextOffset;
          if (chunk.done) break;
        }
        if (offset !== descriptor.byteLength) {
          throw new Error("Image contents changed while they were being read.");
        }
        if (!isCurrent()) return null;
        // IPC は必要な範囲そのものの ArrayBuffer を渡す。Blob はそれらのバイト列を順に取り込むため、
        // 連結したバッファーや裏側のバッファーを参照するビューは不要。
        return URL.createObjectURL(
          new Blob(parts, { type: descriptor.mimeType }),
        );
      } finally {
        signal?.removeEventListener("abort", release);
        activeParts.delete(parts);
        release();
      }
    });
  };
  return {
    resolve,
    /** 待機中・実行中の要求を無効にし、集めた分割バッファーへの参照を直ちに外す。 */
    invalidate() {
      queue.invalidate();
      for (const parts of activeParts) parts.length = 0;
      activeParts.clear();
    },
  };
}

/** キューを再利用しながら、API・セッション文脈・リビジョンが切り替わると旧要求を無効にする。 */
export function useMarkdownImageResolver(
  api: MarkdownImageApi | null,
  context: MarkdownImageContext,
  revision: string | number = "",
): MarkdownImageResolver {
  const [queue] = useState(() => new PreviewResourceQueue(4));
  const loader = useMemo(
    () => createMarkdownImageLoader(api, context, queue),
    [api, context, revision, queue],
  );
  useLayoutEffect(() => () => loader.invalidate(), [loader]);
  return loader.resolve;
}
