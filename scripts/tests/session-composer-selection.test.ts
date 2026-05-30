import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExclusiveComposerPickerToggleState,
  buildSkillPromptInsertionState,
  buildSkillPromptSnippet,
} from "../../src/session-composer-selection.js";

test("buildExclusiveComposerPickerToggleState は agent picker を開くと skill picker を閉じる", () => {
  assert.deepEqual(buildExclusiveComposerPickerToggleState("agent", false), {
    isAgentPickerOpen: true,
    isSkillPickerOpen: false,
  });
  assert.deepEqual(buildExclusiveComposerPickerToggleState("agent", true), {
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
  });
});

test("buildExclusiveComposerPickerToggleState は skill picker を開くと agent picker を閉じる", () => {
  assert.deepEqual(buildExclusiveComposerPickerToggleState("skill", false), {
    isAgentPickerOpen: false,
    isSkillPickerOpen: true,
  });
  assert.deepEqual(buildExclusiveComposerPickerToggleState("skill", true), {
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
  });
});

test("buildSkillPromptSnippet は provider に応じた skill prompt を返す", () => {
  assert.equal(buildSkillPromptSnippet("codex", "review"), "$review");
  assert.equal(
    buildSkillPromptSnippet("copilot", "review"),
    "Use the skill \"review\" for this task.",
  );
});

test("buildSkillPromptInsertionState は空 draft に snippet と末尾改行を入れる", () => {
  assert.deepEqual(buildSkillPromptInsertionState("codex", "review", ""), {
    draft: "$review\n",
    caret: "$review\n".length,
    isActionDockPinnedExpanded: true,
    isSkillPickerOpen: false,
  });
});

test("buildSkillPromptInsertionState は先頭空白を除いて既存 draft の前に snippet を入れる", () => {
  assert.deepEqual(buildSkillPromptInsertionState("copilot", "review", "  直して"), {
    draft: "Use the skill \"review\" for this task.\n\n直して",
    caret: "Use the skill \"review\" for this task.\n\n直して".length,
    isActionDockPinnedExpanded: true,
    isSkillPickerOpen: false,
  });
});
