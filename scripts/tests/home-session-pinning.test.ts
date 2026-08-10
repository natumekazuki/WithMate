import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummary } from "../../src/session-state.js";
import { mergePinnedSessionSummary } from "../../src/home/session-pinning.js";

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    taskTitle: "Current title",
    status: "running",
    updatedAt: "2026-08-09T05:30:00.000Z",
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: {
      main: "#112233",
      sub: "#445566",
    },
    approvalMode: "untrusted",
    ...overrides,
  };
}

test("pin応答は新しいSessionSummaryを巻き戻さずisPinnedだけを反映する", () => {
  const current = createSessionSummary();
  const stalePinResponse = createSessionSummary({
    taskTitle: "Stale title",
    status: "idle",
    updatedAt: "2026-08-09T05:00:00.000Z",
    isPinned: true,
  });

  const [merged] = mergePinnedSessionSummary([current], stalePinResponse);

  assert.deepEqual(merged, { ...current, isPinned: true });
});
