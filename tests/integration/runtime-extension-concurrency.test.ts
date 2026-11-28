import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import {
  startAgentRuntimeApi,
  type StartAgentRuntimeApiOptions,
} from "../../src-electron/platform/agent-runtime/runtime-api.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callAgentRuntime,
  resolveAgentRuntimeApi,
  AgentRuntimeExchangeError,
  type AgentRuntimeConnection,
} from "../../src-electron/platform/agent-runtime/runtime-client.js";
import {
  createAgentRuntimeChallenge,
  createAgentRuntimeOwnerChallenge,
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER,
  WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
  WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES,
  WITHMATE_AGENT_RUNTIME_GENERATION_HEADER,
  WITHMATE_AGENT_RUNTIME_NONCE_HEADER,
  WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER,
} from "../../src-electron/platform/agent-runtime/runtime-exchange.js";

const apiSecret = "extension-test-api";
const adapterSecret = "extension-test-adapter";
const generation = "22222222-2222-4222-8222-222222222222";
const applicationInstanceId = "11111111-1111-4111-8111-111111111111";
/** 要求の処理開始や解放を他の Promise と同期するため、外から完了を通知できる待機点を返す。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** 実ランタイムと検出済み接続を一時ディレクトリに作り、ルーターと同時実行条件だけをケース別に差し替える。 */
async function fixture(
  route: NonNullable<StartAgentRuntimeApiOptions["routeAgentRuntimeExtension"]>,
  options: Partial<StartAgentRuntimeApiOptions> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "withmate-extension-"));
  const server = await startAgentRuntimeApi({
    applicationInstanceId,
    buildChannel: "development",
    registryDirectoryPath: directory,
    /** 一時レジストリの実 ACL を変えず、要求の受付とルーティングを検証する。 */
    runtimePathSecurity: async () => {},
    agentRuntimeBindingRegistry: new AgentRuntimeBindingRegistry(),
    providerAgentRuntimeTurns: new ProviderAgentRuntimeTurnCoordinator(),
    routeAgentRuntimeExtension: route,
    ...options,
  });
  const resolved = await resolveAgentRuntimeApi({
    env: {},
    adapter: "mcp",
    registryRootDirectoryPath: directory,
    applicationInstanceId,
    runtimeGenerationId: server.runtimeGenerationId,
  });
  if (resolved.kind !== "selected") {
    await server.stop();
    throw new Error(JSON.stringify(resolved));
  }
  const connection = resolved.connection;
  return {
    server: {
      /** リスナーを停止したあと、fixture が作成したレジストリだけを削除する。 */
      async stop() {
        await server.stop();
        await rm(directory, { recursive: true, force: true });
      },
    },
    connection,
    /** 実クライアントで拡張交換経路に送り、応答がない場合は所定の時間で中止する。 */
    call: (path: string, body: unknown = {}) =>
      callAgentRuntime(
        connection,
        { method: "POST", path, body },
        {
          signal: AbortSignal.timeout(5000),
          exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        },
      ),
  };
}

/** 実クライアントが自動で計算する本文長では再現できない条件を、HTTP fixture で指定して応答を観測する。 */
function rawCall(
  connection: AgentRuntimeConnection,
  path: string,
  padding: string,
  length: number | null = null,
) {
  const payload = JSON.stringify({
    schemaVersion: "withmate-agent-runtime-exchange-v1",
    apiSecret: connection.api.apiSecret,
    adapter: "mcp",
    adapterSecret: connection.credential.adapterSecret,
    operation: { method: "POST", path, body: { padding } },
  });
  const nonce = "raw-capacity-test";
  return new Promise<{ status: number; value: unknown }>((resolve, reject) => {
    const request = httpRequest(
      new URL(
        WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        connection.api.baseUrl,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WITHMATE_AGENT_RUNTIME_NONCE_HEADER]: nonce,
          [WITHMATE_AGENT_RUNTIME_GENERATION_HEADER]:
            connection.api.runtimeGenerationId,
          [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER]:
            connection.api.applicationInstanceId,
          ...(length === null ? {} : { "content-length": length }),
        },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: response.statusCode!,
              value: text ? JSON.parse(text) : null,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.on("information", (information) => {
      if (information.statusCode !== 103) return;
      assert.equal(
        information.headers[WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER],
        createAgentRuntimeChallenge(
          connection.api.apiSecret,
          connection.api.runtimeGenerationId,
          nonce,
        ),
      );
      request.end(payload);
    });
    request.flushHeaders();
  });
}

// @test-value v2
// kind = "contract"
// claim = "小さいSession読取の5並列exchangeは同時受理され共通の小要求上限枠を共有する"
// oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md#V7共有extensionの容量分類" }
// fault = "小要求をglobal1件で拒否するか共通枠を迂回して上限を超える"
// observable = "実HTTPの5同時dispatchと全成功、6件目のAgentRuntimeExchangeError(dispatched=false)、解放後の成功"
// observation_boundary = "public-boundary"
// scope = "HTTP runtime clientとextension admission（application routeは待機を制御するfixture）"
// lifecycle = "permanent"
// @end-test-value
/** 小さい Session 要求は既存の通常プールで五件並行し、満杯時は追加要求を送出せず、枠が戻れば成功する。 */
test("five small Session calls share the existing normal request pool", async () => {
  const gate = deferred(),
    arrived = deferred();
  let active = 0,
    peak = 0;
  const runtime = await fixture(
    async (request) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 5) arrived.resolve();
      await gate.promise;
      active--;
      return { status: 200, value: { ok: true, path: request.path } };
    },
    { maxConcurrentRequests: 5 },
  );
  const paths = [
    "/v1/session/get",
    "/v1/session/get-catalog",
    "/v1/session/get-selection-policy",
    "/v1/session/get-provider-quota",
    "/v1/session/get-worktree-policy",
  ];
  const calls = paths.map((path) => runtime.call(path));
  const results = Promise.all(calls);
  try {
    await Promise.race([arrived.promise, results]);
    assert.equal(peak, 5);
    await assert.rejects(
      runtime.call("/v1/session/self"),
      (error) =>
        error instanceof AgentRuntimeExchangeError &&
        error.dispatched === false,
    );
    gate.resolve();
    assert.deepEqual(
      (await results).map((result) => result.status),
      [200, 200, 200, 200, 200],
    );
    assert.equal((await runtime.call("/v1/session/self")).status, 200);
  } finally {
    gate.resolve();
    await Promise.allSettled(calls);
    await runtime.server.stop();
  }
});

// @test-value v2
// kind = "security"
// claim = "大/長さ不明要求と小Glossary dispatchは同じ1枠を保持し小Session読取を不必要に拒否しない"
// oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md#V7共有extensionの容量分類" }
// fault = "小Glossaryを多重dispatchする、大要求の1枠を倍増する、または小Sessionへ大枠を要求する"
// observable = "Glossary保持中と不明長要求保持中の大要求exchange例外、Glossary要求の429拒否、small Session成功と解放後のGlossary成功"
// observation_boundary = "public-boundary"
// scope = "authenticated extensionのsmall/large容量とGlossary dispatch admission"
// lifecycle = "permanent"
// @end-test-value
/** Glossary・大きい本文・長さ不明の本文が同じ一枠を共有し、占有中でも通常の小さい Session 要求は通る。 */
test("Glossary and large or unknown bodies retain their single shared slot", async () => {
  let gate = deferred(),
    entered = deferred();
  const runtime = await fixture(
    async (request) => {
      if (request.path !== "/v1/session/self") {
        entered.resolve();
        await gate.promise;
      }
      return { status: 200, value: { ok: true } };
    },
    { maxBodyBytes: 1024 },
  );
  let held: Promise<unknown> | undefined;
  try {
    held = runtime.call("/v1/glossary/list");
    await entered.promise;
    assert.equal((await runtime.call("/v1/glossary/get")).status, 429);
    await assert.rejects(
      runtime.call("/v1/session/get", { padding: "x".repeat(2000) }),
      AgentRuntimeExchangeError,
    );
    assert.equal((await runtime.call("/v1/session/self")).status, 200);
    gate.resolve();
    await held;
    gate = deferred();
    entered = deferred();
    held = rawCall(runtime.connection, "/v1/session/get", "unknown-length");
    await entered.promise;
    await assert.rejects(
      runtime.call("/v1/session/get", { padding: "x".repeat(2000) }),
      AgentRuntimeExchangeError,
    );
    assert.equal((await runtime.call("/v1/glossary/get")).status, 429);
    assert.equal((await runtime.call("/v1/session/self")).status, 200);
    gate.resolve();
    await held;
    assert.equal((await runtime.call("/v1/glossary/get")).status, 200);
  } finally {
    gate.resolve();
    await held?.catch(() => {});
    await runtime.server.stop();
  }
});

// @test-value v2
// kind = "security"
// claim = "容量宣言は認可を与えず不正bodyをdispatch前に拒否しsmall/large受信途中切断の枠も解放する"
// oracle = { type = "contract", ref = "docs/adr/022-repository-glossary-boundary.md#V7共有extensionの容量分類" }
// fault = "小length宣言から大payloadへ昇格、容量分類を認証として扱う、または受信切断で枠を漏らす"
// observable = "偽length400/容量超過413/誤認証401とdispatch0、small/large途中切断後同listenerのstatus確認を経たsmall/Glossary正常受理"
// observation_boundary = "public-boundary"
// scope = "HTTP実受信cap・認証境界・small/large受信枠のlifetime"
// lifecycle = "permanent"
// @end-test-value
/** 不正な長さ、上限超過、不正資格情報は処理へ渡さず、途中切断した受信枠を後続要求で再利用できることを確認する。 */
test("declared lengths never bypass body caps or runtime credentials", async () => {
  let dispatches = 0;
  const runtime = await fixture(
    async () => {
      dispatches++;
      return { status: 200, value: { ok: true } };
    },
    { maxBodyBytes: 1024, maxConcurrentRequests: 1 },
  );
  try {
    const forged = await rawCall(
      runtime.connection,
      "/v1/session/self",
      "x".repeat(2000),
      64,
    );
    assert.equal(forged.status, 400);
    const oversized = await rawCall(
      runtime.connection,
      "/v1/session/self",
      "x".repeat(WITHMATE_AGENT_RUNTIME_EXTENSION_MAX_BODY_BYTES + 1),
    );
    assert.equal(oversized.status, 413);
    assert.equal(
      (oversized.value as { code: string }).code,
      "RUNTIME_REQUEST_TOO_LARGE",
    );
    const denied = await callAgentRuntime(
      {
        ...runtime.connection,
        credential: { adapter: "mcp", adapterSecret: "wrong" },
      },
      { method: "POST", path: "/v1/session/self", body: {} },
      {
        signal: AbortSignal.timeout(5000),
        exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
      },
    );
    assert.equal(denied.status, 401);
    assert.equal(dispatches, 0);
    for (const length of [512, null]) {
      const before: number = dispatches;
      await new Promise<void>((resolve, reject) => {
        let challenged = false,
          partialFlushed = false;
        let failure: Error | undefined;
        const nonce = "disconnect-capacity-test";
        const request = httpRequest(
          new URL(
            WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
            runtime.connection.api.baseUrl,
          ),
          {
            method: "POST",
            signal: AbortSignal.timeout(5000),
            headers: {
              "content-type": "application/json",
              [WITHMATE_AGENT_RUNTIME_NONCE_HEADER]: nonce,
              [WITHMATE_AGENT_RUNTIME_GENERATION_HEADER]:
                runtime.connection.api.runtimeGenerationId,
              [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER]:
                runtime.connection.api.applicationInstanceId,
              ...(length === null ? {} : { "content-length": length }),
            },
          },
          (response) => {
            response.on("error", () => {});
            response.resume();
          },
        );
        request.on("error", (error) => {
          failure = error;
        });
        request.on("close", () => {
          if (!challenged || !partialFlushed)
            reject(
              failure ??
                new Error(
                  "The partial request did not reach its admitted receive phase.",
                ),
            );
          else resolve();
        });
        request.on("information", (information) => {
          if (information.statusCode !== 103) return;
          try {
            assert.equal(
              information.headers[WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER],
              createAgentRuntimeChallenge(
                runtime.connection.api.apiSecret,
                runtime.connection.api.runtimeGenerationId,
                nonce,
              ),
            );
          } catch (error) {
            request.destroy(error as Error);
            return;
          }
          challenged = true;
          request.write('{"schemaVersion":', (error) => {
            if (error) {
              request.destroy(error);
              return;
            }
            partialFlushed = true;
            request.destroy();
          });
        });
        request.flushHeaders();
      });
      assert.equal(dispatches, before);
      // 実クライアントは、この同じリスナーで先に状態の事前確認を完了する。
      assert.equal((await runtime.call("/v1/session/self")).status, 200);
      assert.equal((await runtime.call("/v1/glossary/get")).status, 200);
      assert.equal(dispatches, before + 2);
    }
  } finally {
    await runtime.server.stop();
  }
});

// @test-value v2
// kind = "security"
// claim = "extension clientはUTF-8 body長だけを先送りしowner challenge確認前にcredential/本文を送らない"
// oracle = { type = "contract", ref = "docs/adr/023-multi-instance-runtime-discovery.md; docs/adr/022-repository-glossary-boundary.md#V7共有extensionの容量分類" }
// fault = "Content-Length追加に伴いflushHeaders時にsecret bodyを送信するか偽peerを信用する"
// observable = "実HTTPの宣言byte長、正generation/誤HMACの103に対するcredential-unavailable拒否、受信body0とcredential header不在"
// observation_boundary = "public-boundary"
// scope = "共通runtime clientの103 mutual-owner exchange"
// lifecycle = "permanent"
// @end-test-value
/** クライアントは UTF-8 の本文長だけを先に宣言し、所有者確認が失敗した相手には本文も認証情報も渡さないことを確認する。 */
test("extension length metadata precedes only the verified owner body", async () => {
  let declared = 0,
    received = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      const nonce = new URL(request.url!, "http://localhost").searchParams.get(
        "nonce",
      )!;
      response.end(
        JSON.stringify({
          applicationInstanceId,
          runtimeGenerationId: generation,
          challenge: {
            nonce,
            ownerHmacSha256: createAgentRuntimeOwnerChallenge(
              apiSecret,
              applicationInstanceId,
              generation,
              nonce,
            ),
          },
        }),
      );
      return;
    }
    declared = Number(request.headers["content-length"]);
    assert.equal(
      request.headers["x-withmate-agent-runtime-api-secret"],
      undefined,
    );
    assert.equal(
      request.headers["x-withmate-agent-runtime-cli-api-secret"],
      undefined,
    );
    request.on("data", (chunk) => {
      received += chunk.length;
    });
    response.writeEarlyHints({
      link: `<${WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH}>; rel=preconnect`,
      [WITHMATE_AGENT_RUNTIME_GENERATION_HEADER]: generation,
      [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_HEADER]:
        applicationInstanceId,
      [WITHMATE_AGENT_RUNTIME_CHALLENGE_HEADER]: "forged",
    });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const connection: AgentRuntimeConnection = {
    api: {
      baseUrl: `http://127.0.0.1:${port}`,
      apiSecret,
      runtimeGenerationId: generation,
      applicationInstanceId,
    },
    credential: { adapter: "mcp", adapterSecret },
  };
  try {
    await assert.rejects(
      callAgentRuntime(
        connection,
        { method: "POST", path: "/v1/session/self", body: { label: "日本語" } },
        {
          signal: AbortSignal.timeout(5000),
          exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
        },
      ),
      (error) =>
        error instanceof AgentRuntimeExchangeError &&
        error.dispatched === false &&
        error.discoveryCode === "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE",
    );
    const payload = JSON.stringify({
      schemaVersion: "withmate-agent-runtime-exchange-v1",
      apiSecret,
      adapter: "mcp",
      adapterSecret,
      operation: {
        method: "POST",
        path: "/v1/session/self",
        body: { label: "日本語" },
      },
    });
    assert.equal(declared, Buffer.byteLength(payload, "utf8"));
    assert.equal(received, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
