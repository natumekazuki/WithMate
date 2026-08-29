import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listRuntimeDiscoveryRegistryEntries,
  maintainRuntimeDiscoveryRegistry,
  publishRuntimeDiscoveryEntry,
  readRuntimeDiscoveryCredential,
} from "../../src/runtime-discovery/runtime-discovery-registry.js";
import {
  RuntimeDiscoveryClock,
  RuntimeDiscoveryRegistryError,
  RuntimeDiscoveryTimers,
} from "../../src/runtime-discovery/runtime-discovery-contract.js";

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const;

const iso = (value: number) => new Date(value).toISOString();

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-runtime-registry-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function clock(value: number): RuntimeDiscoveryClock {
  return { now: () => new Date(value) };
}

function timers(): RuntimeDiscoveryTimers {
  return {
    setInterval: () => ({}) as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
  };
}

function options(root: string, applicationInstanceId: string, generation: string, now = Date.parse("2026-08-30T00:00:00.000Z")) {
  return {
    rootDirectoryPath: root,
    security: async () => undefined,
    identity: { applicationInstanceId, runtimeKind: "memory" as const, runtimeGenerationId: generation },
    buildChannel: "development" as const,
    process: { pid: 100, startedAt: iso(now) },
    credentialDocuments: [{ adapterKind: "cli", document: { marker: generation } }],
    challenge: async () => false,
    clock: clock(now),
    timers: timers(),
  };
}

// @test-value v1
// kind = "invariant"
// claim = "後発runtimeのunpublish後も先発runtimeのentryとcredentialを解決できる"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "BのcleanupがAの選択状態またはcredentialを削除する"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("先発runtimeは後発runtimeのcleanupで失われない", async () => withRoot(async (root) => {
  const first = await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1]));
  const firstCredential = await readRuntimeDiscoveryCredential(
    (await listRuntimeDiscoveryRegistryEntries(root)).records[0],
    "cli",
  );
  const second = await publishRuntimeDiscoveryEntry(options(root, UUIDS[2], UUIDS[3]));
  await second.unpublish();
  await second.cleanupGeneration();
  const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].entry.applicationInstanceId, UUIDS[0]);
  assert.equal(await readRuntimeDiscoveryCredential(snapshot.records[0], "cli"), firstCredential);
  await first.unpublish();
  await first.cleanupGeneration();
}));

// @test-value v1
// kind = "invariant"
// claim = "ownerでないpublication handleのcleanupは現ownerのentryを変更しない"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "古いhandleがslot再利用後の別owner artifactを削除する"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("非owner handleはslot再利用後のownerを削除できない", async () => withRoot(async (root) => {
  const owner = await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1]));
  const stale = { ...owner };
  await owner.unpublish();
  await owner.cleanupGeneration();
  const replacement = await publishRuntimeDiscoveryEntry(options(root, UUIDS[2], UUIDS[3]));
  assert.equal(await stale.unpublish(), false);
  assert.equal(await stale.cleanupGeneration(), false);
  const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
  assert.equal(snapshot.records[0].entry.applicationInstanceId, UUIDS[2]);
  await replacement.unpublish();
  await replacement.cleanupGeneration();
}));

// @test-value v1
// kind = "invariant"
// claim = "lease期限切れでchallengeが失敗したentryだけがstale回収される"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "crashしたownerのentryがactive集合に残り続ける"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("期限切れchallenge失敗entryはstale回収される", async () => withRoot(async (root) => {
  const published = await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1], 0));
  await published.stopHeartbeat();
  const result = await maintainRuntimeDiscoveryRegistry({
    rootDirectoryPath: root,
    security: async () => undefined,
    challenge: async () => false,
    clock: clock(120_000),
    limits: { staleThresholdMs: 1, capacityCleanupGraceMs: 1, retentionMs: 1 },
  });
  assert.equal(result.retiredEntries, 1);
  assert.equal((await listRuntimeDiscoveryRegistryEntries(root)).records.length, 0);
}));

// @test-value v1
// kind = "invariant"
// claim = "期限切れでもidentity challenge成功のruntimeはcapacity cleanupで保持される"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "一時的なlease遅延で稼働中runtimeをstale扱いする"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("期限切れchallenge成功entryは保持される", async () => withRoot(async (root) => {
  await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1], 0));
  const result = await maintainRuntimeDiscoveryRegistry({
    rootDirectoryPath: root,
    security: async () => undefined,
    challenge: async () => true,
    clock: clock(120_000),
    limits: { staleThresholdMs: 1, capacityCleanupGraceMs: 1, retentionMs: 1 },
    capacityPressure: true,
  });
  assert.equal(result.retiredEntries, 0);
  assert.equal((await listRuntimeDiscoveryRegistryEntries(root)).records.length, 1);
}));

// @test-value v1
// kind = "invariant"
// claim = "同時publishは完全なentryとcredentialだけを公開し、slot上限を守る"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "partial entryまたはcredential pairがresolverへ公開される"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("同時publishはpartial artifactを公開せずcapacityを守る", async () => withRoot(async (root) => {
  const [a, b] = await Promise.all([
    publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1])),
    publishRuntimeDiscoveryEntry(options(root, UUIDS[2], UUIDS[3])),
  ]);
  const snapshot = await listRuntimeDiscoveryRegistryEntries(root, { maxEntries: 2 });
  assert.equal(snapshot.records.length, 2);
  for (const record of snapshot.records) {
    const credential = await readRuntimeDiscoveryCredential(record, "cli");
    assert.ok(credential?.includes(record.entry.runtimeGenerationId));
  }
  await a.unpublish(); await a.cleanupGeneration();
  await b.unpublish(); await b.cleanupGeneration();
}));

// @test-value v1
// kind = "security"
// claim = "registry capacity到達時はcredential公開前にregistry_capacityで失敗する"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "capacity超過時に新credentialを先に作成してsecret artifactを残す"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("capacity fullではsecurity callback前に失敗する", async () => withRoot(async (root) => {
  await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1]));
  let credentialSecurityCalls = 0;
  await assert.rejects(
    publishRuntimeDiscoveryEntry({
      ...options(root, UUIDS[2], UUIDS[3]),
      limits: { maxEntries: 1 },
      security: async (_path, kind) => { if (kind === "file") credentialSecurityCalls += 1; },
    }),
    (error: unknown) => error instanceof RuntimeDiscoveryRegistryError && error.code === "registry_capacity",
  );
  assert.equal(credentialSecurityCalls, 0);
}));

// @test-value v1
// kind = "security"
// claim = "ACL/security検証失敗時にactive、staging、credential artifactが残らない"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "ACL検証失敗後に未参照のgenerationが残留する"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("security callback失敗時はpublication artifactをrollbackする", async () => withRoot(async (root) => {
  await assert.rejects(
    publishRuntimeDiscoveryEntry({
      ...options(root, UUIDS[0], UUIDS[1]),
      security: async (_path, kind) => { if (kind === "file") throw new Error("acl"); },
    }),
  );
  assert.equal((await listRuntimeDiscoveryRegistryEntries(root)).records.length, 0);
  const staging = path.join(root, "staging");
  const names = await readdir(staging).catch(() => [] as string[]);
  assert.deepEqual(names, []);
}));

// @test-value v1
// kind = "invariant"
// claim = "heartbeatはfake clockでleaseを更新し、停止後は再作成しない"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "heartbeat停止後に旧handleがentryを復活させる"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("heartbeatはfake clockでleaseを更新する", async () => withRoot(async (root) => {
  let now = 0;
  let callback: (() => void) | undefined;
  const publication = await publishRuntimeDiscoveryEntry({
    ...options(root, UUIDS[0], UUIDS[1], now),
    clock: { now: () => new Date(now) },
    timers: {
      setInterval: (cb) => { callback = cb; return 1 as ReturnType<typeof setInterval>; },
      clearInterval: () => undefined,
    },
  });
  now = 5_000;
  callback?.();
  await publication.refreshHeartbeat();
  const record = (await listRuntimeDiscoveryRegistryEntries(root)).records[0];
  assert.equal(record.entry.lease.heartbeatAt, iso(now));
  await publication.unpublish();
  await publication.cleanupGeneration();
}));

// @test-value v1
// kind = "invariant"
// claim = "retired/staging artifactの回収はboundedでretentionを超えて増加しない"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "stale artifactが無制限に蓄積してregistryを圧迫する"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("retired artifact回収はretention境界でboundedになる", async () => withRoot(async (root) => {
  const publication = await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1], 0));
  await publication.unpublish();
  const retired = path.join(root, "retired");
  for (const name of await readdir(retired)) {
    await utimes(path.join(retired, name), new Date(0), new Date(0));
  }
  const result = await maintainRuntimeDiscoveryRegistry({
    rootDirectoryPath: root,
    security: async () => undefined,
    challenge: async () => false,
    clock: clock(2 * 24 * 60 * 60 * 1_000),
  });
  assert.ok(result.removedRetiredArtifacts >= 1);
  assert.equal((await readdir(retired)).length, 0);
}));
