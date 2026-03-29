import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { applyCopilotCustomAgentSelection, buildNewSession } from "../../src/session-state.js";

describe("session-state custom agent selection", () => {
  it("Copilot custom agent 切り替え時は threadId を維持する", () => {
    const session = {
      ...buildNewSession({
        provider: "copilot",
        taskTitle: "copilot",
        workspaceLabel: "workspace",
        workspacePath: "F:/repo",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
        customAgentName: "reviewer",
      }),
      threadId: "thread-keep",
    };

    const next = applyCopilotCustomAgentSelection(session, "planner", "2026-03-29 12:00");

    assert.equal(next.customAgentName, "planner");
    assert.equal(next.threadId, "thread-keep");
    assert.equal(next.updatedAt, "2026-03-29 12:00");
  });
});
