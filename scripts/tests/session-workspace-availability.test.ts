import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_SESSION_WORKSPACE_AVAILABILITY,
  applySessionWorkspaceAvailabilityResult,
  beginSessionWorkspaceAvailabilityCheck,
  isSessionWorkspaceAvailable,
  resolveSessionWorkspaceBlockedReason,
  resolveSessionWorkspaceExecutionGate,
  resolveSessionWorkspaceUnavailableMessage,
} from "../../src/session-workspace-availability.js";

test("Session Workspace は確認完了まで送信不可で missing の原因と復旧方法を投影する", () => {
  assert.deepEqual(
    resolveSessionWorkspaceExecutionGate(INITIAL_SESSION_WORKSPACE_AVAILABILITY, "s-1", "C:/missing"),
    { isPending: true, blockedReason: "" },
  );

  const checking = beginSessionWorkspaceAvailabilityCheck("s-1", "C:/missing", 1);

  assert.equal(
    resolveSessionWorkspaceBlockedReason(checking, "s-1", "C:/missing"),
    "",
  );
  assert.deepEqual(
    resolveSessionWorkspaceExecutionGate(checking, "s-1", "C:/missing"),
    { isPending: true, blockedReason: "" },
  );

  const unavailable = applySessionWorkspaceAvailabilityResult(
    checking,
    "s-1",
    "C:/missing",
    1,
    { valid: false, reason: "missing" },
  );
  assert.equal(isSessionWorkspaceAvailable(unavailable, "s-1", "C:/missing"), false);
  assert.deepEqual(
    resolveSessionWorkspaceExecutionGate(unavailable, "s-1", "C:/missing"),
    {
      isPending: false,
      blockedReason: "Workspace not found: C:/missing. Restore it, then recheck.",
    },
  );
  assert.match(
    resolveSessionWorkspaceUnavailableMessage(unavailable, "s-1", "C:/missing"),
    /Workspace not found.*Restore it, then recheck\./,
  );
});

test("Session Workspace は同じ Session の古い確認結果を無視し、再確認成功で復旧する", () => {
  const firstCheck = beginSessionWorkspaceAvailabilityCheck("s-1", "C:/workspace", 1);
  const secondCheck = beginSessionWorkspaceAvailabilityCheck("s-1", "C:/workspace", 2);
  const afterStaleResult = applySessionWorkspaceAvailabilityResult(
    secondCheck,
    "s-1",
    "C:/workspace",
    1,
    { valid: false, reason: "missing" },
  );

  assert.equal(afterStaleResult, secondCheck);

  const available = applySessionWorkspaceAvailabilityResult(
    afterStaleResult,
    "s-1",
    "C:/workspace",
    2,
    { valid: true },
  );
  assert.equal(isSessionWorkspaceAvailable(available, "s-1", "C:/workspace"), true);
  assert.equal(resolveSessionWorkspaceBlockedReason(available, "s-1", "C:/workspace"), "");
  assert.deepEqual(
    resolveSessionWorkspaceExecutionGate(available, "s-1", "C:/workspace"),
    { isPending: false, blockedReason: "" },
  );
  assert.equal(resolveSessionWorkspaceUnavailableMessage(available, "s-1", "C:/workspace"), "");
});

test("Session 切替後は前の Workspace 確認結果を投影しない", () => {
  const nextSessionCheck = beginSessionWorkspaceAvailabilityCheck("s-2", "C:/next", 2);
  const result = applySessionWorkspaceAvailabilityResult(
    nextSessionCheck,
    "s-1",
    "C:/old",
    1,
    { valid: false, reason: "missing" },
  );

  assert.equal(result, nextSessionCheck);
  assert.equal(
    resolveSessionWorkspaceUnavailableMessage(INITIAL_SESSION_WORKSPACE_AVAILABILITY, "s-1", "C:/old"),
    "",
  );
});
