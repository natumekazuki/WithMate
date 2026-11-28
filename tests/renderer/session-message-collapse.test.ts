import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageCollapseTargets,
  buildMessageNavigatorEntries,
  findMessageIndexByKey,
  reconcileMessageCollapseState,
  toggleAllMessageCollapseState,
  toggleMessageCollapseState,
} from "../../src/chat/conversation/session-message-collapse.js";
import { projectMessagePlainText } from "../../src-shared/session/message-search.js";
import {
  buildMessageListProjection,
  type MessageListSource,
} from "../../src/chat/auxiliary/auxiliary-session-message-projection.js";
import type { Message } from "../../src-shared/session/session-state.js";

/** 永続化済みのMainメッセージを履歴位置で指す。 */
function sessionSource(messageIndex: number): MessageListSource {
  return { kind: "session", messageIndex };
}

/** AuxiliaryのIDと履歴位置を組み合わせてMainと区別する。 */
function auxiliarySource(
  sessionId: string,
  messageIndex: number,
): MessageListSource {
  return { kind: "auxiliary", sessionId, messageIndex, artifact: undefined };
}

/** 保存前のAssistant応答を表すsourceを作り、永続化済み表示と区別する。 */
function liveSource(sessionId: string): MessageListSource {
  return { kind: "live-assistant", sessionId, threadId: null };
}

/** 折りたたみに使う本文と役割を揃え、指定時だけaccentを付ける。 */
function message(role: Message["role"], text: string, accent = false): Message {
  return { role, text, ...(accent ? { accent: true } : {}) };
}

/** しおり付きMainと通常のAuxiliaryを実際のメッセージ投影に通して折りたたみ対象を作る。 */
function buildBookmarkProjectionTargets() {
  const projection = buildMessageListProjection(
    [{ role: "user", text: "bookmarked", isBookmarked: true }],
    [
      {
        id: "aux-1",
        messages: [message("assistant", "ordinary")],
        displayAfterMessageIndex: 0,
        createdAt: "2026-05-24T00:00:00.000Z",
      },
    ],
    "session-1",
  );
  return buildMessageCollapseTargets(
    projection.messages,
    projection.sources,
    projection.keys,
  );
}

// @test-value v2
// kind = "invariant"
// claim = "折りたたみpreviewはMarkdownと空白を正規化して160 code pointsへ収め、派生する本文がなければ空を返す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#rendering-policy; src/chat/conversation/session-message-collapse.ts のpreview投影" }
// fault = "空本文に代替文を生成する、本来の本文を代替文と誤認して除く、または上限を超える"
// observable = "通常本文、summaryが空のMarkdown、本文が実際にNo contentである場合、長文のprojected textとcode point長"
// observation_boundary = "public-boundary"
// scope = "session-message-plain-text-projection"
// lifecycle = "permanent"
// impact = "実在しない本文の表示、本物の本文の欠落、長いsummaryでの見通し悪化を防ぐ"
// distinction = "代替文の削除と、その文言を含む実在本文の保持を同じ投影境界で区別する"
// @end-test-value
/** Markdown記号と空白を正規化し、投影が空なら代替文を生成せず、長文は省略記号込みで160コードポイントに収める。 */
test("plain-text projection は Markdown と空白を正規化し、160 code pointsへ収める", () => {
  assert.equal(
    projectMessagePlainText("# **hello**\n\n  world `code`"),
    "hello world code",
  );
  assert.equal(projectMessagePlainText("***\n\n  \n"), "");
  assert.equal(projectMessagePlainText("No content"), "No content");

  const longText = "あ".repeat(160) + "tail";
  const projected = projectMessagePlainText(longText);
  assert.equal(Array.from(projected).length, 160);
  assert.equal(projected.at(-1), "…");
  assert.equal(projected.slice(0, -1), "あ".repeat(159));
});

// @test-value v2
// kind = "invariant"
// claim = "persisted session/auxiliary の user/assistant は live bridge key を含め collapse target になり、synthetic live assistant は除外される"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "message sourceとdisplay keyの差だけで保存済みレスポンスがcollapse targetから除外される"
// observable = "buildMessageCollapseTargetsのkey・sourceKind・role配列"
// observation_boundary = "component-behavior"
// scope = "session-message-collapse"
// lifecycle = "permanent"
// @end-test-value
/** 表示キーがlive形式でも永続化済みのuser・assistantは折りたたみ対象に含め、sourceが配信中の合成応答だけを除外する。 */
test("collapse target は persisted session/auxiliary の user/assistantだけを採用する", () => {
  const targets = buildMessageCollapseTargets(
    [
      message("user", "user"),
      message("assistant", "assistant"),
      message("assistant", "live"),
      message("assistant", "error"),
      message("assistant", "persisted live"),
    ],
    [
      sessionSource(0),
      auxiliarySource("aux-1", 0),
      liveSource("session-1"),
      sessionSource(3),
      sessionSource(4),
    ],
    [
      "session-session-1-0",
      "auxiliary-aux-1-0",
      "live-assistant-session-1-2-pending",
      "error-row",
      "live-assistant-session-1-4-thread",
    ],
  );

  assert.deepEqual(
    targets.map((target) => [target.key, target.sourceKind, target.role]),
    [
      ["session-session-1-0", "session", "user"],
      ["auxiliary-aux-1-0", "auxiliary", "assistant"],
      ["error-row", "session", "assistant"],
      ["live-assistant-session-1-4-thread", "session", "assistant"],
    ],
  );
});

// @test-value v2
// kind = "contract"
// claim = "message projection は persisted source の bookmark state を navigator entry へ引き継ぎ、source identityを保持する"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: projection と identity" }
// fault = "projectionがbookmark stateを落とすか、Auxiliary messageをMain sourceとして扱う"
// observable = "buildMessageCollapseTargetsとbuildMessageNavigatorEntriesのsource/isBookmarked"
// observation_boundary = "implementation"
// scope = "message-collapse-bookmark-projection"
// lifecycle = "permanent"
// impact = "filter対象や本文のtoggle対象を誤り、別messageのbookmarkを変更する"
// distinction = "DOM操作ではなく、Messages filterと本文toggleが参照するprojection contractを直接確認する"
// @end-test-value
/** MainとAuxiliaryのsourceを区別し、しおりの有無を各ナビゲーター項目へ引き継ぐ。 */
test("collapse target は bookmark state と persisted source identity を navigatorへ引き継ぐ", () => {
  const targets = buildBookmarkProjectionTargets();

  assert.equal(targets[0]?.isBookmarked, true);
  assert.deepEqual(targets[0]?.source, sessionSource(0));
  assert.equal(targets[1]?.isBookmarked, false);
  assert.deepEqual(targets[1]?.source, auxiliarySource("aux-1", 0));

  const entries = buildMessageNavigatorEntries(targets, new Map());
  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.isBookmarked]),
    [
      ["session-session-1-0", true],
      ["auxiliary-aux-1-0", false],
    ],
  );
});

/** 末尾への追加やAuxiliaryの途中挿入で並びが変わっても、同じsourceとキーのメッセージだけが縮小状態を保つ。 */
test("tail append と auxiliary insertion は key/source identityが同じmessageのstateを維持する", () => {
  const initialMessages = [
    message("user", "first"),
    message("assistant", "second"),
  ];
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
  assert.equal(
    reconcileMessageCollapseState(collapsed, appendedTargets).has(
      "session-s-1",
    ),
    true,
  );

  const insertedTargets = buildMessageCollapseTargets(
    [
      message("user", "first"),
      message("assistant", "auxiliary"),
      message("assistant", "second"),
    ],
    [sessionSource(0), auxiliarySource("aux-1", 0), sessionSource(1)],
    ["session-s-0", "auxiliary-aux-1-0", "session-s-1"],
  );
  const reconciled = reconcileMessageCollapseState(collapsed, insertedTargets);
  assert.equal(reconciled.has("session-s-1"), true);
  assert.equal(reconciled.has("auxiliary-aux-1-0"), false);
});

/** 表示キーが変わっても本文などが同じならキャッシュ済みの要約を使い、本文変更時は古い要約を再利用しない。 */
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

/** 同じ表示キーでも本文やsourceの変更で縮小状態が消え、対象が空になったときも状態が残らない。 */
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

/** 一方のメッセージを再展開しても、別のメッセージの縮小状態は残る。 */
test("個別toggleは別messageの縮小状態を保持する", () => {
  const targets = buildMessageCollapseTargets(
    [
      message("user", "user message"),
      message("assistant", "assistant response"),
    ],
    [sessionSource(0), sessionSource(1)],
    ["user-key", "assistant-key"],
  );

  const userCollapsed = toggleMessageCollapseState(new Map(), targets[0]!);
  const bothCollapsed = toggleMessageCollapseState(userCollapsed, targets[1]!);
  assert.deepEqual(Array.from(bothCollapsed.keys()), [
    "user-key",
    "assistant-key",
  ]);

  const assistantOnlyCollapsed = toggleMessageCollapseState(
    bothCollapsed,
    targets[0]!,
  );
  assert.deepEqual(Array.from(assistantOnlyCollapsed.keys()), [
    "assistant-key",
  ]);
});

/** 縮小と展開が混在するときは一括で縮小し、その状態で再度一括操作すると全件を展開する。ナビゲーターも縮小状態を引き継ぐ。 */
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
  assert.deepEqual(
    navigatorEntries.map((entry) => [entry.key, entry.isCollapsed]),
    [
      ["one", true],
      ["two", true],
    ],
  );
});

/** 途中挿入後の移動先は現在のキー配列で引き直し、該当キーがなければ未検出を返す。 */
test("navigator jump は保存indexではなく現在のprojection keyからindexを解決する", () => {
  assert.equal(
    findMessageIndexByKey(["first", "inserted", "target"], "target"),
    2,
  );
  assert.equal(findMessageIndexByKey(["first"], "missing"), -1);
});
