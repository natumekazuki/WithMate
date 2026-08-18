import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ScheduleWorkspace } from "../../src/session-schedule-workspace.js";
import type {
  ScheduleDraftProjection,
  ScheduleSummaryProjection,
} from "../../src/session-schedule-ui-projection.js";

const draft: ScheduleDraftProjection = {
  sessionId: "session-1",
  name: "Morning",
  trigger: { type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Tokyo" },
  prompt: "summarize",
  attachments: [],
  model: "gpt",
  reasoningEffort: "medium",
  approvalMode: "never",
  sandboxMode: "workspace-write",
  customAgent: null,
};

const schedule: ScheduleSummaryProjection = {
  id: "schedule-1",
  sessionId: "session-1",
  sessionTitle: "Session One",
  name: "Morning",
  status: "paused",
  trigger: draft.trigger,
  nextFireAt: null,
  lastFireAt: null,
  lastFireStatus: null,
};

async function withRenderedWorkspace(
  element: React.ReactElement,
  run: (document: Document) => Promise<void>,
): Promise<void> {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { pretendToBeVisual: true });
  let root: Root | null = null;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    await act(async () => root?.render(element));
    await run(dom.window.document);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
}

test("schedule editor emits the selected trigger kind", async () => {
  let updatedDraft: ScheduleDraftProjection | null = null;
  await withRenderedWorkspace(
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
    async (document) => {
      const select = document.querySelector<HTMLSelectElement>("select[aria-label='実行形式']");
      assert.ok(select);
      await act(async () => {
        select.value = "once";
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      assert.equal(updatedDraft?.trigger.type, "once");
    },
  );
});

test("paused schedule routes run-now and resume to distinct operations", async () => {
  const operations: string[] = [];
  await withRenderedWorkspace(
    <ScheduleWorkspace
      mode="list"
      loadState="loaded"
      schedules={[schedule]}
      onBack={() => undefined}
      onRunNow={() => operations.push("run-now")}
      onResume={() => operations.push("resume")}
    />,
    async (document) => {
      const runNow = document.querySelector<HTMLButtonElement>("button[aria-label='今すぐ実行']");
      const resume = document.querySelector<HTMLButtonElement>("button[aria-label='スケジュールを再開']");
      assert.ok(runNow);
      assert.ok(resume);
      await act(async () => {
        runNow.click();
        resume.click();
      });
      assert.deepEqual(operations, ["run-now", "resume"]);
    },
  );
});

test("invalid cron preview exposes the concise parser error", async () => {
  await withRenderedWorkspace(
    <ScheduleWorkspace
      mode="create"
      loadState="loaded"
      schedules={[]}
      draft={{
        ...draft,
        trigger: { ...draft.trigger, expression: "not a cron expression" },
      }}
      onBack={() => undefined}
    />,
    async (document) => {
      const bodyText = document.body.textContent ?? "";
      assert.match(bodyText, /Invalid cron expression\./);
      assert.doesNotMatch(bodyText, /Cron式を確認してください/);
    },
  );
});

test("schedule list shows the terminal time and result without an execution id", async () => {
  await withRenderedWorkspace(
    <ScheduleWorkspace
      mode="list"
      loadState="loaded"
      schedules={[{
        ...schedule,
        lastFireAt: "2026-08-18T12:01:00.000Z",
        lastFireStatus: "success",
      }]}
      onBack={() => undefined}
    />,
    async (document) => {
      const bodyText = document.body.textContent ?? "";
      assert.match(bodyText, /最終実行/);
      assert.match(bodyText, /成功/);
      assert.doesNotMatch(bodyText, /Execution:/);
    },
  );
});

test("home schedule selection opens its owning session", async () => {
  const openedSessionIds: string[] = [];
  await withRenderedWorkspace(
    <ScheduleWorkspace
      mode="list"
      loadState="loaded"
      schedules={[schedule]}
      isHome
      onBack={() => undefined}
      onOpenSession={(sessionId) => openedSessionIds.push(sessionId)}
    />,
    async (document) => {
      const row = document.querySelector<HTMLButtonElement>("button");
      assert.ok(row);
      await act(async () => row.click());
      assert.deepEqual(openedSessionIds, ["session-1"]);
    },
  );
});
