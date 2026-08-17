import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScheduleWorkspaceProjection,
  cloneScheduleDraft,
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
});

test("schedule editor projection does not share draft attachments or trigger state", () => {
  const cloned = cloneScheduleDraft(draft);
  cloned.attachments.push("file:///tmp/b.txt");
  cloned.trigger.expression = "*/15 * * * *";
  assert.deepEqual(draft.attachments, ["file:///tmp/a.txt"]);
  assert.equal(draft.trigger.type, "cron");
  assert.equal(draft.trigger.expression, "0 9 * * 1-5");
});

test("home projection is read-only", () => {
  const projection = buildScheduleWorkspaceProjection({
    mode: "list",
    loadState: "loaded",
    schedules: [],
    canMutate: false,
  });
  assert.equal(projection.canMutate, false);
});
