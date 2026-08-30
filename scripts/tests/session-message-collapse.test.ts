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

test("plain-text projection は Markdown と空白を正規化し、160 code pointsへ収める", () => {
  assert.equal(projectMessagePlainText("# **hello**\n\n  world `code`"), "hello world code");
  assert.equal(projectMessagePlainText("***\n\n  \n"), "内容なし");

  const longText = "あ".repeat(160) + "tail";
  const projected = projectMessagePlainText(longText);
  assert.equal(Array.from(projected).length, 160);
  assert.equal(projected.at(-1), "…");
  assert.equal(projected.slice(0, -1), "あ".repeat(159));
});

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

test("navigator jump は保存indexではなく現在のprojection keyからindexを解決する", () => {
  assert.equal(findMessageIndexByKey(["first", "inserted", "target"], "target"), 2);
  assert.equal(findMessageIndexByKey(["first"], "missing"), -1);
});
