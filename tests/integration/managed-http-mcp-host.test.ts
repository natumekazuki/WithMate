import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AgentRuntimeBindingRegistry,
  type ProviderAgentRuntimeBindingProjection,
} from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import {
  GlossaryApplicationService,
  projectGlossaryCheckoutAuthority,
} from "../../src-electron/glossary/glossary-application-service.js";
import { GlossaryRuntimeService } from "../../src-electron/glossary/glossary-runtime-service.js";
import { getGlossaryAgentRuntimeOperations } from "../../src-shared/glossary/glossary-operation-schema.js";
import { GLOSSARY_MCP_TOOL_DEFINITIONS } from "../../src-electron/platform/mcp/withmate-glossary-mcp.js";
import { WITHMATE_MANAGED_MCP_TOKEN_HEADER } from "../../src-electron/providers/managed-http-mcp.js";
import { startAgentRuntimeApi } from "../../src-electron/platform/agent-runtime/runtime-api.js";

/** 一時 checkout と実 HTTP リスナーを立て、turn 発行から Glossary の保存までを同じ runtime に接続する。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-managed-http-"));
  await promisify(execFile)(
    "git",
    ["init", "--quiet", "--initial-branch=main", directory],
    { windowsHide: true },
  );
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const glossaryApplication = new GlossaryApplicationService();
  const checkout = await glossaryApplication.resolvePrimaryCheckout(directory);
  const glossary = new GlossaryRuntimeService({
    applicationService: glossaryApplication,
    bindingRegistry: bindings,
    providerAgentRuntimeTurns: turns,
    /** テスト上の各 actor を同じ一時 checkout に向け、turn の主体だけを分ける。 */
    resolveActorSession: (id) => ({
      id,
      providerId: "codex",
      characterId: "character",
      workspacePath: directory,
    }),
    /** 能動作成枠を 1 件に固定する。保存を試すケースでは明示作成を使う。 */
    getProactiveCreateLimit: () => 1,
  });
  const runtime = await startAgentRuntimeApi({
    applicationInstanceId: "11111111-1111-4111-8111-111111111111",
    buildChannel: "development",
    registryDirectoryPath: join(directory, "runtime-registry"),
    /** テスト用の一時ディレクトリでは runtime パスの検証を省く。 */
    runtimePathSecurity: async () => {},
    agentRuntimeBindingRegistry: bindings,
    providerAgentRuntimeTurns: turns,
    /** HTTP リスナーから届いた拡張操作を Glossary の実サービスへ渡す。 */
    routeAgentRuntimeExtension: (request) => glossary.route(request),
  });
  const owner = {
    applicationInstanceId: runtime.applicationInstanceId,
    runtimeGenerationId: runtime.runtimeGenerationId,
  };
  const host = runtime.managedMcp;
  const clients: Client[] = [];
  /** 指定 actor の binding を使って新しい turn を開始し、その handle に紐づく HTTP 認証情報を発行する。 */
  async function begin(actorSessionId = "actor-a", signal?: AbortSignal) {
    const projection = bindings.issueOrReuse({
      actorSessionId,
      providerId: "codex",
      operationGrants: getGlossaryAgentRuntimeOperations(),
      authoritySnapshot: {
        userId: "local-user",
        characterId: "character",
        allowedProjectIds: [],
        glossaryPrimaryCheckout: projectGlossaryCheckoutAuthority(checkout),
      },
    });
    const turn = await glossary.beginProviderTurn(actorSessionId, {
      ...projection,
      runtimeOwner: owner,
    });
    const managedMcp = host.issue(turn.binding, turn.handle, signal);
    return { ...turn, binding: { ...turn.binding, managedMcp } };
  }
  /** turn の URL と token で実 MCP クライアントを接続し、終了時に閉じる対象として保持する。 */
  async function connect(binding: ProviderAgentRuntimeBindingProjection) {
    const client = new Client({ name: "http-integration", version: "1" });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(binding.managedMcp!.glossaryUrl),
      {
        requestInit: {
          headers: {
            [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: binding.managedMcp!.token,
          },
        },
      },
    );
    await client.connect(transport);
    return { client, transport };
  }
  return {
    begin,
    connect,
    host,
    bindings,
    directory,
    glossary,
    owner,
    /** クライアントとリスナーを先に閉じてから、runtime と一時 checkout を片付ける。 */
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await host.stop();
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "共有HTTP入口はcanonical Glossary tool一覧とread・create・再接続を同じturnに保ち、checkoutへ保存する"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "HTTPのtool一覧が変わる、readやmutationが届かない、または再接続でturn credentialが変わる"
// observable = "Glossary SDK tools list・read/create結果、保存済みYAML、再接続後のread結果と同turn token"
// observation_boundary = "public-boundary"
// scope = "実HTTP MCP SDKからruntime challenge・Glossary filesystem保存・再接続まで"
// lifecycle = "permanent"
// impact = "provider変更でGlossary機能やSession識別が欠けると利用者データを誤保存する"
// distinction = "stdio testと型検査は共有HTTP listener・protocol・実保存の接続を通らない。モデル不要の小さいfixtureで確認する"
// @end-test-value
/** 公開ツール一覧と checkout への書き込みを確認し、プロトコルセッションを張り直しても同じ turn を使えることを確かめる。 */
test("shared HTTP MCP preserves canonical glossary tools and actor-bound operations", async () => {
  const f = await fixture();
  try {
    const turn = await f.begin();
    const glossary = await f.connect(turn.binding);
    assert.deepEqual(
      (await glossary.client.listTools()).tools.map((tool) => tool.name).sort(),
      GLOSSARY_MCP_TOOL_DEFINITIONS.map((tool) => tool.name).sort(),
    );
    assert.notEqual(
      (
        await glossary.client.callTool({
          name: "glossary.list_targets",
          arguments: {},
        })
      ).isError,
      true,
    );
    const created = await glossary.client.callTool({
      name: "glossary.create",
      arguments: {
        selector: { kind: "primary" },
        mode: "explicit",
        entry: { term: "Captured", definition: "Actor-bound HTTP" },
      },
    });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.match(
      await readFile(join(f.directory, ".withmate", "glossary.yaml"), "utf8"),
      /Captured/,
    );
    const before = turn.binding.managedMcp!.token;
    await glossary.transport.terminateSession();
    const reconnected = await f.connect(turn.binding);
    assert.notEqual(
      (
        await reconnected.client.callTool({
          name: "glossary.list_targets",
          arguments: {},
        })
      ).isError,
      true,
    );
    assert.equal(f.host.issue(turn.binding, turn.handle).token, before);
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "security"
// claim = "MCP session IDは別actorの権限にならず、全HTTP methodはturn tokenを検証し、取消・旧turn cleanupは次turnに権限を渡さない"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "protocol session IDだけで認可する、GET・DELETEの認証を省く、またはold handle cleanupで次turnを失効する"
// observable = "HTTP statusと取消前後の共有state、新turn SDK read結果"
// observation_boundary = "public-boundary"
// scope = "shared listenerのtoken・MCP session分離とexact turn終了"
// lifecycle = "permanent"
// impact = "終了済み・別actorのproviderが現turnの操作を実行するか正常な次turnが誤拒否される"
// distinction = "coordinator単体testはHTTP header認証とprotocol session選択の組合せを通らない"
// @end-test-value
/** HTTP のセッション識別子だけでは認可されず、旧 turn の取り消しと後処理が次の turn を失効させないことを確認する。 */
test("HTTP session selectors never replace captured turn credentials", async () => {
  const f = await fixture();
  try {
    const cancel = new AbortController();
    const old = await f.begin("actor-a", cancel.signal);
    const other = await f.begin("actor-b");
    const memory = await f.connect(old.binding);
    const url = old.binding.managedMcp!.glossaryUrl;
    for (const method of ["GET", "DELETE", "POST"]) {
      assert.equal(
        (
          await fetch(url, {
            method,
            headers: { "mcp-session-id": memory.transport.sessionId! },
          })
        ).status,
        401,
      );
    }
    const cross = await fetch(url, {
      method: "DELETE",
      headers: {
        "mcp-session-id": memory.transport.sessionId!,
        [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: other.binding.managedMcp!.token,
      },
    });
    assert.equal(cross.status, 404);
    assert.equal(
      (
        await fetch(url, {
          method: "GET",
          headers: {
            [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: old.binding.managedMcp!.token,
            origin: "http://localhost",
          },
        })
      ).status,
      403,
    );
    cancel.abort();
    assert.equal(
      Atomics.load(new Int32Array(old.handle.revocationState), 0),
      1,
    );
    const next = await f.begin();
    assert.notEqual(
      next.binding.managedMcp!.token,
      old.binding.managedMcp!.token,
    );
    f.host.release(old.handle);
    f.glossary.endProviderTurn(old.handle);
    assert.equal(
      (
        await fetch(url, {
          headers: {
            [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: old.binding.managedMcp!.token,
          },
        })
      ).status,
      401,
    );
    const live = await f.connect(next.binding);
    assert.notEqual(
      (
        await live.client.callTool({
          name: "glossary.list_targets",
          arguments: {},
        })
      ).isError,
      true,
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "security"
// claim = "HTTP credentialはownerとbinding generationに固定され、binding撤回とhost shutdownはqueued副作用に渡す共有turn stateも即時失効する"
// oracle = { type = "adr", ref = "docs/adr/027-shared-localhost-http-mcp-turn-identity.md" }
// fault = "owner違いでtokenを発行する、registry変更を見逃す、またはsocketだけ閉じてWorker側stateをactiveに残す"
// observable = "issue拒否・失効後HTTP status・共有stateと新generationのread結果"
// observation_boundary = "public-boundary"
// scope = "HTTP hostのcanonical registry subscriptionとruntime lifetime"
// lifecycle = "permanent"
// impact = "削除Session・reset前runtimeの遅延処理がDBまたはfileへ副作用を残す"
// distinction = "Worker testはstateを受ける側だけを検証する。本testはMain側lifecycleがそのstateを失効する結線を確認する"
// @end-test-value
/** 異なる runtime 世代への token 発行を拒否し、binding 撤回とホスト停止の双方で共有失効状態が更新されることを確認する。 */
test("binding revocation and host shutdown revoke the captured shared state", async () => {
  const f = await fixture();
  try {
    const old = await f.begin();
    assert.throws(() =>
      f.host.issue(
        {
          ...old.binding,
          runtimeOwner: {
            ...f.owner,
            runtimeGenerationId: "another-generation",
          },
        },
        old.handle,
      ),
    );
    f.bindings.revokeSession("actor-a");
    assert.equal(
      Atomics.load(new Int32Array(old.handle.revocationState), 0),
      1,
    );
    assert.equal(
      (
        await fetch(old.binding.managedMcp!.glossaryUrl, {
          headers: {
            [WITHMATE_MANAGED_MCP_TOKEN_HEADER]: old.binding.managedMcp!.token,
          },
        })
      ).status,
      401,
    );
    const next = await f.begin();
    const connected = await f.connect(next.binding);
    assert.notEqual(
      (
        await connected.client.callTool({
          name: "glossary.list_targets",
          arguments: {},
        })
      ).isError,
      true,
    );
    await f.host.stop();
    assert.equal(
      Atomics.load(new Int32Array(next.handle.revocationState), 0),
      1,
    );
    assert.throws(() => f.host.issue(next.binding, next.handle), /unavailable/);
  } finally {
    await f.close();
  }
});
