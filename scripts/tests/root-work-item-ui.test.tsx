import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionContextPane, type SessionContextPaneProps } from "../../src/session-components.js";
import {
  isRootWorkItemContextEligible,
  resolveAvailableContextPaneTabs,
  type ContextPaneProjection,
} from "../../src/session-ui-projection.js";
import { buildChildSessionRoleBinding, buildRootSessionRoleBinding } from "../../src/session-role-binding.js";
import type { RootWorkItem } from "../../src/work-item.js";

const rootWorkItem: RootWorkItem = {
  id: "root-1",
  sequence: 1,
  contractRevision: 2,
  revision: 4,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T01:00:00.000Z",
  kind: "root",
  rootSessionId: "session-1",
  creatorSessionId: "session-1",
  targetSessionId: "session-1",
  parentWorkItemId: null,
  goal: "Root goal",
  scope: "Repository source",
  completionCriteria: "Tests pass",
  authority: "Owner may revise root state",
  sourceIdentity: { workspace: "workspace", repository: "repo", branch: "main", base: "base", head: "head" },
  state: "in_progress",
  result: null,
  progressSummary: "Storage is implemented",
  blockers: ["Review pending"],
  nextAction: "Run the targeted checks",
};

const contextPaneProjection: ContextPaneProjection = {
  activeTab: "work-item",
  badgeLabel: "WorkItem",
  toneClassName: "active",
  latestCommandToneClassName: "unknown",
  latestCommandStatusLabel: "待機中",
  latestCommandSourceCopy: "NONE",
  reasoningToneClassName: "unknown",
  tasksToneClassName: "unknown",
};

const telemetryProjection = {
  summaryLabel: "0 tokens",
  currentTokensLabel: "0",
  tokenLimitLabel: "0",
  messagesLengthLabel: "0",
  systemTokensLabel: "0",
  conversationTokensLabel: "0",
};

function paneProps(overrides: Partial<SessionContextPaneProps> = {}): SessionContextPaneProps {
  return {
    activeContextPaneTab: "work-item",
    availableContextPaneTabs: ["latest-command", "work-item"],
    contextPaneProjection,
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
    companionGroupMonitorEntries: [],
    selectedSessionLiveRunErrorMessage: "",
    isSelectedSessionRunning: false,
    isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "100%",
    selectedCopilotRemainingRequestsLabel: "—",
    selectedCopilotQuotaResetLabel: "—",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: telemetryProjection,
    contextEmptyText: "",
    onCycleContextPaneTab: () => {},
    onOpenCompanionReview: () => {},
    rootWorkItem,
    rootWorkItemHistory: [
      { revision: 1, eventType: "created", occurredAt: "2026-08-30T00:00:00.000Z", summary: "created" },
      { revision: 4, eventType: "progress", occurredAt: "2026-08-30T01:00:00.000Z", summary: "progress" },
    ],
    ...overrides,
  };
}

// @test-value v1
// kind = "invariant"
// claim = "standaloneまたはoverall-coordinatorのroot SessionはRoot WorkItem取得前や取得失敗中もWorkItem tabをavailableに保ち、childとcharacter-authoring Sessionは含めない"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6-ui" }
// failure_mode = "初回取得失敗でitemがnullになるとtab自体が消えてerrorとretryへ到達不能になる、または対象外childにtabが表示される"
// scope = "session-context-pane-tab-availability"
// lifecycle = "permanent"
// @end-test-value
test("Root Session の適格性で WorkItem tab の available を決める", () => {
  const rootBinding = buildRootSessionRoleBinding("root", "overall-coordinator");
  const childBinding = buildChildSessionRoleBinding("child", "root", rootBinding, "executor");
  assert.equal(isRootWorkItemContextEligible({ id: "root", sessionKind: "default", roleBinding: rootBinding }), true);
  assert.equal(isRootWorkItemContextEligible({ id: "child", sessionKind: "default", roleBinding: childBinding }), false);
  assert.equal(isRootWorkItemContextEligible({ id: "author", sessionKind: "character-authoring", roleBinding: null }), false);
  assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: false, showRootWorkItemTab: true }), ["latest-command", "work-item"]);
  assert.deepEqual(resolveAvailableContextPaneTabs({ isCopilotSession: false, showRootWorkItemTab: false }), ["latest-command"]);
});

// @test-value v1
// kind = "regression"
// claim = "WorkItem tabはitem未取得でもloading statusを表示し、初回取得失敗時はalertと再試行buttonを残してowner callbackを一回呼ぶ"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6-ui" }
// failure_mode = "itemがnullの分岐でpane全体が空になり、保持済みerrorも再取得手段も利用者に表示されない"
// scope = "SessionContextPane root WorkItem loading and initial error recovery"
// lifecycle = "permanent"
// distinction = "loaded item上のmutation errorではなく、itemが一度も取得できていないloading/error tupleと実button clickを観測する"
// @end-test-value
test("Root WorkItem 初回取得のloadingとerror retryを描画する", async () => {
  const loading = renderToStaticMarkup(<SessionContextPane {...paneProps({
    rootWorkItem: null,
    rootWorkItemLoading: true,
  })} />);
  assert.match(loading, /role="status"[^>]*aria-live="polite"[^>]*aria-busy="true"/);
  assert.match(loading, /root-work-item-spinner/);
  assert.match(loading, /Root WorkItemを読み込んでいます。/);

  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  let retries = 0;
  const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement });
  try {
    await act(async () => root.render(<SessionContextPane {...paneProps({
      rootWorkItem: null,
      rootWorkItemLoading: false,
      rootWorkItemErrorMessage: "Root WorkItem could not be loaded.",
      onRetryRootWorkItem: () => { retries += 1; },
    })} />));
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "Root WorkItem could not be loaded.");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "再試行") as HTMLButtonElement;
    assert.ok(retry);
    await act(async () => retry.click());
    assert.equal(retries, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

// @test-value v1
// kind = "contract"
// claim = "WorkItem tab は current goal、state、progress、blockers、next action を表示し、空の任意説明を常設表示しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6-ui" }
// failure_mode = "再開に必要な Root WorkItem の現在値が右ペインから欠落する、または空説明を常設文言で埋めて情報密度を損なう"
// scope = "session-context-pane-root-work-item-projection"
// lifecycle = "permanent"
// @end-test-value
test("Root WorkItem の現在値を right pane に表示する", () => {
  const html = renderToStaticMarkup(<SessionContextPane {...paneProps()} />);
  assert.match(html, /Root goal/);
  assert.match(html, /in_progress/);
  assert.match(html, /progressSummary.*Storage is implemented/);
  assert.match(html, /blockers.*Review pending/);
  assert.match(html, /nextAction.*Run the targeted checks/);
  assert.match(html, /Repository source/);
  assert.doesNotMatch(html, /作業情報はありません|Root WorkItem を作成してください/);
  const failedMutation = renderToStaticMarkup(<SessionContextPane {...paneProps({
    rootWorkItemErrorMessage: "Root WorkItemの更新に失敗しました。",
  })} />);
  assert.match(failedMutation, /role="alert"[^>]*>Root WorkItemの更新に失敗しました。/);
});

// @test-value v1
// kind = "contract"
// claim = "active Root WorkItemの改訂・引き継ぎはowner callbackへ入力を渡し、空progressでは引き継ぎをdisable、terminalではmutation controlを非表示にする"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
// failure_mode = "右ペインの改訂・引き継ぎ操作が発見不能、または編集値を owner service へ渡さず表示だけが変わる"
// scope = "session-context-pane-root-work-item-mutations"
// lifecycle = "permanent"
// @end-test-value
test("Root WorkItem の改訂と引き継ぎ callback を操作から検証する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  const revisions: unknown[] = [];
  let handoffs = 0;
  const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement });
  try {
    await act(async () => root.render(<SessionContextPane {...paneProps({
      onReviseRootWorkItem: (input) => { revisions.push(input); return true; },
      onHandoffRootWorkItem: () => { handoffs += 1; },
    })} />));
    const revise = [...container.querySelectorAll("button")].find((button) => button.textContent === "改訂") as HTMLButtonElement;
    const handoff = [...container.querySelectorAll("button")].find((button) => button.textContent === "引き継ぎ") as HTMLButtonElement;
    assert.ok(revise);
    assert.ok(handoff);
    assert.equal(revise.getAttribute("aria-expanded"), "false");
    await act(async () => revise.click());
    const goal = [...container.querySelectorAll("textarea")].find((textarea) => textarea.parentElement?.textContent?.startsWith("goal")) as HTMLTextAreaElement;
    assert.ok(goal);
    await act(async () => container.querySelector<HTMLButtonElement>("button[type=submit]")?.click());
    assert.deepEqual(
      { goal: (revisions[0] as { goal: string }).goal, expectedRevision: (revisions[0] as { expectedRevision: number }).expectedRevision },
      { goal: "Root goal", expectedRevision: 4 },
    );
    await act(async () => handoff.click());
    assert.equal(handoffs, 1);

    await act(async () => root.render(<SessionContextPane {...paneProps({
      rootWorkItem: { ...rootWorkItem, progressSummary: "", nextAction: "" },
      onReviseRootWorkItem: (input) => { revisions.push(input); return true; },
      onHandoffRootWorkItem: () => { handoffs += 1; },
    })} />));
    const disabledHandoff = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "引き継ぎ") as HTMLButtonElement;
    assert.equal(disabledHandoff.disabled, true);
    assert.match(disabledHandoff.title, /progressSummary.*nextAction/);
    const emptyRevise = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "改訂") as HTMLButtonElement;
    await act(async () => emptyRevise.click());
    assert.ok(container.querySelector("form.root-work-item-edit-form"));

    await act(async () => root.render(<SessionContextPane {...paneProps({
      rootWorkItem: { ...rootWorkItem, state: "completed", result: {
        outcome: "completed",
        summary: "done",
        changes: [],
        verificationResults: [],
        findings: [],
        unverifiedItems: [],
        remainingWork: [],
        reportingSessionId: "session-1",
        reportedAt: "2026-08-30T02:00:00.000Z",
      } },
      onReviseRootWorkItem: (input) => { revisions.push(input); return true; },
      onHandoffRootWorkItem: () => { handoffs += 1; },
    })} />));
    assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "改訂"), false);
    assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "引き継ぎ"), false);
    assert.equal(container.querySelector("form.root-work-item-edit-form"), null);
    assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "保存"), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

// @test-value v1
// kind = "regression"
// claim = "Root WorkItem改訂editorはowner callbackがtrueを返した場合だけ閉じ、pending中またはfalse完了ではdraftと親から渡されたerrorを同時に保持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6-ui" }
// failure_mode = "保存Promiseを待たずeditorを閉じて入力を失うか、false完了後に再送可能なdraftと部分成功表示が消える"
// scope = "SessionContextPane Root WorkItem revision editor"
// lifecycle = "permanent"
// distinction = "callback呼出しだけでなく未解決Promise、false完了、親からの部分成功error再描画後のeditor stateを順に観測する"
// @end-test-value
test("Root WorkItem改訂は成功時だけeditorを閉じてfailure時はdraftを保持する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  let resolveSave: ((saved: boolean) => void) | null = null;
  const save = () => new Promise<boolean>((resolve) => { resolveSave = resolve; });
  const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement });
  try {
    await act(async () => root.render(<SessionContextPane {...paneProps({ onReviseRootWorkItem: save })} />));
    const revise = [...container.querySelectorAll("button")].find((button) => button.textContent === "改訂") as HTMLButtonElement;
    await act(async () => revise.click());
    await act(async () => container.querySelector<HTMLButtonElement>("button[type=submit]")?.click());
    assert.ok(container.querySelector("form.root-work-item-edit-form"));
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Root goal");

    await act(async () => resolveSave?.(false));
    await act(async () => root.render(<SessionContextPane {...paneProps({
      onReviseRootWorkItem: save,
      rootWorkItemErrorMessage: "契約改訂は保存されましたが、進捗の保存に失敗しました。入力内容を残しています。",
    })} />));
    assert.ok(container.querySelector("form.root-work-item-edit-form"));
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")?.value, "Root goal");
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /契約改訂は保存されました/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

// @test-value v1
// kind = "regression"
// claim = "Root WorkItem editorは編集中に外部revisionが流入するとdraftと編集開始revisionを維持して保存を止め、明示的な破棄操作後だけ最新projectionとrevisionで保存する"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6-ui" }
// failure_mode = "編集中のprojection refreshでexpectedRevisionだけが最新化されるか、stale draftを保存可能なままにして外部変更を上書きする"
// scope = "SessionContextPane Root WorkItem revision editor"
// lifecycle = "permanent"
// distinction = "revision 4でeditorを開いた後、revision 5と外部goalへ再描画し、draft保持、status、保存抑止、明示再読込後のsubmit payloadを順に観測する"
// @end-test-value
test("Root WorkItem改訂は外部更新後の保存を止めて明示再読込する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  const revisions: Array<{ expectedRevision: number; goal: string }> = [];
  const onReviseRootWorkItem = (input: { expectedRevision: number; goal: string }) => {
    revisions.push(input);
    return false;
  };
  const previous = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement });
  try {
    await act(async () => root.render(<SessionContextPane {...paneProps({ onReviseRootWorkItem })} />));
    const revise = [...container.querySelectorAll("button")].find((button) => button.textContent === "改訂") as HTMLButtonElement;
    await act(async () => revise.click());

    await act(async () => root.render(<SessionContextPane {...paneProps({
      rootWorkItem: { ...rootWorkItem, revision: 5, goal: "Externally revised" },
      onReviseRootWorkItem,
    })} />));
    const goal = [...container.querySelectorAll("textarea")]
      .find((textarea) => textarea.parentElement?.textContent?.startsWith("goal")) as HTMLTextAreaElement;
    assert.equal(goal.value, "Root goal");
    assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /入力内容は保持されています/);
    assert.equal(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, true);

    await act(async () => container.querySelector<HTMLButtonElement>("button[type=submit]")?.click());
    assert.deepEqual(revisions, []);
    const reload = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "入力を破棄して最新版を読み込む") as HTMLButtonElement;
    await act(async () => reload.click());
    assert.equal(goal.value, "Externally revised");
    assert.equal(container.querySelector('[role="status"]'), null);
    assert.equal(container.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, false);
    await act(async () => container.querySelector<HTMLButtonElement>("button[type=submit]")?.click());
    assert.deepEqual(revisions.map(({ expectedRevision, goal: submittedGoal }) => ({ expectedRevision, goal: submittedGoal })), [
      { expectedRevision: 5, goal: "Externally revised" },
    ]);
    assert.ok(container.querySelector("form.root-work-item-edit-form"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

// @test-value v1
// kind = "contract"
// claim = "Root WorkItem の履歴は details による progressive disclosure で提供され、履歴が空なら常設説明を描画しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#改訂と進捗の履歴" }
// failure_mode = "履歴が常時展開されて右ペインを占有する、または履歴なしでも説明カードが残る"
// scope = "session-context-pane-root-work-item-history"
// lifecycle = "permanent"
// @end-test-value
test("Root WorkItem 履歴は progressive disclosure で、空履歴は常設しない", () => {
  const withHistory = renderToStaticMarkup(<SessionContextPane {...paneProps()} />);
  assert.match(withHistory, /<details[^>]*root-work-item-history/);
  assert.match(withHistory, /<summary>履歴 \(2\)<\/summary>/);
  const withoutHistory = renderToStaticMarkup(<SessionContextPane {...paneProps({ rootWorkItemHistory: [] })} />);
  assert.doesNotMatch(withoutHistory, /root-work-item-history|履歴 \(/);
});
