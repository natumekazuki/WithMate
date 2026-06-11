import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAuxiliaryCustomAgentSelectionOperation } from "../../src/auxiliary-custom-agent-operation.js";

describe("runAuxiliaryCustomAgentSelectionOperation", () => {
  it("active session がない場合は no-op", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: null,
        customAgentName: "planner",
        updateCustomAgent: async () => {
          events.push("update");
        },
        closeAgentPicker: () => events.push("close"),
      }),
      "noop",
    );
    assert.deepEqual(events, []);
  });

  it("provider が copilot でない場合は no-op", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: {
          provider: "codex",
          customAgentName: "",
        },
        customAgentName: "planner",
        updateCustomAgent: async () => {
          events.push("update");
        },
        closeAgentPicker: () => events.push("close"),
      }),
      "noop",
    );
    assert.deepEqual(events, []);
  });

  it("同じ custom agent の場合は picker close だけ行う", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: {
          provider: "copilot",
          customAgentName: "planner",
        },
        customAgentName: "planner",
        updateCustomAgent: async () => {
          events.push("update");
        },
        closeAgentPicker: () => events.push("close"),
      }),
      "unchanged",
    );
    assert.deepEqual(events, ["close"]);
  });

  it("custom agent が変わる場合は更新後に picker を閉じる", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliaryCustomAgentSelectionOperation({
        activeSession: {
          provider: "copilot",
          customAgentName: "planner",
        },
        customAgentName: "reviewer",
        updateCustomAgent: async (customAgentName) => {
          events.push(`update:${customAgentName}`);
        },
        closeAgentPicker: () => events.push("close"),
      }),
      "updated",
    );
    assert.deepEqual(events, ["update:reviewer", "close"]);
  });
});
