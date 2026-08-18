import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ScheduleWorkspace } from "../../src/session-schedule-workspace.js";
import type {
  ScheduleDraftProjection,
  ScheduleSummaryProjection,
} from "../../src/session-schedule-ui-projection.js";

const draft: ScheduleDraftProjection = {
  sessionId: "session-1",
  name: "Morning review",
  trigger: { type: "cron", expression: "*/15 * * * *", timeZone: "UTC" },
  prompt: "Review the workspace",
  attachments: [],
  model: "gpt-test",
  reasoningEffort: "medium",
  approvalMode: "never",
  sandboxMode: "workspace-write",
  customAgent: null,
};

test("schedule editor hides time zone input and previews the next five cron occurrences", () => {
  const html = renderToStaticMarkup(
    <ScheduleWorkspace
      mode="create"
      loadState="loaded"
      schedules={[]}
      draft={draft}
      previewNow={new Date("2026-08-18T00:07:00Z")}
      onBack={() => undefined}
      onDraftChange={() => undefined}
    />,
  );

  assert.ok(!html.includes("タイムゾーン"));
  assert.ok(html.includes('aria-label="次回の実行予定"'));
  assert.ok(!html.includes("式を入力すると"));
  assert.ok(!html.includes("スケジュールを作成"));
  assert.ok(!html.includes("<span>名前</span>"));
  assert.ok(!html.includes("<span>実行形式</span>"));
  assert.ok(!html.includes("<span>Cron式</span>"));
  assert.ok(html.includes(">定期実行</option>"));
  assert.ok(html.includes(">1回実行</option>"));
  assert.ok(html.includes('aria-label="Cron入力候補"'));
  assert.ok(html.includes(">平日 9:00</button>"));
  assert.equal((html.match(/<li>/g) ?? []).length, 5);
  assert.ok(html.includes('dateTime="2026-08-18T00:15:00.000Z"'));
});

test("cron preset updates the draft through the editor contract", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { pretendToBeVisual: true });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  let updatedDraft: ScheduleDraftProjection | null = null;
  try {
    await act(async () => {
      root.render(
        <ScheduleWorkspace
          mode="create"
          loadState="loaded"
          schedules={[]}
          draft={draft}
          onBack={() => undefined}
          onDraftChange={(nextDraft) => {
            updatedDraft = nextDraft;
          }}
        />,
      );
    });
    const preset = Array.from(dom.window.document.querySelectorAll("button"))
      .find((button) => button.textContent === "平日 9:00");
    assert.ok(preset);

    await act(async () => {
      preset.click();
    });

    assert.equal(updatedDraft?.trigger.type, "cron");
    assert.equal(updatedDraft?.trigger.type === "cron" ? updatedDraft.trigger.expression : null, "0 9 * * 1-5");
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test("schedule list does not expose the persisted internal time zone", () => {
  const schedule: ScheduleSummaryProjection = {
    id: "schedule-1",
    sessionId: "session-1",
    sessionTitle: "Session one",
    revision: 1,
    name: "Morning review",
    state: "active",
    status: "active",
    trigger: { type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Tokyo" },
    nextFireAt: "2026-08-18T00:00:00.000Z",
  };
  const html = renderToStaticMarkup(
    <ScheduleWorkspace
      mode="list"
      loadState="loaded"
      schedules={[schedule]}
      onBack={() => undefined}
    />,
  );

  assert.ok(html.includes("0 9 * * 1-5"));
  assert.ok(!html.includes("Asia/Tokyo"));
  assert.ok(!html.includes("このSession"));
});

test("home schedule row is one button without a nested action", () => {
  const schedule: ScheduleSummaryProjection = {
    id: "schedule-1",
    sessionId: "session-1",
    sessionTitle: "Session one",
    revision: 1,
    name: "Morning review",
    state: "active",
    status: "active",
    trigger: { type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Tokyo" },
    nextFireAt: "2026-08-18T00:00:00.000Z",
  };
  const html = renderToStaticMarkup(
    <ScheduleWorkspace
      mode="list"
      isHome
      loadState="loaded"
      schedules={[schedule]}
      onBack={() => undefined}
      onOpenSession={() => undefined}
    />,
  );

  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.ok(html.includes("schedule-list-row-button"));
  assert.ok(!html.includes('aria-label="所有Sessionを開く"'));
  assert.ok(!html.includes("↗"));
});

test("empty schedule list keeps only the toolbar", () => {
  const html = renderToStaticMarkup(
    <ScheduleWorkspace
      mode="list"
      loadState="loaded"
      schedules={[]}
      onBack={() => undefined}
      onCreate={() => undefined}
    />,
  );

  assert.ok(html.includes("スケジュール"));
  assert.ok(html.includes('aria-label="スケジュールを作成"'));
  assert.ok(!html.includes("スケジュールはありません"));
  assert.ok(!html.includes("schedule-empty-copy"));
});

test("paused schedule uses distinct icons for run now and resume", () => {
  const schedule: ScheduleSummaryProjection = {
    id: "schedule-1",
    sessionId: "session-1",
    sessionTitle: "Session one",
    revision: 1,
    name: "Morning review",
    state: "paused",
    status: "paused",
    trigger: { type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Tokyo" },
    nextFireAt: null,
  };
  const html = renderToStaticMarkup(
    <ScheduleWorkspace
      mode="list"
      loadState="loaded"
      schedules={[schedule]}
      onBack={() => undefined}
      onRunNow={() => undefined}
      onResume={() => undefined}
    />,
  );

  assert.match(html, /aria-label="今すぐ実行"[^>]*>[\s\S]*?⚡/);
  assert.match(html, /aria-label="スケジュールを再開"[^>]*>[\s\S]*?▶/);
});
