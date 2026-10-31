import assert from "node:assert/strict";
import test from "node:test";

import { buildChatEntrySearch, WindowEntryLoader } from "../../src-electron/windows/window-entry-loader.js";

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

// @test-value v2
// kind = "contract"
// claim = "WindowEntryLoader は dev server 使用時に loadURL する"
// oracle = { type = "contract", ref = "src-electron/window-entry-loader.ts" }
// fault = "dev serverの各画面URLを誤り、Session IDやtokenをURL encodeせず別targetを開く"
// observable = "loadURLへ渡されたHome、Session、Diff、File Preview、Boot、Character EditorのURL一覧"
// observation_boundary = "public-boundary"
// scope = "scripts/tests/window-entry-loader.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
  await loader.loadCharacterEditorEntry(stub.window, "char 1");
  await loader.loadCharacterEditorEntry(stub.window);

  assert.deepEqual(stub.calls, [
    { kind: "url", value: "http://localhost:5173?mode=settings" },
    { kind: "url", value: "http://localhost:5173/session.html?sessionId=session%201" },
    { kind: "url", value: "http://localhost:5173/diff.html?token=diff%231" },
    { kind: "url", value: "http://localhost:5173/file-preview.html?token=preview%231" },
    { kind: "url", value: "http://localhost:5173/boot.html" },
    { kind: "url", value: "http://localhost:5173/character-editor.html?characterId=char%201" },
    { kind: "url", value: "http://localhost:5173/character-editor.html" },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "buildChatEntrySearchはagent SessionとAuxiliary IDをsession.html queryへ組み立てる"
// oracle = { type = "contract", ref = "src-electron/window-entry-loader.ts" }
// fault = "Session IDまたは任意のAuxiliary IDをqueryから落とすかURL encodeを誤る"
// observable = "Session単独およびAuxiliary付きのquery文字列"
// observation_boundary = "public-boundary"
// scope = "scripts/tests/window-entry-loader.test.ts"
// lifecycle = "permanent"
// @end-test-value
test("buildChatEntrySearch は chat mode ごとの session.html query を組み立てる", () => {
  assert.equal(buildChatEntrySearch({ kind: "agent", sessionId: "session 1" }), "?sessionId=session%201");
  assert.equal(
    buildChatEntrySearch({ kind: "agent", sessionId: "session 1", auxiliarySessionId: "aux 1" }),
    "?sessionId=session%201&auxiliarySessionId=aux%201",
  );
});

// @test-value v2
// kind = "contract"
// claim = "新規Session Windowのdev/prod session.html load経路は、親Session IDとAuxiliary Session IDをqueryへ保持する"
// oracle = { type = "contract", ref = "ChatEntryMode and session.html location contract" }
// fault = "devまたはproductionのsession.html load経路でAuxiliary Session IDをqueryへ渡さず、対象Auxiliaryの初期選択情報を失う"
// observable = "WindowEntryLoaderのloadURL/loadFileへ渡したsession.html URLまたはquery"
// observation_boundary = "public-boundary"
// scope = "window-entry-auxiliary-navigation"
// lifecycle = "permanent"
// distinction = "通常のchat mode query testとは分離し、新規Windowのentry loaderがdev/prod共通queryを保持することを専用に検証する"
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

// @test-value v2
// kind = "contract"
// claim = "WindowEntryLoader は production build で loadFile する"
// oracle = { type = "contract", ref = "src-electron/window-entry-loader.ts" }
// fault = "productionのdist内entryを誤り、画面選択やtokenをloadFileのsearchから落とす"
// observable = "loadFileへ渡されたHTML pathとsearchの一覧"
// observation_boundary = "public-boundary"
// scope = "scripts/tests/window-entry-loader.test.ts"
// lifecycle = "permanent"
// @end-test-value
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
  await loader.loadCharacterEditorEntry(stub.window, "char 1");

  assert.deepEqual(stub.calls, [
    { kind: "file", value: "F:\\dist\\index.html", search: undefined },
    { kind: "file", value: "F:\\dist\\index.html", search: "?mode=settings" },
    { kind: "file", value: "F:\\dist\\boot.html", search: undefined },
    { kind: "file", value: "F:\\dist\\file-preview.html", search: "?token=preview%231" },
    {
      kind: "file",
      value: "F:\\dist\\character-editor.html",
      search: "?characterId=char%201",
    },
  ]);
});
