import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldScheduleMateMemoryGeneration } from "../../src-electron/mate-memory-generation-scheduling.js";

const enabledAppSettings = { memoryGenerationEnabled: true };
const disabledAppSettings = { memoryGenerationEnabled: false };
const everyTurnGrowthSettings = { enabled: true, memoryCandidateMode: "every_turn" as const };

describe("shouldScheduleMateMemoryGeneration", () => {
  it("app 設定、Mate active、Growth every_turn が揃うと生成を予約する", () => {
    assert.equal(shouldScheduleMateMemoryGeneration({
      appSettings: enabledAppSettings,
      mateState: "active",
      growthSettings: everyTurnGrowthSettings,
    }), true);
  });

  it("app の memory generation が無効なら予約しない", () => {
    assert.equal(shouldScheduleMateMemoryGeneration({
      appSettings: disabledAppSettings,
      mateState: "active",
      growthSettings: everyTurnGrowthSettings,
    }), false);
  });

  it("Mate が active でない場合は予約しない", () => {
    assert.equal(shouldScheduleMateMemoryGeneration({
      appSettings: enabledAppSettings,
      mateState: "draft",
      growthSettings: everyTurnGrowthSettings,
    }), false);
  });

  it("Growth 設定がない、または Growth が無効なら予約しない", () => {
    assert.equal(shouldScheduleMateMemoryGeneration({
      appSettings: enabledAppSettings,
      mateState: "active",
      growthSettings: null,
    }), false);
    assert.equal(shouldScheduleMateMemoryGeneration({
      appSettings: enabledAppSettings,
      mateState: "active",
      growthSettings: { enabled: false, memoryCandidateMode: "every_turn" },
    }), false);
  });

  it("threshold/manual は現行 runtime の自動生成対象にしない", () => {
    assert.equal(shouldScheduleMateMemoryGeneration({
      appSettings: enabledAppSettings,
      mateState: "active",
      growthSettings: { enabled: true, memoryCandidateMode: "threshold" },
    }), false);
    assert.equal(shouldScheduleMateMemoryGeneration({
      appSettings: enabledAppSettings,
      mateState: "active",
      growthSettings: { enabled: true, memoryCandidateMode: "manual" },
    }), false);
  });
});
