import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SETTINGS_SESSION_TURN_NOTIFICATION_LABEL,
  SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL,
} from "../../src/settings/settings-ui.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "../../src-electron/windows/window-defaults.js";

/** 設定項目の識別に使うラベルと、設定を開く Home Window の寸法契約を確認する。 */
describe("Settings UI constants", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Session turn notificationのapp-owned labelはTitle Caseで設定対象を識別し、response preview labelも同じ規則を使う"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
  // fault = "通知設定とresponse preview設定のlabelを取り違え、別の設定対象と誤認させる"
  // observable = "Session turn notification labelとresponse preview label"
  // observation_boundary = "public-boundary"
  // scope = "settings-ui session notification wording"
  // lifecycle = "permanent"
  // @end-test-value
  /** Turn 通知の有効化と応答プレビューを、英語の Title Case の異なるラベルで識別できる。 */
  it("Session turn notification はTitle Case labelで設定対象を識別する", () => {
    assert.equal(
      SETTINGS_SESSION_TURN_NOTIFICATION_LABEL,
      "Session Turn Notification",
    );
    assert.equal(
      SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL,
      "Notification Response Preview",
    );
  });

  /** Home の初期寸法と最小寸法を比較し、Settings overlay を開くための既定の広さが変わらないことを確認する。 */
  it("Home Window は Settings overlay の余裕を確保する既定サイズを使う", () => {
    assert.deepEqual(HOME_WINDOW_DEFAULT_BOUNDS, {
      width: 1440,
      height: 960,
      minWidth: 900,
      minHeight: 680,
    });
  });
});
