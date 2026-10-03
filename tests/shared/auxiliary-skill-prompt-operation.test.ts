import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAuxiliarySkillPromptInsertionOperation } from "../../src/chat/auxiliary/auxiliary-skill-prompt-operation.js";

describe("runAuxiliarySkillPromptInsertionOperation", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "AuxiliaryのClaude Skill選択は検出済みsourcePathをdraft更新へ渡す"
  // oracle = { type = "contract", ref = "src/chat/auxiliary/auxiliary-skill-prompt-operation.ts: runAuxiliarySkillPromptInsertionOperation" }
  // fault = "Auxiliary経路だけSkillのsourcePathを失い、Claudeへ名前だけの指示を送る"
  // observable = "Auxiliary draft更新callbackに渡された文字列"
  // observation_boundary = "component-behavior"
  // scope = "auxiliary-composer-skill-selection"
  // lifecycle = "permanent"
  // impact = "AuxiliaryのClaude turnで選択済みSkill本文を特定できない"
  // distinction = "Main handlerとsnippet単体のtestではAuxiliary独立経路のpath伝搬を確認できない"
  // @end-test-value
  it("ClaudeのSkill選択ではAuxiliary draftに選択元pathを挿入する", async () => {
    const drafts: string[] = [];
    await runAuxiliarySkillPromptInsertionOperation({
      activeSession: { provider: "claude", composerDraft: "fix it" },
      skillName: "review",
      skillSourcePath: ".agents/skills/review",
      applyUiState() {},
      updateDraft: async (draft) => { drafts.push(draft); },
    });
    assert.deepEqual(drafts, ['Use the skill "review" from ".agents/skills/review/SKILL.md" for this task.\n\nfix it']);
  });

  it("active session がない場合は no-op", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliarySkillPromptInsertionOperation({
        activeSession: null,
        skillName: "review",
        applyUiState: () => events.push("ui"),
        updateDraft: async () => {
          events.push("draft");
        },
      }),
      null,
    );
    assert.deepEqual(events, []);
  });

  it("skill prompt state、UI 反映、draft 更新、after hook の順に実行する", async () => {
    const events: string[] = [];
    const result = await runAuxiliarySkillPromptInsertionOperation({
      activeSession: {
        provider: "codex",
        composerDraft: "  fix it",
      },
      skillName: "review",
      applyUiState: (state) => {
        events.push(`ui:${state.caret}:${state.isSkillPickerOpen}`);
      },
      updateDraft: async (draft) => {
        events.push(`draft:${draft}`);
      },
      afterDraftUpdated: (state) => {
        events.push(`after:${state.caret}`);
      },
    });

    assert.deepEqual(result, {
      draft: "$review\n\nfix it",
      caret: 15,
      isActionDockPinnedExpanded: true,
      isSkillPickerOpen: false,
    });
    assert.deepEqual(events, [
      "ui:15:false",
      "draft:$review\n\nfix it",
      "after:15",
    ]);
  });
});
