import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reconcileAuxiliaryLaunchCreation } from "../../src/chat/auxiliary-launch-reconciliation.js";
import type { AuxiliaryCreationRequest, AuxiliaryCreationResult, AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";

const request: AuxiliaryCreationRequest = {
  parentSessionId: "parent-1",
  clientRequestId: "request-1",
  creationContext: { generationId: "generation-1", parentIncarnationId: "incarnation-1" },
};
const session: AuxiliarySession = {
  id: "aux-1",
  parentSessionId: request.parentSessionId,
  clientRequestId: request.clientRequestId,
  creationContext: request.creationContext,
} as AuxiliarySession;

describe("auxiliary-launch-reconciliation", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "selectionが切り替わった旧Auxiliary作成結果を適用しない"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#ui-flow" }
  // fault = "deferredな旧parentの照会結果を現在のrendererへ追加する"
  // observable = "reconcile結果のstaleと適用callback呼出し回数"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-launch-reconciliation"
  // lifecycle = "permanent"
  // distinction = "単純なrequest ID判定ではなく、非同期照会中のcurrent identity再確認を検証する"
  // @end-test-value
  it("selection切替後の旧create応答をstaleとして破棄する", async () => {
    let release!: (result: AuxiliarySession) => void;
    const deferred = new Promise<AuxiliarySession>((resolve) => { release = resolve; });
    let sessionRequested!: () => void;
    const readingSession = new Promise<void>((resolve) => { sessionRequested = resolve; });
    let current = true;
    let applied = 0;
    const resultPromise = reconcileAuxiliaryLaunchCreation({
      request,
      getCreation: async () => ({ status: "committed", auxiliarySessionId: session.id }),
      getSession: async () => { sessionRequested(); return deferred; },
      isCurrent: () => current,
      onStatus: () => undefined,
      onCommittedSession: () => { applied += 1; },
    });
    await readingSession;
    current = false;
    release(session);
    assert.deepEqual(await resultPromise, { status: "committed", applied: false, stale: true });
    assert.equal(applied, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "unknown要求を再照会して後発committedのSessionを適用する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "unknownを確定した失敗として扱い、後発のcommit結果を適用できない"
  // observable = "後発committedのsession適用callbackとstatus履歴"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-launch-reconciliation"
  // lifecycle = "permanent"
  // distinction = "create promiseの成功とは別に、照会結果のunknownからcommittedへの収束を確認する"
  // @end-test-value
  it("unknownからの後発commitを再照会して適用する", async () => {
    const statuses: AuxiliaryCreationResult["status"][] = [];
    let applied = 0;
    let next: AuxiliaryCreationResult = { status: "unknown" };
    const query = () => {
      const result = next;
      next = { status: "committed", auxiliarySessionId: session.id };
      return Promise.resolve(result);
    };
    const first = await reconcileAuxiliaryLaunchCreation({
      request,
      getCreation: query,
      getSession: async () => session,
      isCurrent: () => true,
      onStatus: (status) => statuses.push(status),
      onCommittedSession: () => { applied += 1; },
    });
    const second = await reconcileAuxiliaryLaunchCreation({
      request,
      getCreation: query,
      getSession: async () => session,
      isCurrent: () => true,
      onStatus: (status) => statuses.push(status),
      onCommittedSession: () => { applied += 1; },
    });
    assert.equal(first.applied, false);
    assert.equal(second.applied, true);
    assert.deepEqual(statuses, ["unknown", "committed"]);
    assert.equal(applied, 1);
  });
});
