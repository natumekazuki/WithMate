import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildRuntimeDiscoveryCredentialFileName,
} from "../../src/runtime-discovery/runtime-discovery-contract.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV,
} from "../../src/agent-runtime/agent-runtime-binding-contract.js";
import {
  buildWithMateMemoryDiscoveryGenerationFileName,
  WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
} from "../../src/memory-v6/memory-discovery.js";
import {
  callWithMateMemoryRuntime,
  createMemoryRuntimeDiscoveryError,
  resolveWithMateMemoryApi,
  WithMateMemoryRuntimeExchangeError,
} from "../withmate-memory-runtime-client.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  publishRuntimeDiscoveryEntry,
  type RuntimeDiscoveryRegistryPublication,
} from "../../src/runtime-discovery/runtime-discovery-registry.js";

const API_SECRET = "test-api-secret-not-for-output";
const ADAPTER_SECRET = "test-adapter-secret-not-for-output";
const BASE_TIME = new Date();
const noSecurity = async () => {};
const unboundEnv = {
  ...process.env,
  [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "",
  [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV]: "",
  [WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV]: "",
};

function ids() {
  return { applicationInstanceId: randomUUID(), runtimeGenerationId: randomUUID() };
}

async function publishMemory(rootDirectoryPath: string, identity = ids(), baseUrl = "http://127.0.0.1:39001") {
  const publication = await publishRuntimeDiscoveryEntry({
    rootDirectoryPath,
    security: noSecurity,
    identity: { ...identity, runtimeKind: "memory" },
    buildChannel: "development",
    process: { pid: Math.floor(Math.random() * 20_000) + 1, startedAt: BASE_TIME.toISOString() },
    credentialDocuments: [{
      adapterKind: "cli",
      document: {
        schemaVersion: "withmate-runtime-credential-v1",
        applicationInstanceId: identity.applicationInstanceId,
        runtimeKind: "memory",
        adapterKind: "cli",
        runtimeGenerationId: identity.runtimeGenerationId,
        credential: {
          schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
          adapter: "cli",
          baseUrl,
          apiSecret: API_SECRET,
          adapterSecret: ADAPTER_SECRET,
          applicationInstanceId: identity.applicationInstanceId,
          runtimeGenerationId: identity.runtimeGenerationId,
          runtimeInstanceId: identity.runtimeGenerationId,
          buildChannel: "development",
          publishedAt: BASE_TIME.toISOString(),
        },
      },
    }],
    challenge: async () => false,
    clock: { now: () => new Date(BASE_TIME) },
  });
  return { publication, identity, baseUrl };
}

function statusFetch(applicationInstanceId: string, runtimeGenerationId: string, ok = true): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const nonce = new URL(url).searchParams.get("nonce") ?? "";
    const body = {
      runtimeInstanceId: runtimeGenerationId,
      runtimeGenerationId,
      applicationInstanceId,
      challenge: {
        nonce,
        hmacSha256: createHmac("sha256", API_SECRET).update(nonce, "utf8").digest("base64url"),
        ownerHmacSha256: createHmac("sha256", API_SECRET)
          .update(`${applicationInstanceId}\n${runtimeGenerationId}\n${nonce}`, "utf8")
          .digest("base64url"),
      },
    };
    return new Response(JSON.stringify(body), { status: ok ? 200 : 503 });
  }) as typeof fetch;
}

  // @test-value v1
  // kind = "invariant"
  // claim = "operator resolverは複数active候補から暗黙選択しない"
  // oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
  // failure_mode = "2件のactive runtimeがあるとき後発候補へ誤接続する"
  // scope = "memory-runtime-resolver"
  // lifecycle = "permanent"
  // @end-test-value
  it("2件のactive候補はlast-writer-winsせずambiguousになる", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wm-discovery-test-"));
    const a = await publishMemory(root);
    const b = await publishMemory(root);
    try {
      const result = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env: unboundEnv });
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "runtime_ambiguous");
    } finally { await a.publication.unpublish(); await b.publication.unpublish(); await rm(root, { recursive: true, force: true }); }
  });

// @test-value v1
// kind = "security"
// claim = "credentialを解決できないactive entryもunbound resolverの選択集合へ残り、active候補が複数ならambiguousになる"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "一方のcredential欠損を理由にactive候補を除外し、別instanceへ暗黙接続する"
// scope = "memory-runtime-resolver"
// lifecycle = "permanent"
// distinction = "両credentialが利用可能な通常の複数候補ではなく、一方のcredentialだけが解決不能なactive集合を扱う"
// @end-test-value
it("credential欠損のactive候補があっても別instanceを暗黙選択しない", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wm-discovery-test-"));
  const a = await publishMemory(root, ids(), "http://127.0.0.1:39001");
  const b = await publishMemory(root, ids(), "http://127.0.0.1:39002");
  try {
    const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
    const bRecord = snapshot.records.find((record) => (
      record.entry.applicationInstanceId === b.identity.applicationInstanceId
    ));
    assert.ok(bRecord);
    const credentialFileName = bRecord.entry.adapters.find(
      (adapter) => adapter.adapterKind === "cli",
    )?.credentialFileName;
    assert.ok(credentialFileName);
    await rm(path.join(bRecord.slotDirectoryPath, credentialFileName));

    const incompleteSnapshot = await listRuntimeDiscoveryRegistryEntries(root);
    assert.equal(incompleteSnapshot.records.length, 2);
    assert.equal(
      incompleteSnapshot.issues.some((issue) => (
        issue.slotName === bRecord.slotName && issue.code === "missing_credential"
      )),
      true,
    );

    const result = await resolveWithMateMemoryApi({
      adapter: "cli",
      registryRootDirectoryPath: root,
      legacyDiscoveryFilePath: path.join(root, "missing-legacy-pointer.json"),
      env: unboundEnv,
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.code, "runtime_ambiguous");
      assert.equal(result.candidates.filter((candidate) => candidate.active).length, 2);
    }
  } finally {
    await a.publication.unpublish();
    await b.publication.unpublish();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v1
// kind = "invariant"
// claim = "applicationInstanceId selectorはexpired候補のうち対象instanceだけをidentity challengeする"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "selector指定時に非対象instanceへchallenge通信する、または別instanceへ接続する"
// scope = "memory-runtime-resolver"
// lifecycle = "permanent"
// @end-test-value
it("--instance相当のselectorは指定候補だけをchallengeする", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wm-discovery-test-"));
  const a = await publishMemory(root, ids(), "http://127.0.0.1:39001");
  const b = await publishMemory(root, ids(), "http://127.0.0.1:39002");
  const challengedBaseUrls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    challengedBaseUrls.push(new URL(String(input)).origin);
    return statusFetch(a.identity.applicationInstanceId, a.identity.runtimeGenerationId)(input);
  }) as typeof fetch;
  try {
    const result = await resolveWithMateMemoryApi({
      adapter: "cli",
      registryRootDirectoryPath: root,
      legacyDiscoveryFilePath: path.join(root, "missing-legacy-pointer.json"),
      env: unboundEnv,
      applicationInstanceId: a.identity.applicationInstanceId,
      clock: { now: () => new Date(BASE_TIME.getTime() + 30_000) },
      fetch: fetchImpl,
    });
    assert.equal(result.kind, "selected");
    if (result.kind === "selected") {
      assert.equal(result.candidate.applicationInstanceId, a.identity.applicationInstanceId);
    }
    assert.deepEqual(challengedBaseUrls, [a.baseUrl]);
    assert.notEqual(a.baseUrl, b.baseUrl);
  } finally {
    await a.publication.unpublish();
    await b.publication.unpublish();
    await rm(root, { recursive: true, force: true });
  }
});

// @test-value v1
// kind = "security"
// claim = "binding-required resolverは別application instanceへfallbackしない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "bound Aが不在のときBへoperationをdispatchする"
// scope = "memory-runtime-binding"
// lifecycle = "permanent"
// @end-test-value
it("bound selector AはBのみactiveでもinstance mismatchでdispatchしない", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wm-discovery-test-"));
    const b = await publishMemory(root);
    try {
      const env = { [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1", [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV]: randomUUID(), [WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV]: randomUUID() };
      const result = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env });
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "runtime_instance_mismatch");
      const error = createMemoryRuntimeDiscoveryError(result as Extract<typeof result, { kind: "error" }>);
      assert.equal((error as { error: { code: string } }).error.code, "WITHMATE_RUNTIME_INSTANCE_MISMATCH");
      assert.ok(b.identity.applicationInstanceId);
    } finally { await b.publication.unpublish(); await rm(root, { recursive: true, force: true }); }
  });

// @test-value v1
// kind = "invariant"
// claim = "同一applicationのgeneration変更で自動rebindしない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "bound sessionが新generationへoperationを送る"
// scope = "memory-runtime-binding"
// lifecycle = "permanent"
// @end-test-value
it("同一applicationの旧generationはgeneration changedでfail-closedになる", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wm-discovery-test-"));
    const applicationInstanceId = randomUUID(); const oldGeneration = randomUUID();
    const current = await publishMemory(root, { applicationInstanceId, runtimeGenerationId: randomUUID() });
    try {
      const result = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env: { [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1", [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV]: applicationInstanceId, [WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV]: oldGeneration } });
      assert.equal(result.kind, "error"); if (result.kind === "error") assert.equal(result.code, "runtime_generation_changed");
    } finally { await current.publication.unpublish(); await rm(root, { recursive: true, force: true }); }
  });

// @test-value v1
// kind = "security"
// claim = "binding-required selector欠落はoperator経路へdowngradeしない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "binding markerだけでunbound候補を選ぶ"
// scope = "memory-runtime-binding"
// lifecycle = "permanent"
// @end-test-value
it("binding-required markerのみはselector invalidでoperatorへdowngradeしない", async () => {
    const result = await resolveWithMateMemoryApi({ adapter: "cli", env: { [WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]: "1" }, registryRootDirectoryPath: path.join(tmpdir(), "missing-registry") });
    assert.equal(result.kind, "error"); if (result.kind === "error") assert.equal(result.code, "runtime_selector_invalid");
  });

// @test-value v1
// kind = "invariant"
// claim = "lease期限だけではactiveを失わせずchallenge結果でstaleを判定する"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "expired leaseをPIDだけでactiveへ戻す、またはchallenge成功をstale扱いする"
// scope = "memory-runtime-lease"
// lifecycle = "permanent"
// @end-test-value
it("expired leaseはchallenge失敗ならstale、成功ならactiveとして扱う", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wm-discovery-test-"));
    const runtime = await publishMemory(root);
    try {
      const clock = { now: () => new Date(BASE_TIME.getTime() + 30_000) };
      const stale = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env: unboundEnv, clock, fetch: statusFetch(runtime.identity.applicationInstanceId, runtime.identity.runtimeGenerationId, false) });
      assert.equal(stale.kind, "error"); if (stale.kind === "error") assert.equal(stale.code, "runtime_stale");
      const active = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env: unboundEnv, clock, fetch: statusFetch(runtime.identity.applicationInstanceId, runtime.identity.runtimeGenerationId, true) });
      assert.equal(active.kind, "selected");
    } finally { await runtime.publication.unpublish(); await rm(root, { recursive: true, force: true }); }
  });

// @test-value v1
// kind = "compatibility"
// claim = "legacy pointerとregistryは同一runtimeだけdedupeし別runtimeはambiguousにする"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "legacy pointerがregistry候補を隠す、または重複候補を作る"
// scope = "memory-runtime-legacy"
// lifecycle = "permanent"
// @end-test-value
it("legacy pointerの同一runtimeは重複計上せず、別runtimeならambiguousになる", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wm-discovery-test-"));
    const runtime = await publishMemory(root);
    const legacyDir = await mkdtemp(path.join(tmpdir(), "wm-legacy-test-"));
    const doc = { schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION, adapter: "cli", baseUrl: runtime.baseUrl, apiSecret: API_SECRET, adapterSecret: ADAPTER_SECRET, applicationInstanceId: runtime.identity.applicationInstanceId, runtimeGenerationId: runtime.identity.runtimeGenerationId, runtimeInstanceId: runtime.identity.runtimeGenerationId, buildChannel: "development", publishedAt: BASE_TIME.toISOString() };
    const generationPath = path.join(legacyDir, buildWithMateMemoryDiscoveryGenerationFileName("cli", runtime.identity.runtimeGenerationId));
    await writeFile(generationPath, JSON.stringify(doc));
    const pointerPath = path.join(legacyDir, "memory-v6.current.json");
    await writeFile(pointerPath, JSON.stringify({ schemaVersion: WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION, runtimeInstanceId: runtime.identity.runtimeGenerationId }));
    try {
      const deduped = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env: unboundEnv, legacyDiscoveryFilePath: pointerPath, fetch: statusFetch(runtime.identity.applicationInstanceId, runtime.identity.runtimeGenerationId) });
      assert.equal(deduped.kind, "selected"); if (deduped.kind === "selected") assert.equal(deduped.candidates.length, 1);
      await writeFile(path.join(
        root,
        "active",
        runtime.publication.slotName,
        buildRuntimeDiscoveryCredentialFileName("cli"),
      ), "{}\n");
      const registryCredentialInvalid = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env: unboundEnv, legacyDiscoveryFilePath: pointerPath, fetch: statusFetch(runtime.identity.applicationInstanceId, runtime.identity.runtimeGenerationId) });
      assert.equal(registryCredentialInvalid.kind, "selected");
      if (registryCredentialInvalid.kind === "selected") {
        assert.equal(registryCredentialInvalid.candidates.length, 1);
        assert.equal(registryCredentialInvalid.candidate.applicationInstanceId, runtime.identity.applicationInstanceId);
      }
      const other = await publishMemory(root, ids(), "http://127.0.0.1:39002");
      try { const ambiguous = await resolveWithMateMemoryApi({ adapter: "cli", registryRootDirectoryPath: root, env: unboundEnv, legacyDiscoveryFilePath: pointerPath, fetch: statusFetch(runtime.identity.applicationInstanceId, runtime.identity.runtimeGenerationId) }); assert.equal(ambiguous.kind, "error"); if (ambiguous.kind === "error") assert.equal(ambiguous.code, "runtime_ambiguous"); } finally { await other.publication.unpublish(); }
    } finally { await runtime.publication.unpublish(); await rm(root, { recursive: true, force: true }); await rm(legacyDir, { recursive: true, force: true }); }
  });

// @test-value v1
// kind = "security"
// claim = "identity challenge不一致時はoperation bodyをdispatchしない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "別runtimeへcredentialまたはoperation bodyを送る"
// scope = "memory-runtime-exchange"
// lifecycle = "permanent"
// @end-test-value
it("bound preflight mismatchはexchange dispatchを0回にする", async () => {
    let dispatches = 0;
    const controller = new AbortController();
    await assert.rejects(() => callWithMateMemoryRuntime({ api: { baseUrl: "http://127.0.0.1:1", apiSecret: API_SECRET, applicationInstanceId: randomUUID(), runtimeGenerationId: randomUUID(), runtimeInstanceId: randomUUID() }, credential: { adapter: "cli", adapterSecret: ADAPTER_SECRET } }, { method: "POST", path: "/v1/character_memory/forget", body: { sentinel: "secret-body" } }, { signal: controller.signal, fetch: (async () => { dispatches += 1; return new Response(JSON.stringify({ runtimeInstanceId: randomUUID(), challenge: {} }), { status: 200 }); }) as typeof fetch }), (error: unknown) => error instanceof WithMateMemoryRuntimeExchangeError && error.dispatched === false);
    assert.equal(dispatches, 1); // preflight request only; exchange request is never created
  });

// @test-value v1
// kind = "security"
// claim = "欠落generationとdiagnosticsはsecretやprivate pathを公開しない"
// oracle = { type = "contract", ref = "multi-instance-runtime-discovery" }
// failure_mode = "stale pointerをactive候補として返す、またはerror detailsへcredentialを漏らす"
// scope = "memory-runtime-legacy"
// lifecycle = "permanent"
// @end-test-value
it("missing legacy generationはcandidateへ昇格せず、公開detailsはsafe metadataだけにする", async () => {
    const legacyDir = await mkdtemp(path.join(tmpdir(), "wm-legacy-test-"));
    const pointerPath = path.join(legacyDir, "memory-v6.current.json");
    await writeFile(pointerPath, JSON.stringify({ schemaVersion: WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION, runtimeInstanceId: randomUUID() }));
    try {
      const result = await resolveWithMateMemoryApi({ adapter: "cli", env: unboundEnv, registryRootDirectoryPath: path.join(legacyDir, "registry"), legacyDiscoveryFilePath: pointerPath });
      assert.equal(result.kind, "error");
      const error = createMemoryRuntimeDiscoveryError(result as Extract<typeof result, { kind: "error" }>);
      const serialized = JSON.stringify(error);
      for (const forbidden of [API_SECRET, ADAPTER_SECRET, legacyDir, "secret-body", "binding-reference"]) {
        assert.equal(serialized.includes(forbidden), false);
      }
    } finally { await rm(legacyDir, { recursive: true, force: true }); }
  });
