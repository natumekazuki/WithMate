import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveMateMemoryGenerationTargetSection } from "../../src-electron/mate-memory-generation-section-classifier.js";

describe("mate-memory-generation-section-classifier", () => {
  it("MateTalk の自己定義は誤分類されても core に補正する", () => {
    assert.equal(resolveMateMemoryGenerationTargetSection({
      sourceType: "mate_talk",
      growthSourceType: "explicit_user_instruction",
      targetSection: "bond",
      statement: "Mate の一人称は「わたし」とする。",
      targetClaimKey: "relationship_calling",
    }), "core");
  });

  it("claim key が自己定義を示す MateTalk 訂正は core に補正する", () => {
    assert.equal(resolveMateMemoryGenerationTargetSection({
      sourceType: "mate_talk",
      growthSourceType: "user_correction",
      targetSection: "work_style",
      statement: "落ち着いた案内役として振る舞う。",
      targetClaimKey: "self_definition.role",
    }), "core");
  });

  it("関係性と作業スタイルは自己定義でなければ維持する", () => {
    assert.equal(resolveMateMemoryGenerationTargetSection({
      sourceType: "mate_talk",
      growthSourceType: "explicit_user_instruction",
      targetSection: "bond",
      statement: "ユーザーの呼び方は「あんた」にする。",
      targetClaimKey: "user_calling",
    }), "bond");
    assert.equal(resolveMateMemoryGenerationTargetSection({
      sourceType: "mate_talk",
      growthSourceType: "explicit_user_instruction",
      targetSection: "work_style",
      statement: "作業では最初に方針を短く共有する。",
      targetClaimKey: "planning_style",
    }), "work_style");
  });

  it("project_digest / none と MateTalk 以外の候補は補正しない", () => {
    assert.equal(resolveMateMemoryGenerationTargetSection({
      sourceType: "mate_talk",
      growthSourceType: "explicit_user_instruction",
      targetSection: "project_digest",
      statement: "Mate の一人称は「わたし」とする。",
    }), "project_digest");
    assert.equal(resolveMateMemoryGenerationTargetSection({
      sourceType: "session",
      growthSourceType: "explicit_user_instruction",
      targetSection: "bond",
      statement: "Mate の一人称は「わたし」とする。",
    }), "bond");
    assert.equal(resolveMateMemoryGenerationTargetSection({
      sourceType: "mate_talk",
      growthSourceType: "explicit_user_instruction",
      targetSection: "unknown",
      statement: "Mate の一人称は「わたし」とする。",
    }), "none");
  });
});
