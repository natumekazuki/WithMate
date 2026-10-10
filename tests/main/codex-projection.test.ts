import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { CodexProjectionClient } from "../../src-electron/providers/codex/codex-projection-client.js";
import type { CodexProjectionFinal, CodexProjectionProgress, CodexProjectionStart, CodexProjectionEvent, CodexProjectionRequest, CodexProjectionResponse } from "../../src-electron/providers/codex/codex-projection-protocol.js";
import { PROVIDER_TEXT_PREVIEW_LIMIT } from "../../src-electron/session/provider-payload-limits.js";

function input(name: string): CodexProjectionStart {
  return {
    sessionId: name, threadId: "thread", turnId: "turn", apiKey: `api-${name}`, progress: true,
    binding: { bindingId: name, bindingReference: `binding-${name}`, turnCapability: `cap-${name}`, providerId: "codex", executionGeneration: name, transport: "env", expiresAt: null },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Codexの本文・statusが同じでもexitCodeとerrorだけの補正をWorkerのlive step snapshotとupsertへ反映し重複通知を抑止する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner / 通常履歴と最小turn" }
// fault = "step同値判定が結果fieldを比較せず補正を落とす、または同じ結果で不要な変更通知を生成する"
// observable = "実projection Workerのlive step exitCode・errorと変更upsert・再通知時のnull"
// observation_boundary = "public-boundary"
// scope = "CodexProjectionClient result-only live step corrections"
// lifecycle = "permanent"
// impact = "確定済みの終了コードとtool errorが実行中表示へ反映されず結果を誤認させる"
// distinction = "既存初回結果投影testは本文・status不変の補正と変更step配信を検査せず型検査では通知消失を確認できない"
// @end-test-value
test("Worker liveは結果だけの補正を反映して同値通知を抑止する", async () => {
  const client = new CodexProjectionClient();
  const run = await client.begin(input("correction"));
  const command = { id: "command", type: "commandExecution", command: "check", aggregatedOutput: "same", status: "completed", exitCode: null };
  const mcp = { id: "mcp", type: "mcpToolCall", server: "server", tool: "tool", arguments: {}, result: null, status: "failed", error: null };
  const apply = async (items: unknown[]) => {
    for (const item of items) await client.call(run, { type: "event", event: { method: "item/completed", params: { item } } });
  };
  try {
    await apply([command, mcp]);
    const initial = await client.call<CodexProjectionProgress>(run, { type: "live", inputAvailable: false });
    assert.equal(initial.state.steps[0].exitCode, undefined);
    assert.equal(initial.state.steps[1].error, undefined);
    const corrected = [{ ...command, exitCode: 7 }, { ...mcp, error: { message: "{}" } }];
    await apply(corrected);
    const live = await client.call<CodexProjectionProgress | null>(run, { type: "live", inputAvailable: false });
    assert.ok(live);
    assert.equal(live.state.steps[0].exitCode, 7);
    assert.deepEqual(live.state.steps[1].error, { message: "{}" });
    assert.deepEqual(live.changes.steps.upserts.map((step) => step.id), ["command", "mcp"]);
    assert.deepEqual(live.state.steps.map(({ summary, details, status }) => ({ summary, details, status })),
      initial.state.steps.map(({ summary, details, status }) => ({ summary, details, status })));
    await apply(corrected);
    assert.equal(await client.call(run, { type: "live", inputAvailable: false }), null);
    await client.call(run, { type: "event", event: { method: "turn/completed",
      params: { turn: { id: "turn", status: "completed", items: [command, mcp] } } } });
    const cleared = await client.call<CodexProjectionProgress>(run, { type: "live", inputAvailable: false });
    assert.equal(cleared.state.steps[0].exitCode, undefined);
    assert.equal(cleared.state.steps[1].error, undefined);
    assert.deepEqual(cleared.changes.steps.upserts.map((step) => step.id), ["command", "mcp"]);
  } finally { await client.release(run); }
});

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
// observable = "実Workerから受け取る変更通知、live snapshot、final本文、items、metadata、trace有効時のrawItemsJsonとdiagnostics"
// observation_boundary = "public-boundary"
// scope = "CodexProjectionClient concurrent and sequential turn isolation"
// lifecycle = "permanent"
// risk_tags = ["privacy", "authentication"]
// impact = "binding capabilityやAPI keyの漏洩と別会話への本文混入を防ぐ"
// distinction = "redactor単体とadapter fake transportだけではWorker間のcloneとrun状態分離・次turnの再初期化を確認できない"
// @end-test-value
test("shared Worker isolates turns and sanitizes complete final output", async () => {
  const client = new CodexProjectionClient();
  const first = await client.begin({ ...input("first"), diagnosticTrace: true });
  const second = await client.begin({ ...input("second"), diagnosticTrace: true });
  const runs = [first, second];
  try {
    for (const [index, runId] of runs.entries()) {
      const name = index ? "second" : "first";
      const body = `${name} binding-${name} cap-${name} api-${name} ${"文".repeat(PROVIDER_TEXT_PREVIEW_LIMIT + 10)}`;
      const event = await client.call<CodexProjectionEvent>(runId, { type: "event", event: { method: "item/completed", params: { item: { id: "same", type: "agentMessage", text: body } } } });
      assert.equal(event.changed, true);
      await client.call(runId, { type: "event", event: { method: "item/completed", params: { item: { id: "unsupported", type: "futureItem", payload: `cap-${name}` } } } });
      const live = await client.call<CodexProjectionProgress>(runId, { type: "live", inputAvailable: true });

      assert.equal(await client.call(runId, { type: "live", inputAvailable: true }), null);
      const final = await client.call<CodexProjectionFinal>(runId, { type: "finish", diagnostics: [{ type: "diagnostic", data: { value: `binding-${name}` } }] });
      assert.equal(typeof final.rawItemsJson, "string");
      assert.ok(final.rawItemsJson!.includes("unsupported"));
      const rawItems = JSON.parse(final.rawItemsJson!) as Array<{ type: string; data?: { value?: string } }>;
      assert.ok(rawItems.some(item => item.type === "diagnostic" && item.data?.value === "[WITHMATE_BINDING_REFERENCE_REDACTED]"));
      for (const secret of [`binding-${name}`, `cap-${name}`, `api-${name}`]) {
        assert.ok(!final.rawItemsJson!.includes(secret));
      }
      const combined = JSON.stringify({ event, live, final });
      for (const secret of [`binding-${name}`, `cap-${name}`, `api-${name}`]) assert.ok(!combined.includes(secret));
      assert.ok(final.assistantText.startsWith(`${name} `));
      assert.ok(!final.assistantText.includes(index ? "first" : "second"));
      assert.ok(final.assistantText.endsWith("文".repeat(PROVIDER_TEXT_PREVIEW_LIMIT + 10)));

      assert.equal(final.providerMetadata.length, 1);
      assert.equal(final.items.length, 2);
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
// kind = "contract"
// claim = "正常なcommand burstと大きいeventを容量で拒否せずFIFO適用し、batch中の変更と最終本文を保持する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md: Codex projection owner" }
// fault = "必要commandを件数やbytesで拒否するかbatch内のdelta変更を落とす"
// observable = "実Workerのbatch変更応答とlive本文、FIFOのfinal本文、大きい本文のfinal出力"
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
    assert.deepEqual(batch.map(event => event.changed), [true, true, true]);
    const batchedLive = await client.call<CodexProjectionProgress>(run, { type: "live", inputAvailable: true });
    assert.equal(batchedLive.state.assistantText, deltas.join("") + "abc");
    const text = "文".repeat(12 * 1024 * 1024);
    await client.call(run, { type: "event", event: { method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text } } } });
    const final = await client.call<CodexProjectionFinal>(run, { type: "finish", diagnostics: [] });
    assert.equal(final.assistantText, text);
  } finally { await client.release(run); }
});
