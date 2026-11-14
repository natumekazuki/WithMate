import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  createProviderAgentRuntimeBindingRedactor,
  PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER,
} from "../../src-electron/providers/provider-agent-runtime-binding.js";
import { PROVIDER_TEXT_PREVIEW_LIMIT, boundProviderRawItem } from "../../src-electron/session/provider-payload-limits.js";


// @test-value v2
// kind = "security"
// claim = "budget内raw projectionはkeyと本文のsecretを秘匿化し、preview境界をまたぐsecretの断片も残さない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#streaming-policy" }
// fault = "rawを先に切ってからsecret置換するため切断されたbinding prefixを診断traceに残す、またはkeyの秘匿化を落とす"
// observable = "boundProviderRawItemのJSON、truncation元長、秘匿化されたkeyと入力原文"
// observation_boundary = "component-behavior"
// scope = "bounded raw secret projection"
// lifecycle = "permanent"
// impact = "runtime capabilityの一部やsecret-bearing keyが診断traceへ漏れる"
// distinction = "既存redaction testはcomplete secretだけ、budget testはsecretなしであり境界横断を検出しない。固定prefixでSDK通信や時刻測定は不要"
// risk_tags = ["privacy"]
// @end-test-value
it("raw preview境界のsecretを断片なしで秘匿化し入力を変更しない", () => {
  const secret = "Z9sensitive[+].secret";
  const shorterSecret = "tiny[+]";
  const redactor = createProviderAgentRuntimeBindingRedactor(null, [secret, shorterSecret]);
  for (let overlap = 1; overlap < secret.length; overlap += 1) {
    const content = shorterSecret + "x".repeat(PROVIDER_TEXT_PREVIEW_LIMIT - overlap - shorterSecret.length)
      + secret + "y".repeat(PROVIDER_TEXT_PREVIEW_LIMIT * 4);
    const source = { type: "tool.execution_complete", data: { content, [secret]: shorterSecret } };
    const item = boundProviderRawItem(source, undefined, redactor.sanitizeText);
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
