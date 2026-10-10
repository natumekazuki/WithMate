import assert from "node:assert/strict";
import { it } from "node:test";
import type { ProviderAgentRuntimeBindingProjection } from "../../src-electron/providers/agent-runtime-binding.js";
import { buildProviderAgentRuntimeBindingEnv, createProviderAgentRuntimeBindingRedactor, mergeDefinedProviderEnv } from "../../src-electron/providers/provider-agent-runtime-binding.js";

// @test-value v2
// kind = "invariant"
// claim = "HTTP MCP credentialはCodexの当turnだけに環境注入され、背景envへ継承されず、provider投影の文字列とobject keyから除去される"
// oracle = { type = "contract", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "親envのtokenを再利用する、別providerへ追加envを注入する、またはtokenを投影本文とobject keyに残す"
// observable = "生成されたforegroundとbackgroundのenv、およびredactorの文字列とobject出力"
// observation_boundary = "component-behavior"
// scope = "managed HTTP MCP credential process env and output projection"
// lifecycle = "permanent"
// impact = "別actorのcredentialが背景実行へ流用されるか、短命credentialが監査と利用者表示へ漏れる"
// distinction = "型検査と既存binding testはHTTP tokenの独立したenv名や秘匿化を検証しない。通信なしの小さな固定入力で境界を継続確認する"
// risk_tags = ["privacy", "authentication"]
// @end-test-value
it("HTTP MCP tokenのenv ownershipと投影秘匿化を保つ", () => {
  const binding: ProviderAgentRuntimeBindingProjection = {
    bindingId: "binding", bindingReference: "reference", providerId: "codex",
    executionGeneration: "generation", transport: "env", expiresAt: null,
    managedMcp: { memoryUrl: "http://127.0.0.1:47891/memory", glossaryUrl: "http://127.0.0.1:47891/glossary", token: "opaque-http-token" },
  };
  const inherited = { withmate_managed_mcp_token: "previous-turn", THIRD_PARTY_VALUE: "preserved" };
  const foreground = mergeDefinedProviderEnv(inherited, buildProviderAgentRuntimeBindingEnv(binding));
  assert.equal(foreground.WITHMATE_MANAGED_MCP_TOKEN, "opaque-http-token");
  assert.equal(foreground.withmate_managed_mcp_token, undefined);
  assert.deepEqual(mergeDefinedProviderEnv(inherited, buildProviderAgentRuntimeBindingEnv(undefined)), { THIRD_PARTY_VALUE: "preserved" });
  assert.equal(buildProviderAgentRuntimeBindingEnv({ ...binding, providerId: "claude" }).WITHMATE_MANAGED_MCP_TOKEN, undefined);
  const redactor = createProviderAgentRuntimeBindingRedactor(binding);
  assert.equal(redactor.sanitizeText("credential=opaque-http-token"), "credential=[WITHMATE_BINDING_REFERENCE_REDACTED]");
  assert.deepEqual(redactor.sanitize({ "opaque-http-token": ["opaque-http-token"] }), {
    "[WITHMATE_BINDING_REFERENCE_REDACTED]": ["[WITHMATE_BINDING_REFERENCE_REDACTED]"],
  });
});
