import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAdditionalDirectoryListToggle,
  applyCancelTitleEditCommand,
  applyContextPaneTabCycleCommand,
  applyActionDockCollapseCommand,
  applyActionDockExpandCommand,
  applyExclusiveComposerPickerToggle,
  applyHeaderExpandedToggleCommand,
  applyStartTitleEditCommand,
  applyTitleInputKeyCommand,
  resolveHeaderExpandedToggle,
  toggleExpandedArtifactState,
} from "../../src/chat/session-shell-handlers.js";

describe("toggleExpandedArtifactState", () => {
  it("指定 artifact の展開状態を反転する", () => {
    assert.deepEqual(toggleExpandedArtifactState({ a: true }, "a"), { a: false });
    assert.deepEqual(toggleExpandedArtifactState({ a: true }, "b"), { a: true, b: true });
  });
});

describe("resolveHeaderExpandedToggle", () => {
  it("title 編集中は状態を維持し、それ以外は反転する", () => {
    assert.equal(resolveHeaderExpandedToggle(false, true), false);
    assert.equal(resolveHeaderExpandedToggle(true, true), true);
    assert.equal(resolveHeaderExpandedToggle(false, false), true);
    assert.equal(resolveHeaderExpandedToggle(true, false), false);
  });
});

describe("applyHeaderExpandedToggleCommand", () => {
  it("title 編集中でなければ header 展開状態を反転し、編集中は維持する", () => {
    let expanded = false;

    applyHeaderExpandedToggleCommand({
      isEditingTitle: false,
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    assert.equal(expanded, true);

    applyHeaderExpandedToggleCommand({
      isEditingTitle: true,
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    assert.equal(expanded, true);
  });
});

describe("applyTitleInputKeyCommand", () => {
  it("Enter では保存、Escape ではキャンセルし、それ以外では何もしない", () => {
    const events: string[] = [];

    const runCommand = (key: string) => applyTitleInputKeyCommand({
      key,
      preventDefault: () => events.push(`prevent:${key}`),
      saveTitle: () => events.push("save"),
      cancelTitleEdit: () => events.push("cancel"),
    });

    runCommand("Enter");
    runCommand("Escape");
    runCommand("Tab");

    assert.deepEqual(events, ["prevent:Enter", "save", "prevent:Escape", "cancel"]);
  });
});

describe("applyStartTitleEditCommand", () => {
  it("title draft を現在値に戻し、header を展開して title 編集中にする", () => {
    const events: string[] = [];

    applyStartTitleEditCommand({
      title: "現在のタイトル",
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.deepEqual(events, ["draft:現在のタイトル", "expanded:true", "editing:true"]);
  });
});

describe("applyCancelTitleEditCommand", () => {
  it("title draft を現在値に戻し、title 編集中を解除する", () => {
    const events: string[] = [];

    applyCancelTitleEditCommand({
      title: "現在のタイトル",
      setTitleDraft: (title) => events.push(`draft:${title}`),
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.deepEqual(events, ["draft:現在のタイトル", "editing:false"]);
  });
});

describe("applyActionDockExpandCommand", () => {
  it("dock を展開し、focusComposer が true の場合だけ composer focus を呼ぶ", () => {
    const events: string[] = [];

    applyActionDockExpandCommand({
      options: { focusComposer: false },
      setPinnedExpanded: (expanded) => {
        events.push(`expanded:${expanded}`);
      },
      focusComposer: () => {
        events.push("focus");
      },
    });
    applyActionDockExpandCommand({
      options: { focusComposer: true },
      setPinnedExpanded: (expanded) => {
        events.push(`expanded:${expanded}`);
      },
      focusComposer: () => {
        events.push("focus");
      },
    });

    assert.deepEqual(events, ["expanded:true", "expanded:true", "focus"]);
  });
});

describe("applyActionDockCollapseCommand", () => {
  it("collapse 可能な場合だけ pinned expanded を false にする", () => {
    const events: boolean[] = [];

    applyActionDockCollapseCommand({
      canCollapse: false,
      setPinnedExpanded: (expanded) => {
        events.push(expanded);
      },
    });
    applyActionDockCollapseCommand({
      canCollapse: true,
      setPinnedExpanded: (expanded) => {
        events.push(expanded);
      },
    });

    assert.deepEqual(events, [false]);
  });
});

describe("applyExclusiveComposerPickerToggle", () => {
  it("agent picker を toggle すると skill picker を閉じる", () => {
    let agentOpen = false;
    let skillOpen = true;

    applyExclusiveComposerPickerToggle({
      target: "agent",
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, true);
    assert.equal(skillOpen, false);
  });

  it("skill picker を toggle すると agent picker を閉じる", () => {
    let agentOpen = true;
    let skillOpen = false;

    applyExclusiveComposerPickerToggle({
      target: "skill",
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, false);
    assert.equal(skillOpen, true);
  });
});

describe("applyAdditionalDirectoryListToggle", () => {
  it("additional directory list の開閉状態を反転する", () => {
    let open = false;

    applyAdditionalDirectoryListToggle({
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });
    assert.equal(open, true);

    applyAdditionalDirectoryListToggle({
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });
    assert.equal(open, false);
  });
});

describe("applyContextPaneTabCycleCommand", () => {
  it("利用可能な context pane tab の中で active tab を循環する", () => {
    let activeTab: "latest-command" | "reasoning" | "tasks" | "companion-group" = "latest-command";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = updater(activeTab);
      },
    });
    assert.equal(activeTab, "tasks");

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = updater(activeTab);
      },
    });
    assert.equal(activeTab, "latest-command");

    applyContextPaneTabCycleCommand({
      direction: -1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "tasks");
  });

  it("active tab が利用可能タブにない場合は先頭から循環する", () => {
    let activeTab: "latest-command" | "reasoning" | "tasks" | "companion-group" = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "tasks");
  });

  it("利用可能タブが空の場合は latest-command を維持する", () => {
    let activeTab: "latest-command" | "reasoning" | "tasks" | "companion-group" = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: [],
      setActiveTab: (updater) => {
        activeTab = typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "latest-command");
  });
});
