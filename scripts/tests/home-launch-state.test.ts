import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import type { CharacterProfile, SessionSummary } from "../../src/app-state.js";
import {
  buildCreateCompanionSessionInputFromLaunchDraft,
  buildCreateSessionInputFromLaunchDraft,
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  resolveLastUsedSessionSelection,
  setLaunchWorkspaceFromPath,
  syncLaunchDraftCharacter,
} from "../../src/home-launch-state.js";

function createCharacter(partial: Partial<CharacterProfile> & Pick<CharacterProfile, "id" | "name">): CharacterProfile {
  return {
    description: "",
    iconPath: "icon.png",
    roleMarkdown: "",
    notesMarkdown: "",
    themeColors: {
      main: "#000000",
      sub: "#ffffff",
    },
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandWaiting: [],
      latestCommandEmpty: [],
      changedFilesEmpty: [],
      contextEmpty: [],
    },
    ...partial,
  };
}

describe("home-launch-state", () => {
  it("open と close で launch draft を reset する", () => {
    const opened = openLaunchDraft(
      {
        ...createClosedLaunchDraft("char-1"),
        open: false,
        title: "keep",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "old",
        characterSearchText: "mi",
      },
      "codex",
    );

    assert.deepEqual(opened, {
      open: true,
      mode: "session",
      title: "",
      workspace: null,
      providerId: "codex",
      model: DEFAULT_MODEL_ID,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
      characterId: "char-1",
      characterSearchText: "",
    });

    assert.deepEqual(closeLaunchDraft(opened), {
      open: false,
      mode: "session",
      title: "",
      workspace: null,
      providerId: "",
      model: DEFAULT_MODEL_ID,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
      characterId: "char-1",
      characterSearchText: "",
    });
  });

  it("character 一覧から launch draft の characterId を同期する", () => {
    const draft = createClosedLaunchDraft("missing");
    const synced = syncLaunchDraftCharacter(draft, [
      createCharacter({ id: "a", name: "Mia" }),
      createCharacter({ id: "b", name: "Luna" }),
    ]);

    assert.equal(synced.characterId, "a");
  });

  it("workspace path から launch draft の workspace を更新する", () => {
    const draft = setLaunchWorkspaceFromPath(createClosedLaunchDraft("a"), "F:/work/demo");

    assert.deepEqual(draft.workspace, {
      label: "demo",
      path: "F:/work/demo",
      branch: "",
    });
  });

  it("launch draft から session input を組み立てる", () => {
    const input = buildCreateSessionInputFromLaunchDraft({
      draft: {
        open: true,
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
        characterId: "a",
        characterSearchText: "",
      },
      selectedCharacter: createCharacter({ id: "a", name: "Mia" }),
      selectedProviderId: "codex",
      approvalMode: DEFAULT_APPROVAL_MODE,
      lastUsedSelection: {
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        customAgentName: "reviewer",
      },
    });

    assert.deepEqual(input, {
      provider: "codex",
      taskTitle: "task",
      workspaceLabel: "demo",
      workspacePath: "F:/work/demo",
      branch: "main",
      characterId: "a",
      character: "Mia",
      characterIconPath: "icon.png",
      characterThemeColors: {
        main: "#000000",
        sub: "#ffffff",
      },
      approvalMode: DEFAULT_APPROVAL_MODE,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      customAgentName: "reviewer",
    });
  });

  it("Companion launch は provider の last-used model を優先する", () => {
    const input = buildCreateCompanionSessionInputFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft("a"),
        open: true,
        mode: "companion",
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
      },
      selectedCharacter: createCharacter({ id: "a", name: "Mia" }),
      selectedProviderId: "codex",
      lastUsedSelection: {
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        customAgentName: "reviewer",
      },
    });

    assert.equal(input?.model, "gpt-5.4-mini");
    assert.equal(input?.reasoningEffort, "medium");
    assert.equal(input?.customAgentName, "reviewer");
  });

  it("selected provider の直近 session から last-used selection を引く", () => {
    const sessions: Pick<SessionSummary, "provider" | "model" | "reasoningEffort" | "customAgentName">[] = [
      {
        provider: "copilot",
        model: "gpt-4.1",
        reasoningEffort: "high",
        customAgentName: "planner",
      },
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        customAgentName: "",
      },
    ];
    const selection = resolveLastUsedSessionSelection(
      sessions,
      "codex",
    );

    assert.deepEqual(selection, {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      customAgentName: "",
    });
  });

  it("selected provider の既存 session が無ければ last-used selection を返さない", () => {
    const sessions: Pick<SessionSummary, "provider" | "model" | "reasoningEffort" | "customAgentName">[] = [
      {
        provider: "copilot",
        model: "gpt-4.1",
        reasoningEffort: "high",
        customAgentName: "planner",
      },
    ];
    const selection = resolveLastUsedSessionSelection(
      sessions,
      "codex",
    );

    assert.equal(selection, null);
  });

  it("launch 条件が欠けている時は session input を返さない", () => {
    const input = buildCreateSessionInputFromLaunchDraft({
      draft: createClosedLaunchDraft("a"),
      selectedCharacter: createCharacter({ id: "a", name: "Mia" }),
      selectedProviderId: "codex",
      approvalMode: DEFAULT_APPROVAL_MODE,
    });

    assert.equal(input, null);
  });
});
