import assert from "node:assert/strict";
import test from "node:test";
import { readSessionMonitorPage } from "../../src-electron/session/session-monitor-query.js";
import { buildNewSession, projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

const base = buildNewSession({
  taskTitle: "Monitor", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main",
  characterId: "character", character: "Character", characterIconPath: "",
  characterThemeColors: { main: "#ffffff", sub: "#222222" }, approvalMode: "untrusted",
});

// @test-value v2
// kind = "contract"
// claim = "Monitor queryは履歴pageやWindowの有無に依存せず監視対象を100件ずつ取得し、Mainと全Auxiliaryへ現在の取消・入力待ちを反映する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "閉鎖済み保持Sessionを除外する、page上限で対象を失う、またはAuxiliaryのlive状態を落とす"
// observable = "queryの親ID境界とcursor、応答のMain/Auxiliary状態"
// observation_boundary = "public-boundary"
// scope = "session-monitor-query"
// lifecycle = "permanent"
// @end-test-value
test("監視対象をbounded pageで取得し閉じた親のMain/Auxiliary状態を返す", async () => {
  const ids = [...Array.from({ length: 100 }, (_, i) => `open-${String(i).padStart(3, "0")}`), "retained"];
  const readIds: string[][] = [];
  const auxiliary: AuxiliarySessionSummary = {
    ...base, id: "aux", parentSessionId: "retained", title: "Auxiliary", status: "active", runState: "idle",
    displayAfterMessageIndex: null, createdAt: "", closedAt: "",
  };
  let canceling = true;
  const deps = {
    listMonitorSessionIds: () => ids,
    readSummaries: async (sessionIds: string[]) => {
      readIds.push(sessionIds);
      return sessionIds.map((id) => projectHomeSessionSummary({ ...base, id }));
    },
    readAuxiliarySummaries: async (sessionIds: string[]) => sessionIds.includes("retained") ? [auxiliary] : [],
    getLiveSessionRun: (id: string): LiveSessionRunState | null => ({
      sessionId: id, threadId: "", assistantText: "", steps: [], backgroundTasks: [], usage: null, errorMessage: "",
      runState: "idle", approvalRequest: null, elicitationRequest: null,
      ...(id === "retained" ? { elicitationRequests: [{ id: "question" } as never] } : {}),
      ...(id === "aux" && canceling ? { cancellationState: "terminating" as const } : {}),
    }),
  };
  const first = await readSessionMonitorPage(deps);
  assert.equal(first.entries.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, "open-099");
  const second = await readSessionMonitorPage(deps, { cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((entry) => entry.id), ["retained"]);
  assert.equal(second.entries[0]!.approvalPending, true);
  assert.equal(second.auxiliarySessions[0]!.cancellationState, "terminating");
  assert.equal(second.hasMore, false);
  assert.deepEqual(readIds.map((page) => page.length), [100, 1]);
  canceling = false;
  const completed = await readSessionMonitorPage(deps, { cursor: first.nextCursor });
  assert.equal(completed.auxiliarySessions[0]!.cancellationState, undefined);
  assert.deepEqual(completed.entries.map((entry) => entry.id), ["retained"]);
});
