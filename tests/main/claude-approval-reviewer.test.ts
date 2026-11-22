import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeApprovalReviewer } from "../../src-electron/providers/claude/claude-approval-reviewer.js";

function initMessage(tools: string[]): SDKSystemMessage {
  return { type: "system", subtype: "init", tools, permissionMode: "dontAsk",
    mcp_servers: [{ name: "withmate_history", status: "connected" }],
    agents: ["Explore"], plugins: [{ name: "cc-plugin-privacy", path: "builtin" }],
    apiKeySource: "none", claude_code_version: "test", cwd: "workspace", model: "chosen-model",
    slash_commands: [], output_style: "default", skills: [], uuid: "00000000-0000-4000-8000-000000000001", session_id: "review" };
}

function input() {
  return { selection: { providerId: "claude", model: "chosen-model", reasoningEffort: "high" } as const,
    history: { source: { kind: "main", sessionId: "source", incarnationId: "generation" } as const, url: "http://127.0.0.1/review",
      token: "scoped-secret", close() {}, isCurrent: () => true, readCount: () => 0 } };
}

// @test-value v2
// kind = "contract"
// claim = "Claude審査は共通設定のModel・Depthでツールを履歴読取だけに制限し、対応する入力の構造化値だけを取り出す"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#審査会話と履歴の境界" }
// fault = "通常ツールや永続化を有効にするか、自然文または異なる入力の結果を判定にする"
// observable = "SDKの起動設定、同じSDK会話の入力、構造化結果・自然文・異なる入力への返値"
// observation_boundary = "public-boundary"
// scope = "Claude reviewer adapterとSDK transportの境界"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "共通審査testのadapter stubはProviderへの隔離設定と終端イベントの照合を通らない"
// @end-test-value
test("Claude review uses its isolated structured channel and correlates each input", async () => {
  const decisions = [{ decision: "allow_once", reason: "Authorized." }, undefined, { decision: "deny", reason: "Not this request." }];
  let opened = 0;
  let closed = 0;
  let reviewed = 0;
  const open = createClaudeApprovalReviewer({
    resolveSettings: async () => ({ sources: [] }), resolveBinary: () => "unused-native-binary",
    query: ({ prompt, options }) => {
      opened++;
      assert.equal(options.model, "chosen-model");
      assert.equal(options.effort, "high");
      assert.deepEqual(options.tools, []);
      assert.deepEqual(options.settingSources, []);
      assert.equal(options.permissionMode, "dontAsk");
      assert.equal(options.persistSession, false);
      assert.equal(options.strictMcpConfig, true);
      assert.ok(Object.hasOwn(options.extraArgs ?? {}, "disable-slash-commands"));
      assert.equal(options.mcpServersDelivery, "initialize");
      assert.deepEqual(options.mcpServers, { withmate_history: { type: "http", url: "http://127.0.0.1/review", headers: { "x-withmate-mcp-token": "scoped-secret" } } });
      assert.doesNotMatch(String(options.systemPrompt), /scoped-secret/);
      assert.equal(options.outputFormat?.type, "json_schema");
      assert.equal(options.outputFormat.schema.$schema, "http://json-schema.org/draft-07/schema#");
      const inputs = prompt[Symbol.asyncIterator]();
      let sentInit = false;
      return {
        async supportedModels() { return [{ value: "chosen-model", displayName: "Chosen", description: "", supportsEffort: true, supportedEffortLevels: ["high"] }]; },
        close() { closed++; },
        async next(): Promise<IteratorResult<SDKMessage, void>> {
          if (!sentInit) {
            sentInit = true;
            return { done: false, value: initMessage(["mcp__withmate_history__get_message"]) };
          }
          const { value } = await inputs.next();
          const index = reviewed++;
          assert.equal(value.message.content, `operation ${index}`);
          return { done: false, value: { type: "result", subtype: "success", is_error: false,
            user_message_uuid: index === 2 ? "unrelated" : value.uuid, result: "allow_once", structured_output: decisions[index] } as SDKMessage };
        },
      };
    },
  });
  const signal = new AbortController();
  const conversation = await open({ ...input(), signal: signal.signal });
  assert.deepEqual(await conversation.review("operation 0"), decisions[0]);
  assert.equal(await conversation.review("operation 1"), undefined);
  await assert.rejects(conversation.review("operation 2"), /for this request/);
  signal.abort();
  assert.equal(opened, 1);
  assert.equal(closed, 1);
});

// @test-value v2
// kind = "security"
// claim = "管理設定があり隔離を保証できない場合、非対応Depthの場合、または履歴以外のtoolが可能と報告された場合は審査結果を出さない"
// oracle = { type = "contract", ref = "docs/design/withmate-auto-review.md#審査会話と履歴の境界" }
// fault = "隔離不明のSDKを起動するか、非対応Depthへの置換や想定外toolがあるSDKの出力を許可する"
// observable = "起動回数、SDKへ渡す入力の消費有無、open/reviewの失敗とcleanup"
// observation_boundary = "public-boundary"
// scope = "Claude reviewer adapterの不成立時の境界"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// distinction = "正常SDKの設定検査だけでは、SDK側に競合設定や想定外toolがある場合の拒否条件を観測しない"
// @end-test-value
test("Claude review rejects an unavailable depth or an unverified tool boundary", async () => {
  for (const scenario of ["managed", "unknown-policy", "depth", "extra-tool"] as const) {
    let opened = 0;
    let closed = 0;
    const open = createClaudeApprovalReviewer({
      resolveSettings: async () => ({ sources: scenario === "managed" ? [{ source: "managed", settings: {} }] : [],
        machinePolicy: { didNotLoad: scenario === "unknown-policy" ? ["registry"] : false } }),
      resolveBinary: () => "unused-native-binary",
      query: ({ prompt }) => {
        opened++;
        const inputs = prompt[Symbol.asyncIterator]();
        let requestId: string | null = null;
        return {
          async supportedModels() { return [{ value: "chosen-model", displayName: "Chosen", description: "", supportsEffort: true,
            supportedEffortLevels: [scenario === "depth" ? "low" : "high"] }]; },
          close() { closed++; },
          async next() {
            assert.equal(scenario, "extra-tool", "no prompt may be requested before validating the selection");
            if (requestId === null) {
              const { value } = await inputs.next();
              assert.ok(value.uuid);
              requestId = value.uuid;
              return { done: false, value: initMessage(["Bash"]) };
            }
            return { done: false, value: { type: "result", subtype: "success", is_error: false, user_message_uuid: requestId,
              structured_output: { decision: "allow_once", reason: "A result from an unsafe session." } } as SDKMessage };
          },
        };
      },
    });
    const signal = new AbortController();
    if (scenario === "extra-tool") {
      const conversation = await open({ ...input(), signal: signal.signal });
      await assert.rejects(conversation.review("operation"), /isolation/);
      conversation.close();
    } else {
      await assert.rejects(open({ ...input(), signal: signal.signal }), scenario === "depth" ? /depth is unavailable/ : /Managed settings/);
    }
    assert.deepEqual([opened, closed], scenario === "depth" || scenario === "extra-tool" ? [1, 1] : [0, 0]);
  }
});
