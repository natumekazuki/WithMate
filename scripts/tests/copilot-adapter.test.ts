import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCopilotClientEnv, isRecoverableCopilotConnectionErrorMessage, shouldRetryCopilotTurn } from "../../src-electron/copilot-adapter.js";
import { ProviderTurnError, type RunSessionTurnResult } from "../../src-electron/provider-runtime.js";

function createPartialResult(overrides?: Partial<RunSessionTurnResult>): RunSessionTurnResult {
  return {
    threadId: "",
    assistantText: "",
    systemPromptText: "",
    inputPromptText: "",
    composedPromptText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    ...overrides,
  };
}

describe("CopilotAdapter env", () => {
  it("Copilot child CLI では process warning を抑止する", () => {
    const env = buildCopilotClientEnv({
      PATH: "test-path",
      ELECTRON_RUN_AS_NODE: "1",
    });

    assert.equal(env.NODE_NO_WARNINGS, "1");
    assert.equal(env.PATH, "test-path");
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  });

  it("stale connection 系の message だけ recovery 対象にする", () => {
    assert.equal(isRecoverableCopilotConnectionErrorMessage("Connection is closed."), true);
    assert.equal(isRecoverableCopilotConnectionErrorMessage("CLI server exited unexpectedly with code 0"), true);
    assert.equal(isRecoverableCopilotConnectionErrorMessage("selected model が model catalog に存在しないよ。"), false);
  });

  it("進行途中の partial result が無い stale connection だけ retry する", () => {
    const emptyPartial = new ProviderTurnError("Connection is closed.", createPartialResult(), false);
    const withAssistantText = new ProviderTurnError("Connection is closed.", createPartialResult({ assistantText: "4" }), false);

    assert.equal(shouldRetryCopilotTurn(emptyPartial), true);
    assert.equal(shouldRetryCopilotTurn(withAssistantText), false);
  });
});
