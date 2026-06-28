import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SETTINGS_API_KEY_LABEL,
  SETTINGS_API_KEY_PLACEHOLDER,
  SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE,
  SETTINGS_CODING_CREDENTIALS_HELP,
  SETTINGS_MEMORY_PROVIDER_INSTRUCTION_SAMPLE_HELP,
  SETTINGS_RELEASE_COMPATIBILITY_NOTE,
  SETTINGS_RESET_DATABASE_HELP,
  SETTINGS_RESET_DATABASE_LABEL,
  buildResetDatabaseConfirmMessage,
  buildResetDatabaseSuccessMessage,
} from "../../src/settings/settings-ui.js";
import { WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE } from "../../src/memory-v6/provider-instruction-sample.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "../../src-electron/window-defaults.js";
import { ALL_RESET_APP_DATABASE_TARGETS } from "../../src/withmate-window-types.js";

describe("Settings UI constants", () => {
  it("coding credential の API key 文言は coding plane 専用だと分かる", () => {
    assert.equal(SETTINGS_API_KEY_LABEL, "OpenAI API Key (Coding Agent)");
    assert.equal(SETTINGS_API_KEY_PLACEHOLDER, "Coding Agent 用 OpenAI API Key を入力");
    assert.match(SETTINGS_CODING_CREDENTIALS_HELP, /Character Stream/);
    assert.match(SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE, /future scope/);
  });

  it("初回リリース前の互換性方針と DB 初期化導線を文言で説明する", () => {
    assert.match(SETTINGS_RELEASE_COMPATIBILITY_NOTE, /初回リリース前/);
    assert.match(SETTINGS_RELEASE_COMPATIBILITY_NOTE, /後方互換性は考慮しない/);
    assert.equal(SETTINGS_RESET_DATABASE_LABEL, "DB を初期化");
    assert.match(SETTINGS_RESET_DATABASE_HELP, /Danger Zone/);
    assert.match(buildResetDatabaseConfirmMessage(ALL_RESET_APP_DATABASE_TARGETS), /本当に続ける/);
    assert.match(buildResetDatabaseConfirmMessage(ALL_RESET_APP_DATABASE_TARGETS), /実行中の session がある間は初期化できない/);
    assert.match(buildResetDatabaseSuccessMessage(ALL_RESET_APP_DATABASE_TARGETS), /初期状態へ戻した/);
  });

  it("Home Window は Settings overlay の余裕を確保する既定サイズを使う", () => {
    assert.deepEqual(HOME_WINDOW_DEFAULT_BOUNDS, {
      width: 1440,
      height: 960,
      minWidth: 900,
      minHeight: 680,
    });
  });

  it("Memory provider instruction sample は手動コピー方針で secret や内部 env を含めない", () => {
    assert.match(SETTINGS_MEMORY_PROVIDER_INSTRUCTION_SAMPLE_HELP, /自動編集しない/);
    assert.match(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /withmate-memory/);
    assert.match(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /Do not read or write WithMate database files directly/);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /WITHMATE_MEMORY_/);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /x-withmate-memory/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /binding reference/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /api secret/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /discovery file path/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /internal header/i);
    assert.doesNotMatch(WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE, /local runtime identifier/i);
  });

});
