import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// @test-value v1
// kind = "contract"
// claim = "左ペインのCollapseはFiles、Changes、Historyのdata stateを停止または初期化しない"
// oracle = { type = "contract", ref = "accepted behavior: preserve the complete left pane state while collapsed in the same Window" }
// failure_mode = "左ペインを非表示にした時に各paneへenabled=falseが渡り、treeやGit取得結果が破棄される"
// scope = "App file explorer composition boundary"
// lifecycle = "permanent"
// distinction = "Sessionやroot集合の変更によるowner resetではなく、同じWindow内の表示切替だけを検証する"
// @end-test-value
test("App は左ペインの可視性をdata stateの有効条件に含めない", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const paneStart = source.indexOf("const fileExplorerPane = (");
  const paneEnd = source.indexOf("const previewChatNotice", paneStart);

  assert.notEqual(paneStart, -1);
  assert.notEqual(paneEnd, -1);
  const composition = source.slice(paneStart, paneEnd);
  assert.equal(composition.match(/enabled=\{isSelectedWorkspaceAvailable\}/g)?.length, 3);
  assert.doesNotMatch(composition, /enabled=\{isFilesPaneVisible/);
});
