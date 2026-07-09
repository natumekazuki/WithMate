import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../src/app-state.js";
import type { AuxiliarySessionSummary } from "../../src/auxiliary-session-state.js";
import type { CompanionSessionSummary } from "../../src/companion-state.js";
import {
  buildCompanionGroupMonitorEntries,
  buildHomeSessionProjection,
  getHomeSessionState,
} from "../../src/home/home-session-projection.js";

function createSession(partial: Partial<Session> & Pick<Session, "id" | "taskTitle">): Session {
  return {
    status: "idle",
    updatedAt: "2026-03-28T00:00:00.000Z",
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "F:/workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
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

function createAuxiliarySession(partial: Partial<AuxiliarySessionSummary> & Pick<AuxiliarySessionSummary, "id" | "parentSessionId">): AuxiliarySessionSummary {
  return {
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "danger-full-access",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    displayAfterMessageIndex: null,
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    closedAt: "",
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

  it("active Auxiliary が running の open session は running monitor に分類する", () => {
    const projection = buildHomeSessionProjection(
      [
        createSession({ id: "main", taskTitle: "Main Task", runState: "idle", updatedAt: "2026-03-28T00:00:00.000Z" }),
        createSession({ id: "other", taskTitle: "Other", runState: "idle" }),
      ],
      ["main"],
      "",
      [],
      [],
      [
        createAuxiliarySession({
          id: "aux-main",
          parentSessionId: "main",
          runState: "running",
          updatedAt: "2026-03-30T00:00:00.000Z",
        }),
      ],
    );

    assert.deepEqual(projection.monitorEntries.map(({ session }) => session.id), ["main"]);
    assert.deepEqual(projection.runningMonitorEntries.map(({ session }) => session.id), ["main"]);
    assert.equal(projection.runningMonitorEntries[0]?.activeAuxiliarySession?.id, "aux-main");
    assert.deepEqual(projection.nonRunningMonitorEntries.map(({ session }) => session.id), []);
  });

  it("active Auxiliary が running の open Companion は running monitor に分類する", () => {
    const projection = buildHomeSessionProjection(
      [],
      [],
      "",
      [
        createCompanionSession({
          id: "companion",
          groupId: "companion-group-1",
          taskTitle: "Companion Task",
          repoRoot: "F:/workspace/WithMate",
          runState: "idle",
          updatedAt: "2026-03-28T00:00:00.000Z",
        }),
      ],
      ["companion"],
      [
        createAuxiliarySession({
          id: "aux-companion",
          parentSessionId: "companion",
          runState: "running",
          updatedAt: "2026-03-30T00:00:00.000Z",
        }),
      ],
    );

    assert.deepEqual(projection.monitorEntries.map(({ session }) => session.id), ["companion"]);
    assert.deepEqual(projection.runningMonitorEntries.map(({ session }) => session.id), ["companion"]);
    assert.equal(projection.runningMonitorEntries[0]?.activeAuxiliarySession?.id, "aux-companion");
    assert.deepEqual(projection.nonRunningMonitorEntries.map(({ session }) => session.id), []);
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

  it("character-authoring session は Home に表示する", () => {
    const projection = buildHomeSessionProjection(
      [
        createSession({ id: "main", taskTitle: "Main Task", branch: "main" }),
        createSession({
          id: "authoring",
          taskTitle: "Muse の作成",
          branch: "main",
          sessionKind: "character-authoring",
          status: "running",
          runState: "running",
        }),
      ],
      ["main", "authoring"],
      "",
    );

    assert.deepEqual(projection.filteredSessionEntries.map(({ session }) => session.id), ["main", "authoring"]);
    assert.deepEqual(projection.monitorEntries.map(({ session }) => session.id), ["main", "authoring"]);
  });

  it("session kind label でも Home session を検索できる", () => {
    const sessions = [
      createSession({ id: "agent", taskTitle: "Main Task", sessionKind: "default" }),
      createSession({ id: "authoring", taskTitle: "Muse の作成", sessionKind: "character-authoring" }),
    ];

    assert.deepEqual(
      buildHomeSessionProjection(sessions, [], "agent").filteredSessionEntries.map(({ session }) => session.id),
      ["agent", "authoring"],
    );
    assert.deepEqual(
      buildHomeSessionProjection(sessions, [], "character").filteredSessionEntries.map(({ session }) => session.id),
      ["authoring"],
    );
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
