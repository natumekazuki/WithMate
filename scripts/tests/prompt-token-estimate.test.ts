import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { estimateLogicalPromptTokens } from "../../src-electron/prompt-token-estimate.js";

describe("prompt-token-estimate", () => {
  it("0文字のときは 0 / 0 になる", () => {
    const estimate = estimateLogicalPromptTokens({
      systemText: "",
      inputText: "",
      composedText: "",
    });

    assert.equal(estimate.system.charCount, 0);
    assert.equal(estimate.system.estimatedTokens, 0);
    assert.equal(estimate.input.charCount, 0);
    assert.equal(estimate.input.estimatedTokens, 0);
    assert.equal(estimate.composed.charCount, 0);
    assert.equal(estimate.composed.estimatedTokens, 0);
  });

  it("文字列長からざっくり tokens を推定する", () => {
    const estimate = estimateLogicalPromptTokens({
      systemText: "system",
      inputText: "input",
      composedText: "system\ninput",
    });

    assert.deepEqual(estimate.system, { charCount: 6, estimatedTokens: 2 });
    assert.deepEqual(estimate.input, { charCount: 5, estimatedTokens: 2 });
    assert.deepEqual(estimate.composed, { charCount: 12, estimatedTokens: 3 });
  });
});
