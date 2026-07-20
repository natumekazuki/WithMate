import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src/character/character-catalog.js";
import type { CompanionSession, CompanionSessionSummary } from "../../src/companion-state.js";
import { startHomeLaunch } from "../../src/home/home-launch-actions.js";
import {
  createClosedLaunchDraft,
  setLaunchWorkspaceFromPath,
  type HomeLaunchDraft,
} from "../../src/home/home-launch-state.js";
import type { MateProfile } from "../../src/mate/mate-state.js";
import type { SessionSummary } from "../../src/session-state.js";

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

function createReadyDraft(mode: HomeLaunchDraft["mode"] = "session"): HomeLaunchDraft {
  return {
    ...setLaunchWorkspaceFromPath(createClosedLaunchDraft(), "C:/work/demo"),
    open: true,
    mode,
    title: "Task",
    providerId: "codex",
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
      isDefault: true,
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
      isDefault: false,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      archivedAt: null,
    },
  ];
}

function createCompanionSession(): CompanionSession {
  return {
    id: "companion-1",
    groupId: "group-1",
    taskTitle: "Task",
    status: "active",
    repoRoot: "C:/work/demo",
    focusPath: "",
    targetBranch: "main",
    baseSnapshotRef: "HEAD",
    baseSnapshotCommit: "abc123",
    companionBranch: "companion/task",
    worktreePath: "C:/work/demo-companion",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    runState: "idle",
    threadId: "thread-1",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    customAgentName: "",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    characterId: "mate-1",
    character: "Mia",
    characterRoleMarkdown: "Mate profile",
    characterIconPath: "avatar.png",
    characterThemeColors: { main: "#111111", sub: "#f5f5f5" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  };
}

function createSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-1",
    taskTitle: "Task",
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
  const openedCompanionSessions: string[] = [];
  const companionSummaries: string[] = [];
  let closeCount = 0;

  return {
    feedback,
    startingStates,
    openedSessions,
    sessionSummaries,
    openedCompanionSessions,
    companionSummaries,
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
      sessionSummariesLoadStatus: "loaded" as const,
      createSession: async () => createSessionSummary(),
      createCompanionSession: async () => createCompanionSession(),
      openSessionWindow: async (sessionId: string) => {
        openedSessions.push(sessionId);
      },
      openCompanionReviewWindow: async (sessionId: string) => {
        openedCompanionSessions.push(sessionId);
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
      upsertSessionSummary: (summary: SessionSummary) => {
        sessionSummaries.push(summary.id);
      },
      upsertCompanionSessionSummary: (summary: CompanionSessionSummary) => {
        companionSummaries.push(summary.id);
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

  it("validation error を feedback に返す", async () => {
    const harness = createStartHomeLaunchHarness({
      draft: { ...createReadyDraft(), title: "" },
    });

    await startHomeLaunch(harness.input);

    assert.deepEqual(harness.feedback, ["タイトルを入力してね。"]);
    assert.deepEqual(harness.startingStates, []);
  });

  it("session を作成して window を開く", async () => {
    const harness = createStartHomeLaunchHarness();
    let capturedCharacterId = "";

    harness.input.createSession = async (input) => {
      capturedCharacterId = input.characterId;
      return createSessionSummary();
    };
    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "mia");
    assert.deepEqual(harness.feedback, ["Session を開始してるよ..."]);
    assert.deepEqual(harness.startingStates, [true, false]);
    assert.equal(harness.closeCount, 1);
    assert.deepEqual(harness.sessionSummaries, ["session-1"]);
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

  it("履歴の読み込み中はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessionSummariesLoadStatus: "loading",
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, ["Session 履歴を読み込んでるよ。完了してからもう一度開始してね。"]);
    assert.deepEqual(harness.startingStates, []);
  });

  it("履歴の読み込み失敗後はrandom選択のsessionを開始しない", async () => {
    let createCount = 0;
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft(),
        characterSelectionMode: "random",
      },
      sessionSummariesLoadStatus: "error",
      createSession: async () => {
        createCount += 1;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(createCount, 0);
    assert.deepEqual(harness.feedback, ["Session 履歴を読み込めていないため、ランダム選択を開始できないよ。"]);
    assert.deepEqual(harness.startingStates, []);
  });

  it("履歴の読み込み失敗後でも固定Characterのsessionは開始できる", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      sessionSummariesLoadStatus: "error",
      createSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createSessionSummary();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "mia");
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

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
    assert.deepEqual(harness.feedback, ["Session を開始してるよ..."]);
    assert.deepEqual(harness.openedSessions, ["session-1"]);
  });

  it("companion を作成して review window を開く", async () => {
    const harness = createStartHomeLaunchHarness({
      draft: createReadyDraft("companion"),
      requestedMode: "companion",
    });
    let capturedCharacter = "";

    harness.input.createCompanionSession = async (input) => {
      capturedCharacter = input.character;
      return createCompanionSession();
    };

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacter, "Mia");
    assert.deepEqual(harness.feedback, ["Companion を開始してるよ..."]);
    assert.deepEqual(harness.startingStates, [true, false]);
    assert.equal(harness.closeCount, 1);
    assert.deepEqual(harness.companionSummaries, ["companion-1"]);
    assert.deepEqual(harness.openedCompanionSessions, ["companion-1"]);
  });

  it("random選択では最近使っていないCharacterを重み付きで選んでcompanionを作成する", async () => {
    let capturedCharacterId = "";
    const harness = createStartHomeLaunchHarness({
      draft: {
        ...createReadyDraft("companion"),
        characterSelectionMode: "random",
      },
      requestedMode: "companion",
      sessions: [createSessionSummary({ id: "recent-mia", characterId: "mia" })],
      random: () => 0.4,
      createCompanionSession: async (input) => {
        capturedCharacterId = input.characterId;
        return createCompanionSession();
      },
    });

    await startHomeLaunch(harness.input);

    assert.equal(capturedCharacterId, "noa");
    assert.deepEqual(harness.companionSummaries, ["companion-1"]);
    assert.deepEqual(harness.openedCompanionSessions, ["companion-1"]);
  });
});
