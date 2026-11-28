import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION,
  AGENT_RUNTIME_KIND,
  resolveAgentRuntimeApi,
} from "../../src-electron/platform/agent-runtime/runtime-client.js";
import { createAgentRuntimeOwnerChallenge } from "../../src-electron/platform/agent-runtime/runtime-exchange.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  publishRuntimeDiscoveryEntry,
  type RuntimeDiscoveryRegistryPublication,
} from "../../src-electron/platform/runtime-discovery/runtime-discovery-registry.js";
import {
  WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV,
} from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";

const API_SECRET = "synthetic-discovery-api-secret";
const BASE_TIME = new Date("2026-11-01T00:00:00.000Z");
const EXPIRED_TIME = new Date(BASE_TIME.getTime() + 30_000);
/** 候補間で重複しないアプリインスタンスIDとランタイム世代IDを作る。 */
const identity = () => ({
  applicationInstanceId: randomUUID(),
  runtimeGenerationId: randomUUID(),
});

/** ケース専用の公開レジストリを用意し、候補の追加と後片付けを管理する。 */
async function registryFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "withmate-agent-discovery-"));
  const publications: RuntimeDiscoveryRegistryPublication[] = [];
  /** 公開済み候補を解除し、解除が失敗しても一時レジストリを削除する。 */
  t.after(async () => {
    try {
      for (const publication of publications) await publication.unpublish();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    /** 固定時刻と候補ごとに固有のアドレスで、CLI credential付き候補をレジストリに登録する。 */
    async publish(owner = identity()) {
      const baseUrl = `http://127.0.0.1:${39001 + publications.length}`;
      const publication = await publishRuntimeDiscoveryEntry({
        rootDirectoryPath: root,
        /** fixtureでは外部のセキュリティ初期化を行わない。 */
        security: async () => {},
        identity: { ...owner, runtimeKind: AGENT_RUNTIME_KIND },
        buildChannel: "development",
        process: { pid: process.pid, startedAt: BASE_TIME.toISOString() },
        clock: {
          /** 公開時刻を固定し、探索時の時刻でfreshとexpiredを切り替えられるようにする。 */
          now: () => BASE_TIME,
        },
        /** 公開時に既存候補の応答へ依存しないfixtureにする。 */
        challenge: async () => false,
        credentialDocuments: [
          {
            adapterKind: "cli",
            document: {
              schemaVersion: "withmate-runtime-credential-v1",
              ...owner,
              runtimeKind: AGENT_RUNTIME_KIND,
              adapterKind: "cli",
              credential: {
                schemaVersion: AGENT_RUNTIME_DISCOVERY_SCHEMA_VERSION,
                ...owner,
                adapter: "cli",
                baseUrl,
                apiSecret: API_SECRET,
                adapterSecret: "synthetic-discovery-cli-secret",
              },
            },
          },
        ],
      });
      publications.push(publication);
      return { ...owner, baseUrl, publication };
    },
  };
}

// @test-value v2
// kind = "security"
// claim = "共有registryのfreshな複数候補はcredential欠損を含めてambiguousになり、唯一の候補でもcredential欠損なら選択しない"
// oracle = { type = "adr", ref = "docs/adr/023-multi-instance-runtime-discovery.md: credential欠損を含むactive集合と選択; docs/adr/036-memory-affect-removal.md: 共有runtime維持" }
// fault = "credential欠損entryを候補から除外して他instanceを暗黙選択するか、利用可能credentialなしで選択する"
// observable = "resolveAgentRuntimeApiのerror codeとactive候補のapplication/generation identity集合"
// observation_boundary = "public-boundary"
// scope = "agent-runtime canonical registryのunbound候補選択（synthetic file fixture、実通信なし）"
// lifecycle = "permanent"
// distinction = "registry列挙testと異なりresolverの候補集合・選択判定を実行する"
// risk_tags = ["authorization"]
// @end-test-value
/** 新しい候補はcredentialを欠いても候補集合に残し、曖昧なときに別候補を選ばないことを確認する。 */
test("fresh候補はcredential欠損でも選択集合に残してfail-closedにする", async (t) => {
  for (const scenario of [
    { count: 2, missingCredential: false, code: "runtime_ambiguous" },
    { count: 2, missingCredential: true, code: "runtime_ambiguous" },
    {
      count: 1,
      missingCredential: true,
      code: "runtime_credential_unavailable",
    },
  ] as const) {
    const fixture = await registryFixture(t);
    const owners = [];
    for (let index = 0; index < scenario.count; index++)
      owners.push(await fixture.publish());
    if (scenario.missingCredential) {
      const snapshot = await listRuntimeDiscoveryRegistryEntries(fixture.root);
      const missing = owners.at(-1)!;
      const record = snapshot.records.find(
        (entry) =>
          entry.entry.applicationInstanceId === missing.applicationInstanceId,
      );
      assert.ok(record);
      const credential = record.entry.adapters.find(
        (adapter) => adapter.adapterKind === "cli",
      );
      assert.ok(credential);
      await rm(
        path.join(record.slotDirectoryPath, credential.credentialFileName),
      );
    }
    const result = await resolveAgentRuntimeApi({
      adapter: "cli",
      env: {},
      registryRootDirectoryPath: fixture.root,
      clock: {
        /** 公開時と同じ時刻を使い、期限内の探索を再現する。 */
        now: () => BASE_TIME,
      },
      /** fresh候補の判定中に通信を試みた場合は直ちに失敗させる。 */
      fetch: async () => {
        throw new Error("fresh candidate discovery must not challenge");
      },
    });
    assert.equal(result.kind, "error", JSON.stringify(scenario));
    if (result.kind !== "error")
      throw new Error("Expected discovery rejection");
    assert.equal(result.code, scenario.code);
    assert.deepEqual(
      result.candidates
        .filter((candidate) => candidate.active)
        .map(
          (candidate) =>
            `${candidate.applicationInstanceId}/${candidate.runtimeGenerationId}`,
        )
        .sort(),
      owners
        .map(
          (owner) =>
            `${owner.applicationInstanceId}/${owner.runtimeGenerationId}`,
        )
        .sort(),
    );
  }
});

// @test-value v2
// kind = "security"
// claim = "bound resolverはenvのapplication/generationへ固定し、別instance・旧generation・selector欠落でoperator選択へdowngradeしない"
// oracle = { type = "adr", ref = "docs/adr/023-multi-instance-runtime-discovery.md: binding-required exact selection; docs/adr/036-memory-affect-removal.md: 共有認可維持" }
// fault = "bound owner不在や旧generationで別ownerへrebindするか、selector欠落をunboundとして受理する"
// observable = "resolverのinstance mismatch・generation changed・selector invalid codeとchallenge呼出数0"
// observation_boundary = "public-boundary"
// scope = "agent-runtime binding-required registry解決（operation dispatchは実行しない）"
// lifecycle = "permanent"
// distinction = "発行済みtokenの失効testではなく、接続先選択前のenv selectorを確認する"
// risk_tags = ["authorization"]
// @end-test-value
/** bindingの識別子が未指定または不一致の場合、CLI引数や別候補への通信で補わないことを確認する。 */
test("bound selectorの不一致と欠落は別ownerへfallbackしない", async (t) => {
  const fixture = await registryFixture(t);
  const current = await fixture.publish();
  for (const scenario of [
    {
      application: randomUUID(),
      generation: randomUUID(),
      code: "runtime_instance_mismatch",
    },
    {
      application: current.applicationInstanceId,
      generation: randomUUID(),
      code: "runtime_generation_changed",
    },
    {
      application: undefined,
      generation: undefined,
      code: "runtime_selector_invalid",
    },
    {
      application: current.applicationInstanceId,
      generation: undefined,
      code: "runtime_selector_invalid",
    },
    {
      application: undefined,
      generation: current.runtimeGenerationId,
      code: "runtime_selector_invalid",
    },
  ] as const) {
    let challenges = 0;
    const result = await resolveAgentRuntimeApi({
      adapter: "cli",
      registryRootDirectoryPath: fixture.root,
      clock: {
        /** bindingが不正なら、期限切れでも先にowner照会へ進まないことを確かめる。 */
        now: () => EXPIRED_TIME,
      },
      env: {
        [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
        [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV]:
          scenario.application,
        [WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV]: scenario.generation,
      },
      // CLI オプションでは、環境変数から取得した binding の識別情報を上書きできない。
      applicationInstanceId: current.applicationInstanceId,
      runtimeGenerationId: current.runtimeGenerationId,
      /** binding不一致時の想定外の問合せを記録し、テストでゼロ件を確認できるようにする。 */
      fetch: async () => {
        challenges++;
        throw new Error("must not challenge a different owner");
      },
    });
    assert.equal(result.kind, "error", JSON.stringify(scenario));
    if (result.kind !== "error")
      throw new Error("Expected bound discovery rejection");
    assert.equal(result.code, scenario.code);
    assert.equal(challenges, 0);
  }
});

// @test-value v2
// kind = "security"
// claim = "expired leaseは指定instanceだけをowner challengeし、成功なら同ownerを選択、失敗ならstaleとし非対象instanceへchallengeしない"
// oracle = { type = "adr", ref = "docs/adr/023-multi-instance-runtime-discovery.md: leaseと明示selector; docs/adr/036-memory-affect-removal.md: instance/generation照合維持" }
// fault = "非対象ownerへchallengeするか、lease期限だけで接続を拒否するか、失敗したchallengeをactiveにする"
// observable = "challenge先URL集合、選択されたapplication/generation、stale codeと候補active値"
// observation_boundary = "public-boundary"
// scope = "canonical registry expired候補の選択とowner HMAC判定（fetch応答のみ注入）"
// lifecycle = "permanent"
// distinction = "単一正常ownerのhost testでは区別できないselector外通信と期限切れ候補の再判定を扱う"
// risk_tags = ["authorization"]
// @end-test-value
/** 期限切れ候補のうちselectorに合う一件だけを照会し、応答の検証成功時だけactiveにする。 */
test("expired候補はselector内だけをchallengeし結果からactiveを判定する", async (t) => {
  const fixture = await registryFixture(t);
  const selected = await fixture.publish();
  const other = await fixture.publish();
  for (const succeeds of [false, true]) {
    const challenged: string[] = [];
    const result = await resolveAgentRuntimeApi({
      adapter: "cli",
      env: {},
      registryRootDirectoryPath: fixture.root,
      clock: {
        /** 選択した候補に生存確認が必要になる時刻を返す。 */
        now: () => EXPIRED_TIME,
      },
      applicationInstanceId: selected.applicationInstanceId,
      /** 照会先を記録し、ケースの条件に従って検証に成功または失敗する応答を返す。 */
      fetch: async (input) => {
        const url = new URL(String(input));
        challenged.push(url.origin);
        const nonce = url.searchParams.get("nonce")!;
        return new Response(
          JSON.stringify({
            applicationInstanceId: selected.applicationInstanceId,
            runtimeGenerationId: selected.runtimeGenerationId,
            challenge: {
              nonce,
              ownerHmacSha256: succeeds
                ? createAgentRuntimeOwnerChallenge(
                    API_SECRET,
                    selected.applicationInstanceId,
                    selected.runtimeGenerationId,
                    nonce,
                  )
                : "invalid-owner-challenge",
            },
          }),
          { status: 200 },
        );
      },
    });
    assert.notEqual(selected.baseUrl, other.baseUrl);
    assert.deepEqual(challenged, [selected.baseUrl]);
    if (succeeds) {
      assert.equal(result.kind, "selected");
      if (result.kind !== "selected")
        throw new Error("Expected challenged owner selection");
      assert.equal(
        result.candidate.applicationInstanceId,
        selected.applicationInstanceId,
      );
      assert.equal(
        result.candidate.runtimeGenerationId,
        selected.runtimeGenerationId,
      );
      assert.equal(result.candidate.leaseState, "expired");
      assert.equal(result.candidate.active, true);
    } else {
      assert.equal(result.kind, "error");
      if (result.kind !== "error")
        throw new Error("Expected stale discovery rejection");
      assert.equal(result.code, "runtime_stale");
      assert.deepEqual(
        result.candidates.map((candidate) => candidate.active),
        [false],
      );
    }
  }
});
