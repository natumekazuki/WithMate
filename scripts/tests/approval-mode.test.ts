import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession, normalizeSession } from "../../src/app-state.js";
import {
  approvalModeLabel,
  DEFAULT_APPROVAL_MODE,
  mapApprovalModeToCodexPolicy,
  normalizeApprovalMode,
} from "../../src/approval-mode.js";
import { createDefaultAppSettings, getProviderAppSettings, normalizeAppSettings } from "../../src/provider-settings-state.js";

describe("approval mode helpers", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "現行approval値とlegacy aliasは共有normalizerでprovider-neutral modeへ変換される"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
  // failure_mode = "保存値やlegacy aliasが未正規化のままprovider adapterへ渡る"
  // scope = "approval-mode"
  // lifecycle = "permanent"
  // @end-test-value
  it("legacy/native approval 値を provider-neutral mode へ normalize できる", () => {
    assert.equal(normalizeApprovalMode("never"), "never");
    assert.equal(normalizeApprovalMode("untrusted"), "untrusted");
    assert.equal(normalizeApprovalMode("on-request"), "on-request");
    assert.equal(normalizeApprovalMode("allow-all"), "never");
    assert.equal(normalizeApprovalMode("safety"), "untrusted");
    assert.equal(normalizeApprovalMode("provider-controlled"), "on-request");
  });

  it("provider-neutral approval mode を Codex native policy へ変換できる", () => {
    assert.equal(mapApprovalModeToCodexPolicy("never"), "never");
    assert.equal(mapApprovalModeToCodexPolicy("untrusted"), "untrusted");
    assert.equal(mapApprovalModeToCodexPolicy("on-request"), "on-request");
  });

  // @test-value v1
  // kind = "contract"
  // claim = "session読込時にlegacy approval aliasだけを正規化し、artifactの実行記録は変更しない"
  // oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
  // failure_mode = "session metadataの正規化がartifactの過去記録まで書き換えるか、legacy aliasを残す"
  // scope = "session-normalization"
  // lifecycle = "permanent"
  // @end-test-value
  it("session normalize で approval と artifact run checks を provider-neutral に戻す", () => {
    const normalized = normalizeSession({
      ...buildNewSession({
        taskTitle: "approval normalize",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      approvalMode: "provider-controlled",
      messages: [
        {
          role: "assistant",
          text: "done",
          artifact: {
            title: "artifact",
            activitySummary: [],
            changedFiles: [],
            runChecks: [
              { label: "approval", value: "never" },
              { label: "model", value: "gpt-5" },
            ],
          },
        },
      ],
    });

    assert.ok(normalized);
    assert.equal(normalized.approvalMode, "on-request");
    assert.deepEqual(normalized.messages[0]?.artifact?.runChecks, [
      { label: "approval", value: "never" },
      { label: "model", value: "gpt-5" },
    ]);
  });

  it("default approval label は SDK literal を返す", () => {
    assert.equal(DEFAULT_APPROVAL_MODE, "untrusted");
    assert.equal(approvalModeLabel(DEFAULT_APPROVAL_MODE), "untrusted");
  });

  it("provider settings は skill root path を保持できる", () => {
    const defaults = createDefaultAppSettings();
    assert.equal(getProviderAppSettings(defaults, "codex").skillRootPath, "");

    const normalized = normalizeAppSettings({
      ...defaults,
      codingProviderSettings: {
        codex: {
          enabled: true,
          apiKey: "test-key",
          skillRootPath: "C:/skills/codex",
        },
      },
    });

    assert.equal(getProviderAppSettings(normalized, "codex").skillRootPath, "C:/skills/codex");
  });

  it("session side pane は初期値を none とし、列挙値だけを受け入れる", () => {
    assert.deepEqual(createDefaultAppSettings().chatLayoutPreference, {
      header: "hidden",
      actionDock: "compact",
      sidePane: "none",
      priority: "side-pane-first",
    });
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: {
        header: "visible",
        actionDock: "expanded",
        sidePane: "files",
        priority: "dock-first",
      },
    }).chatLayoutPreference, {
      header: "visible",
      actionDock: "expanded",
      sidePane: "files",
      priority: "dock-first",
    });
    assert.deepEqual(normalizeAppSettings({
      chatLayoutPreference: { header: "shown", actionDock: "open", sidePane: true },
    }).chatLayoutPreference, {
      header: "hidden",
      actionDock: "compact",
      sidePane: "none",
      priority: "side-pane-first",
    });
  });
});

