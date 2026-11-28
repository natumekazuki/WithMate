import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAuxiliarySkillPromptInsertionOperation } from "../../src/chat/auxiliary/auxiliary-skill-prompt-operation.js";

/** プロバイダー別の Skill 挿入内容と、対象なし・対象ありの場合の副作用を確認する。 */
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
  /** Claude では選択元の SKILL.md を明示した指示を既存下書きの前に追加する。 */
  it("ClaudeのSkill選択ではAuxiliary draftに選択元pathを挿入する", async () => {
    const drafts: string[] = [];
    await runAuxiliarySkillPromptInsertionOperation({
      activeSession: { provider: "claude", composerDraft: "fix it" },
      skillName: "review",
      skillSourcePath: ".agents/skills/review",
      /** このケースでは保存本文だけを検証するため、描画状態の通知は処理しない。 */
      applyUiState() {},
      /** Auxiliary の下書き保存に渡った内容を記録し、挿入先と本文を検証する。 */
      updateDraft: async (draft) => {
        drafts.push(draft);
      },
    });
    assert.deepEqual(drafts, [
      'Use the skill "review" from ".agents/skills/review/SKILL.md" for this task.\n\nfix it',
    ]);
  });

  /** 対象の Auxiliary がないときは null を返し、画面状態も下書きも変更しない。 */
  it("active session がない場合は no-op", async () => {
    const events: string[] = [];

    assert.equal(
      await runAuxiliarySkillPromptInsertionOperation({
        activeSession: null,
        skillName: "review",
        /** 対象なしで画面状態の変更が誤って通知された場合に記録する。 */
        applyUiState: () => events.push("ui"),
        /** 対象なしで既存下書きへの更新が誤って呼ばれた場合に記録する。 */
        updateDraft: async () => {
          events.push("draft");
        },
      }),
      null,
    );
    assert.deepEqual(events, []);
  });

  /** Codex の Skill 指示に続いて既存本文を保存し、画面反映・保存・完了後通知の順序と選択位置を確認する。 */
  it("skill prompt state、UI 反映、draft 更新、after hook の順に実行する", async () => {
    const events: string[] = [];
    const result = await runAuxiliarySkillPromptInsertionOperation({
      activeSession: {
        provider: "codex",
        composerDraft: "  fix it",
      },
      skillName: "review",
      /** 画面通知の時点で確定したカーソル位置と Skill ピッカーの開閉を記録する。 */
      applyUiState: (state) => {
        events.push(`ui:${state.caret}:${state.isSkillPickerOpen}`);
      },
      /** 画面状態の通知後に保存される下書き本文を時系列に記録する。 */
      updateDraft: async (draft) => {
        events.push(`draft:${draft}`);
      },
      /** 保存後フックの時点と、渡された状態のカーソル位置を記録する。 */
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
