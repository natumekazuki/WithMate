import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { startHomeLaunch } from "../../src/home/home-launch-actions.js";
import { buildHomeLaunchProjection } from "../../src/home/home-launch-projection.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  createClosedLaunchDraft,
  setLaunchWorkspaceFromPath,
  setLaunchWorkspaceToSessionFolder,
  type HomeLaunchDraft,
} from "../../src/home/home-launch-state.js";
import type { MateProfile } from "../../src-shared/mate/mate-state.js";
import type {
  HomeSessionSummary,
  SessionSummary,
} from "../../src-shared/session/session-state.js";

/** Mate が作成済みの経路を試せる、アクティブなプロフィールを用意する。 */
function createMateProfile(): MateProfile {
  return {
    id: "mate-1",
    state: "active",
    displayName: "Mia",
    description: "Mate profile",
    themeMain: "#111111",
    themeSub: "#f5f5f5",
    avatarFilePath: "avatar.png",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: null,
    profileGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    sections: [],
  };
}

/** 通常の workspace と固定 Character で開始条件を満たす New Session の draft を作る。 */
function createReadyDraft(): HomeLaunchDraft {
  return {
    ...setLaunchWorkspaceFromPath(createClosedLaunchDraft(), "C:/work/demo"),
    open: true,
    title: "Task",
    providerId: "codex",
    characterSelectionMode: "specific",
    characterId: "mia",
  };
}

/** 使用履歴や開いているウィンドウによって抽選結果を区別できる2人の候補を用意する。 */
function createCharacterEntries(): CharacterCatalogEntry[] {
  return [
    {
      id: "mia",
      name: "Mia",
      description: "Character profile",
      iconFilePath: "character.png",
      theme: { main: "#222222", sub: "#eeeeee" },
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    },
    {
      id: "noa",
      name: "Noa",
      description: "Second character",
      iconFilePath: "noa.png",
      theme: { main: "#333333", sub: "#dddddd" },
      state: "active",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      archivedAt: null,
    },
  ];
}

/** Home へ登録される Session 概要を作り、履歴や作成結果ごとに必要な項目だけ上書きする。 */
function createSessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "session-1",
    taskTitle: "Task",
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "demo",
    workspacePath: "C:/work/demo",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "mate-1",
    character: "Mia",
    characterIconPath: "avatar.png",
    characterThemeColors: { main: "#111111", sub: "#f5f5f5" },
    runState: "idle",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    ...overrides,
  };
}

/** 起動処理の既定入力を組み立て、作成・ウィンドウ・ダイアログへの副作用を記録する。 */
function createStartHomeLaunchHarness(
  overrides: Partial<Parameters<typeof startHomeLaunch>[0]> = {},
) {
  const feedback: string[] = [];
  const startingStates: boolean[] = [];
  const openedSessions: string[] = [];
  const sessionSummaries: string[] = [];
  let closeCount = 0;
  let createSessionCount = 0;

  return {
    feedback,
    startingStates,
    openedSessions,
    sessionSummaries,
    /** 実行の結果ダイアログが閉じられた回数を返す。 */
    get closeCount() {
      return closeCount;
    },
    /** 既定の作成スタブが呼ばれた回数を返す。 */
    get createSessionCount() {
      return createSessionCount;
    },
    input: {
      draft: createReadyDraft(),
      launchStarting: false,
      /** 既定ケースの作成は、結果が届く時点でも現行ダイアログに属するものとする。 */
      isCurrentAttempt: () => true,
      /** 既定ケースは現行試行を扱うため、閉じた試行の通知は記録しない。 */
      onDetachedResult: () => {},
      mateState: "active" as const,
      mateProfile: createMateProfile(),
      characterEntries: createCharacterEntries(),
      selectedProviderId: "codex",
      sessions: [],
      sessionCharacterUsage: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded" as const,
      sessionCharacterUsageLoadStatus: "loaded" as const,
      /** Session 作成を数え、一覧への登録とウィンドウ表示に使う概要を返す。 */
      createSession: async () => {
        createSessionCount += 1;
        return createSessionSummary();
      },
      /** 開始処理が開こうとした Session ID を保存する。 */
      openSessionWindow: async (sessionId: string) => {
        openedSessions.push(sessionId);
      },
      /** この試行がダイアログを閉じた回数を記録する。 */
      closeLaunchDialog: () => {
        closeCount += 1;
      },
      /** 検証エラーや成功時のクリアを含め、画面へ通知した文字列を順に保存する。 */
      setLaunchFeedback: (message: string) => {
        feedback.push(message);
      },
      /** 開始中フラグの変更を記録し、拒否時の無変更や完了時の解除を照合できるようにする。 */
      setLaunchStarting: (launchStarting: boolean) => {
        startingStates.push(launchStarting);
      },
      /** Recent Sessions 側に登録した Session ID を保存する。 */
      upsertSessionSummary: (summary: HomeSessionSummary) => {
        sessionSummaries.push(summary.id);
      },
      ...overrides,
    },
  };
}

/** Home の開始アクションについて、作成条件・結果の所属・成功後の画面更新を確認する。 */
describe("home-launch-actions", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "閉じた開始要求が結果を返さない時は未作成と断定せず、現在のdialogを変更せずに確認不能の結果を通知する"
  // oracle = { type = "contract", ref = "GitHub Issue #753 / docs/design/desktop-ui.md New Session dialog" }
  // fault = "null結果を現在のfeedbackへ混入させる、busyを解除する、または自動再作成する"
  // observable = "所属済み結果通知、createSession回数、dialog feedbackとbusyの通知履歴、closeとopenの呼出数"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunchの遅延したnull結果"
  // lifecycle = "permanent"
  // impact = "結果不明の作成を再送して重複Sessionを作ることと、新しい試行の状態破壊を防ぐ"
  // distinction = "Electron APIの成功型にはないnullを返し得るrenderer adapter境界を、型検査や正常系と分けて小さなPromiseで検証する"
  // @end-test-value
  /** 閉じた試行が null で完了したら、現在のダイアログを更新せず確認不能として通知し、自動再作成しないことを確認する。 */
  it("閉じた要求のnull結果は新しいdialogへ反映せず確認不能として通知する", async () => {
    let current = true;
    let resolve!: (value: null) => void;
    let createCount = 0;
    const results: Array<{ title: string; message: string }> = [];
    const harness = createStartHomeLaunchHarness({
      /** 開始時と結果取得時で所有状態を切り替えられるよう、その時点の値を返す。 */
      isCurrentAttempt: () => current,
      /** 閉じた試行の結果を、現在のダイアログ向けフィードバックと分けて保存する。 */
      onDetachedResult: (result) => results.push(result),
      /** 作成呼出を数え、閉じた後に null を返せるよう完了を保留する。 */
      createSession: () => {
        createCount += 1;
        return new Promise<null>((done) => {
          resolve = done;
        });
      },
    });
    const pending = startHomeLaunch(harness.input);
    current = false;
    resolve(null);
    await pending;
    assert.equal(createCount, 1);
    assert.deepEqual(results, [
      {
        title: "Task",
        message:
          "Could not confirm session creation. Check Recent Sessions before trying again.",
      },
    ]);
    assert.deepEqual(harness.feedback, [""]);
    assert.deepEqual(harness.startingStates, [true]);
    assert.equal(harness.closeCount, 0);
    assert.deepEqual(harness.openedSessions, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Randomは履歴とopen Window一覧の両取得成功時だけ開始でき、固定Characterはこの2取得に依存しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog / docs/adr/004-launch-character-random-selection.md Decision" }
  // fault = "Startの有効判定と実行guardが食い違うか、取得失敗を0件としてRandomを開始するか、固定選択を不要に妨げる"
  // observable = "全取得状態の組合せでのcanStartSession、createSession呼出回数、作成Character ID、起動中状態"
  // observation_boundary = "public-boundary"
  // scope = "Home launch readiness projection and action"
  // lifecycle = "permanent"
  // impact = "押せるのに開始できない操作と、履歴取得失敗による不正な抽選を防ぐ"
  // distinction = "既存の個別guard testでは検出しない表示判定との一致、固定選択、取得済み0件とneutralを小さな状態表で検証する"
  // @end-test-value
  /** 利用履歴と Window 一覧の取得状態を全組合せで試し、Random と固定選択のボタン有効判定が実際の作成可否と一致することを確認する。 */
  it("Randomと固定選択の取得前提がprojectionと開始処理で一致する", async () => {
    const states = [
      ["loading", "loading", false],
      ["loading", "error", false],
      ["loading", "loaded", false],
      ["error", "loading", false],
      ["error", "error", false],
      ["error", "loaded", false],
      ["loaded", "loading", false],
      ["loaded", "error", false],
      ["loaded", "loaded", true],
    ] as const;
    const selections = [
      { mode: "random", entries: createCharacterEntries(), characterId: "mia" },
      {
        mode: "specific",
        entries: createCharacterEntries(),
        characterId: "mia",
      },
      {
        mode: "random",
        entries: [],
        characterId: "withmate-neutral-character",
      },
    ] as const;
    for (const selection of selections) {
      for (const [usageStatus, windowStatus, randomReady] of states) {
        const expectedReady = selection.mode === "specific" || randomReady;
        const label = `${selection.mode}/${selection.entries.length}/${usageStatus}/${windowStatus}`;
        const requests: string[] = [];
        const harness = createStartHomeLaunchHarness({
          draft: {
            ...createReadyDraft(),
            characterSelectionMode: selection.mode,
          },
          characterEntries: selection.entries,
          sessionCharacterUsageLoadStatus: usageStatus,
          openSessionWindowIdsLoadStatus: windowStatus,
          /** 候補のある Random ケースで選択が再現できるよう抽選値を固定する。 */
          random: () => 0,
          /** 作成可能な組合せで実際に渡された Character ID を記録し、その ID を結果にも載せる。 */
          createSession: async (input) => {
            requests.push(input.characterId);
            return createSessionSummary({ characterId: input.characterId });
          },
        });
        const projection = buildHomeLaunchProjection({
          launchProviderId: harness.input.draft.providerId,
          launchTitle: harness.input.draft.title,
          launchWorkspace: harness.input.draft.workspace,
          launchCharacterId: harness.input.draft.characterId,
          launchCharacterSelectionMode: selection.mode,
          characterEntries: selection.entries,
          charactersLoaded: true,
          characterLoadStatus: "loaded",
          sessionCharacterUsageLoadStatus: usageStatus,
          openSessionWindowIdsLoadStatus: windowStatus,
          appSettings: createDefaultAppSettings(),
          modelCatalog: {
            providers: [
              {
                id: "codex",
                label: "Codex",
                defaultModelId: "gpt-5.4",
                defaultReasoningEffort: "high",
                models: [
                  {
                    id: "gpt-5.4",
                    label: "GPT-5.4",
                    reasoningEfforts: ["high"],
                  },
                ],
              },
            ],
          },
        });

        assert.equal(projection.canStartSession, expectedReady, label);
        await startHomeLaunch(harness.input);
        assert.deepEqual(
          requests,
          expectedReady ? [selection.characterId] : [],
          label,
        );
        assert.deepEqual(
          harness.startingStates,
          expectedReady ? [true, false] : [],
          label,
        );
      }
    }
  });

  /** すでに起動中ならフィードバックや開始中フラグを再通知せず、ダイアログを閉じないことを確認する。 */
  it("起動中は何もしない", async () => {
    const harness = createStartHomeLaunchHarness({ launchStarting: true });

    await startHomeLaunch(harness.input);

    assert.deepEqual(harness.feedback, []);
    assert.deepEqual(harness.startingStates, []);
    assert.equal(harness.closeCount, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "startHomeLaunchはtitle空のvalidation error時にSession作成を行わず、利用者向けfeedbackを返す"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session validation feedback" }
  // fault = "不正なSession titleでもcreateSessionを実行するか、validation理由をfeedbackへ渡さない"
  // observable = "feedback callbackのvalidation message、launchStarting callbackとcreateSession APIの呼び出し有無"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch empty-title validation guard"
  // lifecycle = "permanent"
  // impact = "利用者が修正すべき入力を識別でき、未検証Sessionの作成を防ぐ"
  // distinction = "validation helperの戻り値だけでなく、launch actionが作成経路へ進まないことをcallbackで確認する"
  // @end-test-value
  /** 空タイトルを利用者向けに指摘し、作成 API と開始中の通知へ進まないことを確認する。 */
  it("validation error を feedback に返す", async () => {
    const harness = createStartHomeLaunchHarness({
      draft: { ...createReadyDraft(), title: "" },
    });

    await startHomeLaunch(harness.input);

    assert.deepEqual(harness.feedback, ["Enter a session title."]);
    assert.deepEqual(harness.startingStates, []);
    assert.equal(harness.createSessionCount, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "startHomeLaunchの成功経路は選択CharacterでSessionを作成し、summaryを保存してwindowを開き、dialogを閉じる"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session launch flow" }
  // fault = "Session作成後にsummary登録・window open・dialog closeのいずれかを省略するか、選択Characterを取り違える"
  // observable = "createSession入力のcharacterId、空のfeedback、starting states、close count、summary/opened session IDs"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch successful launch flow"
  // lifecycle = "permanent"
  // impact = "新規Sessionを作成した直後にHomeとSession windowの状態を同期する"
  // distinction = "createSession単体の呼び出しではなく、成功後のUI状態通知とwindow導線まで一連で確認する"
  // @end-test-value
  /** 選択した Mia で作成し、その結果の概要登録とウィンドウ表示、ダイアログの終了まで進むことを確認する。 */
  it("session を作成して window を開く", async () => {
    const harness = createStartHomeLaunchHarness();
    let capturedCharacterId = "";

    harness.input.createSession = async (input) => {
      capturedCharacterId = input.characterId;
      return createSessionSummary();
    };
    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "mia");
    assert.deepEqual(harness.feedback, [""]);
    assert.deepEqual(harness.startingStates, [true, false]);
    assert.equal(harness.closeCount, 1);
    assert.deepEqual(harness.sessionSummaries, ["session-1"]);
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  /** Session Folder の実パスは作成側に任せ、要求では種別だけを送って返された Session を開くことを確認する。 */
  it("SessionFolder 選択時は未確定 path の request で session を作成する", async () => {
    let capturedWorkspace: unknown = null;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...setLaunchWorkspaceToSessionFolder(createReadyDraft()),
      },
      /** 作成前の workspace 指定を捕捉し、実パスが確定した後の Session 概要を返す。 */
      createSession: async (input) => {
        capturedWorkspace = input.workspace;
        return createSessionSummary({
          workspaceLabel: "SessionFolder",
          workspacePath: "C:/WithMate/session-files/session-1",
        });
      },
    });

    await startHomeLaunch(harness.input);

    assert.deepEqual(capturedWorkspace, { kind: "session-folder" });
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  /** Mia の利用履歴がある状態の重み付き抽選で Noa が選ばれ、その Session を開くことを確認する。 */
  it("random選択では最近使っていないCharacterを重み付きで選んでsessionを作成する", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessions: [
        createSessionSummary({ id: "recent-mia", characterId: "mia" }),
      ],
      sessionCharacterUsage: [{ characterId: "mia", sessionKind: "default" }],
      /** 履歴による重み付けの違いが選択に現れる抽選値を返す。 */
      random: () => 0.4,
      /** 利用履歴を反映した抽選結果が作成 API に届いたか記録する。 */
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "noa");
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  /** Mia の Character Authoring ウィンドウが開いている場合も Random 候補から除き、Noa で開始することを確認する。 */
  it("random選択では開いているSession WindowのCharacterを候補から外す", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessions: [
        createSessionSummary({
          id: "open-mia",
          characterId: "mia",
          sessionKind: "character-authoring",
        }),
      ],
      openSessionWindowIds: ["open-mia"],
      /** 候補の除外がなければ先頭を選ぶ抽選値を返す。 */
      random: () => 0,
      /** 開いているウィンドウを除外した後、作成先に渡る Character ID を取る。 */
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "noa");
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Character usage履歴がloading中のrandom launchはSession作成を保留し、再試行可能なpending feedbackを返す"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session dialogのRandom開始条件" }
  // fault = "履歴が未取得のままrandom候補を確定してSessionを作成するか、履歴待ちの理由を返さない"
  // observable = "createSession call count、Session historyの取得中を示すfeedback、launchStarting callback state"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch random launch usage loading"
  // lifecycle = "permanent"
  // impact = "不完全な履歴による意図しないCharacter選択とSession作成を防ぐ"
  // distinction = "projectionのloading表示ではなく、開始action自体の副作用抑制とfeedbackを確認する"
  // @end-test-value
  /** 使用履歴の取得中は Random の作成や開始中通知を行わず、履歴待ちを案内することを確認する。 */
  it("履歴の読み込み中はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessionCharacterUsageLoadStatus: "loading",
      /** 履歴待ちのガードを越えて作成に進んだ場合を検出できるよう呼出を数える。 */
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, [
      "Loading session history for random character selection",
    ]);
    assert.deepEqual(harness.startingStates, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Character usage履歴がerrorのrandom launchはSession作成を行わず、利用不能理由をfeedbackへ返す"
  // oracle = { type = "contract", ref = "Issue #731 New session random selection data-state distinction" }
  // fault = "履歴取得失敗を空履歴として扱ってrandom Sessionを作成するか、利用不能状態を隠す"
  // observable = "createSession call count、unavailable feedback、launchStarting callback state"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch random launch usage error"
  // lifecycle = "permanent"
  // impact = "取得失敗による予測不能なrandom選択を防ぎ、利用者が再試行判断できる"
  // distinction = "loading時の保留とは別に、error状態を明示feedbackへ投影する契約を確認する"
  // @end-test-value
  /** 使用履歴の取得失敗を空履歴や取得待ちと扱わず、Random を始めず利用不能を伝えることを確認する。 */
  it("履歴の読み込み失敗後はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessionCharacterUsageLoadStatus: "error",
      /** 履歴の取得失敗が作成に進まないことを検査するため呼出を数える。 */
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, [
      "Session history is unavailable, so random selection cannot start.",
    ]);
    assert.deepEqual(harness.startingStates, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "open Session Window一覧がloading中のrandom launchはSession作成を保留し、確認中feedbackを返す"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session dialogのRandom開始条件" }
  // fault = "open window情報が未取得のまま候補を確定してSessionを作成するか、Window取得待ちの理由を返さない"
  // observable = "createSession call count、Open session windowsの取得中を示すfeedback、launchStarting callback state"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch random launch open-window loading"
  // lifecycle = "permanent"
  // impact = "既存open windowとの重複を避け、不完全な候補情報でのSession作成を防ぐ"
  // distinction = "session usage履歴ではなくopen window一覧のloading guardを独立して確認する"
  // @end-test-value
  /** 開いているウィンドウ一覧の取得中は Random を始めず、何を確認中か明示することを確認する。 */
  it("open Session Window 一覧の読み込み中はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      openSessionWindowIdsLoadStatus: "loading",
      /** ウィンドウ一覧の取得待ちで誤って作成を呼んだ場合に数を残す。 */
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, [
      "Loading open session windows for random character selection",
    ]);
    assert.deepEqual(harness.startingStates, []);
  });

  /** ウィンドウ一覧が取得できなくても、固定選択の Mia で作成してウィンドウを開けることを確認する。 */
  it("open Session Window 一覧の取得失敗後でも固定Characterのsessionは開始できる", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      openSessionWindowIdsLoadStatus: "error",
      /** ウィンドウ一覧の成否とは無関係に、固定 Character が要求に入ったか観測する。 */
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "mia");
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  /** 使用履歴が取得できなくても、固定選択の Mia で作成してウィンドウを開けることを確認する。 */
  it("履歴の読み込み失敗後でも固定Characterのsessionは開始できる", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      sessionCharacterUsageLoadStatus: "error",
      /** 履歴取得失敗後も作成が選択済み Character を受け取ったか記録する。 */
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "mia");
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Character未作成かつMate未作成でもrandom launchはneutral CharacterでSession作成を完了する"
  // oracle = { type = "contract", ref = "Issue #731 New session neutral Character fallback" }
  // fault = "候補catalogが空の初回状態でSession作成を停止するか、neutral Characterを選択せず不正なIDを渡す"
  // observable = "createSession入力のneutral characterId、空のfeedback、opened session ID"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch neutral Character fallback"
  // lifecycle = "permanent"
  // impact = "初回利用者がCharacterを作成する前でも新規Session導線を利用できる"
  // distinction = "通常のspecific/random候補選択ではなく、空catalogとMate未作成のfallback境界を確認する"
  // @end-test-value
  /** Mate も Character 候補も存在しない初回状態で、Random が neutral ID を渡して正常に作成・表示できることを確認する。 */
  it("Mate 未作成でも neutral character で session を作成する", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      mateState: "not_created",
      mateProfile: null,
      characterEntries: [],
      /** 初回状態のフォールバックとして選択された Character ID を記録する。 */
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "withmate-neutral-character");
    assert.deepEqual(harness.feedback, [""]);
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });
});
