import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageCollapseTargets,
  buildMessageNavigatorEntries,
  findMessageIndexByKey,
  projectMessagePlainText,
  reconcileMessageCollapseState,
  toggleAllMessageCollapseState,
  toggleMessageCollapseState,
} from "../../src/session-message-collapse.js";
import type { MessageListSource } from "../../src/auxiliary-session-message-projection.js";
import type { Message } from "../../src/session-state.js";

function sessionSource(messageIndex: number): MessageListSource {
  return { kind: "session", messageIndex };
}

function auxiliarySource(sessionId: string, messageIndex: number): MessageListSource {
  return { kind: "auxiliary", sessionId, messageIndex, artifact: undefined };
}

function liveSource(sessionId: string): MessageListSource {
  return { kind: "live-assistant", sessionId, threadId: null };
}

function message(role: Message["role"], text: string, accent = false): Message {
  return { role, text, ...(accent ? { accent: true } : {}) };
}

// @test-value v1
// kind = "invariant"
// claim = "message previewはMarkdownと空白をplain textへ正規化し160 code points以内に収める"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "縮小previewへmarkupや過長本文が残りmessage listの可読性を壊す"
// scope = "session-message-collapse-preview-projection"
// lifecycle = "permanent"
// @end-test-value
test("plain-text projection は Markdown と空白を正規化し、160 code pointsへ収める", () => {
  assert.equal(projectMessagePlainText("# **hello**\n\n  world `code`"), "hello world code");
  assert.equal(projectMessagePlainText("***\n\n  \n"), "内容なし");

  const longText = "あ".repeat(160) + "tail";
  const projected = projectMessagePlainText(longText);
  assert.equal(Array.from(projected).length, 160);
  assert.equal(projected.at(-1), "…");
  assert.equal(projected.slice(0, -1), "あ".repeat(159));
});

// @test-value v1
// kind = "invariant"
// claim = "collapse対象はpersisted Sessionとauxiliaryのuser/assistant messageだけに限定する"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "tool/systemまたは未永続messageがcollapse対象となり操作identityが不安定になる"
// scope = "session-message-collapse-target-selection"
// lifecycle = "permanent"
// @end-test-value
test("collapse target は persisted session/auxiliary の user/assistantだけを採用する", () => {
  const targets = buildMessageCollapseTargets(
    [
      message("user", "user"),
      message("assistant", "assistant"),
      message("assistant", "live"),
      message("assistant", "error"),
      message("assistant", "persisted live"),
    ],
    [sessionSource(0), auxiliarySource("aux-1", 0), liveSource("session-1"), sessionSource(3), sessionSource(4)],
    ["session-session-1-0", "auxiliary-aux-1-0", "live-assistant-session-1-2-pending", "error-row", "live-assistant-session-1-4-thread"],
  );

  assert.deepEqual(targets.map((target) => [target.key, target.sourceKind, target.role]), [
    ["session-session-1-0", "session", "user"],
    ["auxiliary-aux-1-0", "auxiliary", "assistant"],
    ["error-row", "session", "assistant"],
  ]);
});

// @test-value v1
// kind = "invariant"
// claim = "tail appendやauxiliary insertion後もkeyとsource identityが同じmessageのcollapse stateを維持する"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "新着messageの追加だけで既存messageの展開状態がリセットされる"
// scope = "session-message-collapse-state-reconciliation"
// lifecycle = "permanent"
// @end-test-value
test("tail append と auxiliary insertion は key/source identityが同じmessageのstateを維持する", () => {
  const initialMessages = [message("user", "first"), message("assistant", "second")];
  const initialTargets = buildMessageCollapseTargets(
    initialMessages,
    [sessionSource(0), sessionSource(1)],
    ["session-s-0", "session-s-1"],
  );
  const collapsed = toggleMessageCollapseState(new Map(), initialTargets[1]!);

  const appendedTargets = buildMessageCollapseTargets(
    [...initialMessages, message("user", "third")],
    [sessionSource(0), sessionSource(1), sessionSource(2)],
    ["session-s-0", "session-s-1", "session-s-2"],
  );
  assert.equal(reconcileMessageCollapseState(collapsed, appendedTargets).has("session-s-1"), true);

  const insertedTargets = buildMessageCollapseTargets(
    [message("user", "first"), message("assistant", "auxiliary"), message("assistant", "second")],
    [sessionSource(0), auxiliarySource("aux-1", 0), sessionSource(1)],
    ["session-s-0", "auxiliary-aux-1-0", "session-s-1"],
  );
  const reconciled = reconcileMessageCollapseState(collapsed, insertedTargets);
  assert.equal(reconciled.has("session-s-1"), true);
  assert.equal(reconciled.has("auxiliary-aux-1-0"), false);
});

// @test-value v1
// kind = "invariant"
// claim = "同一targetのpreviewは再利用し、本文が変わったtargetには新しいpreviewを生成する"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "本文更新後も古い縮小previewが表示される"
// scope = "session-message-collapse-preview-cache"
// lifecycle = "permanent"
// @end-test-value
test("collapse preview は不変なtargetを再利用し、本文変更では古いpreviewを使わない", () => {
  const initialTargets = buildMessageCollapseTargets(
    [message("assistant", "# first")],
    [sessionSource(0)],
    ["old-key"],
  );
  const cachedTargets = [{ ...initialTargets[0]!, preview: "cached first" }];

  const appendedTargets = buildMessageCollapseTargets(
    [message("assistant", "# first"), message("user", "second")],
    [sessionSource(0), sessionSource(1)],
    ["new-key", "second-key"],
    cachedTargets,
  );
  assert.deepEqual(
    { key: appendedTargets[0]?.key, preview: appendedTargets[0]?.preview },
    { key: "new-key", preview: "cached first" },
  );
  assert.equal(appendedTargets[1]?.preview, "second");

  const changedTargets = buildMessageCollapseTargets(
    [message("assistant", "# changed")],
    [sessionSource(0)],
    ["new-key"],
    cachedTargets,
  );
  assert.equal(changedTargets[0]?.preview, "changed");
});

// @test-value v1
// kind = "invariant"
// claim = "message identity要素の変更・削除・Session切替時は対応するcollapse stateを無効化する"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "別messageや別Sessionへ以前のcollapse stateが誤適用される"
// scope = "session-message-collapse-state-invalidation"
// lifecycle = "permanent"
// @end-test-value
test("同じkeyのsource/role/body変更、消えたkey、Session切り替えではstateを無効化できる", () => {
  const target = buildMessageCollapseTargets(
    [message("assistant", "before")],
    [sessionSource(0)],
    ["same-key"],
  )[0]!;
  const collapsed = toggleMessageCollapseState(new Map(), target);

  const changedBody = buildMessageCollapseTargets(
    [message("assistant", "after")],
    [sessionSource(0)],
    ["same-key"],
  );
  assert.equal(reconcileMessageCollapseState(collapsed, changedBody).size, 0);

  const changedSource = buildMessageCollapseTargets(
    [message("assistant", "before")],
    [auxiliarySource("aux-1", 0)],
    ["same-key"],
  );
  assert.equal(reconcileMessageCollapseState(collapsed, changedSource).size, 0);
  assert.equal(reconcileMessageCollapseState(collapsed, []).size, 0);
});

// @test-value v1
// kind = "invariant"
// claim = "個別messageのtoggleは他messageのcollapse stateを変更しない"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "一件の開閉操作で別messageの状態まで反転する"
// scope = "session-message-collapse-individual-toggle"
// lifecycle = "permanent"
// @end-test-value
test("個別toggleは別messageの縮小状態を保持する", () => {
  const targets = buildMessageCollapseTargets(
    [message("user", "user message"), message("assistant", "assistant response")],
    [sessionSource(0), sessionSource(1)],
    ["user-key", "assistant-key"],
  );

  const userCollapsed = toggleMessageCollapseState(new Map(), targets[0]!);
  const bothCollapsed = toggleMessageCollapseState(userCollapsed, targets[1]!);
  assert.deepEqual(Array.from(bothCollapsed.keys()), ["user-key", "assistant-key"]);

  const assistantOnlyCollapsed = toggleMessageCollapseState(bothCollapsed, targets[0]!);
  assert.deepEqual(Array.from(assistantOnlyCollapsed.keys()), ["assistant-key"]);
});

// @test-value v1
// kind = "invariant"
// claim = "一括toggleは展開中があれば全縮小し、全件縮小済みなら全展開する"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "一括操作後にmessageの開閉状態が混在し利用者の操作意図とずれる"
// scope = "session-message-collapse-bulk-toggle"
// lifecycle = "permanent"
// @end-test-value
test("一括toggle は一件でも展開中なら全縮小、全縮小済みなら全展開する", () => {
  const targets = buildMessageCollapseTargets(
    [message("user", "one"), message("assistant", "two")],
    [sessionSource(0), sessionSource(1)],
    ["one", "two"],
  );
  const oneCollapsed = toggleMessageCollapseState(new Map(), targets[0]!);
  const allCollapsed = toggleAllMessageCollapseState(oneCollapsed, targets);
  assert.deepEqual(Array.from(allCollapsed.keys()), ["one", "two"]);
  assert.equal(toggleAllMessageCollapseState(allCollapsed, targets).size, 0);

  const navigatorEntries = buildMessageNavigatorEntries(targets, allCollapsed);
  assert.deepEqual(navigatorEntries.map((entry) => [entry.key, entry.isCollapsed]), [
    ["one", true],
    ["two", true],
  ]);
});

// @test-value v1
// kind = "regression"
// claim = "navigator jumpは保存済みindexではなく現在のprojection keyから対象indexを解決する"
// oracle = { type = "contract", ref = "docs/features/session-message-collapse-and-navigation.md" }
// failure_mode = "message挿入後に古いindexへjumpして別messageを選択する"
// scope = "session-message-navigation-target-resolution"
// lifecycle = "permanent"
// @end-test-value
test("navigator jump は保存indexではなく現在のprojection keyからindexを解決する", () => {
  assert.equal(findMessageIndexByKey(["first", "inserted", "target"], "target"), 2);
  assert.equal(findMessageIndexByKey(["first"], "missing"), -1);
});
