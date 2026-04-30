import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../src/app-state.js";
import type { CompanionSessionSummary } from "../../src/companion-state.js";
import {
  buildCompanionGroupMonitorEntries,
  buildHomeSessionProjection,
  getHomeSessionState,
  shouldDisplayHomeSession,
} from "../../src/home-session-projection.js";

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

function createCompanionSession(partial: Partial<CompanionSessionSummary> & Pick<CompanionSessionSummary, "id" | "taskTitle" | "groupId" | "repoRoot">): CompanionSessionSummary {
  return {
    status: "active",
    focusPath: "",
    targetBranch: "main",
    baseSnapshotRef: "refs/withmate/base/1",
    baseSnapshotCommit: "base-1",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: [],
    runState: "idle",
    threadId: "",
    provider: "codex",
    model: "gpt-5.4",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "danger-full-access",
    character: "Mia",
    characterRoleMarkdown: "",
    characterIconPath: "icon.png",
    characterThemeColors: {
      main: "#000000",
      sub: "#ffffff",
    },
    updatedAt: "2026-03-29T00:00:00.000Z",
    latestMergeRun: null,
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

  it("Monitor entries に Companion session と group 表示情報を含める", () => {
    const projection = buildHomeSessionProjection(
      [createSession({ id: "agent", taskTitle: "Agent Task", runState: "running", updatedAt: "2026-03-28T00:00:00.000Z" })],
      ["agent"],
      "",
      [
        createCompanionSession({
          id: "companion",
          groupId: "companion-group-1",
          taskTitle: "Companion Task",
          repoRoot: "F:/workspace/WithMate",
          runState: "idle",
          updatedAt: "2026-03-29T00:00:00.000Z",
        }),
        createCompanionSession({
          id: "sibling",
          groupId: "companion-group-1",
          taskTitle: "Sibling Task",
          repoRoot: "F:/workspace/WithMate",
          runState: "running",
          updatedAt: "2026-03-27T00:00:00.000Z",
        }),
        createCompanionSession({
          id: "unopened",
          groupId: "companion-group-2",
          taskTitle: "Unopened Task",
          repoRoot: "F:/workspace/Other",
          updatedAt: "2026-03-30T00:00:00.000Z",
        }),
      ],
      ["companion"],
    );

    assert.deepEqual(projection.monitorEntries.map((entry) => `${entry.kind}:${entry.session.id}`), [
      "companion:companion",
      "agent:agent",
      "companion:sibling",
    ]);
    assert.equal(projection.monitorEntries[0]?.kind, "companion");
    assert.equal(projection.nonRunningMonitorEntries[0]?.state.label, "待機");
  });

  it("開いている Companion Review と同じ CompanionGroup の monitor entries を返す", () => {
    const entries = buildCompanionGroupMonitorEntries(
      [
        createCompanionSession({
          id: "matched",
          groupId: "companion-group-1",
          taskTitle: "Matched",
          repoRoot: "F:/workspace/WithMate",
        }),
        createCompanionSession({
          id: "other",
          groupId: "companion-group-2",
          taskTitle: "Other",
          repoRoot: "F:/workspace/Other",
        }),
      ],
      ["matched"],
    );

    assert.deepEqual(entries.map((entry) => entry.session.id), ["matched"]);
    assert.equal(entries[0]?.groupLabel, "WithMate");
  });

  it("Session workspace に依存せず open group の sibling を返す", () => {
    const entries = buildCompanionGroupMonitorEntries(
      [
        createCompanionSession({
          id: "opened",
          groupId: "companion-group-1",
          taskTitle: "Opened",
          repoRoot: "F:/workspace/WithMate",
        }),
        createCompanionSession({
          id: "sibling",
          groupId: "companion-group-1",
          taskTitle: "Sibling",
          repoRoot: "F:/workspace/WithMate",
        }),
        createCompanionSession({
          id: "other",
          groupId: "companion-group-2",
          taskTitle: "Other",
          repoRoot: "F:/workspace/Other",
        }),
      ],
      ["opened"],
    );

    assert.deepEqual(entries.map((entry) => entry.session.id), ["opened", "sibling"]);
  });
});

