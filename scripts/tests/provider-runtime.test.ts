import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderBackgroundAdapter } from "../../src-electron/provider-runtime.js";
import {
  canUseProviderForMateTalkBackgroundPrompt,
  isMateTalkBackgroundStructuredPromptPolicyCompatible,
  type ProviderBackgroundStructuredPromptPolicy,
} from "../../src-electron/provider-runtime.js";

const MATE_TALK_SUPPORTED_POLICY: ProviderBackgroundStructuredPromptPolicy = {
  allowsFileWrite: false,
  allowsToolPermissionRequests: false,
  structuredOutputOnly: true,
};

function createAdapter(policy: ProviderBackgroundStructuredPromptPolicy): ProviderBackgroundAdapter {
  return {
    getBackgroundStructuredPromptPolicy() {
      return policy;
    },
    async extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    async runCharacterReflection() {
      throw new Error("not used");
    },
    async runBackgroundStructuredPrompt() {
      throw new Error("not used");
    },
  };
}

describe("provider-runtime background structured prompt policy", () => {
  it("有効な policy は MateTalk 対応として扱う", () => {
    assert.equal(isMateTalkBackgroundStructuredPromptPolicyCompatible(MATE_TALK_SUPPORTED_POLICY), true);
  });

  it("file write を許可する policy は MateTalk 対応外とする", () => {
    assert.equal(
      isMateTalkBackgroundStructuredPromptPolicyCompatible({
        ...MATE_TALK_SUPPORTED_POLICY,
        allowsFileWrite: true,
      }),
      false,
    );
  });

  it("ファイル外 tool permission を許可する policy は MateTalk 対応外とする", () => {
    assert.equal(
      isMateTalkBackgroundStructuredPromptPolicyCompatible({
        ...MATE_TALK_SUPPORTED_POLICY,
        allowsToolPermissionRequests: true,
      }),
      false,
    );
  });

  it("MateTalk 用 structured output のみの要件を満たさない policy は対象外とする", () => {
    assert.equal(
      isMateTalkBackgroundStructuredPromptPolicyCompatible({
        ...MATE_TALK_SUPPORTED_POLICY,
        structuredOutputOnly: false,
      }),
      false,
    );
  });

  it("能力不足の adapter は MateTalk 候補から除外される", () => {
    const adapter = createAdapter({
      ...MATE_TALK_SUPPORTED_POLICY,
      allowsToolPermissionRequests: true,
    });

    assert.equal(canUseProviderForMateTalkBackgroundPrompt(adapter), false);
  });

  it("既存 provider の既定能力は MateTalk で許可される", () => {
    const adapter = createAdapter(MATE_TALK_SUPPORTED_POLICY);

    assert.equal(canUseProviderForMateTalkBackgroundPrompt(adapter), true);
  });
});
