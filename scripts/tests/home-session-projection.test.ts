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

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Monitorはopen Agentの配下で実行中のAuxiliaryを親のrunning stateへ反映する"
  // oracle = { type = "contract", ref = "Home Session Monitor Auxiliary running state projection" }
  // fault = "実行中のAuxiliaryを無視し、親Agentを停止扱いに分類する"
  // observable = "runningMonitorEntries と nonRunningMonitorEntries の親session ID"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Agent Auxiliary state"
  // lifecycle = "permanent"
  // impact = "実行中会話のMonitor分類を正しく維持する"
  // distinction = "公開entry fieldではなく、Monitor分類のstate contractを検証する"
  // @end-test-value
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
    assert.deepEqual(projection.nonRunningMonitorEntries.map(({ session }) => session.id), []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Monitorはopen Companionの配下で実行中のAuxiliaryを親のrunning stateへ反映する"
  // oracle = { type = "contract", ref = "Home Companion Monitor Auxiliary running state projection" }
  // fault = "実行中のAuxiliaryを無視し、親Companionを停止扱いに分類する"
  // observable = "runningMonitorEntries と nonRunningMonitorEntries の親session ID"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Companion Auxiliary state"
  // lifecycle = "permanent"
  // impact = "実行中Companion会話のMonitor分類を正しく維持する"
  // distinction = "公開entry fieldではなく、Monitor分類のstate contractを検証する"
  // @end-test-value
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

  // @test-value v2
  // kind = "contract"
  // claim = "Companion Monitor projectionはopen groupの全兄弟を表示し、各entryへ実Windowの開閉状態、Auxiliary、Main/Auxiliary stateを投影する"
  // oracle = { type = "contract", ref = "Home Session Monitor Companion window state projection" }
  // fault = "開いていないCompanion siblingまでopen扱いになり、存在しないWindowへの閉じる操作が表示される"
  // observable = "monitor entryのkind、session ID、isWindowOpen、Auxiliary、Main/Auxiliary state"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Companion Monitor entries"
  // lifecycle = "permanent"
  // impact = "Companion rowの操作対象を実在するReview Windowに限定する"
  // distinction = "group選択やstate labelではなく、row操作可否へ使うWindow identity projectionを検証する"
  // @end-test-value
  it("Monitor entries に Companion session と state projection を含める", () => {
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
          runState: "idle",
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
      [
        createAuxiliarySession({ id: "companion-aux", parentSessionId: "companion", runState: "running" }),
        createAuxiliarySession({ id: "sibling-aux", parentSessionId: "sibling", status: "closed", closedAt: "2026-03-30T00:00:00.000Z" }),
      ],
    );

    assert.deepEqual(projection.monitorEntries.map((entry) => `${entry.kind}:${entry.session.id}`), [
      "agent:agent",
      "companion:companion",
      "companion:sibling",
    ]);
    assert.deepEqual(
      projection.monitorEntries
        .filter((entry) => entry.kind === "companion")
        .map(({ session, isWindowOpen }) => [session.id, isWindowOpen]),
      [["companion", true], ["sibling", false]],
    );
    assert.equal(projection.monitorEntries[0]?.kind, "agent");
    assert.equal(projection.monitorEntries[1]?.mainState.label, "待機");
    assert.deepEqual(
      projection.monitorEntries
        .filter((entry) => entry.kind === "companion")
        .map(({ session, state, mainState, auxiliarySessions }) => [
          session.id,
          state.kind,
          mainState.kind,
          auxiliarySessions.map(({ id, status }) => [id, status]),
        ]),
      [
        ["companion", "running", "neutral", [["companion-aux", "active"]]],
        ["sibling", "neutral", "neutral", [["sibling-aux", "closed"]]],
      ],
    );
    assert.equal(projection.nonRunningMonitorEntries[0]?.state.label, "待機");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "開いているCompanion ReviewのGroupだけをMonitorへ投影し、open Reviewがなければ空にする"
  // oracle = { type = "contract", ref = "companion-group-monitor" }
  // fault = "無関係なGroupまで表示するか、open ReviewがないのにMonitor entriesを生成する"
  // observable = "buildCompanionGroupMonitorEntriesの返却Session ID一覧"
  // observation_boundary = "declaration"
  // scope = "home-companion-monitor group filtering"
  // lifecycle = "permanent"
  // distinction = "同一GroupのSiblingをrepoRoot一致なしで含める挙動とは分離して、Group filterとopen状態の境界だけを検証する"
  // @end-test-value
  it("開いている Companion Review と同じ CompanionGroup の monitor entries を返す", () => {
    const sessions = [
      createCompanionSession({
        id: "matched",
        groupId: "companion-group-1",
        taskTitle: "Matched",
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
    ];
    assert.deepEqual(
      buildCompanionGroupMonitorEntries(sessions, ["matched"]).map((entry) => entry.session.id),
      ["matched", "sibling"],
    );
    assert.deepEqual(buildCompanionGroupMonitorEntries(sessions, []), []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "開いているCompanionの同一Groupに属するSiblingをrepoRoot一致なしでMonitorへ含める"
  // oracle = { type = "contract", ref = "companion-group-monitor" }
  // fault = "Session workspaceだけを比較してSiblingをMonitorから欠落させる"
  // observable = "buildCompanionGroupMonitorEntriesの返却Session ID一覧"
  // observation_boundary = "declaration"
  // scope = "home-companion-monitor"
  // lifecycle = "permanent"
  // @end-test-value
  it("Session workspace に依存せず open group の sibling を返す", () => {
    const entries = buildCompanionGroupMonitorEntries(
      [
        createCompanionSession({
          id: "opened",
          groupId: "companion-group-1",
          taskTitle: "Opened",
          repoRoot: "F:/workspace/OtherSibling",
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

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Monitorは同じ親に属する複数Auxiliaryを集計し、いずれかが実行中なら親を実行中へ分類する"
  // oracle = { type = "contract", ref = "issue-710 acceptance F: all auxiliary lifecycle aggregation" }
  // fault = "親配下の複数Auxiliaryのうち一件だけを見て、実行中の兄弟を見落とす"
  // observable = "monitorEntriesの親session state.kind"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Auxiliary state aggregation"
  // lifecycle = "permanent"
  // impact = "非表示の実行中Auxiliaryを停止扱いにせずMonitorへ反映する"
  // distinction = "Auxiliary一覧の公開有無ではなく、親stateへの集約結果を検証する"
  // @end-test-value
  it("同一親の複数Auxiliaryのうち実行中があればMonitorをrunningに分類する", () => {
    const projection = buildHomeSessionProjection(
      [createSession({ id: "parent", taskTitle: "Parent" })],
      ["parent"],
      "",
      [],
      [],
      [
        createAuxiliarySession({ id: "aux-a", parentSessionId: "parent", updatedAt: "2026-03-28T00:00:00.000Z" }),
        createAuxiliarySession({ id: "aux-b", parentSessionId: "parent", runState: "running", updatedAt: "2026-03-29T00:00:00.000Z" }),
      ],
    );

    assert.equal(projection.monitorEntries[0]?.state.kind, "running");
    assert.deepEqual(projection.nonRunningMonitorEntries, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Monitorは親MainのstateをAuxiliaryの集約stateから分離し、全Auxiliaryを実行中優先・updatedAtの降順で投影する"
  // oracle = { type = "contract", ref = "issue-722 monitor aggregate projection" }
  // fault = "Auxiliaryの実行状態でMainを実行中扱いにする、表示対象を一件に絞る、または実行中を後ろへ置く"
  // observable = "monitor entryのmainState、state、auxiliarySessionsのID一覧"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Main and Auxiliary projection"
  // lifecycle = "permanent"
  // impact = "2行の集約表示と展開一覧がMain/Auxiliaryの状態を混同せず再描画で順序を維持する"
  // distinction = "親のsection分類とMain表示、Auxiliary個別表示の契約を分離し、実行中優先と最終使用時刻順を直接検証する"
  // @end-test-value
  it("Main stateとAuxiliary一覧を分離し、Auxiliaryを実行中優先の最終使用順で投影する", () => {
    const projection = buildHomeSessionProjection(
      [createSession({ id: "parent", taskTitle: "Parent", runState: "error" })],
      ["parent"],
      "",
      [],
      [],
      [
        createAuxiliarySession({
          id: "aux-b",
          parentSessionId: "parent",
          runState: "running",
          createdAt: "2026-03-29T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
        }),
        createAuxiliarySession({
          id: "aux-z",
          parentSessionId: "parent",
          status: "closed",
          closedAt: "2026-03-30T00:00:00.000Z",
          createdAt: "2026-03-28T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        }),
        createAuxiliarySession({
          id: "aux-a",
          parentSessionId: "parent",
          createdAt: "2026-03-28T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        }),
      ],
    );

    const entry = projection.monitorEntries[0];
    assert.deepEqual(entry?.auxiliarySessions.map(({ id }) => id), ["aux-b", "aux-a", "aux-z"]);
    assert.equal(entry?.auxiliarySessions.find(({ id }) => id === "aux-z")?.status, "closed");
    assert.equal(entry?.mainState.kind, "error");
    assert.equal(entry?.state.kind, "running");
    assert.deepEqual(projection.runningMonitorEntries.map(({ session }) => session.id), ["parent"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Monitorは親ごとにAuxiliaryを全件保持し、実行中を先頭にupdatedAt DESC、id DESCで並べ、runState変化を再投影する"
  // oracle = { type = "contract", ref = "Home Session Monitor Auxiliary display ordering and retention" }
  // fault = "Auxiliaryを5件へ切り捨てる、親をまたいで混ぜる、実行中を優先しない、または同じupdatedAtの順序を入力順へ委ねる"
  // observable = "各monitor entryの親session IDとauxiliarySessionsのID一覧"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Auxiliary ordering, retention, and state transition"
  // lifecycle = "permanent"
  // impact = "展開一覧から会話を失わず、実行中のAuxiliaryを同じ親の先頭から開ける"
  // distinction = "projectionが親ごとの全件保持、状態変化による再配置、時刻同率のstable ID tie-breakerを直接観測する"
  // @end-test-value
  it("Auxiliaryを親ごとに全件保持し、実行中優先とstable ID順で再投影する", () => {
    const parentAuxiliaries = [
      createAuxiliarySession({
        id: "aux-a",
        parentSessionId: "parent-a",
        updatedAt: "2026-04-01T00:00:00.000Z",
      }),
      createAuxiliarySession({
        id: "aux-b",
        parentSessionId: "parent-a",
        updatedAt: "2026-04-02T00:00:00.000Z",
      }),
      createAuxiliarySession({
        id: "aux-c",
        parentSessionId: "parent-a",
        runState: "running",
        updatedAt: "2026-03-30T00:00:00.000Z",
      }),
      createAuxiliarySession({
        id: "aux-g",
        parentSessionId: "parent-a",
        runState: "running",
        updatedAt: "2026-03-30T00:00:00.000Z",
      }),
      createAuxiliarySession({
        id: "aux-d",
        parentSessionId: "parent-a",
        updatedAt: "2026-04-02T00:00:00.000Z",
      }),
      createAuxiliarySession({
        id: "aux-e",
        parentSessionId: "parent-a",
        status: "closed",
        updatedAt: "2026-04-03T00:00:00.000Z",
      }),
      createAuxiliarySession({
        id: "aux-f",
        parentSessionId: "parent-a",
        runState: "error",
        updatedAt: "2026-04-04T00:00:00.000Z",
      }),
      createAuxiliarySession({
        id: "aux-other",
        parentSessionId: "parent-b",
        updatedAt: "2026-04-05T00:00:00.000Z",
      }),
    ];
    const sessions = [
      createSession({ id: "parent-a", taskTitle: "Parent A" }),
      createSession({ id: "parent-b", taskTitle: "Parent B" }),
    ];
    const buildProjection = (auxiliaries: AuxiliarySessionSummary[]) => buildHomeSessionProjection(
      sessions,
      ["parent-a", "parent-b"],
      "",
      [],
      [],
      auxiliaries,
    );

    const projection = buildProjection(parentAuxiliaries);
    assert.deepEqual(
      projection.monitorEntries.map(({ session, auxiliarySessions }) => [
        session.id,
        auxiliarySessions.map(({ id }) => id),
      ]),
      [
        ["parent-a", ["aux-g", "aux-c", "aux-f", "aux-e", "aux-d", "aux-b", "aux-a"]],
        ["parent-b", ["aux-other"]],
      ],
    );

    const transitionedProjection = buildProjection(parentAuxiliaries.map((summary) => (
      summary.id === "aux-a"
        ? { ...summary, runState: "running" as const }
        : summary.id === "aux-c"
          ? { ...summary, runState: "idle" as const }
          : summary
    )));
    assert.deepEqual(
      transitionedProjection.monitorEntries[0]?.auxiliarySessions.map(({ id }) => id),
      ["aux-a", "aux-g", "aux-f", "aux-e", "aux-d", "aux-b", "aux-c"],
    );
  });

});
