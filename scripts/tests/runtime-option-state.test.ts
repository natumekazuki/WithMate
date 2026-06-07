import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionWithApprovalMode,
  buildSessionWithCodexSandboxMode,
  buildSessionWithModelChange,
  buildSessionWithReasoningEffort,
} from "../../src/runtime-option-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";

const providerCatalog = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-default",
  defaultReasoningEffort: "medium",
  models: [
    {
      id: "gpt-default",
      label: "GPT Default",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-fast",
      label: "GPT Fast",
      reasoningEfforts: ["minimal", "low"],
    },
  ],
} satisfies ModelCatalogProvider;

test("buildSessionWithApprovalMode は approval mode と updatedAt を反映する", () => {
  const session = {
    id: "session-1",
    approvalMode: "on-request" as const,
    provider: "codex",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithApprovalMode(
    session,
    "never",
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    approvalMode: "never",
    provider: "codex",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

test("buildSessionWithApprovalMode は同じ approval mode なら no-op を返す", () => {
  const session = {
    id: "session-1",
    approvalMode: "on-request" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.equal(
    buildSessionWithApprovalMode(session, "on-request", "2026-06-07T01:00:00.000Z"),
    null,
  );
});

test("buildSessionWithCodexSandboxMode は sandbox mode と updatedAt を反映する", () => {
  const session = {
    id: "session-1",
    codexSandboxMode: "workspace-write" as const,
    provider: "codex",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithCodexSandboxMode(
    session,
    "read-only",
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    codexSandboxMode: "read-only",
    provider: "codex",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

test("buildSessionWithCodexSandboxMode は同じ sandbox mode なら no-op を返す", () => {
  const session = {
    id: "session-1",
    codexSandboxMode: "workspace-write" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.equal(
    buildSessionWithCodexSandboxMode(
      session,
      "workspace-write",
      "2026-06-07T01:00:00.000Z",
    ),
    null,
  );
});

test("buildSessionWithModelChange は model catalog selection を session patch に反映する", () => {
  const session = {
    id: "session-1",
    catalogRevision: 1,
    model: "gpt-default",
    reasoningEffort: "high" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithModelChange(
    session,
    providerCatalog,
    "gpt-fast",
    2,
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    catalogRevision: 2,
    model: "gpt-fast",
    reasoningEffort: "minimal",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

test("buildSessionWithReasoningEffort は reasoning effort selection を session patch に反映する", () => {
  const session = {
    id: "session-1",
    catalogRevision: 1,
    model: "gpt-fast",
    reasoningEffort: "low" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  const nextSession = buildSessionWithReasoningEffort(
    session,
    providerCatalog,
    "minimal",
    2,
    "2026-06-07T01:00:00.000Z",
  );

  assert.deepEqual(nextSession, {
    id: "session-1",
    catalogRevision: 2,
    model: "gpt-fast",
    reasoningEffort: "minimal",
    updatedAt: "2026-06-07T01:00:00.000Z",
  });
});

test("model / reasoning effort helper は同じ選択でも既存どおり patch を返す", () => {
  const session = {
    id: "session-1",
    catalogRevision: 1,
    model: "gpt-default",
    reasoningEffort: "medium" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.deepEqual(
    buildSessionWithModelChange(
      session,
      providerCatalog,
      "gpt-default",
      2,
      "2026-06-07T01:00:00.000Z",
    ),
    {
      id: "session-1",
      catalogRevision: 2,
      model: "gpt-default",
      reasoningEffort: "medium",
      updatedAt: "2026-06-07T01:00:00.000Z",
    },
  );
  assert.deepEqual(
    buildSessionWithReasoningEffort(
      session,
      providerCatalog,
      "medium",
      2,
      "2026-06-07T01:00:00.000Z",
    ),
    {
      id: "session-1",
      catalogRevision: 2,
      model: "gpt-default",
      reasoningEffort: "medium",
      updatedAt: "2026-06-07T01:00:00.000Z",
    },
  );
});

test("model / reasoning effort helper は model catalog validation error を維持する", () => {
  const session = {
    id: "session-1",
    catalogRevision: 1,
    model: "gpt-default",
    reasoningEffort: "medium" as const,
    updatedAt: "2026-06-07T00:00:00.000Z",
  };

  assert.throws(
    () => buildSessionWithModelChange(
      session,
      providerCatalog,
      "missing-model",
      2,
      "2026-06-07T01:00:00.000Z",
    ),
    /selected model/,
  );
  assert.throws(
    () => buildSessionWithReasoningEffort(
      session,
      providerCatalog,
      "xhigh",
      2,
      "2026-06-07T01:00:00.000Z",
    ),
    /selected depth/,
  );
});
