import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { CodexProjectionClient } from "../../src-electron/providers/codex/codex-projection-client.js";
import type { CodexProjectionFinal, CodexProjectionProgress, CodexProjectionStart, CodexProjectionEvent, CodexProjectionRequest, CodexProjectionResponse } from "../../src-electron/providers/codex/codex-projection-protocol.js";
import { AUDIT_RAW_ITEMS_JSON_LIMIT, AUDIT_TEXT_PREVIEW_LIMIT } from "../../src-electron/session/audit-payload-limits.js";

function input(name: string): CodexProjectionStart {
  return {
    sessionId: name, threadId: "thread", turnId: "turn", apiKey: `api-${name}`, progress: true,
    binding: { bindingId: name, bindingReference: `binding-${name}`, turnCapability: `cap-${name}`, providerId: "codex", executionGeneration: name, transport: "env", expiresAt: null },
  };
}

// @test-value v2
// kind = "contract"
// claim = "共有Workerがburst処理中でもreleaseはowner削除を確認し他runの状態を維持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "client登録だけ失いWorker ownerを保持するか別runを破壊する"
// observable = "実Workerのrelease完了と解放runへのprotocol照会拒否、存続runのlive本文"
// observation_boundary = "public-boundary"
// scope = "CodexProjectionClient shared Worker release"
// lifecycle = "permanent"
// impact = "終了turnの本文とsecretが存続Workerに不要に残り保持が累積することを防ぐ"
// distinction = "通常releaseはburst中の実Worker owner削除を観測しないため実protocol boundaryで確認する"
// @end-test-value
test("release confirms Worker owner deletion while another run handles a burst", { timeout: 10_000 }, async () => {
    let worker: Worker | undefined;
    const postMessage = Worker.prototype.postMessage;
    const spy = mock.method(Worker.prototype, "postMessage", function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      if ((args[0] as CodexProjectionRequest).command.type === "start") worker = this;
      return postMessage.apply(this, args);
    });
    const client = new CodexProjectionClient();
    const retired = await client.begin(input("retired"));
    const survivor = await client.begin(input("survivor"));
    try {
      for (const [run, text] of [[retired, "retained body"], [survivor, "surviving body"]]) {
        await client.call(run, { type: "event", event: { method: "item/completed", params: { item: { id: "same", type: "agentMessage", text } } } });
      }
      const pending = Array.from({ length: 100 }, () => client.call(survivor, { type: "event", event: { method: "unknown" } }));
      const release = client.release(retired);
      void release.catch(() => undefined);
      await Promise.all([release, ...pending]);
      assert.ok(worker);
      // Observe deletion at the Worker protocol, rather than only the client run registry.
      const response = once(worker, "message", { signal: AbortSignal.timeout(2_000) });
      worker.postMessage({ id: -1, runId: retired, command: { type: "live", inputAvailable: true } } satisfies CodexProjectionRequest);
      const [reply] = await response as [CodexProjectionResponse];
      assert.equal(reply.id, -1);
      assert.ok(reply.error);
      assert.equal(reply.value, undefined);
      const live = await client.call<CodexProjectionProgress>(survivor, { type: "live", inputAvailable: true });
      assert.equal(live.state.assistantText, "surviving body");
    } finally {
      spy.mock.restore();
      await Promise.all([client.release(retired), client.release(survivor)]);
    }
});

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
// claim = "正常なcommand burstと大きいeventを容量で拒否せずFIFO適用し、batch中のAudit変更と最終本文を保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "必要commandを件数やbytesで拒否するかbatch内のdelta/Audit変更を落とす"
// observable = "実Workerのbatch応答数とAudit本文、FIFOのfinal本文、大きい本文のfinal出力"
// observation_boundary = "public-boundary"
// scope = "CodexProjectionClient burst and batch processing"
// lifecycle = "permanent"
// impact = "正常な集中出力や長い本文が欠落しturnが失敗することを防ぐ"
// distinction = "小さい逐次event testでは共有burst・batch順序・大きいWorker入力を通らない;固定100commandと36 MiB入力で確認する"
// @end-test-value
test("projection preserves bursts, batch changes and large valid input", async () => {
  const client = new CodexProjectionClient();
  const run = await client.begin(input("capacity"));
  try {
    await client.call(run, { type: "event", event: { method: "item/started", params: { item: { id: "answer", type: "agentMessage", text: "" } } } });
    const deltas = Array.from({ length: 100 }, (_, index) => `${index}:`);
    const pending = deltas.map(delta => client.call(run, { type: "event", event: { method: "item/agentMessage/delta", params: { itemId: "answer", delta } } }));
    const live = client.call<CodexProjectionProgress>(run, { type: "live", inputAvailable: true });
    await Promise.all(pending);
    assert.equal((await live).state.assistantText, deltas.join(""));
    const batch = await client.call<CodexProjectionEvent[]>(run, { type: "events", events: ["a", "b", "c"].map(delta => ({ method: "item/agentMessage/delta", params: { itemId: "answer", delta } })) });
    assert.deepEqual(batch.map(event => event.audit?.state.assistantText), ["a", "ab", "abc"].map(suffix => deltas.join("") + suffix));
    const text = "文".repeat(12 * 1024 * 1024);
    await client.call(run, { type: "event", event: { method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text } } } });
    const final = await client.call<CodexProjectionFinal>(run, { type: "finish", diagnostics: [] });
    assert.equal(final.assistantText, text);
  } finally { await client.release(run); }
});
