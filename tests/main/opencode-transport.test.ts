import assert from "node:assert/strict";
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { OpenCodeTransport, parseOpenCodeServerUrl } from "../../src-electron/providers/opencode/opencode-transport.js";
import type { ProviderProcessLaunchOptions } from "../../src-electron/providers/owned-process.js";

// @test-value v2
// kind = "invariant"
// claim = "起動通知は指定loopbackのHTTP endpointだけを受け付け、credentialやpathを含む外部endpointを拒否する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "起動JSONのURLを未検証でclientへ渡す"
// observable = "URL解析結果と不正URLに対する例外"
// observation_boundary = "public-boundary"
// scope = "OpenCode transport startup endpoint"
// lifecycle = "permanent"
// impact = "server passwordが外部endpointへ漏れる"
// distinction = "型検査は外部JSONのURLの意味を検査しない。高速な純粋境界検証である"
// @end-test-value
test("OpenCode startup URL is restricted to owned IPv4 loopback", () => {
  assert.equal(parseOpenCodeServerUrl({ url: "http://127.0.0.1:12345" }), "http://127.0.0.1:12345");
  for (const url of ["http://example.com:123", "http://0.0.0.0:123", "http://localhost:123", "https://127.0.0.1:123", "http://user:pass@127.0.0.1:123", "http://127.0.0.1:123/path", "http://127.0.0.1:123?token=secret"]) {
    assert.throws(() => parseOpenCodeServerUrl({ url }));
  }
});

// @test-value v2
// kind = "invariant"
// claim = "専用DBの起動を直列化し、clientはランダムpasswordで認証し、通常設定を引き継ぎ、実closeだけでwhenClosedを解放する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/879" }
// fault = "DB bootstrapを並行開始する、global passwordを継承する、通常設定を失う、cleanup timeoutで終了確認を成立させる"
// observable = "spawn options、HTTP Authorization、spawn回数、close失敗とwhenClosed未解決後の実close解決"
// observation_boundary = "public-boundary"
// scope = "OpenCode owned transport"
// lifecycle = "permanent"
// impact = "DB migration競合、利用者のnative設定喪失、cleanup前の再実行が起きる"
// distinction = "fake owned childとローカルHTTPで非同期の公開契約を検証し、有料モデルや実CLI起動は不要"
// @end-test-value
test("OpenCode authenticates, serializes bootstrap and preserves cleanup confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-opencode-日本語 "));
  const launches: ProviderProcessLaunchOptions[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const auth: string[] = [];
  const server = createServer((request, response) => {
    auth.push(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: "2.1.4", pid: 1, urls: [], paths: { tmp: directory } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const spawnOwnedProcess = (options: ProviderProcessLaunchOptions) => {
    launches.push(options);
    const child = new ChildProcess() as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    children.push(child);
    return { child, ready: Promise.resolve(), terminate() {}, release() {} };
  };
  const options = { executable: process.execPath, cwd: directory, databasePath: path.join(directory, "native.sqlite"),
    env: { OPENCODE_CONFIG: "project.json", OPENCODE_CONFIG_CONTENT: "secret-config", OPENCODE_SERVER_PASSWORD: "inherited" }, closeTimeoutMs: 5 };
  const first = new OpenCodeTransport(options, { spawnOwnedProcess });
  const second = new OpenCodeTransport(options, { spawnOwnedProcess });
  try {
    const one = first.start();
    const two = second.start();
    while (!children.length) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(launches.length, 1);
    (children[0].stdout as PassThrough).write(JSON.stringify({ url: `http://127.0.0.1:${address.port}` }) + "\n");
    await one;
    while (children.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    (children[1].stdout as PassThrough).write(JSON.stringify({ url: `http://127.0.0.1:${address.port}` }) + "\n");
    await two;
    const env = launches[0].env!;
    assert.equal(env.OPENCODE_DB, options.databasePath);
    assert.equal(env.OPENCODE_CONFIG, options.env.OPENCODE_CONFIG);
    assert.equal(env.OPENCODE_CONFIG_CONTENT, options.env.OPENCODE_CONFIG_CONTENT);
    assert.notEqual(env.OPENCODE_SERVER_PASSWORD, "inherited");
    assert.notEqual(env.OPENCODE_SERVER_PASSWORD, launches[1].env!.OPENCODE_SERVER_PASSWORD);
    assert.equal(auth[0], `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`);
    assert.ok(first.secrets.includes(env.OPENCODE_SERVER_PASSWORD!));
    let confirmed = false;
    void first.whenClosed().then(() => { confirmed = true; });
    await assert.rejects(first.close(), /cleanup failed/);
    assert.equal(confirmed, false);
    children[0].emit("close", 0, null);
    await first.whenClosed();
    assert.equal(confirmed, true);
    children[1].emit("close", 0, null);
    await second.whenClosed();
  } finally {
    for (const child of children) child.emit("close", 0, null);
    await Promise.allSettled([first.close(), second.close()]);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "子processの起動失敗と起動通知前終了をstartのrejectで伝え、owned cleanupを完了し、未処理rejectをMainへ漏らさない"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "起動失敗を握り潰す、所有processを解放しない、または別の未処理rejectを発生させる"
// observable = "startの拒否理由、terminate/release回数、whenClosed解決、unhandledRejectionの件数"
// observation_boundary = "public-boundary"
// scope = "OpenCode transport startup failure and owned cleanup"
// lifecycle = "permanent"
// impact = "通常のprovider起動失敗がMainのfatal障害として重複記録され診断を誤らせる"
// distinction = "成功起動の既存testや型検査では複数Promiseの非同期rejectを観測できない。実CLIなしの2故障ケースで境界を保護する"
// @end-test-value
test("OpenCode startup failures are handled and release owned processes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-opencode-start-failure-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const event of ["error", "exit"] as const) {
      const failure = new Error(`Provider failed before ready: ${event}`);
      let terminated = 0;
      let released = 0;
      const transport = new OpenCodeTransport({ executable: process.execPath, cwd: directory,
        databasePath: path.join(directory, `${event}.sqlite`), closeTimeoutMs: 500 }, {
        spawnOwnedProcess: () => {
          const child = new ChildProcess() as ChildProcessWithoutNullStreams;
          Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
          const ready = new Promise<void>((_resolve, reject) => { child.once(event, () => reject(failure)); });
          queueMicrotask(() => {
            if (event === "error") child.emit("error", failure);
            child.emit("exit", 1, null);
            child.emit("close", 1, null);
          });
          return { child, ready, terminate: () => { terminated++; }, release: () => { released++; } };
        },
      });
      try {
        await assert.rejects(transport.start(), (error) => error === failure);
        await transport.whenClosed();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(terminated, 1);
        assert.equal(released, 1);
        assert.deepEqual(unhandled, []);
      } finally {
        await transport.close();
      }
    }
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(directory, { recursive: true, force: true });
  }
});
