import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "../../src/auxiliary-runtime-option-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";

function makeAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
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

describe("runAuxiliaryApprovalModeChangeOperation", () => {
  it("approval mode patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession();
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryApprovalModeChangeOperation({
      approvalMode: "never",
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      approvalMode: "never",
      updatedAt: "updated",
    });
  });
});

describe("runAuxiliarySandboxModeChangeOperation", () => {
  it("sandbox mode patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession();
    let updated: AuxiliarySession | null = null;

    await runAuxiliarySandboxModeChangeOperation({
      codexSandboxMode: "read-only",
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      codexSandboxMode: "read-only",
      updatedAt: "updated",
    });
  });
});
