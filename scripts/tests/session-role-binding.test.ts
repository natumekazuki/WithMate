import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChildSessionRoleBinding,
  buildRootSessionRoleBinding,
  requireChildSessionRoleAllowed,
  requireSessionRoleBinding,
  SESSION_ROLE_CHILDREN,
  SESSION_ROLE_CONTRACT_REVISION,
  SESSION_ROLE_MAX_DELEGATION_DEPTH,
  SESSION_ROLE_VALUES,
  SessionRoleBindingError,
} from "../../src/session-role-binding.js";
import {
  buildCreateSessionRequestFromLaunchDraft,
  createClosedLaunchDraft,
} from "../../src/home/home-launch-state.js";

describe("Session Role binding", () => {
  it("revision、Role、child規則、最大depthを閉じたcontractとして固定する", () => {
    assert.equal(SESSION_ROLE_CONTRACT_REVISION, 1);
    assert.equal(SESSION_ROLE_MAX_DELEGATION_DEPTH, 2);
    assert.deepEqual(SESSION_ROLE_VALUES, [
      "standalone",
      "overall-coordinator",
      "task-coordinator",
      "executor",
    ]);
    assert.deepEqual(SESSION_ROLE_CHILDREN, {
      standalone: [],
      "overall-coordinator": ["task-coordinator", "executor"],
      "task-coordinator": ["executor"],
      executor: [],
    });
  });

  it("rootとdepth 2までのchild tupleをcaller入力なしで導出する", () => {
    const root = buildRootSessionRoleBinding("root", "overall-coordinator");
    const coordinator = buildChildSessionRoleBinding("task", "root", root, "task-coordinator");
    const executor = buildChildSessionRoleBinding("executor", "task", coordinator, "executor");

    assert.deepEqual(root, {
      sessionRole: "overall-coordinator",
      roleContractRevision: 1,
      rootSessionId: "root",
      parentSessionId: null,
      delegationDepth: 0,
    });
    assert.deepEqual(coordinator, {
      sessionRole: "task-coordinator",
      roleContractRevision: 1,
      rootSessionId: "root",
      parentSessionId: "root",
      delegationDepth: 1,
    });
    assert.deepEqual(executor, {
      sessionRole: "executor",
      roleContractRevision: 1,
      rootSessionId: "root",
      parentSessionId: "task",
      delegationDepth: 2,
    });
  });

  it("Role違反、depth超過、unknown Role、unsupported revision、壊れたtupleを拒否する", () => {
    const standalone = buildRootSessionRoleBinding("standalone", "standalone");
    const overall = buildRootSessionRoleBinding("root", "overall-coordinator");
    const task = buildChildSessionRoleBinding("task", "root", overall, "task-coordinator");
    const depthTwoExecutor = buildChildSessionRoleBinding("executor", "task", task, "executor");

    assert.throws(
      () => requireChildSessionRoleAllowed(standalone, "executor"),
      (error) => error instanceof SessionRoleBindingError && error.code === "SESSION_ROLE_FORBIDDEN",
    );
    assert.throws(
      () => requireChildSessionRoleAllowed(depthTwoExecutor, "executor"),
      (error) => error instanceof SessionRoleBindingError && error.code === "SESSION_ROLE_FORBIDDEN",
    );
    assert.throws(
      () => requireChildSessionRoleAllowed({ ...task, delegationDepth: 2 }, "executor"),
      (error) => error instanceof SessionRoleBindingError && error.code === "SESSION_ROLE_DEPTH_EXCEEDED",
    );
    for (const binding of [
      { ...overall, sessionRole: "unknown" },
      { ...overall, roleContractRevision: 2 },
      { ...overall, rootSessionId: "other-root" },
      { ...task, delegationDepth: 2 },
    ]) {
      assert.throws(() => requireSessionRoleBinding("root", binding), SessionRoleBindingError);
    }
  });
});

describe("GUI root Session purpose", () => {
  const buildRequest = (sessionPurpose: "standalone" | "overall-coordinator") => buildCreateSessionRequestFromLaunchDraft({
    draft: {
      ...createClosedLaunchDraft(),
      open: true,
      title: "Session",
      sessionPurpose,
      workspace: { kind: "session-folder" },
    },
    mateProfile: null,
    selectedProviderId: "codex",
  });

  it("既定をstandaloneとし、選択したroot Roleをそのまま作成requestへ渡す", () => {
    assert.equal(createClosedLaunchDraft().sessionPurpose, "standalone");
    assert.equal(buildRequest("standalone")?.rootSessionRole, "standalone");
    assert.equal(buildRequest("overall-coordinator")?.rootSessionRole, "overall-coordinator");
  });
});
