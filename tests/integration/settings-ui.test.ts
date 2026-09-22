import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SETTINGS_API_KEY_LABEL,
  SETTINGS_API_KEY_PLACEHOLDER,
  SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE,
  SETTINGS_CODING_CREDENTIALS_HELP,
  SETTINGS_MEMORY_FILE_QUOTA_HELP,
  SETTINGS_MEMORY_FILE_QUOTA_LABEL,
  SETTINGS_RELEASE_COMPATIBILITY_NOTE,
  SETTINGS_RESET_DATABASE_HELP,
  SETTINGS_RESET_DATABASE_LABEL,
  SETTINGS_SESSION_TURN_NOTIFICATION_LABEL,
  SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL,
  buildResetDatabaseConfirmMessage,
  buildResetDatabaseSuccessMessage,
} from "../../src/settings/settings-ui.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "../../src-electron/windows/window-defaults.js";
import { ALL_RESET_APP_DATABASE_TARGETS } from "../../src-shared/window/withmate-window-types.js";

describe("Settings UI constants", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Coding AgentのAPI key label、placeholder、helpは資格情報の適用範囲をcoding planeとして示す"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
  // fault = "API keyを汎用またはCharacter側の資格情報として表示し、適用範囲を誤認させる"
  // observable = "API key label、placeholder、Character Streamを除外したfuture scope note"
  // observation_boundary = "public-boundary"
  // scope = "settings-ui coding credential wording"
  // lifecycle = "permanent"
  // @end-test-value
  it("coding credential の API key 文言は coding plane 専用だと分かる", () => {
    assert.equal(SETTINGS_API_KEY_LABEL, "OpenAI API key (coding agent)");
    assert.equal(SETTINGS_API_KEY_PLACEHOLDER, "Enter the OpenAI API key for the coding agent");
    assert.match(SETTINGS_CODING_CREDENTIALS_HELP, /Character Stream/);
    assert.match(SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE, /future scope/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "初回release前の互換性方針とdatabase reset導線は、破壊的影響と実行中Sessionの制約を明示する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
  // fault = "Reset databaseのlabel、Danger zone、確認時の実行中Session制約、保持対象を説明しない"
  // observable = "compatibility note、reset label/help、confirm/success message"
  // observation_boundary = "public-boundary"
  // scope = "settings-ui database reset safety wording"
  // lifecycle = "permanent"
  // @end-test-value
  it("初回リリース前の互換性方針と DB 初期化導線を文言で説明する", () => {
    assert.match(SETTINGS_RELEASE_COMPATIBILITY_NOTE, /before the first release/);
    assert.match(SETTINGS_RELEASE_COMPATIBILITY_NOTE, /compatibility is not supported/);
    assert.equal(SETTINGS_RESET_DATABASE_LABEL, "Reset database");
    assert.match(SETTINGS_RESET_DATABASE_HELP, /Danger zone/);
    assert.match(buildResetDatabaseConfirmMessage(ALL_RESET_APP_DATABASE_TARGETS), /Continue\?/);
    assert.match(buildResetDatabaseConfirmMessage(ALL_RESET_APP_DATABASE_TARGETS), /Running sessions must finish/);
    assert.match(buildResetDatabaseSuccessMessage(ALL_RESET_APP_DATABASE_TARGETS), /including the database and character file bodies/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Memory file quotaの説明はProtected Objectのappend制約を具体的に示す"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
  // fault = "quotaの対象を曖昧にするか、protected objectとfile appendの制約を落とす"
  // observable = "Memory file quota label/helpに含まれるprotected objectsとfile append"
  // observation_boundary = "public-boundary"
  // scope = "settings-ui memory quota wording"
  // lifecycle = "permanent"
  // @end-test-value
  it("Memory file quota は Protected Object の append 制約として説明する", () => {
    assert.equal(SETTINGS_MEMORY_FILE_QUOTA_LABEL, "Memory file quota");
    assert.match(SETTINGS_MEMORY_FILE_QUOTA_HELP, /protected objects/);
    assert.match(SETTINGS_MEMORY_FILE_QUOTA_HELP, /file append/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Session turn notificationのlabelはWindows通知であることとresponse previewの範囲を示す"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md" }
  // fault = "通知対象OSまたはresponse previewの意味を隠し、別の通知設定と誤認させる"
  // observable = "Session turn notification labelとresponse preview label"
  // observation_boundary = "public-boundary"
  // scope = "settings-ui session notification wording"
  // lifecycle = "permanent"
  // @end-test-value
  it("Session turn notification は Windows 通知だと分かる", () => {
    assert.equal(SETTINGS_SESSION_TURN_NOTIFICATION_LABEL, "Show a Windows notification when a session turn finishes");
    assert.equal(
      SETTINGS_SESSION_TURN_NOTIFICATION_RESPONSE_PREVIEW_LABEL,
      "Show the start of the response in the Windows notification",
    );
  });

  it("Home Window は Settings overlay の余裕を確保する既定サイズを使う", () => {
    assert.deepEqual(HOME_WINDOW_DEFAULT_BOUNDS, {
      width: 1440,
      height: 960,
      minWidth: 900,
      minHeight: 680,
    });
  });

});
