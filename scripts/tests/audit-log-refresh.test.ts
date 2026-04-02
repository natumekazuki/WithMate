import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession, type SessionBackgroundActivityState } from "../../src/app-state.js";
import { buildAuditLogRefreshSignature } from "../../src/audit-log-refresh.js";

function makeBackgroundActivity(
  partial: Partial<SessionBackgroundActivityState> & Pick<SessionBackgroundActivityState, "kind" | "status">,
): SessionBackgroundActivityState {
  return {
    sessionId: "session-1",
    kind: partial.kind,
    status: partial.status,
    title: "background",
    summary: "summary",
    details: partial.details,
    errorMessage: "",
    updatedAt: partial.updatedAt ?? "2026-04-02T12:00:00.000Z",
  };
}

describe("audit-log-refresh", () => {
  it("session が無い時は固定 signature を返す", () => {
    assert.equal(
      buildAuditLogRefreshSignature({
        selectedSession: null,
        displayedMessagesLength: 0,
      }),
      "no-session",
    );
  });

  it("memory generation の更新を audit log 再読込条件へ含める", () => {
    const session = buildNewSession({
      taskTitle: "調査",
      workspaceLabel: "repo",
      workspacePath: "/repo",
      branch: "main",
      characterId: "character-1",
      character: "WithMate",
      characterIconPath: "",
      characterThemeColors: {
        accent: "#000000",
        surface: "#ffffff",
        text: "#111111",
      },
      approvalMode: "default",
    });

    const runningSignature = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: session.messages.length,
      selectedMemoryGenerationActivity: makeBackgroundActivity({
        kind: "memory-generation",
        status: "running",
      }),
    });
    const completedSignature = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: session.messages.length,
      selectedMemoryGenerationActivity: makeBackgroundActivity({
        kind: "memory-generation",
        status: "completed",
        updatedAt: "2026-04-02T12:01:00.000Z",
      }),
    });

    assert.notEqual(runningSignature, completedSignature);
  });

  it("message 数や session 更新時刻が同じでも monologue 更新で signature が変わる", () => {
    const session = buildNewSession({
      taskTitle: "調査",
      workspaceLabel: "repo",
      workspacePath: "/repo",
      branch: "main",
      characterId: "character-1",
      character: "WithMate",
      characterIconPath: "",
      characterThemeColors: {
        accent: "#000000",
        surface: "#ffffff",
        text: "#111111",
      },
      approvalMode: "default",
    });

    const before = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: 3,
      selectedMonologueActivity: makeBackgroundActivity({
        kind: "monologue",
        status: "running",
      }),
    });
    const after = buildAuditLogRefreshSignature({
      selectedSession: session,
      displayedMessagesLength: 3,
      selectedMonologueActivity: makeBackgroundActivity({
        kind: "monologue",
        status: "completed",
        updatedAt: "2026-04-02T12:02:00.000Z",
      }),
    });

    assert.notEqual(before, after);
  });
});
