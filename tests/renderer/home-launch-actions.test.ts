import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { startHomeLaunch } from "../../src/home/home-launch-actions.js";
import {
  createClosedLaunchDraft,
  setLaunchWorkspaceFromPath,
  setLaunchWorkspaceToSessionFolder,
  type HomeLaunchDraft,
} from "../../src/home/home-launch-state.js";
import type { MateProfile } from "../../src-shared/mate/mate-state.js";
import type { HomeSessionSummary, SessionSummary } from "../../src-shared/session/session-state.js";

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


function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
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

function createStartHomeLaunchHarness(overrides: Partial<Parameters<typeof startHomeLaunch>[0]> = {}) {
  const feedback: string[] = [];
  const startingStates: boolean[] = [];
  const openedSessions: string[] = [];
  const sessionSummaries: string[] = [];
  let closeCount = 0;

  return {
    feedback,
    startingStates,
    openedSessions,
    sessionSummaries,
    get closeCount() {
      return closeCount;
    },
    input: {
      draft: createReadyDraft(),
      launchStarting: false,
      mateState: "active" as const,
      mateProfile: createMateProfile(),
      characterEntries: createCharacterEntries(),
      selectedProviderId: "codex",
      sessions: [],
      sessionCharacterUsage: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded" as const,
      sessionCharacterUsageLoadStatus: "loaded" as const,
      createSession: async () => createSessionSummary(),
      openSessionWindow: async (sessionId: string) => {
        openedSessions.push(sessionId);
      },
      closeLaunchDialog: () => {
        closeCount += 1;
      },
      setLaunchFeedback: (message: string) => {
        feedback.push(message);
      },
      setLaunchStarting: (launchStarting: boolean) => {
        startingStates.push(launchStarting);
      },
      upsertSessionSummary: (summary: HomeSessionSummary) => {
        sessionSummaries.push(summary.id);
      },
      ...overrides,
    },
  };
}

describe("home-launch-actions", () => {
  it("起動中は何もしない", async () => {
    const harness = createStartHomeLaunchHarness({ launchStarting: true });

    await startHomeLaunch(harness.input);

    assert.deepEqual(harness.feedback, []);
    assert.deepEqual(harness.startingStates, []);
    assert.equal(harness.closeCount, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "startHomeLaunchは入力validation error時にSession作成を行わず、利用者向けfeedbackを返す"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session validation feedback" }
  // fault = "不正なSession titleでもcreateSessionを実行するか、validation理由をfeedbackへ渡さない"
  // observable = "feedback callbackのvalidation messageとlaunchStarting callbackの呼び出し有無"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch validation guard"
  // lifecycle = "permanent"
  // impact = "利用者が修正すべき入力を識別でき、未検証Sessionの作成を防ぐ"
  // distinction = "validation helperの戻り値だけでなく、launch actionが作成経路へ進まないことをcallbackで確認する"
  // @end-test-value
  it("validation error を feedback に返す", async () => {
    const harness = createStartHomeLaunchHarness({
      draft: { ...createReadyDraft(), title: "" },
    });

    await startHomeLaunch(harness.input);

    assert.deepEqual(harness.feedback, ["Enter a session title."]);
    assert.deepEqual(harness.startingStates, []);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "startHomeLaunchの成功経路は選択CharacterでSessionを作成し、summaryを保存してwindowを開き、dialogを閉じる"
  // oracle = { type = "contract", ref = "Issue #731 Home/New session launch flow" }
  // fault = "Session作成後にsummary登録・window open・dialog closeのいずれかを省略するか、選択Characterを取り違える"
  // observable = "createSession入力のcharacterId、Starting session… feedback、starting states、close count、summary/opened session IDs"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch successful launch flow"
  // lifecycle = "permanent"
  // impact = "新規Sessionを作成した直後にHomeとSession windowの状態を同期する"
  // distinction = "createSession単体の呼び出しではなく、成功後のUI状態通知とwindow導線まで一連で確認する"
  // @end-test-value
  it("session を作成して window を開く", async () => {
    const harness = createStartHomeLaunchHarness();
    let capturedCharacterId = "";

    harness.input.createSession = async (input) => {
      capturedCharacterId = input.characterId;
      return createSessionSummary();
    };
    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "mia");
    assert.deepEqual(harness.feedback, ["Starting session…"]);
    assert.deepEqual(harness.startingStates, [true, false]);
    assert.equal(harness.closeCount, 1);
    assert.deepEqual(harness.sessionSummaries, ["session-1"]);
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  it("SessionFolder 選択時は未確定 path の request で session を作成する", async () => {
    let capturedWorkspace: unknown = null;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...setLaunchWorkspaceToSessionFolder(createReadyDraft()),
      },
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

  it("random選択では最近使っていないCharacterを重み付きで選んでsessionを作成する", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessions: [createSessionSummary({ id: "recent-mia", characterId: "mia" })],
      sessionCharacterUsage: [{ characterId: "mia", sessionKind: "default" }],
      random: () => 0.4,
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "noa");
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  it("random選択では開いているSession WindowのCharacterを候補から外す", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessions: [createSessionSummary({
        id: "open-mia",
        characterId: "mia",
        sessionKind: "character-authoring",
      })],
      openSessionWindowIds: ["open-mia"],
      random: () => 0,
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
  // oracle = { type = "contract", ref = "Issue #731 New session random selection data-state distinction" }
  // fault = "履歴が未取得のままrandom候補を確定してSessionを作成するか、loading理由を表示しない"
  // observable = "createSession call count、feedback message、launchStarting callback state"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch random launch usage loading"
  // lifecycle = "permanent"
  // impact = "不完全な履歴による意図しないCharacter選択とSession作成を防ぐ"
  // distinction = "projectionのloading表示ではなく、開始action自体の副作用抑制とfeedbackを確認する"
  // @end-test-value
  it("履歴の読み込み中はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessionCharacterUsageLoadStatus: "loading",
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, ["Loading session history. Try again when it finishes."]);
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
  it("履歴の読み込み失敗後はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessionCharacterUsageLoadStatus: "error",
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, ["Session history is unavailable, so random selection cannot start."]);
    assert.deepEqual(harness.startingStates, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "open Session Window一覧がloading中のrandom launchはSession作成を保留し、確認中feedbackを返す"
  // oracle = { type = "contract", ref = "Issue #731 New session random selection open-window state" }
  // fault = "open window情報が未取得のまま候補を確定してSessionを作成するか、確認中状態を利用者へ伝えない"
  // observable = "createSession call count、Checking open session windows feedback、launchStarting callback state"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch random launch open-window loading"
  // lifecycle = "permanent"
  // impact = "既存open windowとの重複を避け、不完全な候補情報でのSession作成を防ぐ"
  // distinction = "session usage履歴ではなくopen window一覧のloading guardを独立して確認する"
  // @end-test-value
  it("open Session Window 一覧の読み込み中はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      openSessionWindowIdsLoadStatus: "loading",
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, [
      "Checking open session windows. Try again when it finishes.",
    ]);
    assert.deepEqual(harness.startingStates, []);
  });

  it("open Session Window 一覧の取得失敗後でも固定Characterのsessionは開始できる", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      openSessionWindowIdsLoadStatus: "error",
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "mia");
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  it("履歴の読み込み失敗後でも固定Characterのsessionは開始できる", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      sessionCharacterUsageLoadStatus: "error",
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
  // observable = "createSession入力のneutral characterId、Starting session… feedback、opened session ID"
  // observation_boundary = "public-boundary"
  // scope = "startHomeLaunch neutral Character fallback"
  // lifecycle = "permanent"
  // impact = "初回利用者がCharacterを作成する前でも新規Session導線を利用できる"
  // distinction = "通常のspecific/random候補選択ではなく、空catalogとMate未作成のfallback境界を確認する"
  // @end-test-value
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
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "withmate-neutral-character");
    assert.deepEqual(harness.feedback, ["Starting session…"]);
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

});
