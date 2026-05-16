import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderBackgroundAdapter } from "../../src-electron/provider-runtime.js";
import {
  evaluateMateTalkBackgroundStructuredPromptPolicy,
  canUseProviderForMateTalkBackgroundPrompt,
  isMateTalkBackgroundStructuredPromptPolicyCompatible,
  getMateTalkBackgroundStructuredPromptCapability,
  summarizeMateTalkBackgroundStructuredPromptCapability,
  resolveMateTalkBackgroundStructuredPromptPolicy,
  type ProviderBackgroundStructuredPromptPolicy,
} from "../../src-electron/provider-runtime.js";

const MATE_TALK_SUPPORTED_POLICY: ProviderBackgroundStructuredPromptPolicy = {
  allowsFileWrite: false,
  allowsShellWrite: false,
  allowsToolPermissionRequests: false,
  structuredOutputOnly: true,
  structuredOutputMode: "provider_schema",
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

  it("shell write を許可する policy は MateTalk 対応外とする", () => {
    assert.equal(
      isMateTalkBackgroundStructuredPromptPolicyCompatible({
        ...MATE_TALK_SUPPORTED_POLICY,
        allowsShellWrite: true,
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

  it("compatible policy は compatible=true, reasons=[] を返す", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy(MATE_TALK_SUPPORTED_POLICY);

    assert.equal(capability.compatible, true);
    assert.equal(capability.policy, MATE_TALK_SUPPORTED_POLICY);
    assert.deepEqual(capability.reasons, []);
  });

  it("MateTalk のユーザー選択権限では approval / sandbox の実効 policy を反映する", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy(MATE_TALK_SUPPORTED_POLICY, {
      operationPermissionMode: "user-selected",
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write",
    });

    assert.equal(capability.compatible, true);
    assert.deepEqual(capability.reasons, []);
    assert.deepEqual(capability.policy, {
      ...MATE_TALK_SUPPORTED_POLICY,
      allowsFileWrite: true,
      allowsShellWrite: true,
      allowsToolPermissionRequests: true,
    });
  });

  it("MateTalk のユーザー選択権限でも structured output が保証されない provider は対象外とする", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy(
      {
        ...MATE_TALK_SUPPORTED_POLICY,
        allowsFileWrite: true,
        allowsShellWrite: true,
        allowsToolPermissionRequests: true,
        structuredOutputOnly: false,
      },
      {
        operationPermissionMode: "user-selected",
        approvalMode: "on-request",
        codexSandboxMode: "danger-full-access",
      },
    );

    assert.equal(capability.compatible, false);
    assert.deepEqual(capability.reasons, ["structured_output_not_guaranteed"]);
  });

  it("実効 policy helper は read-only-required では provider policy をそのまま返す", () => {
    assert.equal(
      resolveMateTalkBackgroundStructuredPromptPolicy(MATE_TALK_SUPPORTED_POLICY),
      MATE_TALK_SUPPORTED_POLICY,
    );
  });

  it("file write 有効時の不適合理由を返す", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy({
      ...MATE_TALK_SUPPORTED_POLICY,
      allowsFileWrite: true,
    });

    assert.equal(capability.compatible, false);
    assert.deepEqual(capability.reasons, ["file_write_allowed"]);
  });

  it("shell write 有効時の不適合理由を返す", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy({
      ...MATE_TALK_SUPPORTED_POLICY,
      allowsShellWrite: true,
    });

    assert.equal(capability.compatible, false);
    assert.deepEqual(capability.reasons, ["shell_write_allowed"]);
  });

  it("tool permission requests 有効時の不適合理由を返す", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy({
      ...MATE_TALK_SUPPORTED_POLICY,
      allowsToolPermissionRequests: true,
    });

    assert.equal(capability.compatible, false);
    assert.deepEqual(capability.reasons, ["tool_permission_requests_allowed"]);
  });

  it("structured output not guaranteed 時の不適合理由を返す", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy({
      ...MATE_TALK_SUPPORTED_POLICY,
      structuredOutputOnly: false,
    });

    assert.equal(capability.compatible, false);
    assert.deepEqual(capability.reasons, ["structured_output_not_guaranteed"]);
  });

  it("複数不一致のときは理由の順序が安定している", () => {
    const capability = evaluateMateTalkBackgroundStructuredPromptPolicy({
      allowsFileWrite: true,
      allowsShellWrite: true,
      allowsToolPermissionRequests: true,
      structuredOutputOnly: false,
      structuredOutputMode: "provider_schema",
    });

    assert.equal(capability.compatible, false);
    assert.deepEqual(capability.reasons, [
      "file_write_allowed",
      "shell_write_allowed",
      "tool_permission_requests_allowed",
      "structured_output_not_guaranteed",
    ]);
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

  it("adapter 由来の policy を反映した capability を返す", () => {
    const policy: ProviderBackgroundStructuredPromptPolicy = {
      allowsFileWrite: true,
      allowsShellWrite: false,
      allowsToolPermissionRequests: false,
      structuredOutputOnly: false,
      structuredOutputMode: "provider_schema",
    };
    const adapter = createAdapter(policy);
    const capability = getMateTalkBackgroundStructuredPromptCapability(adapter);

    assert.equal(capability.policy, policy);
    assert.deepEqual(capability.reasons, [
      "file_write_allowed",
      "structured_output_not_guaranteed",
    ]);
  });

  it("runtime capability summary helper が provider schema の対応を一括で取得できる", () => {
    const summary = summarizeMateTalkBackgroundStructuredPromptCapability({
      allowsFileWrite: true,
      allowsShellWrite: true,
      allowsToolPermissionRequests: false,
      structuredOutputOnly: true,
      structuredOutputMode: "provider_schema",
    });

    assert.deepEqual(summary, {
      structuredOutputSupported: true,
      providerSchemaSupported: true,
      schemaSubmitToolSupported: false,
      fileWriteDisabled: false,
      shellWriteDisabled: false,
      toolPermissionRequestDisabled: true,
    });
  });

  it("runtime capability summary helper が schema submit tool の対応を一括で取得できる", () => {
    const summary = summarizeMateTalkBackgroundStructuredPromptCapability({
      allowsFileWrite: false,
      allowsShellWrite: false,
      allowsToolPermissionRequests: false,
      structuredOutputOnly: true,
      structuredOutputMode: "schema_submit_tool",
    });

    assert.deepEqual(summary, {
      structuredOutputSupported: true,
      providerSchemaSupported: false,
      schemaSubmitToolSupported: true,
      fileWriteDisabled: true,
      shellWriteDisabled: true,
      toolPermissionRequestDisabled: true,
    });
  });
});
