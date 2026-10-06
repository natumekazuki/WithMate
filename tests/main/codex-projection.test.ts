import assert from "node:assert/strict";
import test from "node:test";
import { CodexProjectionClient } from "../../src-electron/providers/codex/codex-projection-client.js";
import { CODEX_PROJECTION_MAX_PENDING, CODEX_PROJECTION_MAX_PENDING_BYTES, type CodexProjectionFinal, type CodexProjectionProgress, type CodexProjectionStart, type CodexProjectionEvent } from "../../src-electron/providers/codex/codex-projection-protocol.js";
import { AUDIT_RAW_ITEMS_JSON_LIMIT, AUDIT_TEXT_PREVIEW_LIMIT } from "../../src-electron/session/audit-payload-limits.js";

function input(name: string): CodexProjectionStart {
  return {
    sessionId: name, threadId: "thread", turnId: "turn", apiKey: `api-${name}`, progress: true,
    binding: { bindingId: name, bindingReference: `binding-${name}`, turnCapability: `cap-${name}`, providerId: "codex", executionGeneration: name, transport: "env", expiresAt: null },
  };
}

// @test-value v2
// kind = "security"
// claim = "共有projection Workerの同じitem IDを持つ同時turnと次turnは原文・secret cacheを混ぜず全出力を秘匿化しfinal本文をpreviewで切らない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Streaming Policy / Codex projection owner" }
// fault = "runまたはsecret集合の境界を越えてcacheを再利用する、final本文をlive長で切る、rawとdiagnosticのsecretを残す"
// observable = "実Workerから受け取るAudit変更、live snapshot、final本文、operations、metadataとbounded raw JSON"
// observation_boundary = "public-boundary"
// scope = "CodexProjectionClient concurrent and sequential turn isolation"
// lifecycle = "permanent"
// risk_tags = ["privacy", "authentication"]
// impact = "binding capabilityやAPI keyの漏洩と別会話への本文混入を防ぐ"
// distinction = "redactor単体とadapter fake transportだけではWorker間のcloneとrun状態分離・次turnの再初期化を確認できない"
// @end-test-value
test("shared Worker isolates turns and sanitizes complete final output", async () => {
  const client = new CodexProjectionClient();
  const first = await client.begin(input("first"));
  const second = await client.begin(input("second"));
  const runs = [first, second];
  try {
    for (const [index, runId] of runs.entries()) {
      const name = index ? "second" : "first";
      const body = `${name} binding-${name} cap-${name} api-${name} ${"文".repeat(AUDIT_TEXT_PREVIEW_LIMIT + 10)}`;
      const audit = (await client.call<CodexProjectionEvent>(runId, { type: "event", event: { method: "item/completed", params: { item: { id: "same", type: "agentMessage", text: body } } } })).audit!;
      assert.equal(audit.changes.delivery, "audit");
      assert.ok(audit.state.assistantText.endsWith(`originalLength=${body.length}]`));
      await client.call(runId, { type: "event", event: { method: "item/completed", params: { item: { id: "unsupported", type: "futureItem", payload: `cap-${name}` } } } });
      const live = await client.call<CodexProjectionProgress>(runId, { type: "live", inputAvailable: true });
      assert.equal(live.changes.delivery, "live");
      assert.equal(await client.call(runId, { type: "live", inputAvailable: true }), null);
      const final = await client.call<CodexProjectionFinal>(runId, { type: "finish", diagnostics: [{ type: "diagnostic", data: { value: `binding-${name}` } }] });
      const combined = JSON.stringify({ audit, live, final });
      for (const secret of [`binding-${name}`, `cap-${name}`, `api-${name}`]) assert.ok(!combined.includes(secret));
      assert.ok(final.assistantText.startsWith(`${name} `));
      assert.ok(!final.assistantText.includes(index ? "first" : "second"));
      assert.ok(final.assistantText.endsWith("文".repeat(AUDIT_TEXT_PREVIEW_LIMIT + 10)));
      assert.ok(final.rawItemsJson.length <= AUDIT_RAW_ITEMS_JSON_LIMIT);
      assert.equal(final.providerMetadata.length, 1);
      assert.equal(final.operations.length, 2);
    }
  } finally { await Promise.all(runs.map(runId => client.release(runId))); }
  const next = await client.begin(input("next"));
  try {
    const live = await client.call<CodexProjectionProgress>(next, { type: "live", inputAvailable: true });
    assert.equal(live.state.assistantText, "");
    assert.deepEqual(live.state.steps, []);
    await assert.rejects(client.call(first, { type: "live", inputAvailable: true }), /unavailable/);
  } finally { await client.release(next); }
});

// @test-value v2
// kind = "invariant"
// claim = "reasoning変更はliveで返しcommand変更のAuditは変更stepだけで未変更本文・reasoningを再転送しない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "reasoningをAuditへ配送するかcommand deltaに未変更長文snapshotを毎回同梱する"
// observable = "実Workerのevent Audit fieldsとupsert、無通信後のlive snapshot、完全なfinal本文"
// observation_boundary = "public-boundary"
// scope = "CodexProjectionClient sparse Audit and lazy live text"
// lifecycle = "permanent"
// impact = "長文と多数commandを持つturnのMain転送・保持量の増幅を防ぎ最終本文を維持する"
// distinction = "item cacheの単体testではWorker返送boundaryに未変更全文が同梱される欠陥を検出できない"
// @end-test-value
test("Audit transports changed scalars and steps without unchanged long text", async () => {
  const client = new CodexProjectionClient();
  const run = await client.begin(input("sparse"));
  const text = "文".repeat(AUDIT_TEXT_PREVIEW_LIMIT + 1);
  try {
    const assistant = await client.call<CodexProjectionEvent>(run, { type: "event", event: { method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text } } } });
    assert.ok(assistant.audit?.state.assistantText);
    const reasoning = await client.call<CodexProjectionEvent>(run, { type: "event", event: { method: "item/completed", params: { item: { id: "thinking", type: "reasoning", summary: [text], content: [] } } } });
    assert.equal(reasoning.audit, null);
    const command = await client.call<CodexProjectionEvent>(run, { type: "event", event: { method: "item/completed", params: { item: { id: "command", type: "commandExecution", command: "pwd", aggregatedOutput: "directory", exitCode: 0, status: "completed" } } } });
    assert.equal(command.audit?.state.assistantText, "");
    assert.equal(command.audit?.state.reasoningText, "");
    assert.equal(command.audit?.state.usage, null);
    assert.deepEqual(command.audit?.changes.steps.upserts.map(step => step.id), ["command"]);
    const live = await client.call<CodexProjectionProgress>(run, { type: "live", inputAvailable: true });
    assert.equal(live.state.assistantText, assistant.audit!.state.assistantText);
    assert.ok(live.state.reasoningText?.startsWith("文".repeat(AUDIT_TEXT_PREVIEW_LIMIT)));
    const final = await client.call<CodexProjectionFinal>(run, { type: "finish", diagnostics: [] });
    assert.equal(final.assistantText, text);
  } finally { await client.release(run); }
});

// @test-value v2
// kind = "contract"
// claim = "projection受付は64未応答commandと32 MiB入力までを有限にし超過を明示拒否した後も受付済みcommandを完了・解放する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "受付境界を越えてWorker入力を保持するか拒否後に正常な受付まで失敗させる"
// observable = "過負荷callのreject、受付済みcallの完了とその後のlive応答"
// observation_boundary = "public-boundary"
// scope = "CodexProjectionClient bounded admission"
// lifecycle = "permanent"
// impact = "高速event列や巨大frameによる無制限のMain／Worker間保持を防ぐ"
// distinction = "transport queue境界はprojectionへdispatch済みの要求を計上しないため実Worker client受付のcheckが必要"
// @end-test-value
test("projection admission rejects overload and returns capacity", async () => {
  const client = new CodexProjectionClient();
  const run = await client.begin(input("capacity"));
  try {
    const pending = Array.from({ length: CODEX_PROJECTION_MAX_PENDING }, () => client.call(run, { type: "event", event: { method: "unknown" } }, 1));
    await assert.rejects(client.call(run, { type: "live", inputAvailable: true }), /capacity exceeded/);
    await Promise.all(pending);
    await assert.rejects(client.call(run, { type: "event", event: { method: "unknown" } }, CODEX_PROJECTION_MAX_PENDING_BYTES + 1), /capacity exceeded/);
    const live = await client.call<CodexProjectionProgress>(run, { type: "live", inputAvailable: true });
    assert.equal(live.state.sessionId, "capacity");
  } finally { await client.release(run); }
});
