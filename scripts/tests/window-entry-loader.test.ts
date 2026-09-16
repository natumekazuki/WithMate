import assert from "node:assert/strict";
import test from "node:test";

import { buildChatEntrySearch, WindowEntryLoader } from "../../src-electron/window-entry-loader.js";

function createWindowStub() {
  const calls: Array<{ kind: "url" | "file"; value: string; search?: string }> = [];
  return {
    window: {
      async loadURL(url: string) {
        calls.push({ kind: "url", value: url });
      },
      async loadFile(filePath: string, options?: { search?: string }) {
        calls.push({ kind: "file", value: filePath, search: options?.search });
      },
    },
    calls,
  };
}

test("WindowEntryLoader は dev server 使用時に loadURL する", async () => {
  const stub = createWindowStub();
  const loader = new WindowEntryLoader({
    devServerUrl: "http://localhost:5173",
    rendererDistPath: "F:/dist",
  });

  await loader.loadHomeEntry(stub.window, "settings");
  await loader.loadChatEntry(stub.window, { kind: "agent", sessionId: "session 1" });
  await loader.loadDiffEntry(stub.window, "diff#1");
  await loader.loadFilePreviewEntry(stub.window, "preview#1");
  await loader.loadBootEntry(stub.window);
  await loader.loadChatEntry(stub.window, { kind: "companion", sessionId: "companion 1" });
  await loader.loadCompanionMergeReviewEntry(stub.window, "companion 1");
  await loader.loadCharacterEditorEntry(stub.window, "char 1");
  await loader.loadCharacterEditorEntry(stub.window);

  assert.deepEqual(stub.calls, [
    { kind: "url", value: "http://localhost:5173?mode=settings" },
    { kind: "url", value: "http://localhost:5173/session.html?sessionId=session%201" },
    { kind: "url", value: "http://localhost:5173/diff.html?token=diff%231" },
    { kind: "url", value: "http://localhost:5173/file-preview.html?token=preview%231" },
    { kind: "url", value: "http://localhost:5173/boot.html" },
    { kind: "url", value: "http://localhost:5173/session.html?companionSessionId=companion%201&mode=companion" },
    { kind: "url", value: "http://localhost:5173/review.html?companionSessionId=companion%201&view=merge" },
    { kind: "url", value: "http://localhost:5173/character-editor.html?characterId=char%201" },
    { kind: "url", value: "http://localhost:5173/character-editor.html" },
  ]);
});

test("buildChatEntrySearch は chat mode ごとの session.html query を組み立てる", () => {
  assert.equal(buildChatEntrySearch({ kind: "agent", sessionId: "session 1" }), "?sessionId=session%201");
  assert.equal(
    buildChatEntrySearch({ kind: "companion", sessionId: "companion 1" }),
    "?companionSessionId=companion%201&mode=companion",
  );
});

// @test-value v2
// kind = "contract"
// claim = "既存Session WindowをAuxiliary対象で新規作成すると、dev/prodのsession.html load経路へ親Session IDとAuxiliary Session IDを渡す"
// oracle = { type = "contract", ref = "ChatEntryMode and session.html location contract" }
// fault = "Auxiliary通知から新規Windowを開いた時にdevまたはproductionのload経路で対象Auxiliaryのqueryを落とし、一覧先頭や保存済み選択へ誤って移動する"
// observable = "WindowEntryLoaderのloadURL/loadFileへ渡したsession.html URLまたはquery"
// observation_boundary = "public-boundary"
// scope = "window-entry-auxiliary-navigation"
// lifecycle = "permanent"
// distinction = "通常のchat mode query testとは分離し、通知起点のAuxiliary初期選択に必要なdev/prod共通queryを専用に検証する"
// @end-test-value
test("WindowEntryLoader はAuxiliary対象のagent queryをdev/prodで保持する", async () => {
  const devStub = createWindowStub();
  const devLoader = new WindowEntryLoader({
    devServerUrl: "http://localhost:5173",
    rendererDistPath: "F:/dist",
  });

  await devLoader.loadChatEntry(devStub.window, {
    kind: "agent",
    sessionId: "session 1",
    auxiliarySessionId: "auxiliary 1",
  });

  const productionStub = createWindowStub();
  const productionLoader = new WindowEntryLoader({
    devServerUrl: "",
    rendererDistPath: "F:/dist",
  });
  await productionLoader.loadChatEntry(productionStub.window, {
    kind: "agent",
    sessionId: "session 1",
    auxiliarySessionId: "auxiliary 1",
  });

  assert.deepEqual(devStub.calls, [{
    kind: "url",
    value: "http://localhost:5173/session.html?sessionId=session%201&auxiliarySessionId=auxiliary%201",
  }]);
  assert.deepEqual(productionStub.calls, [{
    kind: "file",
    value: "F:\\dist\\session.html",
    search: "?sessionId=session%201&auxiliarySessionId=auxiliary%201",
  }]);
});

test("WindowEntryLoader は production build で loadFile する", async () => {
  const stub = createWindowStub();
  const loader = new WindowEntryLoader({
    devServerUrl: "",
    rendererDistPath: "F:/dist",
  });

  await loader.loadHomeEntry(stub.window);
  await loader.loadHomeEntry(stub.window, "settings");
  await loader.loadBootEntry(stub.window);
  await loader.loadFilePreviewEntry(stub.window, "preview#1");
  await loader.loadChatEntry(stub.window, { kind: "companion", sessionId: "companion 1" });
  await loader.loadCompanionMergeReviewEntry(stub.window, "companion 1");
  await loader.loadCharacterEditorEntry(stub.window, "char 1");

  assert.deepEqual(stub.calls, [
    { kind: "file", value: "F:\\dist\\index.html", search: undefined },
    { kind: "file", value: "F:\\dist\\index.html", search: "?mode=settings" },
    { kind: "file", value: "F:\\dist\\boot.html", search: undefined },
    { kind: "file", value: "F:\\dist\\file-preview.html", search: "?token=preview%231" },
    {
      kind: "file",
      value: "F:\\dist\\session.html",
      search: "?companionSessionId=companion%201&mode=companion",
    },
    {
      kind: "file",
      value: "F:\\dist\\review.html",
      search: "?companionSessionId=companion%201&view=merge",
    },
    {
      kind: "file",
      value: "F:\\dist\\character-editor.html",
      search: "?characterId=char%201",
    },
  ]);
});
