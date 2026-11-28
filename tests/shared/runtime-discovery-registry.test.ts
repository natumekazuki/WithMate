import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
} from "../../src-electron/platform/runtime-discovery/runtime-discovery-registry.js";
import {
  RuntimeDiscoveryClock,
  RuntimeDiscoveryRegistryError,
  RuntimeDiscoveryTimers,
} from "../../src-electron/platform/runtime-discovery/runtime-discovery-contract.js";

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const;

/** fixture のミリ秒時刻を、保存される lease と比較できる ISO 文字列にする。 */
const iso = (value: number) => new Date(value).toISOString();

/** 各ケースを専用の一時レジストリで実行し、失敗しても作成したディレクトリだけを片付ける。 */
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

/** 実時間に依存せず、指定時点で停止したレジストリ用の時計を作る。 */
function clock(value: number): RuntimeDiscoveryClock {
  return {
    /** 毎回同じ時点を、新しい Date として返す。 */
    now: () => new Date(value),
  };
}

/** 自動 heartbeat を動かさず、テストが明示した更新だけでレジストリを進める。 */
function timers(): RuntimeDiscoveryTimers {
  return {
    /** 実タイマーを予約せず、解除に渡せるハンドルだけを返す。 */
    setInterval: () => ({}) as ReturnType<typeof setInterval>,
    /** タイマーを予約していないため、ハンドル解除に外部効果はない。 */
    clearInterval: () => undefined,
  };
}

/** 指定されたアプリと世代を別々に識別できるよう、公開オプションと世代マーカー付き資格情報を作る。 */
function options(
  root: string,
  applicationInstanceId: string,
  generation: string,
  now = Date.parse("2026-08-30T00:00:00.000Z"),
) {
  return {
    rootDirectoryPath: root,
    /** 一時ディレクトリでは実 ACL を変更せず、公開処理のファイル操作だけを通す。 */
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
    /** 既定では公開先の生存確認に応答がない状態を返す。 */
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
/** 二つ目のランタイムの公開終了と世代削除で、先発の登録・資格情報を失わないことを確認する。 */
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
/** 古いハンドルで公開終了や世代削除を試みても、スロットの新所有者には効果がないことを確認する。 */
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
/** 古い lease を回収しようとしても、待機中に先行 heartbeat が更新した所有者の登録を取り除かない。 */
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
      clock: {
        /** 時刻を進めた後の heartbeat に、新しい時刻を使わせる。 */
        now: () => new Date(now),
      },
      /** heartbeat が変更ロック内部に入ったところで止め、回収処理を並行させる。 */
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
      /** ACL を変えず、heartbeat と回収処理の順序だけを検証する。 */
      security: async () => undefined,
      /** 古い lease の確認が始まったことを通知し、生存確認は不成立として返す。 */
      challenge: async () => {
        challengeEnteredResolve?.();
        return false;
      },
      clock: {
        /** heartbeat と同じ時刻で、回収時の lease を判定する。 */
        now: () => new Date(now),
      },
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
/** 公開終了処理がスロットを変更している間は新しい公開を待たせ、完了後も旧ハンドルから新所有者を保護する。 */
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
      /** 旧所有者の公開終了をロック内で止め、後発の公開がまだ完了しないことを観測できるようにする。 */
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
/** heartbeat を止めた期限切れの公開は、生存確認も失敗したときに一覧から取り除かれる。 */
test("期限切れchallenge失敗entryはstale回収される", async () =>
  withRoot(async (root) => {
    const published = await publishRuntimeDiscoveryEntry(
      options(root, UUIDS[0], UUIDS[1], 0),
    );
    await published.stopHeartbeat();
    const result = await maintainRuntimeDiscoveryRegistry({
      rootDirectoryPath: root,
      /** 古い登録の回収に OS の ACL 操作を伴わせない。 */
      security: async () => undefined,
      /** 期限切れの所有者が応答しない状況を返す。 */
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
/** 期限が切れていても生存確認に応答する公開は、容量に余裕がない場合にも残す。 */
test("期限切れchallenge成功entryは保持される", async () =>
  withRoot(async (root) => {
    await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1], 0));
    const result = await maintainRuntimeDiscoveryRegistry({
      rootDirectoryPath: root,
      /** ACL の変更なしで、期限切れの登録をレジストリの保守処理に渡す。 */
      security: async () => undefined,
      /** lease は期限切れだがランタイムが応答する条件を再現する。 */
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
/** 二件を同時に公開した状態で容量二件の一覧を読み、各登録と同じ世代の資格情報を取得できることを確認する。 */
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
/** 容量に達したときは専用エラーを返し、追加の資格情報ファイルにセキュリティ処理を実行しない。 */
test("capacity fullではsecurity callback前に失敗する", async () =>
  withRoot(async (root) => {
    await publishRuntimeDiscoveryEntry(options(root, UUIDS[0], UUIDS[1]));
    let credentialSecurityCalls = 0;
    await assert.rejects(
      publishRuntimeDiscoveryEntry({
        ...options(root, UUIDS[2], UUIDS[3]),
        limits: { maxEntries: 1 },
        /** 失敗する公開で資格情報ファイルのセキュリティ処理に到達した回数を記録する。 */
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
/** 資格情報ファイルのセキュリティ処理に失敗した場合、公開一覧にも staging にも途中の成果を残さない。 */
test("security callback失敗時はpublication artifactをrollbackする", async () =>
  withRoot(async (root) => {
    await assert.rejects(
      publishRuntimeDiscoveryEntry({
        ...options(root, UUIDS[0], UUIDS[1]),
        /** ファイルの ACL 処理だけを意図的に失敗させ、ディレクトリの処理は通す。 */
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
// kind = "regression"
// claim = "entry commit後にmutation lockの解放が失敗しても、publisherは同じpublicationをread-backしてowner entryをrollbackする"
// oracle = { type = "adr", ref = "ADR-023 publication commit-unknown recovery" }
// failure_mode = "lock解放失敗をpublish失敗として返す一方、handleを持たないfreshなowner entryとcredentialをregistryへ残す"
// scope = "runtime-discovery-registry-publication-recovery"
// lifecycle = "permanent"
// distinction = "entry commit前のACL失敗ではなく、完全なentryのread-back後にlock directoryの削除だけが失敗する時点を注入する"
// @end-test-value
/** 公開を反映した後にロックの解放が失敗したとき、途中の公開を取り消し、後続のロールバック通知も一度だけ行う。 */
test("publication commit後のlock解放失敗はowner entryをrollbackする", async () =>
  withRoot(async (root) => {
    const lockDirectoryPath = resolveRuntimeDiscoveryMutationLockFilePath(root);
    const blockerPath = path.join(lockDirectoryPath, "release-blocker");
    let projectionRollbackCount = 0;
    try {
      await assert.rejects(
        publishRuntimeDiscoveryEntry({
          ...options(root, UUIDS[0], UUIDS[1]),
          /** 公開段階でロック先にファイルを作り、空のロックディレクトリとして解放できない状況を再現する。 */
          mutationObserver: async (kind) => {
            if (kind === "publish") {
              await writeFile(blockerPath, "block release\n", "utf8");
            }
          },
          /** 公開の取り消し後に投影側へ通知した回数を記録する。 */
          afterPublicationRollback: async () => {
            projectionRollbackCount += 1;
          },
        }),
        (error: unknown) =>
          (error as NodeJS.ErrnoException)?.code === "ENOTEMPTY" ||
          (error as NodeJS.ErrnoException)?.code === "EEXIST",
      );
      const snapshot = await listRuntimeDiscoveryRegistryEntries(root);
      assert.equal(snapshot.records.length, 0);
      assert.deepEqual(await readdir(path.join(root, "staging")), []);
      assert.equal(projectionRollbackCount, 1);
    } finally {
      await rm(lockDirectoryPath, { recursive: true, force: true });
    }
  }));

// @test-value v2
// kind = "invariant"
// claim = "heartbeatは保護済みslot内でACL処理を再実行せずleaseをatomic更新する"
// oracle = { type = "adr", ref = "ADR-023" }
// fault = "5秒周期のheartbeatがACL helperを起動して共通lockを長時間占有し、fresh runtimeをstale化する"
// observable = "security call count、lease expiry、fake clock heartbeat callback"
// observation_boundary = "public-boundary"
// scope = "runtime-discovery-registry"
// lifecycle = "permanent"
// distinction = "初回publish成功では検出できないheartbeat更新とACL再実行抑止を確認する"
// @end-test-value
/** テスト時計を進めて heartbeat を更新すると、lease の時刻は進むが初回公開時の ACL 処理は繰り返さない。 */
test("heartbeatはACL処理を再実行せずfake clockのleaseを更新する", async () =>
  withRoot(async (root) => {
    let now = 0;
    let callback: (() => void) | undefined;
    let securityCallCount = 0;
    const publication = await publishRuntimeDiscoveryEntry({
      ...options(root, UUIDS[0], UUIDS[1], now),
      /** 公開と heartbeat がセキュリティ処理を呼んだ累積回数を記録する。 */
      security: async () => {
        securityCallCount += 1;
      },
      clock: {
        /** 手動で進めた時刻を heartbeat の lease 更新に反映する。 */
        now: () => new Date(now),
      },
      timers: {
        /** heartbeat コールバックを退避して手動で起動できるようにし、解除可能な実タイマーハンドルを返す。 */
        setInterval: (cb) => {
          callback = cb;
          return setInterval(() => {}, 60_000);
        },
        /** 公開終了時に、fixture が作った実タイマーを解除する。 */
        clearInterval: (handle) => globalThis.clearInterval(handle),
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
/** 公開終了で退避された成果の時刻を保持期間より前に設定し、保守処理で退避ディレクトリから除去されることを確認する。 */
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
      /** 退避済み成果の整理では OS の ACL を操作しない。 */
      security: async () => undefined,
      /** 整理対象のランタイムに生存応答がない状態とする。 */
      challenge: async () => false,
      clock: clock(2 * 24 * 60 * 60 * 1_000),
    });
    assert.ok(result.removedRetiredArtifacts >= 1);
    assert.equal((await readdir(retired)).length, 0);
  }));

// @test-value v2
// kind = "regression"
// claim = "別processがmutation lock保持中にcrashしてもstale lock回収後のpublisherは完全なentryを公開できる"
// oracle = { type = "adr", ref = "ADR-023 cross-process mutation lock recovery" }
// fault = "crashしたprocessのlockが残留し、同じOSユーザーの全runtime publishとheartbeatを永久に停止させる"
// observable = "lock取得通知後の子process終了と、期限切れlock回収後にpublishしたentryの参照結果"
// observation_boundary = "public-boundary"
// scope = "runtime-discovery-registry-mutation-lock"
// lifecycle = "permanent"
// distinction = "同一Node process内のbarrierではなく、独立child processの強制終了とlock mtime expiryを通る"
// @end-test-value
/** 専用の子プロセスを公開ロックの保持中に終了させ、古くなったロックがある状態でも別の世代を公開できることを確認する。 */
test("別process crash後にstale mutation lockを回収してpublishできる", async () =>
  withRoot(async (root) => {
    const moduleUrl = pathToFileURL(
      path.resolve(
        "src-electron/platform/runtime-discovery/runtime-discovery-registry.ts",
      ),
    ).href;
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
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        childSource,
        moduleUrl,
        root,
        UUIDS[0],
        UUIDS[1],
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
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
        reject(
          new Error(
            "lock holder exited before acquiring the lock: " +
              code +
              " " +
              stderr,
          ),
        );
      });
      child.once("error", reject);
    });

    const exitPromise = once(child, "exit");
    if (process.platform === "win32") {
      const killed = spawnSync(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
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
