import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummary } from "../../src-shared/session/session-state.js";
import { mergePinnedSessionSummary } from "../../src/home/session-pinning.js";

/** 現在の一覧項目と古い pin 応答を同じ ID で比較できるよう、最新の表示値を持つ Session 要約を作る。 */
function createSessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
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
    runState: overrides.runState ?? "idle",
    codexSandboxMode: overrides.codexSandboxMode ?? "workspace-write",
    codexSpeed: overrides.codexSpeed ?? "standard",
    codexReviewer: overrides.codexReviewer ?? "auto-review",
    model: overrides.model ?? "gpt-5.4",
    reasoningEffort: overrides.reasoningEffort ?? "medium",
    customAgentName: overrides.customAgentName ?? "",
    allowedAdditionalDirectories: overrides.allowedAdditionalDirectories ?? [],
    threadId: overrides.threadId ?? "",
  };
}

/** 古い pin 応答を受け取っても最新の名前・状態・更新時刻を戻さず、ピン留めだけを反映する。 */
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
