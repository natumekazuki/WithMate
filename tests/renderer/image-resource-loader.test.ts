import assert from "node:assert/strict";
import test from "node:test";

import { createMarkdownImageLoader, type MarkdownImageApi } from "../../src/ui/markdown/image-resource-loader.js";
import type { SessionFileDescriptor, SessionImageResourceRequest, SessionImageChunkRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";

const MIB = 1024 * 1024;
const descriptor: SessionFileDescriptor = {
  sessionId: "session-1", absolutePath: "C:/outside/image.png", name: "image.png",
  kind: "image", byteLength: MIB + 3, mimeType: "image/png", revision: "image-r1",
  modifiedAt: "2026-10-03T00:00:00.000Z", suggestedEncoding: "utf-8",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function chunk(request: SessionImageChunkRequest) {
  const data = new Uint8Array(request.length).fill(request.offset === 0 ? 1 : 2).buffer;
  return {
    data, offset: request.offset, nextOffset: request.offset + request.length,
    totalBytes: descriptor.byteLength, done: request.offset + request.length === descriptor.byteLength,
    revision: request.expectedRevision,
  };
}

// @test-value v2
// kind = "contract"
// claim = "共通画像loaderはchatとroot/absolute previewのcontextとroot外targetをMainへ送り、1MiB以下のchunkを連結して画像を返す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "rendererがroot外targetを拒否する、contextを落とす、1MiBを超すrequestを送る、またはchunk連結で画像bytesを失う"
// observable = "画像APIへ渡るrequestと返されたblobのMIME/bytes"
// observation_boundary = "public-boundary"
// scope = "createMarkdownImageLoader local image resource"
// lifecycle = "permanent"
// impact = "chatとpreviewからroot外を含む画像を同じ読込制限で表示する"
// distinction = "Mainのpath解決testと異なりrenderer context伝達とchunkから表示resourceへの変換を確認する"
// @end-test-value
test("共通画像loaderはcontextを保持してroot外画像を1MiB chunkで読み込む", async () => {
  const contexts = [
    { sessionId: "session-1" },
    { sessionId: "session-1", baseResource: { sessionId: "session-1", rootId: "workspace", relativePath: "docs/readme.md" } },
    { sessionId: "session-1", baseResource: { sessionId: "session-1", absolutePath: "C:/notes/diagram.mmd" } },
  ];
  for (const context of contexts) {
    for (const target of ["../../outside/image.png", "C:/outside/image.png", "file:///C:/outside/image.png"]) {
      const inspected: SessionImageResourceRequest[] = [];
      const reads: SessionImageChunkRequest[] = [];
      const api: MarkdownImageApi = {
        async inspectSessionImage(request) { inspected.push(request); return descriptor; },
        async readSessionImageChunk(request) { reads.push(request); return chunk(request); },
      };
      const loader = createMarkdownImageLoader(api, context);
      const url = await loader.resolve(target);
      assert.ok(url);
      try {
        assert.deepEqual(inspected, [{ ...context, target }]);
        assert.deepEqual(reads, [
          { ...context, target, offset: 0, length: MIB, expectedRevision: descriptor.revision },
          { ...context, target, offset: MIB, length: 3, expectedRevision: descriptor.revision },
        ]);
        const response = await fetch(url);
        assert.equal(response.headers.get("content-type"), "image/png");
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.equal(bytes.byteLength, MIB + 3);
        assert.ok(bytes.subarray(0, MIB).every((value) => value === 1));
        assert.deepEqual([...bytes.subarray(MIB)], [2, 2, 2]);
      } finally { URL.revokeObjectURL(url); loader.invalidate(); }
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "共通画像loaderはlocal画像の同時読込を4件以内にし、invalidate後は待機画像を開始せず実行中画像も表示しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "5件以上の画像を同時にinspectする、または無効化後に旧世代を読込/表示する"
// observable = "保留中のinspect request数、chunk API呼出し数、各resolverの戻り値"
// observation_boundary = "public-boundary"
// scope = "createMarkdownImageLoader concurrency and generation"
// lifecycle = "permanent"
// impact = "大量の画像requestによる負荷を抑え対象切替後のstale resourceを防ぐ"
// distinction = "queue単体testとは異なり実際の画像inspectとread境界の制限を確認する"
// @end-test-value
test("共通画像loaderは同時4件で無効化時に待機と実行中の画像を停止する", async () => {
  const gates = Array.from({ length: 4 }, () => deferred<SessionFileDescriptor>());
  const inspected: string[] = [];
  let readCount = 0;
  const api: MarkdownImageApi = {
    inspectSessionImage(request) { inspected.push(request.target); return gates[inspected.length - 1].promise; },
    async readSessionImageChunk(request) { readCount += 1; return chunk(request); },
  };
  const loader = createMarkdownImageLoader(api, { sessionId: "session-1" });
  const resolutions = Array.from({ length: 6 }, (_, index) => loader.resolve(`image-${index}.png`));
  await Promise.resolve();
  assert.deepEqual(inspected, ["image-0.png", "image-1.png", "image-2.png", "image-3.png"]);
  loader.invalidate();
  for (const gate of gates) gate.resolve(descriptor);
  assert.deepEqual(await Promise.all(resolutions), Array(6).fill(null));
  assert.equal(readCount, 0);
  assert.equal(inspected.length, 4);
});

// @test-value v2
// kind = "invariant"
// claim = "共通画像loaderはAbortSignal取消またはchunk revision不一致を検出し、続きのchunkや画像resourceを生成しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "abort後のchunkを続ける、または変更されたrevisionの画像を混在させて返す"
// observable = "chunk読込数、resolverのnullまたはrevision error"
// observation_boundary = "public-boundary"
// scope = "createMarkdownImageLoader cancelled and changed bytes"
// lifecycle = "permanent"
// impact = "破棄した描画の無駄な読込と異なる世代の画像bytes混在を防ぐ"
// distinction = "型検査では実行中IPCから戻った後の取消とrevision照合を確認できない"
// @end-test-value
test("共通画像loaderはabortとrevision変更でchunk読込を止める", async () => {
  for (const outcome of ["abort", "changed"] as const) {
    const gate = deferred<ReturnType<typeof chunk>>();
    let reads = 0;
    const api: MarkdownImageApi = {
      async inspectSessionImage() { return descriptor; },
      readSessionImageChunk() { reads += 1; return gate.promise; },
    };
    const controller = new AbortController();
    const loader = createMarkdownImageLoader(api, { sessionId: "session-1" });
    const resolution = loader.resolve("image.png", controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reads, 1);
    if (outcome === "abort") controller.abort();
    gate.resolve({ ...chunk({ sessionId: "session-1", target: "image.png", offset: 0, length: MIB, expectedRevision: descriptor.revision }), revision: "changed" });
    if (outcome === "abort") assert.equal(await resolution, null);
    else await assert.rejects(resolution, /changed while/);
    assert.equal(reads, 1);
    loader.invalidate();
  }
});
