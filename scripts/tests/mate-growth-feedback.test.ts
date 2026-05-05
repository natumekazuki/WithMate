import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildApplyPendingGrowthFeedback } from "../../src/mate-growth-feedback.js";

describe("buildApplyPendingGrowthFeedback", () => {
  it("null は既定完了メッセージを返す", () => {
    assert.equal(buildApplyPendingGrowthFeedback(null), "Mate 成長の手動適用が完了したよ。");
  });

  it("非 object は既定完了メッセージを返す", () => {
    assert.equal(buildApplyPendingGrowthFeedback("invalid"), "Mate 成長の手動適用が完了したよ。");
    assert.equal(buildApplyPendingGrowthFeedback(100), "Mate 成長の手動適用が完了したよ。");
  });

  it("件数は number のみ採用される", () => {
    assert.equal(
      buildApplyPendingGrowthFeedback({
        candidateCount: 4,
        appliedCount: "2",
        skippedCount: 1,
        revisionId: null,
      }),
      "Mate 成長を手動適用したよ（候補 4 件 / スキップ 1 件）。",
    );
  });

  it("revisionId は string のみ採用される", () => {
    assert.equal(
      buildApplyPendingGrowthFeedback({
        candidateCount: 1,
        appliedCount: 2,
        skippedCount: 3,
        revisionId: "rev-9",
      }),
      "Mate 成長を手動適用したよ（候補 1 件 / 適用 2 件 / スキップ 3 件 / revisionId rev-9）。",
    );
  });

  it("有効フィールドが無い object は既定完了メッセージを返す", () => {
    assert.equal(
      buildApplyPendingGrowthFeedback({ candidateCount: "0", appliedCount: false, skippedCount: true }),
      "Mate 成長の手動適用が完了したよ。",
    );
  });

  it("混在ケースでフィールド順は固定される", () => {
    assert.equal(
      buildApplyPendingGrowthFeedback({
        revisionId: "rev-7",
        candidateCount: 3,
        skippedCount: 1,
        appliedCount: 2,
      }),
      "Mate 成長を手動適用したよ（候補 3 件 / 適用 2 件 / スキップ 1 件 / revisionId rev-7）。",
    );
  });
});
