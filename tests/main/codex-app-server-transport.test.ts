import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { CodexAppServerTransport, CodexAppServerRpcError, type CodexProtocolEvent } from "../../src-electron/providers/codex/app-server-transport.js";
import { spawnOwnedCodexProcess } from "../../src-electron/providers/codex/owned-process.js";

const fixture = `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
let initialized = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (!message.params.capabilities.experimentalApi || message.jsonrpc) process.exit(2);
    send({ id:message.id, result:{userAgent:'fixture', codexHome:process.cwd(), platformFamily:'fixture', platformOs:'fixture'} });
  } else if (message.method === 'initialized') initialized = true;
  else if (message.method === 'echo') {
    if (!initialized) process.exit(3);
    send({method:'early',params:{text:'日本語'}});
    setTimeout(() => send({id:message.id,result:message.params}), message.params.delay);
  } else if (message.method === 'approval') {
    send({id:77, method:'item/commandExecution/requestApproval',params:{}});
    send({id:message.id,result:null});
  } else if (message.id === 77) send({method:'answered',params:message.result ?? message.error});
  else if (message.method === 'rpcError') send({id:message.id,error:{code:-32001,message:'denied',data:{reason:'policy'}}});
  else if (message.method === 'descendant' || message.method === 'descendantExit') {
    const child = spawn(process.execPath, ['-e','setInterval(() => {}, 1000)'], {stdio:'ignore'});
    send({id:message.id,result:{pid:child.pid}});
    if (message.method === 'descendantExit') setTimeout(() => process.exit(0), 30);
  }
  else if (message.method === 'malformed') process.stdout.write('not-json\\n');
  else if (message.method === 'partial') process.stdout.write('{"id":', () => process.exit(0));
});
setInterval(() => {}, 1000);
`;
function transport(): CodexAppServerTransport {
  return new CodexAppServerTransport({ executable: process.execPath,
    arguments: ["--input-type=module", "-e", fixture], clientInfo: { name: "withmate-test", version: "1" } });
}

// @test-value v2
// kind = "invariant"
// claim = "initialize完了後に通知が先行しても並行requestの結果をIDで相関できる"
// oracle = { type = "contract", ref = "https://developers.openai.com/codex/app-server/" }
// fault = "通知を応答として扱う、または応答到着順でrequestを解決する"
// observable = "request結果とnextEventから取得する日本語通知"
// observation_boundary = "public-boundary"
// scope = "Codex stdio transport"
// lifecycle = "permanent"
// impact = "turn開始応答と通知の順序でセッションが混線する"
// distinction = "型検査では実processのJSONL順序や相関を検証できない;短いローカルprocessのみ使用"
// @end-test-value
test("stdio initializes and correlates concurrent requests with early notifications", async () => {
  const sut = transport();
  try {
    await sut.start();
    const slow = sut.request("echo", { delay: 40, label: "slow" });
    const fast = sut.request("echo", { delay: 0, label: "fast" });
    assert.deepEqual(await fast, { delay: 0, label: "fast" });
    assert.deepEqual(await slow, { delay: 40, label: "slow" });
    assert.deepEqual(await sut.nextEvent(), { kind: "notification", method: "early", params: { text: "日本語" } });
  } finally { await sut.close(); }
  assert.equal(sut.state, "closed");
});

// @test-value v2
// kind = "invariant"
// claim = "server requestへ一回だけ応答しRPC errorのcodeとdataを呼出元へ返す"
// oracle = { type = "contract", ref = "https://developers.openai.com/codex/app-server/" }
// fault = "server request応答を捨てる、二重送信する、またはRPC errorを成功として扱う"
// observable = "server側応答通知と二重respondのrejectおよびRPC errorのcodeとdata"
// observation_boundary = "public-boundary"
// scope = "Codex stdio transport server requests"
// lifecycle = "permanent"
// impact = "approval結果がサーバへ届かず処理が停止する"
// distinction = "実processへの往復応答と一回性は型検査で確認できない"
// @end-test-value
test("server responses are one-shot and RPC errors preserve details", async () => {
  const sut = transport();
  try {
    await sut.start();
    await sut.request("approval");
    const event = await sut.nextEvent();
    assert.equal(event.kind, "serverRequest");
    if (event.kind !== "serverRequest") throw new Error("Expected request");
    await event.respond({ decision: "accept" });
    await assert.rejects(event.respond({ decision: "accept" }), /already resolved/);
    assert.deepEqual(await sut.nextEvent(), { kind: "notification", method: "answered", params: { decision: "accept" } });
    await assert.rejects(sut.request("rpcError"), error => error instanceof CodexAppServerRpcError
      && error.code === -32001 && error.message === "denied" && JSON.stringify(error.data) === '{"reason":"policy"}');
  } finally { await sut.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "abortとtimeoutで待機requestを解放し遅延応答後も次のrequestを正しく完了する"
// oracle = { type = "contract", ref = "Issue #780 stdio transport cancellation and deadlines" }
// fault = "取消済み応答を新しいrequestへ流用する、または待機promiseを解放しない"
// observable = "abort/timeoutのrejectと後続echoの結果"
// observation_boundary = "public-boundary"
// scope = "Codex stdio request cancellation"
// lifecycle = "permanent"
// impact = "キャンセル後のセッション操作が停止または混線する"
// distinction = "非同期のabortと遅延wire response競合は型やbuildでは検出できない"
// @end-test-value
test("abort and timeout settle callers without miscorrelating late responses", async () => {
  const sut = transport();
  try {
    await sut.start();
    const abort = new AbortController();
    const request = sut.request("echo", { delay: 20 }, { signal: abort.signal });
    abort.abort();
    await assert.rejects(request, { name: "AbortError" });
    await assert.rejects(sut.request("echo", { delay: 20 }, { timeoutMs: 1 }), /timed out/);
    assert.deepEqual(await sut.request("echo", { delay: 40, label: "next" }), { delay: 40, label: "next" });
  } finally { await sut.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "不正JSONまたは途中終了したstdoutが待機requestとeventを失敗として解放する"
// oracle = { type = "contract", ref = "Issue #780 no stdout failures hidden as success" }
// fault = "不正stdoutを無視してrequestまたはeventを永久待機させる"
// observable = "requestとnextEventのreject"
// observation_boundary = "public-boundary"
// scope = "Codex stdio disconnect"
// lifecycle = "permanent"
// impact = "壊れたCLI通信を実行成功と誤認する、またはturnが停止する"
// distinction = "実stdout streamの終了はschema/type検査では確認できない"
// @end-test-value
test("malformed and truncated stdout fail requests and event consumers", async () => {
  for (const method of ["malformed", "partial"]) {
    const sut = transport();
    try {
      await sut.start();
      const event = sut.nextEvent();
      await Promise.all([
        assert.rejects(sut.request(method), /stdout|process exited/),
        assert.rejects(event, /stdout|process exited/),
      ]);
    } finally { await sut.close(); }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "closeは所有processの子孫を終了し待機requestとeventを解放する"
// oracle = { type = "contract", ref = "Issue #780 owned app-server process cleanup" }
// fault = "root processのみ終了して子processを残す、またはpending promiseを残す"
// observable = "子PIDの不存在とrequest/eventのreject"
// observation_boundary = "public-boundary"
// scope = "Codex stdio lifecycle"
// lifecycle = "permanent"
// impact = "session停止後もCLI実行processが残留する"
// distinction = "実OSのprocess tree終了を静的検査では確認できない;所有fixture processのみ使用"
// @end-test-value
test("close terminates owned descendants and settles pending consumers", async () => {
  const sut = transport();
  try {
    await sut.start();
    const { pid } = await sut.request<{ pid: number }>("descendant");
    const pending = assert.rejects(sut.request("never"), /closed/);
    const event = assert.rejects(sut.nextEvent(), /closed/);
    await sut.close();
    await Promise.all([pending, event]);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await sut.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "rootが自然終了しても所有子孫を終了しevent consumerへ切断を通知する"
// oracle = { type = "contract", ref = "Issue #780 owned app-server process cleanup" }
// fault = "root終了後に子孫を残す、またはcloseを待って切断検出が停止する"
// observable = "nextEventのrejectと子PIDの不存在"
// observation_boundary = "public-boundary"
// scope = "Codex stdio abnormal exit lifecycle"
// lifecycle = "permanent"
// impact = "異常終了したCLIの子孫が次turnと同じworkspaceで競合する"
// distinction = "active rootのclose testはroot不在時のcleanupを担わない;短い実process検証"
// @end-test-value
test("unexpected root exit cleans descendants without relying on a live root PID", async () => {
  const sut = transport();
  try {
    await sut.start();
    const { pid } = await sut.request<{ pid: number }>("descendantExit");
    await assert.rejects(sut.nextEvent(), /stdout|process exited/);
    await sut.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await sut.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "Windows Job確保失敗時はapp-serverやsupervisorを起動しない"
// oracle = { type = "contract", ref = "Issue #780 fail-closed Windows process ownership" }
// fault = "Jobを確保できなくても非所有processへfallbackする"
// observable = "ownership取得のthrowとspawn未呼出し"
// observation_boundary = "component-behavior"
// scope = "Codex Windows process ownership acquisition"
// lifecycle = "permanent"
// impact = "所有できないCLI子孫が停止後もworkspaceへアクセスする"
// distinction = "実OSの成功系ではJob作成拒否の起動境界を確認できない"
// @end-test-value
test("Windows ownership acquisition failure does not launch an unowned process", () => {
  let launched = false;
  const forbiddenSpawn = (() => { launched = true; throw new Error("Unexpected spawn"); }) as typeof spawn;
  assert.throws(() => spawnOwnedCodexProcess({ executable: process.execPath, arguments: [] }, {
    platform: "win32", spawnProcess: forbiddenSpawn,
    createJobObject: () => { throw new Error("Job unavailable"); },
  }), /Job unavailable/);
  assert.equal(launched, false);
});

function cleanupFaultTransport(fault: "terminate" | "exit" | "release") {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(String(chunk)) as { id?: number; method: string };
    if (request.method === "initialize") stdout.write(`${JSON.stringify({ id: request.id,
      result: { userAgent: "fixture", codexHome: process.cwd(), platformFamily: "fixture", platformOs: "fixture" } })}\n`);
    callback();
  } });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  const calls = { terminate: 0, release: 0 };
  const sut = new CodexAppServerTransport({ executable: "owned-fixture", clientInfo: { name: "test", version: "1" }, closeTimeoutMs: 10 }, {
    spawnOwnedProcess: () => ({ child: child as ChildProcessWithoutNullStreams, ready: Promise.resolve(),
      terminate() {
        calls.terminate++;
        if (fault === "terminate") throw new Error("Injected terminate failure");
        if (fault === "release") setImmediate(() => child.emit("close", 0, null));
      },
      release() {
        calls.release++;
        if (fault === "release" && calls.release === 1) throw new Error("Injected release failure");
        if (fault !== "exit") setImmediate(() => child.emit("close", 0, null));
      },
    }),
  });
  return { sut, calls, child, stdout, streams: [stdin, stdout, stderr] };
}

// @test-value v2
// kind = "invariant"
// claim = "受信済み通知を到着順に取り出してから後続EOFまたはexitを失敗として通知し、待機RPCは即失敗する"
// oracle = { type = "contract", ref = "docs/adr/002-provider-turn-terminal-and-cancellation.md#現在の適用範囲" }
// fault = "切断時に受信済みitemやnative completedを破棄する、またはterminalなしEOFを成功として扱う"
// observable = "待機RPCのreject、item/completed通知の順序、queue消費後のnextEventのreject"
// observation_boundary = "public-boundary"
// scope = "Codex stdio received-event and disconnect ordering"
// lifecycle = "permanent"
// impact = "providerが既に完了したturnを失敗へ変更し最終itemを失う"
// distinction = "既存切断testは通知の消費待ちとの競合を作らない;in-memory streamでEOFとexitを決定論的に再現する"
// @end-test-value
test("received events drain in order before EOF or exit rejects event consumers", async () => {
  for (const disconnect of ["eof", "exit"]) {
    for (const completed of [false, true]) {
      const { sut, child, stdout } = cleanupFaultTransport("exit");
      await sut.start();
      const pending = assert.rejects(sut.request("never"), /stdout disconnected|process exited/);
      const events: CodexProtocolEvent[] = [{ kind: "notification", method: "item/completed", params: { item: { id: "final-item" } } }];
      if (completed) events.push({ kind: "notification", method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } });
      for (const event of events) stdout.write(`${JSON.stringify({ method: event.method, params: event.params })}\n`);
      if (disconnect === "eof") stdout.end();
      else child.emit("exit", 0, null);
      await pending;
      child.emit("close", 0, null);
      for (const event of events) assert.deepEqual(await sut.nextEvent(), event);
      await assert.rejects(sut.nextEvent(), /stdout disconnected|process exited/);
      await sut.close();
      await sut.whenClosed();
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "terminate失敗後もreleaseとstream解放を試しcloseは失敗を返しwhenClosedは終了確認を成功としない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "terminate例外でcleanupを中断してresourceを残す、またはterminate失敗中にwhenClosedを成功解決する"
// observable = "closeのAggregateError、release呼出回数、各streamのdestroyedとfailed状態、whenClosedの未解決"
// observation_boundary = "public-boundary"
// scope = "Codex transport OS cleanup failure"
// lifecycle = "permanent"
// impact = "OS終了API失敗時にresourceが残留する、または未終了processと次turnが競合する"
// distinction = "成功系の実OS testでは終了API例外後のresource解放を確認できない;小さい所有境界fixtureで検出"
// @end-test-value
test("terminate failure still releases ownership and streams while reporting failure", async () => {
  const { sut, calls, streams } = cleanupFaultTransport("terminate");
  await sut.start();
  let confirmedClosed = false;
  void sut.whenClosed().then(() => { confirmedClosed = true; });
  await assert.rejects(sut.close(), error => error instanceof AggregateError && error.errors.some((cause: Error) => cause.message === "Injected terminate failure"));
  assert.deepEqual(calls, { terminate: 1, release: 1 });
  assert.ok(streams.every(stream => stream.destroyed));
  assert.equal(sut.state, "failed");
  await assert.rejects(sut.close(), /cleanup failed/);
  assert.deepEqual(calls, { terminate: 1, release: 1 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(confirmedClosed, false);
});

// @test-value v2
// kind = "invariant"
// claim = "exit待ちtimeoutは有界に失敗を返しwhenClosedは遅延closeによる所有process終了確認後にだけ解決する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "child closeが来ない場合にresourceを残す、またはclose確認前にwhenClosedを解決し遅延closeでも未解決にする"
// observable = "closeのtimeoutを含むAggregateError、release回数、stream destroyedとfailed状態、遅延close前後のwhenClosed解決"
// observation_boundary = "public-boundary"
// scope = "Codex transport missing process-close notification"
// lifecycle = "permanent"
// impact = "終了待ち失敗でresourceが残る、次turnが未終了processと競合する、または終了後も再送を拒否する"
// distinction = "実OS成功系はprocess-close通知欠落を発生させない;10ms deadlineの小さいfixtureを使用"
// @end-test-value
test("exit timeout releases ownership and streams and remains a cleanup failure", async () => {
  const { sut, calls, child, streams } = cleanupFaultTransport("exit");
  await sut.start();
  let confirmedClosed = false;
  void sut.whenClosed().then(() => { confirmedClosed = true; });
  await assert.rejects(sut.close(), error => error instanceof AggregateError && error.errors.some((cause: Error) => /timed out/.test(cause.message)));
  assert.deepEqual(calls, { terminate: 1, release: 1 });
  assert.ok(streams.every(stream => stream.destroyed));
  assert.equal(sut.state, "failed");
  assert.equal(confirmedClosed, false);
  child.emit("close", 0, null);
  await sut.whenClosed();
  assert.equal(confirmedClosed, true);
  await assert.rejects(sut.close(), /cleanup failed/);
});

// @test-value v2
// kind = "invariant"
// claim = "release失敗を通知してwhenClosedを未解決にし保持したhandleの明示再close成功後に終了を確認できる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "未解放handleの再closeを拒否する、またはrelease失敗中にwhenClosedを解決し再close成功を通知しない"
// observable = "初回closeのrelease failure、全stream destroyed、再closeのrelease回数とclosed状態、whenClosedの解決"
// observation_boundary = "public-boundary"
// scope = "Codex transport retained ownership release"
// lifecycle = "permanent"
// impact = "一時的なCloseHandle失敗後にresourceが残る、または未解放processと次turnが競合し終了後も再送不能になる"
// distinction = "terminate/timeout fixtureとは異なるnative handleの保持・明示再解放を確認する"
// @end-test-value
test("release failure is reported and an explicitly repeated close releases the retained owner", async () => {
  const { sut, calls, streams } = cleanupFaultTransport("release");
  await sut.start();
  let confirmedClosed = false;
  void sut.whenClosed().then(() => { confirmedClosed = true; });
  await assert.rejects(sut.close(), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0].message === "Injected release failure");
  assert.ok(streams.every(stream => stream.destroyed));
  assert.equal(sut.state, "failed");
  assert.equal(confirmedClosed, false);
  await sut.close();
  await sut.whenClosed();
  assert.deepEqual(calls, { terminate: 2, release: 2 });
  assert.equal(sut.state, "closed");
  assert.equal(confirmedClosed, true);
});
