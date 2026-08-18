import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
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
  assert.ok(html.includes("次回の実行予定"));
  assert.equal((html.match(/<li>/g) ?? []).length, 5);
  assert.ok(html.includes('dateTime="2026-08-18T00:15:00.000Z"'));
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
});
