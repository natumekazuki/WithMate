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
// claim = "共通画像loaderはchatとroot/absolute previewのcontextとroot外targetをMainへ送り、1MiB以下のchunkのbytesをsnapshotした画像を返す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "rendererがroot外targetを拒否する、contextを落とす、1MiBを超すrequestを送る、chunkの順序/bytesを失う、または返却後のbuffer変更を画像へ漏らす"
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
      const buffers: ArrayBuffer[] = [];
      const api: MarkdownImageApi = {
        async inspectSessionImage(request) { inspected.push(request); return descriptor; },
        async readSessionImageChunk(request) {
          reads.push(request);
          const result = chunk(request);
          buffers.push(result.data);
          return result;
        },
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
        for (const buffer of buffers) new Uint8Array(buffer).fill(9);
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
// kind = "contract"
// claim = "共通画像loaderは認可失敗と不整合chunkをrejectし、修正後の再取得では完全な現行画像を返す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling" }
// fault = "拒否されたpathや不完全/過剰なbytesを画像として返す、または失敗した取得が再試行を妨げる"
// observable = "resolverのreject、返却Blobのbytes、再試行時のinspect/read request"
// observation_boundary = "public-boundary"
// scope = "createMarkdownImageLoader failure and retry"
// lifecycle = "permanent"
// impact = "認可境界と画像revision整合性を維持し、失敗後のreloadで画像を回復できる"
// distinction = "Mainの実path認可testと異なりrendererがAPI失敗を伝播し、offset/総bytes/終了通知の実行時整合性と再試行を確認する"
// @end-test-value
test("共通画像loaderは認可とchunk整合性の失敗後も再取得できる", async () => {
  for (const fault of ["denied", "offset", "total", "short", "overflow", "empty"] as const) {
    let failed = true;
    let inspections = 0;
    const api: MarkdownImageApi = {
      async inspectSessionImage() {
        inspections += 1;
        if (failed && fault === "denied") throw new Error("Image path denied.");
        return descriptor;
      },
      async readSessionImageChunk(request) {
        const result = chunk(request);
        if (!failed) return result;
        if (fault === "offset") return { ...result, offset: 1 };
        if (fault === "total") return { ...result, totalBytes: 1 };
        if (fault === "short") return { ...result, done: true };
        if (fault === "overflow") {
          const data = new ArrayBuffer(descriptor.byteLength + 1);
          return { ...result, data, nextOffset: data.byteLength };
        }
        return { ...result, data: new ArrayBuffer(0), nextOffset: request.offset };
      },
    };
    const loader = createMarkdownImageLoader(api, { sessionId: "session-1" });
    await assert.rejects(loader.resolve("image.png"), fault === "denied" ? /denied/ : /changed while/);
    failed = false;
    const url = await loader.resolve("image.png");
    assert.ok(url);
    try {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      assert.equal(bytes.byteLength, descriptor.byteLength);
      assert.equal(bytes[0], 1);
      assert.equal(bytes.at(-1), 2);
      assert.equal(inspections, 2);
    } finally { URL.revokeObjectURL(url); loader.invalidate(); }
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
