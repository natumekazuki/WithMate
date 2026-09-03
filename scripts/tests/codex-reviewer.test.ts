import assert from "node:assert/strict";
import test from "node:test";

import {
  getCodexReviewerOptions,
  isCodexReviewerControlDisabled,
  mapCodexReviewerToApprovalsReviewer,
  normalizeCodexReviewer,
} from "../../src/codex-reviewer.js";
import { buildSessionWithApprovalMode } from "../../src/runtime-option-state.js";

// @test-value v1
// kind = "contract"
// claim = "Reviewerの未知値はUserへ正規化され、SDK値とCodex限定の選択肢へ一意に変換される"
// oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-1" }
// failure_mode = "未知値がAuto-reviewへ昇格する、SDKへ誤った値を渡す、または非Codex providerにReviewerを表示する"
// scope = "codex-reviewer"
// lifecycle = "permanent"
// @end-test-value
test("Reviewerを正規化してSDK値とprovider別選択肢へ写像する", () => {
  assert.equal(normalizeCodexReviewer("auto-review"), "auto-review");
  assert.equal(normalizeCodexReviewer("unexpected"), "user");
  assert.equal(normalizeCodexReviewer(undefined), "user");
  assert.equal(mapCodexReviewerToApprovalsReviewer("user"), "user");
  assert.equal(mapCodexReviewerToApprovalsReviewer("auto-review"), "auto_review");
  assert.deepEqual(getCodexReviewerOptions("codex"), [
    { value: "user", label: "User" },
    { value: "auto-review", label: "Auto-review" },
  ]);
  assert.deepEqual(getCodexReviewerOptions("copilot"), []);
});

// @test-value v1
// kind = "invariant"
// claim = "approvalModeがneverの間はReviewer controlだけが無効になり、保存済みReviewer値は保持される"
// oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-3" }
// failure_mode = "neverへの変更でReviewer値がUserへ上書きされる、またはinteractiveへ戻しても以前の選択を再利用できない"
// scope = "codex-reviewer-control-state"
// lifecycle = "permanent"
// @end-test-value
test("neverではReviewer変更を無効化し保存値をinteractive復帰後も保持する", () => {
  const session = { approvalMode: "on-request" as const, codexReviewer: "auto-review" as const };
  const neverSession = buildSessionWithApprovalMode(session, "never", "2026-09-04T00:00:00.000Z");
  assert.equal(neverSession?.codexReviewer, "auto-review");
  assert.equal(isCodexReviewerControlDisabled({
    approvalMode: "never",
    isRunning: false,
    composerBlocked: false,
  }), true);
  assert.equal(isCodexReviewerControlDisabled({
    approvalMode: "on-request",
    isRunning: false,
    composerBlocked: false,
  }), false);
});
