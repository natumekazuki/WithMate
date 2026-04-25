import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../src/app-state.js";
import { buildHomeSessionProjection, getHomeSessionState, shouldDisplayHomeSession } from "../../src/home-session-projection.js";

function createSession(partial: Partial<Session> & Pick<Session, "id" | "taskTitle">): Session {
  return {
    taskSummary: "",
    status: "idle",
    updatedAt: "2026-03-28T00:00:00.000Z",
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "F:/workspace",
    branch: "main",
    sessionKind: "default",
    characterId: "char-1",
    character: "Mia",
    characterIconPath: "icon.png",
    characterThemeColors: {
      main: "#000000",
      sub: "#ffffff",
    },
    runState: "idle",
    approvalMode: "untrusted",
    model: "gpt-5.4",
    reasoningEffort: "high",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    messages: [],
    stream: [],
    ...partial,
  };
}

describe("home-session-projection", () => {
  it("runState に応じた Home session state を返す", () => {
    assert.deepEqual(
      getHomeSessionState(createSession({ id: "a", taskTitle: "A", runState: "running" })),
      { kind: "running", label: "実行中" },
    );
    assert.deepEqual(
      getHomeSessionState(createSession({ id: "b", taskTitle: "B", runState: "interrupted" })),
      { kind: "interrupted", label: "中断" },
    );
  });

  it("search と openSessionWindowIds から monitor entries を組み立てる", () => {
    const projection = buildHomeSessionProjection(
      [
        createSession({ id: "a", taskTitle: "Alpha", runState: "running", status: "running" }),
        createSession({ id: "b", taskTitle: "Beta", runState: "idle", workspaceLabel: "beta-workspace" }),
        createSession({ id: "c", taskTitle: "Gamma", runState: "error" }),
      ],
      ["a", "c"],
      "a",
    );

    assert.equal(projection.normalizedSessionSearch, "a");
    assert.deepEqual(projection.filteredSessionEntries.map(({ session }) => session.id), ["a", "b", "c"]);
    assert.deepEqual(projection.monitorEntries.map(({ session }) => session.id), ["a", "c"]);
    assert.deepEqual(projection.runningMonitorEntries.map(({ session }) => session.id), ["a"]);
    assert.deepEqual(projection.nonRunningMonitorEntries.map(({ session }) => session.id), ["c"]);
  });

  it("一致する monitor が無い時の empty message を返す", () => {
    const projection = buildHomeSessionProjection(
      [createSession({ id: "a", taskTitle: "Alpha" })],
      [],
      "beta",
    );

    assert.equal(projection.monitorBaseEmptyMessage, "一致するセッションはないよ。");
    assert.equal(projection.monitorRunningEmptyMessage, "一致するセッションはないよ。");
    assert.equal(projection.monitorCompletedEmptyMessage, "一致するセッションはないよ。");
  });

  it("character-update session を Home 一覧と monitor から除外する", () => {
    const projection = buildHomeSessionProjection(
      [
        createSession({ id: "main", taskTitle: "Main Task", branch: "main" }),
        createSession({
          id: "update",
          taskTitle: "Muse の更新",
          branch: "main",
          sessionKind: "character-update",
          status: "running",
          runState: "running",
        }),
      ],
      ["main", "update"],
      "",
    );

    assert.equal(shouldDisplayHomeSession(createSession({ id: "visible", taskTitle: "visible", branch: "main" })), true);
    assert.equal(
      shouldDisplayHomeSession(createSession({ id: "hidden", taskTitle: "hidden", branch: "main", sessionKind: "character-update" })),
      false,
    );
    assert.deepEqual(projection.filteredSessionEntries.map(({ session }) => session.id), ["main"]);
    assert.deepEqual(projection.monitorEntries.map(({ session }) => session.id), ["main"]);
  });
});

