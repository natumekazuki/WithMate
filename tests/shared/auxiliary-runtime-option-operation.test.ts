import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliaryModelChangeOperation,
  runAuxiliaryReasoningEffortChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "../../src/chat/auxiliary/auxiliary-runtime-option-operation.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";

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
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
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
  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary model操作はmodelとDepthを対象updaterへ反映する"
  // oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
  // fault = "変更が対象updaterへ渡らないか既存設定を消す"
  // observable = "updaterのAuxiliary Session patch"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-model-operation"
  // lifecycle = "permanent"
  // @end-test-value
  it("model selection patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession();
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryModelChangeOperation({
      model: providerCatalog.models[1]!,

      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,

      model: "gpt-5.5",
      reasoningEffort: "medium",
      updatedAt: "updated",
    });
  });
});

describe("runAuxiliaryReasoningEffortChangeOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Auxiliary Depth操作はmodelを維持して指定Depthを対象updaterへ反映する"
  // oracle = { type = "contract", ref = "Issue #879 discovered models and preserved execution selections" }
  // fault = "Depthを置換するか対象modelを変える"
  // observable = "updaterのAuxiliary Session patch"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-depth-operation"
  // lifecycle = "permanent"
  // @end-test-value
  it("reasoning effort selection patch を active session updater に渡す", async () => {
    const current = makeAuxiliarySession({ model: "gpt-5.5" });
    let updated: AuxiliarySession | null = null;

    await runAuxiliaryReasoningEffortChangeOperation({
      reasoningEffort: "high",
      providerCatalog,

      updateActiveAuxiliarySession: async (recipe) => {
        updated = recipe(current);
      },
      createTimestampLabel: () => "updated",
    });

    assert.deepEqual(updated, {
      ...current,

      reasoningEffort: "high",
      updatedAt: "updated",
    });
  });
});
