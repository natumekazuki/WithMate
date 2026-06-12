import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAuxiliarySkillPromptInsertionOperation } from "../../src/auxiliary-skill-prompt-operation.js";

describe("runAuxiliarySkillPromptInsertionOperation", () => {
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
