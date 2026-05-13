import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppSettings } from "../../src/provider-settings-state.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import { type HomeProviderInstructionTargetApi } from "../../src/settings/provider-instruction-target-actions.js";
import { type HomeProviderInstructionTargetDraft } from "../../src/settings/provider-instruction-target-draft.js";
import {
  handleBrowseProviderInstructionInstructionRelativePath,
  handleChangeProviderInstructionEnabled,
  handleChangeProviderInstructionFailPolicy,
  handleChangeProviderInstructionInstructionRelativePath,
  handleChangeProviderInstructionWriteMode,
} from "../../src/settings/provider-instruction-target-actions.js";

function createApi(overrides?: Partial<HomeProviderInstructionTargetApi>): HomeProviderInstructionTargetApi {
  return {
    pickFile: async () => null,
    upsertProviderInstructionTarget: async () => null as never,
    ...overrides,
  };
}

function createSettings(skillRootPath: string): AppSettings {
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings = {
    ...settings.codingProviderSettings,
    codex: {
      ...settings.codingProviderSettings.codex,
      skillRootPath,
    },
  };
  return settings;
}

function createTargetState() {
  const state = {
    targets: [] as HomeProviderInstructionTargetDraft[],
    feedback: "",
  };

  return {
    get targets() {
      return state.targets;
    },
    get feedback() {
      return state.feedback;
    },
    setTargets: (updater: (current: HomeProviderInstructionTargetDraft[]) => HomeProviderInstructionTargetDraft[]) => {
      state.targets = updater(state.targets);
    },
    setFeedback: (feedback: string) => {
      state.feedback = feedback;
    },
    setTargetsState: (targets: HomeProviderInstructionTargetDraft[]) => {
      state.targets = targets;
    },
  };
}

describe("provider instruction target actions", () => {
  it("enabled/write/fail/relativePath 更新は skill root を保持して upsert する", async () => {
    const state = createTargetState();
    const settingsDraft = createSettings("/tmp/workspace");
    const upsertInputs: unknown[] = [];
    const api = createApi({
      upsertProviderInstructionTarget: async (input) => {
        upsertInputs.push(input);
        return null as never;
      },
    });

    const setFeedback = (feedback: string) => {
      state.setFeedback(feedback);
    };

    handleChangeProviderInstructionEnabled({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: setFeedback,
      api,
      providerId: "codex",
      enabled: true,
    });
    await Promise.resolve();

    handleChangeProviderInstructionWriteMode({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: setFeedback,
      api,
      providerId: "codex",
      writeMode: "managed_file",
    });
    await Promise.resolve();

    handleChangeProviderInstructionFailPolicy({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: setFeedback,
      api,
      providerId: "codex",
      failPolicy: "block_session",
    });
    await Promise.resolve();

    handleChangeProviderInstructionInstructionRelativePath({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: setFeedback,
      api,
      providerId: "codex",
      instructionRelativePath: "AGENTS.md",
    });
    await Promise.resolve();

    const latestTarget = state.targets[0];
    assert.equal(upsertInputs.length, 4);
    assert.equal(latestTarget.providerId, "codex");
    assert.equal(latestTarget.rootDirectory, "/tmp/workspace");
    assert.equal(latestTarget.enabled, true);
    assert.equal(latestTarget.writeMode, "managed_file");
    assert.equal(latestTarget.failPolicy, "block_session");
    assert.equal(latestTarget.instructionRelativePath, "AGENTS.md");
    assert.equal(state.feedback, "");
    const latestInput = upsertInputs[3] as { rootDirectory: string };
    assert.equal(latestInput.rootDirectory, "/tmp/workspace");
  });

  it("invalid write/fail は state と upsert を変更しない", () => {
    const state = createTargetState();
    const settingsDraft = createSettings("/tmp/workspace");
    const upsertInputs: unknown[] = [];
    const api = createApi({
      upsertProviderInstructionTarget: async (input) => {
        upsertInputs.push(input);
        return null as never;
      },
    });
    state.setTargetsState([
      {
        providerId: "codex",
        targetId: "main",
        enabled: false,
        rootDirectory: "/tmp/workspace",
        instructionRelativePath: ".github/copilot-instructions.md",
        lastSyncState: "never",
        lastSyncRunId: null,
        lastSyncedRevisionId: null,
        lastErrorPreview: "",
        lastSyncedAt: null,
        writeMode: "managed_block",
        projectionScope: "mate_only",
        failPolicy: "warn_continue",
        requiresRestart: false,
      },
    ]);
    const before = structuredClone(state.targets);

    const setFeedback = (feedback: string) => {
      state.setFeedback(feedback);
    };

    handleChangeProviderInstructionWriteMode({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: setFeedback,
      api,
      providerId: "codex",
      writeMode: "invalid",
    });
    handleChangeProviderInstructionFailPolicy({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: setFeedback,
      api,
      providerId: "codex",
      failPolicy: "invalid",
    });

    assert.equal(upsertInputs.length, 0);
    assert.deepEqual(state.targets, before);
  });

  it("browse では root directory 未設定時はフィードバックして upsert しない", async () => {
    const state = createTargetState();
    const settingsDraft = createSettings("");
    const upsertInputs: unknown[] = [];
    const api = createApi({
      upsertProviderInstructionTarget: async (input) => {
        upsertInputs.push(input);
        return null as never;
      },
    });

    await handleBrowseProviderInstructionInstructionRelativePath({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: state.setFeedback,
      api,
      providerId: "codex",
    });

    assert.equal(state.feedback, "Instruction Relative Path を選ぶ前に Root Directory を指定してね。");
    assert.equal(upsertInputs.length, 0);
    assert.equal(state.targets.length, 0);
  });

  it("browse で root 外を選ぶと upsert しない", async () => {
    const state = createTargetState();
    const settingsDraft = createSettings("/tmp/workspace");
    const upsertInputs: unknown[] = [];
    const api = createApi({
      upsertProviderInstructionTarget: async (input) => {
        upsertInputs.push(input);
        return null as never;
      },
      pickFile: async () => "/tmp/other/place/AGENTS.md",
    });

    await handleBrowseProviderInstructionInstructionRelativePath({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: state.setFeedback,
      api,
      providerId: "codex",
    });

    assert.equal(state.feedback, "Root Directory 配下の instruction file を選んでね。");
    assert.equal(upsertInputs.length, 0);
    assert.equal(state.targets.length, 0);
  });

  it("browse で root 配下を選ぶと upsert が実行される", async () => {
    const state = createTargetState();
    const settingsDraft = createSettings("/tmp/workspace");
    const upsertInputs: unknown[] = [];
    const api = createApi({
      upsertProviderInstructionTarget: async (input) => {
        upsertInputs.push(input);
        return null as never;
      },
      pickFile: async () => "/tmp/workspace/.github/copilot-instructions.md",
    });

    await handleBrowseProviderInstructionInstructionRelativePath({
      providerInstructionTargets: state.targets,
      settingsDraft,
      setProviderInstructionTargets: state.setTargets,
      setSettingsFeedback: state.setFeedback,
      api,
      providerId: "codex",
    });

    const latestTarget = state.targets[0];
    assert.equal(state.feedback, "");
    assert.equal(latestTarget.rootDirectory, "/tmp/workspace");
    assert.equal(latestTarget.instructionRelativePath, ".github/copilot-instructions.md");
    assert.equal(upsertInputs.length, 1);
    const latestInput = upsertInputs[0] as { rootDirectory: string; instructionRelativePath: string };
    assert.equal(latestInput.rootDirectory, "/tmp/workspace");
    assert.equal(latestInput.instructionRelativePath, ".github/copilot-instructions.md");
  });
});
