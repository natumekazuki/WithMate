import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExclusiveComposerPickerToggleState,
  buildSkillPromptInsertionState,
  buildSkillPromptSnippet,
} from "../../src/chat/composer/session-composer-selection.js";

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

// @test-value v2
// kind = "contract"
// claim = "Skill選択時は既存draftの先頭空白を除いて指示snippetを前置し、編集位置とpicker状態を一貫して返す"
// oracle = { type = "contract", ref = "src/chat/composer/session-composer-selection.ts: buildSkillPromptInsertionState" }
// fault = "既存draftを消す、不要な先頭空白を残す、またはcaretとpicker状態を挿入結果に合わせない"
// observable = "返されたdraft・caret・Action DockとSkill pickerの状態"
// observation_boundary = "component-behavior"
// scope = "composer-skill-prompt-insertion-state"
// lifecycle = "permanent"
// impact = "選択したSkill指示と既存入力が一致せず、意図しない依頼になる"
// distinction = "snippet単体testでは既存draftとの結合と編集位置・picker状態を確認できない"
// @end-test-value
test("buildSkillPromptInsertionState は先頭空白を除いて既存 draft の前に snippet を入れる", () => {
  assert.deepEqual(buildSkillPromptInsertionState("copilot", "review", "  直して"), {
    draft: "Use the skill \"review\" for this task.\n\n直して",
    caret: "Use the skill \"review\" for this task.\n\n直して".length,
    isActionDockPinnedExpanded: true,
    isSkillPickerOpen: false,
  });
});

// @test-value v2
// kind = "contract"
// claim = "Claudeへの選択済Skill指示は実際に発見したSkillディレクトリのSKILL.mdをplain pathで示し、他Providerの挿入表現を変えない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Skill picker; src-electron/skills/skill-discovery.ts: sourcePath" }
// fault = "Skill名だけでClaudeに渡してファイルを特定できないか、@添付経路や他Providerの指示へ波及する"
// observable = "Claude/Codex/Copilotの生成snippetとClaudeの挿入draft"
// observation_boundary = "component-behavior"
// scope = "composer-skill-prompt-projection"
// lifecycle = "permanent"
// impact = "Claudeがユーザー選択のSkill本文を読めず、意図と異なる作業をする"
// distinction = "型検査ではruntime provider分岐と選択sourcePathが指示文へ届くことを確認できない"
// @end-test-value
test("Claude Skill prompt は選択元の SKILL.md を明示する", () => {
  const sourcePath = "C:/Skills/custom review";
  const expected = 'Use the skill "review" from "C:/Skills/custom review/SKILL.md" for this task.';
  assert.equal(buildSkillPromptSnippet("claude", "review", sourcePath), expected);
  assert.equal(buildSkillPromptInsertionState("claude", "review", "  fix it", sourcePath).draft, `${expected}\n\nfix it`);
  assert.equal(buildSkillPromptSnippet("codex", "review", sourcePath), "$review");
  assert.equal(buildSkillPromptSnippet("copilot", "review", sourcePath), 'Use the skill "review" for this task.');
});
