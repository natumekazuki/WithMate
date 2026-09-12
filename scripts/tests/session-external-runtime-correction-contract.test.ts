import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { baselineSessionAuthorityPermissions } from "../../src-electron/session-authority-storage.js";
import {
  createSessionRuntimeResult,
  parseSessionRuntimeOperationInput,
  sessionRuntimeOperationMayHaveEffect,
} from "../../src/session-external-runtime-contract.js";
import { parseSessionRuntimeResultEnvelope } from "../../src/session-external-runtime-schema.js";

const workItem = {
  id: "root-work",
  sequence: 1,
  contractRevision: 2,
  kind: "root",
  rootSessionId: "root",
  creatorSessionId: "root",
  targetSessionId: "root",
  parentWorkItemId: null,
  goal: "goal",
  scope: "scope",
  completionCriteria: "done",
  authority: "owner",
  sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
  resultRevision: 2,
  resultCurrent: true,
  stale: false,
  state: "completed",
  revision: 3,
  result: {
    outcome: "completed",
    summary: "current",
    changes: [],
    verificationResults: [],
    findings: [],
    unverifiedItems: [],
    remainingWork: [],
    reportingSessionId: "root",
    reportedAt: "2026-09-13T00:00:00.000Z",
  },
  progressSummary: "done",
  blockers: [],
  nextAction: "none",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

describe("Session external runtime correction contract", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "correction inputはchild result revision zeroとstrict unionを共有し、未知fieldをtransport間で受理しない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/09-public-api-migration-and-review.md" }
  // fault = "result未生成childのrevision zeroまたはcorrection unionの未知fieldがadapterごとに別扱いになる"
  // observable = "canonical input parserのaccepted zero revisionとINVALID_INPUT"
  // observation_boundary = "public-boundary"
  // scope = "work.aggregation.correct strict input"
  // lifecycle = "permanent"
  // distinction = "storage testはtransactionを確認し、ここではadapter共通のstrict input boundaryを確認する"
  // @end-test-value
  it("work.aggregation.correctはresult revision 0とstrict unionを受理する", () => {
    const parsed = parseSessionRuntimeOperationInput("work.aggregation.correct", {
      parentWorkItemId: "parent",
      childWorkItemId: "child",
      expectedAggregateRevision: 1,
      expectedChildResultRevision: 0,
      correction: { kind: "withdraw", reason: "obsolete result" },
      idempotencyKey: "correction-1",
    });
    assert.equal((parsed as { expectedChildResultRevision: number }).expectedChildResultRevision, 0);
    assert.throws(() => parseSessionRuntimeOperationInput("work.aggregation.correct", {
      parentWorkItemId: "parent",
      childWorkItemId: "child",
      expectedAggregateRevision: 1,
      expectedChildResultRevision: 0,
      correction: { kind: "withdraw", unexpected: true },
      idempotencyKey: "correction-2",
    }));
  });

  // @test-value v2
  // kind = "contract"
  // claim = "correction success outputはcurrent resultとstale propagationを隠さず公開する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/03-result-and-aggregation-correction.md" }
  // fault = "adapterが訂正を成功扱いしながらresultRevisionまたはstaleを落とす"
  // observable = "strict result envelopeのresultRevision、supersede、staleParentWorkItemIds"
  // observation_boundary = "public-boundary"
  // scope = "work.result.correct and work.aggregation.correct output"
  // lifecycle = "permanent"
  // distinction = "domain testは永続化を確認し、ここではadapter output contractを確認する"
  // @end-test-value
  it("correction outputはrevisionとstale情報をcanonical schemaで検証する", () => {
    const result = createSessionRuntimeResult("work.result.correct", {
      workItem,
      resultRevision: 2,
      supersededResultRevision: 1,
      stale: true,
      staleParentWorkItemIds: ["parent"],
    });
    const parsed = parseSessionRuntimeResultEnvelope("work.result.correct", result);
    assert.equal(parsed.result.resultRevision, 2);
    assert.deepEqual(parsed.result.staleParentWorkItemIds, ["parent"]);
    assert.equal(sessionRuntimeOperationMayHaveEffect("work.result.correct"), true);
    assert.equal(sessionRuntimeOperationMayHaveEffect("work.aggregation.correct"), true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "correction capabilityはbaseline grantへ暗黙追加されず、明示grant発行境界を維持する"
  // oracle = { type = "adr", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/05-grants-routing-and-transfer.md" }
  // fault = "新operationの公開追加により既存roleのbaseline authorityが自動拡張される"
  // observable = "role baseline permission setからcorrection operationが不在"
  // observation_boundary = "public-boundary"
  // scope = "work result and aggregation correction authority"
  // lifecycle = "permanent"
  // distinction = "registry mappingの存在とは別に、baseline grant issuanceが不変であることを検証する"
  // @end-test-value
  it("correction operationはbaseline permissionへ暗黙追加されない", () => {
    const baseline = baselineSessionAuthorityPermissions("task-coordinator").map((item) => item.action);
    assert.equal(baseline.includes("work.result.correct"), false);
    assert.equal(baseline.includes("work.aggregation.correct"), false);
  });
});
