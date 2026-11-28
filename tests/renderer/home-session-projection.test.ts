import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Session } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  buildHomeSessionProjection,
  getHomeSessionState,
  getHomeAuxiliarySessionState,
} from "../../src/home/home-session-projection.js";
import { projectHomeSessionSummary } from "../../src-shared/session/session-state.js";

/** Homeの投影に必要な既定値を持つ保存Sessionを作り、ケースが変える状態だけを受け取る。 */
function createSession(
  partial: Partial<Session> & Pick<Session, "id" | "taskTitle">,
): Session {
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
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    messages: [],
    stream: [],
    ...partial,
    isPinned: partial.isPinned ?? false,
    characterRuntimeSnapshot: partial.characterRuntimeSnapshot ?? null,
    codexSandboxMode: partial.codexSandboxMode ?? "workspace-write",
    model: partial.model ?? "gpt-5.4",
    reasoningEffort: partial.reasoningEffort ?? "high",
    codexSpeed: partial.codexSpeed ?? "standard",
    codexReviewer: partial.codexReviewer ?? "auto-review",
  };
}

/** 親との関連を持つAuxiliary要約を作り、実行状態や時刻の上書きを許す。 */
function createAuxiliarySession(
  partial: Partial<AuxiliarySessionSummary> &
    Pick<AuxiliarySessionSummary, "id" | "parentSessionId">,
): AuxiliarySessionSummary {
  return {
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "danger-full-access",
    customAgentName: "",
    threadId: "",
    displayAfterMessageIndex: null,
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    ...partial,
    codexSpeed: partial.codexSpeed ?? "standard",
    codexReviewer: partial.codexReviewer ?? "auto-review",
  };
}

/** Homeの検索とMonitor分類の投影を、MainとAuxiliaryを含む保存状態から検証する。 */
describe("home-session-projection", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Monitorは有効なMainまたはAuxiliary承認待ちをAttentionへ一度だけ分類し、同じ会話の取消を優先しつつ別Auxiliaryの承認を保持する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window / Issue #483" }
  // fault = "承認待ちをRunningへ混ぜる、監視対象外Sessionを表示する、取消中の承認を表示する、または別Auxiliaryの承認まで隠す"
  // observable = "Attention/Running/Stopped分類のsession ID、MainとAuxiliaryのkindとlabel、承認解除後の所属"
  // observation_boundary = "public-boundary"
  // scope = "Home summary正規化とMain/Auxiliary承認状態のMonitor投影"
  // lifecycle = "permanent"
  // impact = "ユーザー操作が必要な会話を見落とさず、取消済み要求への誤誘導を防ぐ"
  // distinction = "型検査では検出できない複数会話の状態優先順位と排他的分類をpure projectionで確認する"
  // @end-test-value
  /** 有効な承認待ちがある開いた親はAttentionだけに属し、取消中の会話や承認を解消した親は承認待ちに数えない。 */
  it("有効な承認待ちを会話別に判定しAttentionへ排他的に分類する", () => {
    const main = projectHomeSessionSummary({
      ...createSession({ id: "main", taskTitle: "Main", runState: "running" }),
      approvalPending: true,
    });
    const parent = {
      ...createSession({
        id: "parent",
        taskTitle: "Parent",
        runState: "running",
      }),
      approvalPending: true,
      cancellationState: "requested" as const,
    };
    const auxiliary = createAuxiliarySession({
      id: "approval",
      parentSessionId: "parent",
      runState: "running",
      approvalPending: true,
    });
    const canceling = createAuxiliarySession({
      id: "canceling",
      parentSessionId: "parent",
      runState: "running",
      approvalPending: true,
      cancellationState: "terminating",
    });
    const sessions = [main, parent, { ...main, id: "closed" }];
    const projection = buildHomeSessionProjection(
      sessions,
      ["main", "parent"],
      "",
      [auxiliary, canceling],
    );
    assert.deepEqual(
      projection.approvalMonitorEntries.map((entry) => entry.session.id),
      ["main", "parent"],
    );
    assert.deepEqual(projection.runningMonitorEntries, []);
    assert.deepEqual(projection.nonRunningMonitorEntries, []);
    assert.deepEqual(
      projection.approvalMonitorEntries.map((entry) => entry.mainState.label),
      ["Attention", "Canceling"],
    );
    assert.deepEqual(getHomeAuxiliarySessionState(auxiliary), {
      kind: "approval",
      label: "Attention",
    });
    assert.deepEqual(getHomeAuxiliarySessionState(canceling), {
      kind: "running",
      label: "Waiting For Stop",
    });
    const resolved = buildHomeSessionProjection(
      [{ ...main, approvalPending: false }, parent],
      ["main", "parent"],
      "",
      [{ ...auxiliary, approvalPending: false }, canceling],
    );
    assert.deepEqual(resolved.approvalMonitorEntries, []);
    assert.deepEqual(
      resolved.runningMonitorEntries.map((entry) => entry.session.id),
      ["main", "parent"],
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "取消待ちのMainとAuxiliaryは保存済みrunStateより優先されRunningに属し、対象別labelと実終了後のStopped復帰を保つ"
  // oracle = { type = "contract", ref = "GitHub Issue #783 / docs/design/desktop-ui.md Home Window" }
  // fault = "取消待ちをStoppedへ分類する、Auxiliaryの取消をMainへ混同する、実終了後も取消表示を残す"
  // observable = "projectionのRunning/Stopped所属、Main state、Auxiliary stateと順序、summary正規化後の取消state"
  // observation_boundary = "public-boundary"
  // scope = "Home軽量summaryの正規化とMain/Auxiliary状態投影"
  // lifecycle = "permanent"
  // impact = "実処理が残りSendが拒否される会話を停止済みと誤認させる"
  // distinction = "保存済みrunStateの既存testでは検出できないlive取消stateとの優先順位と対象分離を低コストなpure projectionで検証する"
  // @end-test-value
  /** Main・Auxiliaryの取消中は保存runStateより優先して親をRunningに置き、取消状態がなくなるとFailedまたはIdleのStoppedへ戻す。 */
  it("取消待ちを対象別に投影し、最後の実終了でStoppedへ戻す", () => {
    const main = projectHomeSessionSummary({
      ...createSession({ id: "main", taskTitle: "Main", runState: "error" }),
      cancellationState: "requested",
    });
    const auxiliaryParent = createSession({
      id: "parent",
      taskTitle: "Parent",
    });
    const waiting = createAuxiliarySession({
      id: "waiting",
      parentSessionId: "parent",
      cancellationState: "terminating",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const idle = createAuxiliarySession({
      id: "idle",
      parentSessionId: "parent",
    });
    const projection = buildHomeSessionProjection(
      [main, auxiliaryParent],
      ["main", "parent"],
      "",
      [idle, waiting],
    );
    assert.deepEqual(
      projection.runningMonitorEntries.map((entry) => entry.session.id),
      ["main", "parent"],
    );
    assert.equal(projection.nonRunningMonitorEntries.length, 0);
    assert.deepEqual(projection.runningMonitorEntries[0]?.mainState, {
      kind: "running",
      label: "Canceling",
    });
    assert.deepEqual(projection.runningMonitorEntries[1]?.mainState, {
      kind: "neutral",
      label: "Idle",
    });
    assert.deepEqual(
      projection.runningMonitorEntries[1]?.auxiliarySessions.map(
        (item) => item.id,
      ),
      ["waiting", "idle"],
    );
    assert.deepEqual(getHomeAuxiliarySessionState(waiting), {
      kind: "running",
      label: "Waiting For Stop",
    });
    assert.deepEqual(
      getHomeSessionState({ ...main, cancellationState: "terminating" }),
      { kind: "running", label: "Waiting For Stop" },
    );
    assert.deepEqual(
      getHomeAuxiliarySessionState({
        ...waiting,
        cancellationState: "requested",
      }),
      { kind: "running", label: "Canceling" },
    );

    const released = buildHomeSessionProjection(
      [{ ...main, cancellationState: undefined }, auxiliaryParent],
      ["main", "parent"],
      "",
      [idle, { ...waiting, cancellationState: undefined }],
    );
    assert.equal(released.runningMonitorEntries.length, 0);
    assert.deepEqual(
      released.nonRunningMonitorEntries.map((entry) => entry.state.label),
      ["Failed", "Idle"],
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Homeでは通常失敗と旧interruptedを同じFailed状態へ投影し、実行中と未知状態は区別する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window の Monitor状態" }
  // fault = "再起動時だけ別の失敗状態を表示するか、実行中と失敗を混同するか、未知enumを露出する"
  // observable = "Mainの旧interrupted・error・running・未知とAuxiliaryのerrorを投影したkindとlabel"
  // observation_boundary = "public-boundary"
  // scope = "getHomeSessionState runState projection"
  // lifecycle = "permanent"
  // impact = "将来追加されたrunStateでも誤った既知状態を表示せず、診断用原値をUIへ漏らさない"
  // distinction = "型上の既知enumだけでなく未知文字列入力の公開labelを直接確認する"
  // @end-test-value
  /** 通常失敗と旧interruptedをFailedに揃え、実行中や未知の状態とは別のラベルを返す。 */
  it("runState に応じた Home session state を返す", () => {
    assert.deepEqual(
      getHomeSessionState(
        createSession({ id: "a", taskTitle: "A", runState: "running" }),
      ),
      { kind: "running", label: "Running" },
    );
    for (const runState of ["error", "interrupted"]) {
      assert.deepEqual(
        getHomeSessionState(
          createSession({ id: "b", taskTitle: "B", runState }),
        ),
        { kind: "error", label: "Failed" },
      );
    }
    assert.deepEqual(
      getHomeAuxiliarySessionState(
        createAuxiliarySession({
          id: "aux",
          parentSessionId: "b",
          runState: "error",
        }),
      ),
      { kind: "error", label: "Failed" },
    );
    assert.deepEqual(
      getHomeSessionState(
        createSession({ id: "c", taskTitle: "C", runState: "future-state" }),
      ),
      { kind: "neutral", label: "Unknown" },
    );
  });

  /** 検索結果に含まれる行のうち開いているSessionだけをMonitorに表示し、RunningとStoppedへ分ける。 */
  it("search と openSessionWindowIds から monitor entries を組み立てる", () => {
    const projection = buildHomeSessionProjection(
      [
        createSession({
          id: "a",
          taskTitle: "Alpha",
          runState: "running",
          status: "running",
        }),
        createSession({
          id: "b",
          taskTitle: "Beta",
          runState: "idle",
          workspaceLabel: "beta-workspace",
        }),
        createSession({ id: "c", taskTitle: "Gamma", runState: "error" }),
      ],
      ["a", "c"],
      "a",
    );

    assert.equal(projection.normalizedSessionSearch, "a");
    assert.deepEqual(
      projection.filteredSessionEntries.map(({ session }) => session.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      projection.monitorEntries.map(({ session }) => session.id),
      ["a", "c"],
    );
    assert.deepEqual(
      projection.runningMonitorEntries.map(({ session }) => session.id),
      ["a"],
    );
    assert.deepEqual(
      projection.nonRunningMonitorEntries.map(({ session }) => session.id),
      ["c"],
    );
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
  /** MainがIdleでも開いている親のAuxiliaryが実行中なら、Runningにだけ分類する。 */
  it("active Auxiliary が running の open session は running monitor に分類する", () => {
    const projection = buildHomeSessionProjection(
      [
        createSession({
          id: "main",
          taskTitle: "Main Task",
          runState: "idle",
          updatedAt: "2026-03-28T00:00:00.000Z",
        }),
        createSession({ id: "other", taskTitle: "Other", runState: "idle" }),
      ],
      ["main"],
      "",
      [
        createAuxiliarySession({
          id: "aux-main",
          parentSessionId: "main",
          runState: "running",
          updatedAt: "2026-03-30T00:00:00.000Z",
        }),
      ],
    );

    assert.deepEqual(
      projection.monitorEntries.map(({ session }) => session.id),
      ["main"],
    );
    assert.deepEqual(
      projection.runningMonitorEntries.map(({ session }) => session.id),
      ["main"],
    );
    assert.deepEqual(
      projection.nonRunningMonitorEntries.map(({ session }) => session.id),
      [],
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "buildHomeSessionProjectionは検索結果に一致するmonitorがない場合、Monitor各分類のempty messageを空文字へ投影する"
  // oracle = { type = "contract", ref = "Issue #731 Home Monitor empty-state identification" }
  // fault = "一致しない検索で冗長なempty messageを表示するか、Monitor分類ごとに異なるempty messageを混在させる"
  // observable = "monitorBaseEmptyMessage、monitorRunningEmptyMessage、monitorCompletedEmptyMessage"
  // observation_boundary = "public-boundary"
  // scope = "buildHomeSessionProjection monitor empty messages"
  // lifecycle = "permanent"
  // impact = "検索結果がない状態で冗長な説明文を重ねず、loadingとerrorのfeedbackを独立して表示できる"
  // distinction = "entry配列の長さだけでなく、検索条件下で生成される各分類のmessageが空であることを確認する"
  // @end-test-value
  /** 検索に一致するMonitorがなければ、分類ごとの空表示文言はすべて空文字を返す。 */
  it("一致する monitor が無い時の empty message を返す", () => {
    const projection = buildHomeSessionProjection(
      [createSession({ id: "a", taskTitle: "Alpha" })],
      [],
      "beta",
    );

    assert.equal(projection.monitorBaseEmptyMessage, "");
    assert.equal(projection.monitorRunningEmptyMessage, "");
    assert.equal(projection.monitorCompletedEmptyMessage, "");
  });

  /** Character作成用Sessionも、通常Sessionと同様にHome一覧と開いたSessionのMonitorへ出す。 */
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

    assert.deepEqual(
      projection.filteredSessionEntries.map(({ session }) => session.id),
      ["main", "authoring"],
    );
    assert.deepEqual(
      projection.monitorEntries.map(({ session }) => session.id),
      ["main", "authoring"],
    );
  });

  /** 種別名の検索ではAgentで両種別を拾い、CharacterではCharacter作成用Sessionだけに絞る。 */
  it("session kind label でも Home session を検索できる", () => {
    const sessions = [
      createSession({
        id: "agent",
        taskTitle: "Main Task",
        sessionKind: "default",
      }),
      createSession({
        id: "authoring",
        taskTitle: "Muse の作成",
        sessionKind: "character-authoring",
      }),
    ];

    assert.deepEqual(
      buildHomeSessionProjection(
        sessions,
        [],
        "agent",
      ).filteredSessionEntries.map(({ session }) => session.id),
      ["agent", "authoring"],
    );
    assert.deepEqual(
      buildHomeSessionProjection(
        sessions,
        [],
        "character",
      ).filteredSessionEntries.map(({ session }) => session.id),
      ["authoring"],
    );
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
  /** 一人の親にIdleとRunningのAuxiliaryが混在しても、実行中の子を見落とさず親をRunningに分類する。 */
  it("同一親の複数Auxiliaryのうち実行中があればMonitorをrunningに分類する", () => {
    const projection = buildHomeSessionProjection(
      [createSession({ id: "parent", taskTitle: "Parent" })],
      ["parent"],
      "",
      [
        createAuxiliarySession({
          id: "aux-a",
          parentSessionId: "parent",
          updatedAt: "2026-03-28T00:00:00.000Z",
        }),
        createAuxiliarySession({
          id: "aux-b",
          parentSessionId: "parent",
          runState: "running",
          updatedAt: "2026-03-29T00:00:00.000Z",
        }),
      ],
    );

    assert.equal(projection.monitorEntries[0]?.state.kind, "running");
    assert.deepEqual(projection.nonRunningMonitorEntries, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home Monitorは親MainのstateをAuxiliaryの集約stateから分離し、全Auxiliaryを実行中優先・updatedAtの降順で投影する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session Monitor Window" }
  // fault = "Auxiliaryの実行状態でMainを実行中扱いにする、表示対象を一件に絞る、または実行中を後ろへ置く"
  // observable = "monitor entryのmainState、state、auxiliarySessionsのID一覧"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Main and Auxiliary projection"
  // lifecycle = "permanent"
  // impact = "2行の集約表示と展開一覧がMain/Auxiliaryの状態を混同せず再描画で順序を維持する"
  // distinction = "親のsection分類とMain表示、Auxiliary個別表示の契約を分離し、実行中優先と最終使用時刻順を直接検証する"
  // @end-test-value
  /** 親自身のFailedを保持したまま集約状態をRunningとし、子一覧は実行中を先頭にその後は更新時刻の新しい順に並べる。 */
  it("Main stateとAuxiliary一覧を分離し、Auxiliaryを実行中優先の最終使用順で投影する", () => {
    const projection = buildHomeSessionProjection(
      [createSession({ id: "parent", taskTitle: "Parent", runState: "error" })],
      ["parent"],
      "",
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
    assert.deepEqual(
      entry?.auxiliarySessions.map(({ id }) => id),
      ["aux-b", "aux-a", "aux-z"],
    );
    assert.equal(entry?.mainState.kind, "error");
    assert.equal(entry?.state.kind, "running");
    assert.deepEqual(
      projection.runningMonitorEntries.map(({ session }) => session.id),
      ["parent"],
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Home Monitorは親ごとにAuxiliaryを全件保持し、実行中を先頭にupdatedAt DESC、id DESCで並べ、runState変化を再投影する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session Monitor Window" }
  // fault = "Auxiliaryを5件へ切り捨てる、親をまたいで混ぜる、実行中を優先しない、または同じupdatedAtの順序を入力順へ委ねる"
  // observable = "各monitor entryの親session IDとauxiliarySessionsのID一覧"
  // observation_boundary = "implementation"
  // scope = "buildHomeSessionProjection Auxiliary ordering, retention, and state transition"
  // lifecycle = "permanent"
  // impact = "展開一覧から会話を失わず、実行中のAuxiliaryを同じ親の先頭から開ける"
  // distinction = "projectionが親ごとの全件保持、状態変化による再配置、時刻同率のstable ID tie-breakerを直接観測する"
  // @end-test-value
  /** 親をまたいで子を混ぜず全件表示し、実行状態の変更で順序を更新する。更新時刻が同じときもID順で安定させる。 */
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
    /** 親と検索条件を固定し、Auxiliaryの状態を変更する前後で同じ投影を実行する。 */
    const buildProjection = (auxiliaries: AuxiliarySessionSummary[]) =>
      buildHomeSessionProjection(
        sessions,
        ["parent-a", "parent-b"],
        "",
        auxiliaries,
      );

    const projection = buildProjection(parentAuxiliaries);
    assert.deepEqual(
      projection.monitorEntries.map(({ session, auxiliarySessions }) => [
        session.id,
        auxiliarySessions.map(({ id }) => id),
      ]),
      [
        [
          "parent-a",
          ["aux-g", "aux-c", "aux-f", "aux-e", "aux-d", "aux-b", "aux-a"],
        ],
        ["parent-b", ["aux-other"]],
      ],
    );

    const transitionedProjection = buildProjection(
      parentAuxiliaries.map((summary) =>
        summary.id === "aux-a"
          ? { ...summary, runState: "running" as const }
          : summary.id === "aux-c"
            ? { ...summary, runState: "idle" as const }
            : summary,
      ),
    );
    assert.deepEqual(
      transitionedProjection.monitorEntries[0]?.auxiliarySessions.map(
        ({ id }) => id,
      ),
      ["aux-a", "aux-g", "aux-f", "aux-e", "aux-d", "aux-b", "aux-c"],
    );
  });
});
