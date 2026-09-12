import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_SESSION_WORKSPACE_AVAILABILITY,
  applySessionWorkspaceAvailabilityResult,
  beginSessionWorkspaceAvailabilityCheck,
  isSessionWorkspaceAvailable,
  isSessionWorkspaceFileExplorerEnabled,
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

// @test-value v2
// kind = "invariant"
// claim = "Session切替後は前のWorkspace確認結果を新しいSessionへ投影せず、現在の確認状態を保持する"
// oracle = { type = "contract", ref = "session workspace availability owner boundary" }
// fault = "古いSessionの確認結果を新しいSessionのWorkspace状態やエラーメッセージとして表示する"
// observable = "applySessionWorkspaceAvailabilityResultの返り値とresolveSessionWorkspaceUnavailableMessageの返り値"
// observation_boundary = "component-behavior"
// scope = "Session workspace availability owner boundary"
// lifecycle = "permanent"
// distinction = "同一Workspaceの再確認中のFile Explorer保持ではなく、Session切替時のstale結果排除を確認する"
// @end-test-value
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
    resolveSessionWorkspaceUnavailableMessage(result, "s-1", "C:/old"),
    "",
  );
  assert.equal(
    resolveSessionWorkspaceUnavailableMessage(result, "s-2", "C:/next"),
    "",
  );
});

// @test-value v2
// kind = "invariant"
// claim = "同じSessionとWorkspaceの再確認中だけ、既知の有効状態をFile Explorerのenabled判定へ引き継ぐ"
// oracle = { type = "contract", ref = "v6.3.27 left pane state" }
// fault = "workspace確認中の一時的なcheckingをroot無効化と誤認し、File Explorerを再読込するenabled判定を返す"
// observable = "isSessionWorkspaceFileExplorerEnabledの返り値"
// observation_boundary = "component-behavior"
// scope = "Session workspace availability File Explorer enabled projection"
// lifecycle = "permanent"
// impact = "prompt送信などの再確認でFile Explorerのreload effectを起こさず、実際にWorkspaceが無効になった場合は既存の無効化を維持する"
// distinction = "Paneの実stateではなく、AppがPaneへ渡すowner一致・再確認中のenabled判定を直接確認する"
// @end-test-value
test("File Explorerのenabled判定は同一Workspaceの再確認中だけ既存状態を維持する", () => {
  const checking = beginSessionWorkspaceAvailabilityCheck("s-1", "C:/workspace", 2);
  const unavailable = applySessionWorkspaceAvailabilityResult(
    checking,
    "s-1",
    "C:/workspace",
    2,
    { valid: false, reason: "missing" },
  );

  assert.equal(isSessionWorkspaceFileExplorerEnabled(checking, "s-1", "C:/workspace", true), true);
  assert.equal(isSessionWorkspaceFileExplorerEnabled(checking, "s-1", "C:/workspace", false), false);
  assert.equal(isSessionWorkspaceFileExplorerEnabled(checking, "s-2", "C:/workspace", true), false);
  assert.equal(isSessionWorkspaceFileExplorerEnabled(checking, "s-1", "C:/other", true), false);
  assert.equal(isSessionWorkspaceFileExplorerEnabled(unavailable, "s-1", "C:/workspace", true), false);
});
