import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyActionDockCollapseCommand,
  applyActionDockExpandCommand,
  applyExclusiveComposerPickerToggle,
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
