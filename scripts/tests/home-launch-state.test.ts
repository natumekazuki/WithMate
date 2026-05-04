import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../../src/model-catalog.js";
import type { SessionSummary } from "../../src/app-state.js";
import {
  buildCreateCompanionSessionInputFromLaunchDraft,
  buildCreateSessionInputFromLaunchDraft,
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  resolveLastUsedSessionSelection,
  setLaunchWorkspaceFromPath,
} from "../../src/home-launch-state.js";
import type { MateProfile } from "../../src/mate-state.js";

function createMateProfile(partial: Partial<MateProfile> & Pick<MateProfile, "id" | "displayName">): MateProfile {
  return {
    id: "mate-1",
    state: "active",
    displayName: "Default Mate",
    description: "",
    themeMain: "#000000",
    themeSub: "#ffffff",
    avatarFilePath: "avatar.png",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: null,
    profileGeneration: 1,
    createdAt: "",
    updatedAt: "",
    deletedAt: null,
    sections: [],
    ...partial,
  };
}

describe("home-launch-state", () => {
  it("open と close で launch draft を reset する", () => {
    const opened = openLaunchDraft(
      {
        ...createClosedLaunchDraft(),
        open: false,
        title: "keep",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "old",
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
    });
  });

  it("workspace path から launch draft の workspace を更新する", () => {
    const draft = setLaunchWorkspaceFromPath(createClosedLaunchDraft(), "F:/work/demo");

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
      },
      mateProfile: createMateProfile({
        id: "mate-a",
        displayName: "Mia",
        avatarFilePath: "icon.png",
        themeMain: "#000000",
        themeSub: "#ffffff",
      }),
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
      characterId: "mate-a",
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
        ...createClosedLaunchDraft(),
        open: true,
        mode: "companion",
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
      },
      mateProfile: createMateProfile({
        id: "mate-a",
        displayName: "Mia",
        description: "assistant profile",
      }),
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
      draft: createClosedLaunchDraft(),
      mateProfile: null,
      selectedProviderId: "codex",
      approvalMode: DEFAULT_APPROVAL_MODE,
    });

    assert.equal(input, null);
  });
});
