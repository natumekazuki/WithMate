import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA } from "../../src-electron/character/character-affect-turn-evaluator.js";
import { OpenCodeBackgroundAdapter } from "../../src-electron/providers/opencode/opencode-background.js";
import type { OpenCodeTransportOptions } from "../../src-electron/providers/opencode/opencode-transport.js";
import type { RunBackgroundStructuredPromptInput } from "../../src-electron/providers/provider-runtime.js";
import { validateStructuredPromptSchemaValue } from "../../src-electron/providers/structured-prompt-validation.js";

function input(): RunBackgroundStructuredPromptInput {
  return { providerId: "opencode", workspacePath: process.cwd(), appSettings: normalizeAppSettings({ codingProviderSettings: { opencode: { apiKey: "test-go-key" } } }),
    model: "opencode-go/glm-5.3", reasoningEffort: "high", timeoutMs: 5000,
    prompt: { systemText: "Evaluate the turn", userText: "turn", outputSchema: CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA } };
}

function harness(generate: (request: { prompt: string; model?: unknown }, signal?: AbortSignal) => Promise<{ text: string }>) {
  let options: OpenCodeTransportOptions | undefined;
  let closed = 0;
  let resolveClosed!: () => void;
  const whenClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const client = {
    model: { list: async () => ({ data: [{ providerID: "opencode-go", id: "glm-5.3", enabled: true, variants: [{ id: "high" }], capabilities: { input: ["text"] } }] }) },
    generate: { text: (request: { prompt: string; model?: unknown }, requestOptions?: { signal?: AbortSignal }) => generate(request, requestOptions?.signal) },
  } as unknown as OpenCodeClient;
  const adapter = new OpenCodeBackgroundAdapter({ databasePath: path.join(process.cwd(), "test-opencode.db"), executable: path.join(process.cwd(), "fake-opencode"),
    createTransport: (value) => { options = value; return { start: async () => client, close: async () => { closed++; resolveClosed(); }, whenClosed: () => whenClosed }; } });
  return { adapter, options: () => options, closed: () => closed };
}

// @test-value v2
// kind = "invariant"
// claim = "OpenCodeのAffect生成は同じmodel/Depthをstateless経路へ渡し、schema適合JSONのみを履歴や推測usageなしで返す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "Session生成経路を使う、Depthを落とす、または背景processにturn tokenを投影する"
// observable = "generate入力、transport設定、結果のthread/usage/output、close回数"
// observation_boundary = "public-boundary"
// scope = "OpenCodeBackgroundAdapter"
// lifecycle = "permanent"
// @end-test-value
test("OpenCode background uses stateless model and validated Affect JSON", async () => {
  const run = harness(async (request) => {
    assert.deepEqual(request.model, { providerID: "opencode-go", id: "glm-5.3", variant: "high" });
    assert.ok(request.prompt.includes(JSON.stringify(CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA)));
    return { text: '{"candidates":[]}' };
  });
  const previousTurnCapability = process.env.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY;
  process.env.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY = "parent-turn-capability";
  let result;
  try { result = await run.adapter.runBackgroundStructuredPrompt(input()); }
  finally {
    if (previousTurnCapability === undefined) delete process.env.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY;
    else process.env.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY = previousTurnCapability;
  }
  assert.deepEqual(result.output, { candidates: [] });
  assert.equal(result.threadId, null);
  assert.equal(result.usage, null);
  assert.equal(run.options()?.background, true);
  assert.equal(run.options()?.env?.OPENCODE_API_KEY, "test-go-key");
  assert.equal(run.options()?.env?.WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY, undefined);
  assert.equal(run.adapter.getBackgroundStructuredPromptPolicy().structuredOutputMode, "validated_json");
  assert.equal(run.closed(), 1);
});

// @test-value v2
// kind = "invariant"
// claim = "背景生成の説明文・コードフェンス・不正JSON・Affect schema違反を成功にしない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "JSON断片を抽出するかschema検証を省略して無効出力を評価結果として返す"
// observable = "runBackgroundStructuredPromptのrejectとclose回数"
// observation_boundary = "public-boundary"
// scope = "OpenCodeBackgroundAdapter"
// lifecycle = "permanent"
// @end-test-value
test("OpenCode background rejects non-JSON and schema violations and closes", async () => {
  for (const text of ['Explanation {"candidates":[]}', '```json\n{"candidates":[]}\n```', '{', '{"candidates":[],"extra":true}', '{"candidates":[{}]}']) {
    const run = harness(async () => ({ text }));
    await assert.rejects(run.adapter.runBackgroundStructuredPrompt(input()), /JSON|schema/);
    assert.equal(run.closed(), 1);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Affect出力のnullable値・数値境界・候補上限を検証し未知schema制約を成功扱いしない"
// oracle = { type = "contract", ref = "src-electron/character/character-affect-turn-evaluator.ts#CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA" }
// fault = "anyOfのnullや数値範囲・maxItemsを無視する、未評価branchの未知keywordを黙認する"
// observable = "共通validatorのerror配列"
// observation_boundary = "public-boundary"
// scope = "structured-prompt-validation"
// lifecycle = "permanent"
// @end-test-value
test("shared validation enforces the current Affect schema and rejects unknown constraints", () => {
  const candidate = { layer: "session", targetType: "task", targetId: "task", family: "interest", label: "interest", valence: 1, arousal: null, intensity: 0.5, reason: "reason", evidence: "evidence" };
  assert.deepEqual(validateStructuredPromptSchemaValue(CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA, { candidates: [candidate] }), []);
  for (const candidates of [[{ ...candidate, intensity: 2 }], [{ ...candidate, arousal: "high" }], [{ ...candidate, family: "invalid" }], Array.from({ length: 5 }, () => candidate)]) {
    assert.notEqual(validateStructuredPromptSchemaValue(CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA, { candidates }).length, 0);
  }
  assert.match(validateStructuredPromptSchemaValue({ anyOf: [{ type: "null" }, { type: "string", pattern: "^a" }] }, null).join(), /unsupported schema keyword pattern/);
});

// @test-value v2
// kind = "invariant"
// claim = "背景生成のtimeoutとdisposeは上流のtransport error包装に関係なくAbortErrorへ正規化しprocessを閉じる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "signalを無視してtimeoutを通常失敗と診断する、またはdisposeで生成processを残す"
// observable = "adapter rejectのname、生成signalのabort、transport.close回数"
// observation_boundary = "public-boundary"
// scope = "OpenCodeBackgroundAdapter"
// lifecycle = "permanent"
// @end-test-value
test("OpenCode background normalizes timeout and disposal after wrapped transport abort", async () => {
  for (const dispose of [false, true]) {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const run = harness(async (_request, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("Transport error")), { once: true });
      started();
    }));
    const pending = run.adapter.runBackgroundStructuredPrompt({ ...input(), timeoutMs: dispose ? 5000 : 20 });
    const rejection = assert.rejects(pending, { name: "AbortError" });
    await ready;
    // Keep the fake transport alive while the production AbortSignal timeout is unref'ed.
    const keepAlive = setTimeout(() => {}, 1000);
    try { if (dispose) await run.adapter.dispose(); await rejection; }
    finally { clearTimeout(keepAlive); }
    assert.ok(run.closed() >= 1);
  }
});
