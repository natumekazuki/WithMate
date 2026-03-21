import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession, normalizeSession } from "../../src/app-state.js";
import {
  approvalModeLabel,
  DEFAULT_APPROVAL_MODE,
  mapApprovalModeToCodexPolicy,
  normalizeApprovalMode,
} from "../../src/approval-mode.js";

describe("approval mode helpers", () => {
  it("legacy/native approval 値を provider-neutral mode へ normalize できる", () => {
    assert.equal(normalizeApprovalMode("never"), "allow-all");
    assert.equal(normalizeApprovalMode("untrusted"), "safety");
    assert.equal(normalizeApprovalMode("on-request"), "provider-controlled");
    assert.equal(normalizeApprovalMode("on-failure"), "provider-controlled");
    assert.equal(normalizeApprovalMode("provider-controlled"), "provider-controlled");
  });

  it("provider-neutral approval mode を Codex native policy へ変換できる", () => {
    assert.equal(mapApprovalModeToCodexPolicy("allow-all"), "never");
    assert.equal(mapApprovalModeToCodexPolicy("safety"), "untrusted");
    assert.equal(mapApprovalModeToCodexPolicy("provider-controlled"), "on-request");
  });

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
      approvalMode: "on-failure",
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
    assert.equal(normalized.approvalMode, "provider-controlled");
    assert.deepEqual(normalized.messages[0]?.artifact?.runChecks, [
      { label: "approval", value: "allow-all" },
      { label: "model", value: "gpt-5" },
    ]);
  });

  it("default approval label は 安全寄り を返す", () => {
    assert.equal(DEFAULT_APPROVAL_MODE, "safety");
    assert.equal(approvalModeLabel(DEFAULT_APPROVAL_MODE), "安全寄り");
  });
});
