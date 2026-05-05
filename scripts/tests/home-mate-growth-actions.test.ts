import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyHomePendingGrowth,
  type HomeMateGrowthApplyApi,
} from "../../src/home-mate-growth-actions.js";

function createApi(overrides?: Partial<HomeMateGrowthApplyApi>): HomeMateGrowthApplyApi {
  return {
    applyPendingGrowth: async () => ({
      candidateCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      revisionId: null,
    }),
    ...overrides,
  };
}

describe("applyHomePendingGrowth", () => {
  it("candidate/applied/skipped/revisionId を反映した feedback を返す", async () => {
    const feedback = await applyHomePendingGrowth(
      createApi({
        applyPendingGrowth: async () => ({
          candidateCount: 3,
          appliedCount: 2,
          skippedCount: 1,
          revisionId: "rev-001",
        }),
      }),
    );

    assert.equal(feedback, "Mate 成長を手動適用したよ（候補 3 件 / 適用 2 件 / スキップ 1 件 / revisionId rev-001）。");
  });

  it("API の reject はそのまま伝播される", async () => {
    const error = new Error("apply failed");
    await assert.rejects(
      () =>
        applyHomePendingGrowth({
          applyPendingGrowth: async () => {
            throw error;
          },
        }),
      error,
    );
  });
});
