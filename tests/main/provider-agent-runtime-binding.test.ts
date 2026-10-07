import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildProviderAgentRuntimeAuthoritySnapshot,
  createProviderAgentRuntimeBindingRedactor,
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
} from "../../src-electron/providers/provider-agent-runtime-binding.js";
import { AUDIT_TEXT_PREVIEW_LIMIT, boundAuditRawItem } from "../../src-electron/session/audit-payload-limits.js";

describe("buildProviderAgentRuntimeAuthoritySnapshot", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "actor Sessionのcharacterとknown workspace projectだけがcanonical authorityへ投影される"
  // oracle = { type = "adr", ref = "ADR-024" }
  // failure_mode = "binding authorityがcaller入力や未canonicalなworkspace値を許可集合へ投影する"
  // scope = "provider-agent-runtime-authority-snapshot"
  // lifecycle = "permanent"
  // @end-test-value
  it("workspace projectをknown resolverのIDへcanonicalizeする", () => {
    const snapshot = buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: " character-a ",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: (workspacePath) => {
        assert.equal(workspacePath, "C:/workspace");
        return " project-z ";
      },
    });

    assert.deepEqual(snapshot, {
      userId: "local-user",
      characterId: "character-a",
      allowedProjectIds: ["project-z"],
    });
  });

  // @test-value v1
  // kind = "security"
  // claim = "unresolved workspaceはProject authorityを持たず、空characterはsnapshotを生成しない"
  // oracle = { type = "adr", ref = "ADR-024" }
  // failure_mode = "解決不能なworkspaceまたは空のCharacter identityへauthorityを付与してMemory targetを越権する"
  // scope = "provider-agent-runtime-authority-snapshot"
  // lifecycle = "permanent"
  // distinction = "既知workspaceのcanonical化とは異なり、fail-closedの境界を検証する"
  // @end-test-value
  it("unresolved workspaceは空、空characterはnullにする", () => {
    assert.deepEqual(buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: "character-a",
      workspacePath: "C:/missing",
      resolveCanonicalProjectId: () => null,
    }), {
      userId: "local-user",
      characterId: "character-a",
      allowedProjectIds: [],
    });
    assert.equal(buildProviderAgentRuntimeAuthoritySnapshot({
      characterId: "   ",
      workspacePath: "C:/workspace",
      resolveCanonicalProjectId: () => "project-a",
    }), null);
  });

});

// @test-value v2
// kind = "security"
// claim = "budget内raw projectionはkeyと本文のsecretを秘匿化し、preview境界をまたぐsecretの断片も残さない"
// oracle = { type = "contract", ref = "docs/design/audit-log.md#表示とデータ保護" }
// fault = "rawを先に切ってからsecret置換するため切断されたbinding prefixを監査に残す、またはkeyの秘匿化を落とす"
// observable = "boundAuditRawItemのJSON、truncation元長、秘匿化されたkeyと入力原文"
// observation_boundary = "component-behavior"
// scope = "bounded raw secret projection"
// lifecycle = "permanent"
// impact = "runtime capabilityの一部やsecret-bearing keyが監査へ漏れる"
// distinction = "既存redaction testはcomplete secretだけ、budget testはsecretなしであり境界横断を検出しない。固定prefixでSDK通信や時刻測定は不要"
// risk_tags = ["privacy"]
// @end-test-value
it("raw preview境界のsecretを断片なしで秘匿化し入力を変更しない", () => {
  const secret = "Z9sensitive[+].secret";
  const shorterSecret = "tiny[+]";
  const redactor = createProviderAgentRuntimeBindingRedactor(null, [secret, shorterSecret]);
  for (let overlap = 1; overlap < secret.length; overlap += 1) {
    const content = shorterSecret + "x".repeat(AUDIT_TEXT_PREVIEW_LIMIT - overlap - shorterSecret.length)
      + secret + "y".repeat(AUDIT_TEXT_PREVIEW_LIMIT * 4);
    const source = { type: "tool.execution_complete", data: { content, [secret]: shorterSecret } };
    const item = boundAuditRawItem(source, undefined, redactor.sanitizeText);
    const json = JSON.stringify(item);
    assert.ok(!json.includes("Z9sensitive") && !json.includes(secret) && !json.includes(shorterSecret));
    assert.ok(!json.includes(`x${secret.slice(0, overlap)}`), `secret prefix at overlap ${overlap}`);
    assert.ok(json.includes(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER));
    assert.deepEqual(item.data?.[PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER], PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER);
    const preview = item.data?.content as { truncated: boolean; originalLength: number };
    assert.equal(preview.truncated, true);
    assert.equal(preview.originalLength, content.length);
    assert.equal(source.data.content, content);
    assert.equal(source.data[secret], shorterSecret);
  }
});
