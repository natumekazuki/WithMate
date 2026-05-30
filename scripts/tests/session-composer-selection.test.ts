import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSkillPromptInsertionState,
  buildSkillPromptSnippet,
} from "../../src/session-composer-selection.js";

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
