import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  listRuntimeDiscoveryRegistryEntries,
  maintainRuntimeDiscoveryRegistry,
  publishRuntimeDiscoveryEntry,
  readRuntimeDiscoveryCredential,
  resolveRuntimeDiscoveryMutationLockFilePath,
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
  const root = await mkdtemp(
    path.join(os.tmpdir(), "withmate-runtime-registry-test-"),
  );
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

function options(
  root: string,
  applicationInstanceId: string,
  generation: string,
  now = Date.parse("2026-08-30T00:00:00.000Z"),
) {
  return {
    rootDirectoryPath: root,
    security: async () => undefined,
    identity: {
      applicationInstanceId,
      runtimeKind: "memory" as const,
      runtimeGenerationId: generation,
    },
    buildChannel: "development" as const,
    process: { pid: 100, startedAt: iso(now) },
    credentialDocuments: [
      { adapterKind: "cli", document: { marker: generation } },
    ],
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
test("先発runtimeは後発runtimeのcleanupで失われない", async () =>
  withRoot(async (root) => {
    const first = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[0], UUIDS[1]),
    );
    const firstCredential = await readRuntimeDiscoveryCredential(
      (await listRuntimeDiscoveryRegistryEntries(root)).records[0],
      "cli",
    );
    const second = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[2], UUIDS[3]),
    );
    await second.unpublish();
    await second.cleanupGeneration();
    const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].entry.applicationInstanceId, UUIDS[0]);
    assert.equal(
      await readRuntimeDiscoveryCredential(snapshot.records[0], "cli"),
      firstCredential,
    );
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
test("非owner handleはslot再利用後のownerを削除できない", async () =>
  withRoot(async (root) => {
    const owner = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[0], UUIDS[1]),
    );
    const stale = { ...owner };
    await owner.unpublish();
    await owner.cleanupGeneration();
    const replacement = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[2], UUIDS[3]),
    );
    assert.equal(await stale.unpublish(), false);
    assert.equal(await stale.cleanupGeneration(), false);
    const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
    assert.equal(snapshot.records[0].entry.applicationInstanceId, UUIDS[2]);
    await replacement.unpublish();
    await replacement.cleanupGeneration();
  }));

// @test-value v1
// kind = "invariant"
// claim = "heartbeat更新とstale retireのowner再検証は同じcross-process lockで直列化される"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "maintenanceが確認後にfresh化したentryをpathnameだけでretireして稼働中runtimeを失わせる"
// scope = "runtime-discovery-registry-mutation-lock"
// lifecycle = "permanent"
// @end-test-value
test("heartbeat中のstale retireは更新後のowner stateを再検証する", async () =>
  withRoot(async (root) => {
    let now = 0;
    let heartbeatEnteredResolve: (() => void) | undefined;
    let releaseHeartbeatResolve: (() => void) | undefined;
    let challengeEnteredResolve: (() => void) | undefined;
    const heartbeatEntered = new Promise<void>((resolve) => {
      heartbeatEnteredResolve = resolve;
    });
    const releaseHeartbeat = new Promise<void>((resolve) => {
      releaseHeartbeatResolve = resolve;
    });
    const challengeEntered = new Promise<void>((resolve) => {
      challengeEnteredResolve = resolve;
    });
    const publication = await publishRuntimeDiscoveryEntry({
      ...options(root, UUIDS[0], UUIDS[1], now),
      clock: { now: () => new Date(now) },
      mutationObserver: async (kind) => {
        if (kind === "heartbeat") {
          heartbeatEnteredResolve?.();
          await releaseHeartbeat;
        }
      },
    });
    now = 120_000;
    const heartbeat = publication.refreshHeartbeat();
    await heartbeatEntered;
    let maintenanceSettled = false;
    const maintenance = maintainRuntimeDiscoveryRegistry({
      rootDirectoryPath: root,
      security: async () => undefined,
      challenge: async () => {
        challengeEnteredResolve?.();
        return false;
      },
      clock: { now: () => new Date(now) },
      limits: {
        staleThresholdMs: 1,
        capacityCleanupGraceMs: 1,
        retentionMs: 1,
      },
    }).finally(() => {
      maintenanceSettled = true;
    });
    await challengeEntered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(maintenanceSettled, false);

    releaseHeartbeatResolve?.();
    assert.equal(await heartbeat, true);
    const result = await maintenance;
    assert.equal(result.retiredEntries, 0);
    const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].entry.lease.heartbeatAt, iso(now));
    await publication.unpublish();
    await publication.cleanupGeneration();
  }));

// @test-value v1
// kind = "invariant"
// claim = "slot owner確認からmutation完了までのcross-process lockは別publisherのslot再利用を待機させる"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "旧ownerのunpublishが確認後に再利用されたslotをrenameして新ownerのentryとcredentialを失わせる"
// scope = "runtime-discovery-registry-mutation-lock"
// lifecycle = "permanent"
// @end-test-value
test("owner mutation中のslot再利用をregistry lockで直列化する", async () =>
  withRoot(async (root) => {
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const owner = await publishRuntimeDiscoveryEntry({
      ...options(root, UUIDS[0], UUIDS[1]),
      mutationObserver: async (kind) => {
        if (kind === "unpublish") {
          enteredResolve?.();
          await release;
        }
      },
    });
    const staleOwner = { ...owner };
    const ownerUnpublish = owner.unpublish();
    await entered;

    let replacementSettled = false;
    const replacementPromise = publishRuntimeDiscoveryEntry(
      options(root, UUIDS[2], UUIDS[3]),
    ).finally(() => {
      replacementSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replacementSettled, false);

    releaseResolve?.();
    assert.equal(await ownerUnpublish, true);
    await owner.cleanupGeneration();
    const replacement = await replacementPromise;
    assert.equal(await staleOwner.unpublish(), false);
    const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].entry.applicationInstanceId, UUIDS[2]);
    assert.ok(await readRuntimeDiscoveryCredential(snapshot.records[0], "cli"));
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
test("期限切れchallenge失敗entryはstale回収される", async () =>
  withRoot(async (root) => {
    const published = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[0], UUIDS[1], 0),
    );
    await published.stopHeartbeat();
    const result = await maintainRuntimeDiscoveryRegistry({
      rootDirectoryPath: root,
      security: async () => undefined,
      challenge: async () => false,
      clock: clock(120_000),
      limits: {
        staleThresholdMs: 1,
        capacityCleanupGraceMs: 1,
        retentionMs: 1,
      },
    });
    assert.equal(result.retiredEntries, 1);
    assert.equal(
      (await listRuntimeDiscoveryRegistryEntries(root)).records.length,
      0,
    );
  }));

// @test-value v1
// kind = "invariant"
// claim = "期限切れでもidentity challenge成功のruntimeはcapacity cleanupで保持される"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "一時的なlease遅延で稼働中runtimeをstale扱いする"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("期限切れchallenge成功entryは保持される", async () =>
  withRoot(async (root) => {
    await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1], 0));
    const result = await maintainRuntimeDiscoveryRegistry({
      rootDirectoryPath: root,
      security: async () => undefined,
      challenge: async () => true,
      clock: clock(120_000),
      limits: {
        staleThresholdMs: 1,
        capacityCleanupGraceMs: 1,
        retentionMs: 1,
      },
      capacityPressure: true,
    });
    assert.equal(result.retiredEntries, 0);
    assert.equal(
      (await listRuntimeDiscoveryRegistryEntries(root)).records.length,
      1,
    );
  }));

// @test-value v1
// kind = "invariant"
// claim = "同時publishは完全なentryとcredentialだけを公開し、slot上限を守る"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "partial entryまたはcredential pairがresolverへ公開される"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("同時publishはpartial artifactを公開せずcapacityを守る", async () =>
  withRoot(async (root) => {
    const [a, b] = await Promise.all([
      publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1])),
      publishRuntimeDiscoveryEntry(options(root, UUIDS[2], UUIDS[3])),
    ]);
    const snapshot = await listRuntimeDiscoveryRegistryEntries(root, {
      maxEntries: 2,
    });
    assert.equal(snapshot.records.length, 2);
    for (const record of snapshot.records) {
      const credential = await readRuntimeDiscoveryCredential(record, "cli");
      assert.ok(credential?.includes(record.entry.runtimeGenerationId));
    }
    await a.unpublish();
    await a.cleanupGeneration();
    await b.unpublish();
    await b.cleanupGeneration();
  }));

// @test-value v1
// kind = "security"
// claim = "registry capacity到達時はcredential公開前にregistry_capacityで失敗する"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "capacity超過時に新credentialを先に作成してsecret artifactを残す"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("capacity fullではsecurity callback前に失敗する", async () =>
  withRoot(async (root) => {
    await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1]));
    let credentialSecurityCalls = 0;
    await assert.rejects(
      publishRuntimeDiscoveryEntry({
        ...options(root, UUIDS[2], UUIDS[3]),
        limits: { maxEntries: 1 },
        security: async (_path, kind) => {
          if (kind === "file") credentialSecurityCalls += 1;
        },
      }),
      (error: unknown) =>
        error instanceof RuntimeDiscoveryRegistryError &&
        error.code === "registry_capacity",
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
test("security callback失敗時はpublication artifactをrollbackする", async () =>
  withRoot(async (root) => {
    await assert.rejects(
      publishRuntimeDiscoveryEntry({
        ...options(root, UUIDS[0], UUIDS[1]),
        security: async (_path, kind) => {
          if (kind === "file") throw new Error("acl");
        },
      }),
    );
    assert.equal(
      (await listRuntimeDiscoveryRegistryEntries(root)).records.length,
      0,
    );
    const staging = path.join(root, "staging");
    const names = await readdir(staging).catch(() => [] as string[]);
    assert.deepEqual(names, []);
  }));

// @test-value v1
// kind = "invariant"
// claim = "heartbeatは保護済みslot内でACL処理を再実行せずleaseをatomic更新する"
// oracle = { type = "adr", ref = "ADR-023" }
// failure_mode = "5秒周期のheartbeatがACL helperを起動して共通lockを長時間占有し、fresh runtimeをstale化する"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// @end-test-value
test("heartbeatはACL処理を再実行せずfake clockのleaseを更新する", async () =>
  withRoot(async (root) => {
    let now = 0;
    let callback: (() => void) | undefined;
    let securityCallCount = 0;
    const publication = await publishRuntimeDiscoveryEntry({
      ...options(root, UUIDS[0], UUIDS[1], now),
      security: async () => {
        securityCallCount += 1;
      },
      clock: { now: () => new Date(now) },
      timers: {
        setInterval: (cb) => {
          callback = cb;
          return 1 as ReturnType<typeof setInterval>;
        },
        clearInterval: () => undefined,
      },
    });
    const securityCallCountAfterPublish = securityCallCount;
    now = 5_000;
    callback?.();
    await publication.refreshHeartbeat();
    const record = (await listRuntimeDiscoveryRegistryEntries(root)).records[0];
    assert.equal(record.entry.lease.heartbeatAt, iso(now));
    assert.equal(securityCallCount, securityCallCountAfterPublish);
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
test("retired artifact回収はretention境界でboundedになる", async () =>
  withRoot(async (root) => {
    const publication = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[0], UUIDS[1], 0),
    );
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

// @test-value v1
// kind = "regression"
// claim = "別processがmutation lock保持中にcrashしてもstale lock回収後のpublisherは完全なentryを公開できる"
// oracle = { type = "adr", ref = "ADR-023 cross-process mutation lock recovery" }
// failure_mode = "crashしたprocessのlockが残留し、同じOSユーザーの全runtime publishとheartbeatを永久に停止させる"
// scope = "runtime-discovery-registry-mutation-lock"
// lifecycle = "permanent"
// distinction = "同一Node process内のbarrierではなく、独立child processの強制終了とlock mtime expiryを通る"
// @end-test-value
test("別process crash後にstale mutation lockを回収してpublishできる", async () =>
  withRoot(async (root) => {
    const moduleUrl = pathToFileURL(path.resolve(
      "src/runtime-discovery/runtime-discovery-registry.ts",
    )).href;
    const childSource = [
      "const registry = await import(process.argv[1]);",
      "await registry.publishRuntimeDiscoveryEntry({",
      "  rootDirectoryPath: process.argv[2],",
      "  security: async () => undefined,",
      "  identity: { applicationInstanceId: process.argv[3], runtimeKind: 'memory', runtimeGenerationId: process.argv[4] },",
      "  buildChannel: 'development',",
      "  process: { pid: process.pid, startedAt: new Date(0).toISOString() },",
      "  credentialDocuments: [{ adapterKind: 'cli', document: { marker: 'child' } }],",
      "  challenge: async () => false,",
      "  timers: { setInterval: () => ({}), clearInterval: () => undefined },",
      "  mutationObserver: async (kind) => {",
      "    if (kind === 'publish') {",
      "      process.stdout.write('LOCKED\\n');",
      "      await new Promise(() => { setInterval(() => undefined, 1000); });",
      "    }",
      "  },",
      "});",
    ].join("\n");
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      childSource,
      moduleUrl,
      root,
      UUIDS[0],
      UUIDS[1],
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => {
        if (chunk.includes("LOCKED")) {
          resolve();
        }
      });
      child.once("exit", (code) => {
        reject(new Error("lock holder exited before acquiring the lock: " + code + " " + stderr));
      });
      child.once("error", reject);
    });

    const exitPromise = once(child, "exit");
    if (process.platform === "win32") {
      const killed = spawnSync("taskkill", [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ], { windowsHide: true });
      assert.equal(killed.status, 0, killed.stderr?.toString("utf8"));
    } else {
      assert.equal(child.kill("SIGKILL"), true);
    }
    await exitPromise;
    const expiredAt = new Date(Date.now() - 60_000);
    await utimes(
      resolveRuntimeDiscoveryMutationLockFilePath(root),
      expiredAt,
      expiredAt,
    );

    const replacement = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[2], UUIDS[3]),
    );
    const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].entry.applicationInstanceId, UUIDS[2]);
    assert.ok(await readRuntimeDiscoveryCredential(snapshot.records[0], "cli"));
    await replacement.unpublish();
    await replacement.cleanupGeneration();
  }));
