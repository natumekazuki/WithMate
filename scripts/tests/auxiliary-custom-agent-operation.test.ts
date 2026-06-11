import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAuxiliaryCustomAgentPatchOperation,
  runAuxiliaryCustomAgentSelectionOperation,
} from "../../src/auxiliary-custom-agent-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function makeAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "copilot",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "",
    updatedAt: "",
    closedAt: "",
    ...overrides,
  };
}

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

describe("runAuxiliaryCustomAgentPatchOperation", () => {
  it("custom agent patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession({ customAgentName: "planner", updatedAt: "before" });
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryCustomAgentPatchOperation({
      customAgentName: "reviewer",
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      customAgentName: "reviewer",
      updatedAt: "updated",
    });
  });
});
