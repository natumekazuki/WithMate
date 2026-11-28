import assert from "node:assert/strict";
import {
  ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  OpenCodeTransport,
  parseOpenCodeServerUrl,
} from "../../src-electron/providers/opencode/opencode-transport.js";
import type { ProviderProcessLaunchOptions } from "../../src-electron/providers/owned-process.js";
import type { resolveOpenCodeEnvironment } from "../../src-electron/providers/opencode/opencode-environment.js";

/** 実 CLI を探索せず、指定された実行ファイルと DB を維持し、未指定の値だけフィクスチャから補う。 */
const resolveEnvironment: typeof resolveOpenCodeEnvironment = async (
  options,
) => ({
  executable: options.executable ?? process.execPath,
  databasePath:
    options.env?.OPENCODE_DB ?? path.join(options.cwd, "native.sqlite"),
  env: options.env ?? {},
});

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
/** 起動通知では IPv4 ループバックの HTTP オリジンだけを採用し、認証情報・パス・クエリ付きの URL も拒否する。 */
test("OpenCode startup URL is restricted to owned IPv4 loopback", () => {
  assert.equal(
    parseOpenCodeServerUrl({ url: "http://127.0.0.1:12345" }),
    "http://127.0.0.1:12345",
  );
  for (const url of [
    "http://example.com:123",
    "http://0.0.0.0:123",
    "http://localhost:123",
    "https://127.0.0.1:123",
    "http://user:pass@127.0.0.1:123",
    "http://127.0.0.1:123/path",
    "http://127.0.0.1:123?token=secret",
  ]) {
    assert.throws(() => parseOpenCodeServerUrl({ url }));
  }
});

// @test-value v2
// kind = "invariant"
// claim = "同じDBの起動を直列化し、native DB指定を追加せず、clientはランダムpasswordで認証し、通常設定を引き継ぎ、実closeだけでwhenClosedを解放する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/902" }
// fault = "DB bootstrapを並行開始する、global passwordを継承する、通常設定を失う、cleanup timeoutで終了確認を成立させる"
// observable = "spawn options、HTTP Authorization、spawn回数、close失敗とwhenClosed未解決後の実close解決"
// observation_boundary = "public-boundary"
// scope = "OpenCode owned transport"
// lifecycle = "permanent"
// impact = "DB migration競合、利用者のnative設定喪失、cleanup前の再実行が起きる"
// distinction = "fake owned childとローカルHTTPで非同期の公開契約を検証し、有料モデルや実CLI起動は不要"
// @end-test-value
/** 同じ DB の起動を直列化し、各子プロセス固有のパスワードで認証しながら、実際の終了通知までクリーンアップ済みと扱わない。 */
test("OpenCode authenticates, serializes bootstrap and preserves cleanup confirmation", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-opencode-日本語 "),
  );
  const launches: ProviderProcessLaunchOptions[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const auth: string[] = [];
  const server = createServer((request, response) => {
    auth.push(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        version: "2.2.5",
        pid: 1,
        urls: [],
        paths: { tmp: directory },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  /** 起動設定を捕捉し、実行ファイルを起動せずに標準出力と終了イベントを制御できる子プロセスを返す。 */
  const spawnOwnedProcess = (options: ProviderProcessLaunchOptions) => {
    launches.push(options);
    const child = new ChildProcess() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    children.push(child);
    return {
      child,
      ready: Promise.resolve(),
      /** 終了通知を手動で発行できるよう、停止要求だけでは子プロセスを閉じない。 */
      terminate() {},
      /** 実プロセスを取得していないため、解除する外部資源はない。 */
      release() {},
    };
  };
  const options = {
    executable: process.execPath,
    cwd: directory,
    databasePath: path.join(directory, "native.sqlite"),
    env: {
      OPENCODE_CONFIG: "project.json",
      OPENCODE_CONFIG_CONTENT: "secret-config",
      OPENCODE_SERVER_PASSWORD: "inherited",
    },
    closeTimeoutMs: 5,
  };
  const first = new OpenCodeTransport(options, {
    spawnOwnedProcess,
    resolveEnvironment,
  });
  const second = new OpenCodeTransport(options, {
    spawnOwnedProcess,
    resolveEnvironment,
  });
  const native = new OpenCodeTransport(
    { cwd: directory, env: options.env, closeTimeoutMs: 5 },
    { spawnOwnedProcess, resolveEnvironment },
  );
  try {
    const one = first.start();
    const two = second.start();
    while (!children.length)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(launches.length, 1);
    (children[0].stdout as PassThrough).write(
      JSON.stringify({ url: `http://127.0.0.1:${address.port}` }) + "\n",
    );
    await one;
    while (children.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 1));
    (children[1].stdout as PassThrough).write(
      JSON.stringify({ url: `http://127.0.0.1:${address.port}` }) + "\n",
    );
    await two;
    const env = launches[0].env!;
    assert.equal(env.OPENCODE_DB, options.databasePath);
    assert.equal(env.OPENCODE_CONFIG, options.env.OPENCODE_CONFIG);
    assert.equal(
      env.OPENCODE_CONFIG_CONTENT,
      options.env.OPENCODE_CONFIG_CONTENT,
    );
    assert.notEqual(env.OPENCODE_SERVER_PASSWORD, "inherited");
    assert.notEqual(
      env.OPENCODE_SERVER_PASSWORD,
      launches[1].env!.OPENCODE_SERVER_PASSWORD,
    );
    assert.equal(
      auth[0],
      `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
    );
    assert.ok(first.secrets.includes(env.OPENCODE_SERVER_PASSWORD!));
    const nativeStart = native.start();
    while (children.length < 3)
      await new Promise((resolve) => setTimeout(resolve, 1));
    (children[2].stdout as PassThrough).write(
      JSON.stringify({ url: `http://127.0.0.1:${address.port}` }) + "\n",
    );
    await nativeStart;
    assert.equal(Object.hasOwn(launches[2].env!, "OPENCODE_DB"), false);
    assert.equal(
      launches[2].env!.OPENCODE_CONFIG_CONTENT,
      options.env.OPENCODE_CONFIG_CONTENT,
    );
    let confirmed = false;
    void first.whenClosed().then(() => {
      confirmed = true;
    });
    await assert.rejects(first.close(), /cleanup failed/);
    assert.equal(confirmed, false);
    children[0].emit("close", 0, null);
    await first.whenClosed();
    assert.equal(confirmed, true);
    children[1].emit("close", 0, null);
    await second.whenClosed();
    children[2].emit("close", 0, null);
    await native.whenClosed();
  } finally {
    for (const child of children) child.emit("close", 0, null);
    await Promise.allSettled([first.close(), second.close(), native.close()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
/** 起動失敗と準備前終了のどちらも元のエラーで拒否され、終了要求と所有権解放は一度ずつで未処理の拒否が残らない。 */
test("OpenCode startup failures are handled and release owned processes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-opencode-start-failure-"),
  );
  const unhandled: unknown[] = [];
  /** 呼び出し元に伝わる起動エラーとは別の未処理拒否を記録する。 */
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const event of ["error", "exit"] as const) {
      const failure = new Error(`Provider failed before ready: ${event}`);
      let terminated = 0;
      let released = 0;
      const transport = new OpenCodeTransport(
        {
          executable: process.execPath,
          cwd: directory,
          databasePath: path.join(directory, `${event}.sqlite`),
          closeTimeoutMs: 500,
        },
        {
          resolveEnvironment,
          /** 起動完了前に指定のエラーまたは終了イベントを発生させ、終了処理を計測できるプロセスを返す。 */
          spawnOwnedProcess: () => {
            const child = new ChildProcess() as ChildProcessWithoutNullStreams;
            Object.assign(child, {
              stdin: new PassThrough(),
              stdout: new PassThrough(),
              stderr: new PassThrough(),
            });
            const ready = new Promise<void>((_resolve, reject) => {
              child.once(event, () => reject(failure));
            });
            queueMicrotask(() => {
              if (event === "error") child.emit("error", failure);
              child.emit("exit", 1, null);
              child.emit("close", 1, null);
            });
            return {
              child,
              ready,
              /** 起動に失敗したプロセスへの停止要求を数える。 */
              terminate: () => {
                terminated++;
              },
              /** 所有権の解除が重複しないことを確認できるように数える。 */
              release: () => {
                released++;
              },
            };
          },
        },
      );
      try {
        await assert.rejects(transport.start(), (error) => error === failure);
        await transport.whenClosed();
        await new Promise<void>((resolve) => setImmediate(resolve));
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

// @test-value v2
// kind = "contract"
// claim = "native環境の解決失敗はserverを起動せず所有外processを停止せずに利用側へ失敗を返す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/902" }
// fault = "version不一致の環境解決失敗後にserverを起動するかcleanup対象を勝手に取得する"
// observable = "startのreject、owned spawn呼出数、whenClosedの解決"
// observation_boundary = "public-boundary"
// scope = "OpenCode native environment preflight"
// lifecycle = "permanent"
// impact = "対応外CLIによる既存DB変更やPC側processの停止が起きる"
// distinction = "型検査では非同期環境解決失敗時のprocess副作用を検出できず、fake境界で高速に検証する"
// @end-test-value
/** 対応外 CLI と分かった時点で起動を拒否し、管理対象のサーバープロセスを取得しないことを確認する。 */
test("OpenCode environment failure does not acquire a server process", async () => {
  let spawned = 0;
  const failure = new Error("OpenCode CLI 2.2.5 is required.");
  const transport = new OpenCodeTransport(
    { cwd: process.cwd() },
    {
      /** 起動準備で判明した非対応バージョンのエラーを返す。 */
      resolveEnvironment: async () => {
        throw failure;
      },
      /** 環境確認に失敗したのにプロセスを起動した場合は、呼び出しを記録して失敗させる。 */
      spawnOwnedProcess: () => {
        spawned++;
        throw new Error("Unexpected spawn");
      },
    },
  );
  await assert.rejects(transport.start(), (error) => error === failure);
  await transport.whenClosed();
  assert.equal(spawned, 0);
});
