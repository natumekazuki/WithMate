import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_RESET_APP_DATABASE_TARGETS,
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
} from "../../src-shared/window/withmate-window-types.js";

/** データベース初期化の対象の既定値と全選択の判定を検証する。 */
describe("resetAppDatabaseTargets", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "未指定のDB resetはSession・App Settingsを全対象にする"
  // oracle = { type = "contract", ref = "src-shared/window/withmate-window-types.ts ResetAppDatabaseTarget" }
  // fault = "未指定resetが保存領域を取りこぼすか対象外領域を含む"
  // observable = "normalizeResetAppDatabaseTargetsの対象一覧"
  // observation_boundary = "public-boundary"
  // scope = "DB reset target normalization"
  // lifecycle = "permanent"
  // @end-test-value
  /** 対象を省略したときに Session とアプリ設定の両方を選ぶことを確認する。 */
  it("未指定時は全対象を返す", () => {
    assert.deepEqual(normalizeResetAppDatabaseTargets(undefined), [
      ...ALL_RESET_APP_DATABASE_TARGETS,
    ]);
    assert.deepEqual(
      new Set(normalizeResetAppDatabaseTargets(undefined)),
      new Set(["sessions", "appSettings"]),
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "DB resetの全対象選択は全保存領域の選択と部分選択を区別する"
  // oracle = { type = "contract", ref = "src-shared/window/withmate-window-types.ts areAllResetAppDatabaseTargetsSelected" }
  // fault = "部分選択を全選択と誤判定する"
  // observable = "全対象とApp Settingsのみの判定boolean"
  // observation_boundary = "public-boundary"
  // scope = "DB reset target selection"
  // lifecycle = "permanent"
  // @end-test-value
  /** アプリ設定だけの初期化を全領域の初期化と判定しないことを確認する。 */
  it("全対象選択を判定できる", () => {
    assert.equal(
      areAllResetAppDatabaseTargetsSelected(ALL_RESET_APP_DATABASE_TARGETS),
      true,
    );
    assert.equal(areAllResetAppDatabaseTargetsSelected(["appSettings"]), false);
  });
});
