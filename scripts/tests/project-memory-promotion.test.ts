import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionMemoryDelta } from "../../src/app-state.js";
import { buildProjectMemoryPromotionEntries } from "../../src-electron/project-memory-promotion.js";

describe("buildProjectMemoryPromotionEntries", () => {
  it("decisions を decision category として昇格する", () => {
    const entries = buildProjectMemoryPromotionEntries(
      { id: "session-1" },
      "scope-1",
      {
        decisions: ["Copilot の image は file attachment として扱う"],
      },
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.category, "decision");
    assert.equal(entries[0]?.projectScopeId, "scope-1");
    assert.equal(entries[0]?.sourceSessionId, "session-1");
    assert.match(entries[0]?.keywords.join(" ") ?? "", /copilot/i);
  });

  it("tag 付き notes だけを project memory へ昇格する", () => {
    const delta: SessionMemoryDelta = {
      notes: [
        "制約: Copilot の approval callback は SDK 待ち",
        "慣例: DB schema を変えたら docs/design/database-schema.md を更新する",
        "これは単なる補助メモ",
      ],
    };

    const entries = buildProjectMemoryPromotionEntries({ id: "session-1" }, "scope-1", delta);

    assert.deepEqual(
      entries.map((entry) => [entry.category, entry.detail]),
      [
        ["constraint", "Copilot の approval callback は SDK 待ち"],
        ["convention", "DB schema を変えたら docs/design/database-schema.md を更新する"],
      ],
    );
  });

  it("goal と openQuestions と nextActions は昇格しない", () => {
    const entries = buildProjectMemoryPromotionEntries(
      { id: "session-1" },
      "scope-1",
      {
        goal: "Memory 設計を整理する",
        openQuestions: ["Project Memory retrieval の threshold をどうするか"],
        nextActions: ["Project Memory の retrieval を実装する"],
      },
    );

    assert.equal(entries.length, 0);
  });

  it("同一内容は batch 内で重複昇格しない", () => {
    const entries = buildProjectMemoryPromotionEntries(
      { id: "session-1" },
      "scope-1",
      {
        decisions: [
          "長期記憶の名称は Project Memory とする",
          "長期記憶の名称は Project Memory とする",
        ],
      },
    );

    assert.equal(entries.length, 1);
  });
});
