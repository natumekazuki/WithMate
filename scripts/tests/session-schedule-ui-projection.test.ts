import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScheduleDraftComposerState,
  buildScheduleWorkspaceProjection,
  cloneScheduleDraft,
  projectScheduleLastFire,
  resolveSystemScheduleTimeZone,
  type ScheduleDraftProjection,
} from "../../src/session-schedule-ui-projection.js";

const draft: ScheduleDraftProjection = {
  sessionId: "session-1",
  name: "Morning",
  trigger: { type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Tokyo" },
  prompt: "summarize",
  attachments: ["file:///tmp/a.txt"],
  model: "gpt",
  reasoningEffort: "medium",
  approvalMode: "never",
  sandboxMode: "workspace-write",
  customAgent: null,
};

test("schedule workspace exposes loading, empty, and error states", () => {
  assert.equal(
    buildScheduleWorkspaceProjection({
      mode: "list",
      loadState: "loading",
      schedules: [],
    }).state,
    "loading",
  );
  assert.equal(
    buildScheduleWorkspaceProjection({
      mode: "list",
      loadState: "loaded",
      schedules: [],
    }).state,
    "empty",
  );
  assert.equal(
    buildScheduleWorkspaceProjection({
      mode: "list",
      loadState: "error",
      schedules: [],
      errorMessage: "failed",
    }).state,
    "error",
  );
  const mutationError = buildScheduleWorkspaceProjection({
    mode: "editor",
    loadState: "loaded",
    schedules: [],
    draft,
    errorMessage: "invalid cron",
  });
  assert.equal(mutationError.state, "editor");
  assert.equal(mutationError.errorMessage, "invalid cron");
});

test("schedule last-fire projection only exposes terminal result state", () => {
  assert.deepEqual(projectScheduleLastFire(null), {
    lastFireAt: null,
    lastFireStatus: null,
  });
  assert.deepEqual(projectScheduleLastFire({ state: "pending", updatedAt: "2026-08-18T12:00:00.000Z" }), {
    lastFireAt: null,
    lastFireStatus: null,
  });
  assert.deepEqual(projectScheduleLastFire({ state: "enqueued", updatedAt: "2026-08-18T12:01:00.000Z" }), {
    lastFireAt: "2026-08-18T12:01:00.000Z",
    lastFireStatus: "success",
  });
  assert.deepEqual(projectScheduleLastFire({ state: "failed", updatedAt: "2026-08-18T12:02:00.000Z" }), {
    lastFireAt: "2026-08-18T12:02:00.000Z",
    lastFireStatus: "error",
  });
});

test("schedule editor projection does not share draft attachments or trigger state", () => {
  const cloned = cloneScheduleDraft(draft);
  cloned.attachments.push("file:///tmp/b.txt");
  cloned.trigger.expression = "*/15 * * * *";
  assert.deepEqual(draft.attachments, ["file:///tmp/a.txt"]);
  assert.equal(draft.trigger.type, "cron");
  assert.equal(draft.trigger.expression, "0 9 * * 1-5");
});

test("schedule editor resolves an IANA time zone from the current OS", () => {
  assert.match(resolveSystemScheduleTimeZone(), /^[^/]+(?:\/[^/]+)+$|^UTC$/);
});

test("schedule editor rejects a missing OS time zone without fallback", () => {
  const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = () => ({
    locale: "ja-JP",
    calendar: "gregory",
    numberingSystem: "latn",
    timeZone: "",
  });
  try {
    assert.throws(
      () => resolveSystemScheduleTimeZone(),
      /PCのローカルタイムゾーンを取得できませんでした/,
    );
  } finally {
    Intl.DateTimeFormat.prototype.resolvedOptions = originalResolvedOptions;
  }
});

test("schedule draft canonicalizes composer attachment references for removal", () => {
  const composerState = buildScheduleDraftComposerState(
    "Review @src/report.txt and ![chart](C:/workspace/assets/chart.png)",
    [
      {
        id: "file-1",
        kind: "file",
        source: "text",
        absolutePath: "C:\\workspace\\src\\report.txt",
        displayPath: "src/report.txt",
        workspaceRelativePath: "src/report.txt",
        isOutsideWorkspace: false,
      },
      {
        id: "image-1",
        kind: "image",
        source: "markdown-image",
        absolutePath: "C:\\workspace\\assets\\chart.png",
        displayPath: "assets/chart.png",
        workspaceRelativePath: "assets/chart.png",
        isOutsideWorkspace: false,
      },
    ],
  );

  assert.deepEqual(composerState.attachments, [
    "C:\\workspace\\src\\report.txt",
    "C:\\workspace\\assets\\chart.png",
  ]);
  assert.equal(
    composerState.prompt,
    "Review and @C:\\workspace\\src\\report.txt ![chart.png](C:/workspace/assets/chart.png)",
  );
});
