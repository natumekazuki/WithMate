import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliaryModelChangeOperation,
  runAuxiliaryReasoningEffortChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "../../src/auxiliary-runtime-option-operation.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "medium",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["low", "medium"],
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      reasoningEfforts: ["medium", "high"],
    },
  ],
};

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

describe("runAuxiliaryModelChangeOperation", () => {
  it("model selection patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession();
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryModelChangeOperation({
      model: "gpt-5.5",
      providerCatalog,
      catalogRevision: 2,
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      catalogRevision: 2,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      updatedAt: "updated",
    });
  });
});

describe("runAuxiliaryReasoningEffortChangeOperation", () => {
  it("reasoning effort selection patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession({ model: "gpt-5.5" });
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryReasoningEffortChangeOperation({
      reasoningEffort: "high",
      providerCatalog,
      catalogRevision: 3,
      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,
      catalogRevision: 3,
      reasoningEffort: "high",
      updatedAt: "updated",
    });
  });
});
