import assert from "node:assert/strict";
import test from "node:test";

import { parseCreateSessionScheduleInput } from "../../src/session-schedule.js";

function input() {
  return {
    name: "Morning",
    trigger: {
      type: "cron",
      expression: "0 9 * * 1-5",
      timeZone: "Asia/Tokyo",
    },
    turn: {
      provider: "codex",
      userMessage: "summarize",
      model: "gpt",
      reasoningEffort: "medium",
      approvalMode: "never",
      codexSandboxMode: "workspace-write",
    },
  };
}

test("schedule input accepts only known runtime option values", () => {
  assert.equal(parseCreateSessionScheduleInput(input()).turn.reasoningEffort, "medium");
  for (const field of ["reasoningEffort", "approvalMode", "codexSandboxMode"] as const) {
    const candidate = input();
    candidate.turn[field] = "unknown";
    assert.throws(() => parseCreateSessionScheduleInput(candidate));
  }
});
