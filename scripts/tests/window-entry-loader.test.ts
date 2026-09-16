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

// @test-value v2
// kind = "contract"
// claim = "Chat Window entry queryは親Sessionのmodeを維持し、指定されたAuxiliary IDだけを追加する"
// oracle = { type = "contract", ref = "issue-722 exact Auxiliary window navigation" }
// fault = "Auxiliary選択がqueryから欠落するか、未指定時の既存queryが変わる"
// observable = "agent/companionのbuildChatEntrySearch結果"
// observation_boundary = "public-boundary"
// scope = "WindowEntryLoader chat navigation"
// lifecycle = "permanent"
// impact = "開いたWindowが選択済みAuxiliaryへ初期選択を渡せる"
// distinction = "Main IPCの存在確認とは分離して、Window entryのquery serializationを検証する"
// @end-test-value
test("buildChatEntrySearch は chat mode ごとの session.html query を組み立てる", () => {
  assert.equal(buildChatEntrySearch({ kind: "agent", sessionId: "session 1" }), "?sessionId=session%201");
  assert.equal(
    buildChatEntrySearch({ kind: "agent", sessionId: "session 1", auxiliarySessionId: "aux 1" }),
    "?sessionId=session%201&auxiliarySessionId=aux%201",
  );
  assert.equal(
    buildChatEntrySearch({ kind: "companion", sessionId: "companion 1" }),
    "?companionSessionId=companion%201&mode=companion",
  );
  assert.equal(
    buildChatEntrySearch({ kind: "companion", sessionId: "companion 1", auxiliarySessionId: "aux 1" }),
    "?companionSessionId=companion%201&mode=companion&auxiliarySessionId=aux%201",
  );
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
