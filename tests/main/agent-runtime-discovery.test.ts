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
const identity = () => ({ applicationInstanceId: randomUUID(), runtimeGenerationId: randomUUID() });

async function registryFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "withmate-agent-discovery-"));
  const publications: RuntimeDiscoveryRegistryPublication[] = [];
  t.after(async () => {
    try {
      for (const publication of publications) await publication.unpublish();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    async publish(owner = identity()) {
      const baseUrl = `http://127.0.0.1:${39001 + publications.length}`;
      const publication = await publishRuntimeDiscoveryEntry({
        rootDirectoryPath: root,
        security: async () => {},
        identity: { ...owner, runtimeKind: AGENT_RUNTIME_KIND },
        buildChannel: "development",
        process: { pid: process.pid, startedAt: BASE_TIME.toISOString() },
        clock: { now: () => BASE_TIME },
        challenge: async () => false,
        credentialDocuments: [{
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
        }],
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
test("fresh候補はcredential欠損でも選択集合に残してfail-closedにする", async (t) => {
  for (const scenario of [
    { count: 2, missingCredential: false, code: "runtime_ambiguous" },
    { count: 2, missingCredential: true, code: "runtime_ambiguous" },
    { count: 1, missingCredential: true, code: "runtime_credential_unavailable" },
  ] as const) {
    const fixture = await registryFixture(t);
    const owners = [];
    for (let index = 0; index < scenario.count; index++) owners.push(await fixture.publish());
    if (scenario.missingCredential) {
      const snapshot = await listRuntimeDiscoveryRegistryEntries(fixture.root);
      const missing = owners.at(-1)!;
      const record = snapshot.records.find((entry) => entry.entry.applicationInstanceId === missing.applicationInstanceId);
      assert.ok(record);
      const credential = record.entry.adapters.find((adapter) => adapter.adapterKind === "cli");
      assert.ok(credential);
      await rm(path.join(record.slotDirectoryPath, credential.credentialFileName));
    }
    const result = await resolveAgentRuntimeApi({
      adapter: "cli", env: {}, registryRootDirectoryPath: fixture.root, clock: { now: () => BASE_TIME },
      fetch: async () => { throw new Error("fresh candidate discovery must not challenge"); },
    });
    assert.equal(result.kind, "error", JSON.stringify(scenario));
    if (result.kind !== "error") throw new Error("Expected discovery rejection");
    assert.equal(result.code, scenario.code);
    assert.deepEqual(
      result.candidates.filter((candidate) => candidate.active)
        .map((candidate) => `${candidate.applicationInstanceId}/${candidate.runtimeGenerationId}`).sort(),
      owners.map((owner) => `${owner.applicationInstanceId}/${owner.runtimeGenerationId}`).sort(),
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
test("bound selectorの不一致と欠落は別ownerへfallbackしない", async (t) => {
  const fixture = await registryFixture(t);
  const current = await fixture.publish();
  for (const scenario of [
    { application: randomUUID(), generation: randomUUID(), code: "runtime_instance_mismatch" },
    { application: current.applicationInstanceId, generation: randomUUID(), code: "runtime_generation_changed" },
    { application: undefined, generation: undefined, code: "runtime_selector_invalid" },
    { application: current.applicationInstanceId, generation: undefined, code: "runtime_selector_invalid" },
    { application: undefined, generation: current.runtimeGenerationId, code: "runtime_selector_invalid" },
  ] as const) {
    let challenges = 0;
    const result = await resolveAgentRuntimeApi({
      adapter: "cli", registryRootDirectoryPath: fixture.root, clock: { now: () => EXPIRED_TIME },
      env: {
        [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1",
        [WITHMATE_AGENT_RUNTIME_APPLICATION_INSTANCE_ID_ENV]: scenario.application,
        [WITHMATE_AGENT_RUNTIME_GENERATION_ID_ENV]: scenario.generation,
      },
      // CLI options cannot override the captured bound env identity.
      applicationInstanceId: current.applicationInstanceId,
      runtimeGenerationId: current.runtimeGenerationId,
      fetch: async () => { challenges++; throw new Error("must not challenge a different owner"); },
    });
    assert.equal(result.kind, "error", JSON.stringify(scenario));
    if (result.kind !== "error") throw new Error("Expected bound discovery rejection");
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
test("expired候補はselector内だけをchallengeし結果からactiveを判定する", async (t) => {
  const fixture = await registryFixture(t);
  const selected = await fixture.publish();
  const other = await fixture.publish();
  for (const succeeds of [false, true]) {
    const challenged: string[] = [];
    const result = await resolveAgentRuntimeApi({
      adapter: "cli", env: {}, registryRootDirectoryPath: fixture.root, clock: { now: () => EXPIRED_TIME },
      applicationInstanceId: selected.applicationInstanceId,
      fetch: async (input) => {
        const url = new URL(String(input));
        challenged.push(url.origin);
        const nonce = url.searchParams.get("nonce")!;
        return new Response(JSON.stringify({
          applicationInstanceId: selected.applicationInstanceId,
          runtimeGenerationId: selected.runtimeGenerationId,
          challenge: {
            nonce,
            ownerHmacSha256: succeeds ? createAgentRuntimeOwnerChallenge(
              API_SECRET, selected.applicationInstanceId, selected.runtimeGenerationId, nonce,
            ) : "invalid-owner-challenge",
          },
        }), { status: 200 });
      },
    });
    assert.notEqual(selected.baseUrl, other.baseUrl);
    assert.deepEqual(challenged, [selected.baseUrl]);
    if (succeeds) {
      assert.equal(result.kind, "selected");
      if (result.kind !== "selected") throw new Error("Expected challenged owner selection");
      assert.equal(result.candidate.applicationInstanceId, selected.applicationInstanceId);
      assert.equal(result.candidate.runtimeGenerationId, selected.runtimeGenerationId);
      assert.equal(result.candidate.leaseState, "expired");
      assert.equal(result.candidate.active, true);
    } else {
      assert.equal(result.kind, "error");
      if (result.kind !== "error") throw new Error("Expected stale discovery rejection");
      assert.equal(result.code, "runtime_stale");
      assert.deepEqual(result.candidates.map((candidate) => candidate.active), [false]);
    }
  }
});
