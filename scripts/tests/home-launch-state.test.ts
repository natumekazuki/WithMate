import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { CharacterProfile } from "../../src/app-state.js";
import {
  buildCreateSessionInputFromLaunchDraft,
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  setLaunchWorkspaceFromPath,
  syncLaunchDraftCharacter,
} from "../../src/home-launch-state.js";

function createCharacter(partial: Partial<CharacterProfile> & Pick<CharacterProfile, "id" | "name">): CharacterProfile {
  return {
    description: "",
    iconPath: "icon.png",
    roleMarkdown: "",
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
        open: false,
        title: "keep",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "old",
        characterId: "char-1",
        characterSearchText: "mi",
      },
      "codex",
    );

    assert.deepEqual(opened, {
      open: true,
      title: "",
      workspace: null,
      providerId: "codex",
      characterId: "char-1",
      characterSearchText: "",
    });

    assert.deepEqual(closeLaunchDraft(opened), {
      open: false,
      title: "",
      workspace: null,
      providerId: "",
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
    });
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
