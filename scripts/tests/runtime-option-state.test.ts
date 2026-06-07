import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionWithApprovalMode,
  buildSessionWithCodexSandboxMode,
} from "../../src/runtime-option-state.js";

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
