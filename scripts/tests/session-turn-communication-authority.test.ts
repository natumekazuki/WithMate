import assert from "node:assert/strict";
import { test } from "node:test";

import { canSendSessionTurn } from "../../src/session-turn-communication-authority.js";
import type { SessionRole } from "../../src/session-role-binding.js";

function principal(
  sessionId: string,
  sessionRole: SessionRole,
  rootSessionId: string,
  parentSessionId: string | null,
  delegationDepth: number,
) {
  return {
    sessionId,
    sessionRole,
    roleContractRevision: 1 as const,
    rootSessionId,
    parentSessionId,
    delegationDepth,
  };
}

const root = principal("root", "overall-coordinator", "root", null, 0);
const taskA = principal("task-a", "task-coordinator", "root", "root", 1);
const taskB = principal("task-b", "task-coordinator", "root", "root", 1);
const directExecutor = principal("executor-root", "executor", "root", "root", 1);
const executorA = principal("executor-a", "executor", "root", "task-a", 2);
const executorB = principal("executor-b", "executor", "root", "task-b", 2);
const otherRoot = principal("other-root", "overall-coordinator", "other-root", null, 0);
const standalone = principal("standalone", "standalone", "standalone", null, 0);

test("ORCH-AUTH-02: Roleとhierarchyの許可辺をcanonical tupleで判定する", () => {
  for (const [actor, targets] of [
    [standalone, [standalone]],
    [root, [root, taskA, taskB, directExecutor]],
    [taskA, [taskA, root, taskB, executorA]],
    [executorA, [executorA, taskA]],
    [directExecutor, [directExecutor, root]],
  ] as const) {
    for (const target of targets) {
      assert.equal(canSendSessionTurn(actor, target), true, `${actor.sessionId} -> ${target.sessionId}`);
    }
  }
});

test("ORCH-AUTH-02: 異root、孫、兄弟executor、別branchを拒否する", () => {
  for (const [actor, target] of [
    [standalone, root],
    [root, executorA],
    [taskA, executorB],
    [executorA, taskB],
    [executorA, executorB],
    [taskA, otherRoot],
    [root, otherRoot],
  ] as const) {
    assert.equal(canSendSessionTurn(actor, target), false, `${actor.sessionId} -> ${target.sessionId}`);
  }
});
