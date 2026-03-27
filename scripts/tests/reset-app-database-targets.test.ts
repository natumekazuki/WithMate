import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
} from "../../src/withmate-window.js";

describe("resetAppDatabaseTargets", () => {
  it("sessions を選ぶと auditLogs も自動的に含める", () => {
    assert.deepEqual(normalizeResetAppDatabaseTargets(["sessions"]), ["sessions", "auditLogs"]);
  });

  it("未指定時は全対象を返す", () => {
    assert.deepEqual(normalizeResetAppDatabaseTargets(undefined), [...ALL_RESET_APP_DATABASE_TARGETS]);
  });

  it("全対象選択を判定できる", () => {
    assert.equal(areAllResetAppDatabaseTargetsSelected(ALL_RESET_APP_DATABASE_TARGETS), true);
    assert.equal(areAllResetAppDatabaseTargetsSelected(["appSettings", "modelCatalog"]), false);
  });

  it("characterMemory を個別 target として保持する", () => {
    assert.deepEqual(normalizeResetAppDatabaseTargets(["characterMemory"]), ["characterMemory"]);
  });
});
