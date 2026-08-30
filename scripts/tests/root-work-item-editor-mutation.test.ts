import assert from "node:assert/strict";
import test from "node:test";

import type { RootWorkItem } from "../../src/work-item.js";
import {
  RootWorkItemEditorSaveError,
  saveRootWorkItemEditor,
} from "../../src/root-work-item-editor-mutation.js";

const rootWorkItem: RootWorkItem = {
  id: "root-1",
  sequence: 1,
  contractRevision: 2,
  revision: 4,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T01:00:00.000Z",
  kind: "root",
  rootSessionId: "session-1",
  creatorSessionId: "session-1",
  targetSessionId: "session-1",
  parentWorkItemId: null,
  goal: "Root goal",
  scope: "Repository source",
  completionCriteria: "Tests pass",
  authority: "Owner",
  sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
  state: "in_progress",
  result: null,
  progressSummary: "Storage",
  blockers: [],
  nextAction: "Review",
};

// @test-value v1
// kind = "regression"
// claim = "Root WorkItem editorの契約改訂後にprogress保存が失敗した場合、改訂済みrevisionを後続requestへ渡し、部分成功を識別できるerrorとして返す"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6-ui" }
// failure_mode = "二つのcommitの後半失敗を全体未適用として表示し、利用者が保存済み契約を古いrevisionで再送する"
// scope = "Root WorkItem editor mutation orchestration"
// lifecycle = "permanent"
// distinction = "最初のreviseだけ成功させ、appendへ渡るexpectedRevisionとerrorのcontractRevisionCommittedを直接観測する"
// @end-test-value
test("Root WorkItem editorは契約改訂後のprogress失敗を部分成功として返す", async () => {
  const calls: Array<{ operation: string; expectedRevision: number }> = [];
  const revised = { ...rootWorkItem, goal: "Revised goal", revision: 5 };
  await assert.rejects(
    saveRootWorkItemEditor(rootWorkItem, {
      expectedRevision: 4,
      goal: "Revised goal",
      scope: rootWorkItem.scope,
      completionCriteria: rootWorkItem.completionCriteria,
      authority: rootWorkItem.authority,
      progressSummary: "Updated progress",
      blockers: [],
      nextAction: rootWorkItem.nextAction,
    }, {
      async revise(request) {
        calls.push({ operation: "revise", expectedRevision: request.expectedRevision });
        return revised;
      },
      async appendProgress(request) {
        calls.push({ operation: "append", expectedRevision: request.expectedRevision });
        throw new Error("append failed");
      },
      createIdempotencyKey: () => "key-" + calls.length,
    }),
    (error) => error instanceof RootWorkItemEditorSaveError
      && error.contractRevisionCommitted
      && error.message === "append failed",
  );
  assert.deepEqual(calls, [
    { operation: "revise", expectedRevision: 4 },
    { operation: "append", expectedRevision: 5 },
  ]);
});

// @test-value v1
// kind = "regression"
// claim = "Root WorkItem editorは外部更新後のcurrent projectionではなく編集開始時のbase revisionを最初のmutationへ渡し、stale draftをrevision conflictへ収束させる"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#6-ui" }
// failure_mode = "外部更新でrevisionだけを最新化したstale draftが競合せず、外部のcontractまたはprogressを上書きする"
// scope = "Root WorkItem editor mutation orchestration"
// lifecycle = "permanent"
// distinction = "current projectionをrevision 5、editor baseをrevision 4として、最初のrevise requestだけを直接観測する"
// @end-test-value
test("Root WorkItem editorは編集開始revisionで外部更新との競合を検出する", async () => {
  const current = { ...rootWorkItem, goal: "Externally revised", revision: 5 };
  const expectedRevisions: number[] = [];
  await assert.rejects(
    saveRootWorkItemEditor(current, {
      expectedRevision: 4,
      goal: rootWorkItem.goal,
      scope: rootWorkItem.scope,
      completionCriteria: rootWorkItem.completionCriteria,
      authority: rootWorkItem.authority,
      progressSummary: rootWorkItem.progressSummary,
      blockers: [],
      nextAction: rootWorkItem.nextAction,
    }, {
      async revise(request) {
        expectedRevisions.push(request.expectedRevision);
        throw new Error("revision conflict");
      },
      async appendProgress() {
        assert.fail("progress must not be appended after a stale contract revision");
      },
      createIdempotencyKey: () => "stale-editor-key",
    }),
    (error) => error instanceof RootWorkItemEditorSaveError
      && !error.contractRevisionCommitted
      && error.message === "revision conflict",
  );
  assert.deepEqual(expectedRevisions, [4]);
});
