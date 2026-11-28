import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import * as properLockfile from "proper-lockfile";
import {
  buildRuntimeDiscoveryCredentialFileName,
  buildRuntimeDiscoverySlotName,
  normalizeRuntimeDiscoveryRegistryLimits,
  parseRuntimeDiscoveryRegistryEntry,
  resolveDefaultRuntimeDiscoveryRegistryRoot,
  RUNTIME_DISCOVERY_ENTRY_FILE_NAME,
  RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION,
  RuntimeDiscoveryClock,
  RuntimeDiscoveryIdentity,
  RuntimeDiscoveryRegistryEntry,
  RuntimeDiscoveryRegistryError,
  RuntimeDiscoveryRegistryLimits,
  RuntimeDiscoveryTimerHandle,
  RuntimeDiscoveryTimers,
  RuntimeBuildChannel,
  SYSTEM_RUNTIME_DISCOVERY_CLOCK,
  SYSTEM_RUNTIME_DISCOVERY_TIMERS,
  isSameRuntimeDiscoveryIdentity,
} from "./runtime-discovery-contract.js";

const ACTIVE_DIRECTORY_NAME = "active";
const STAGING_DIRECTORY_NAME = "staging";
const RETIRED_DIRECTORY_NAME = "retired";
const REGISTRY_MUTATION_LOCK_FILE_NAME = ".registry-mutation.lock";
const REGISTRY_MUTATION_LOCK_STALE_MS = 20_000;
const STAGING_NAME_PATTERN = /^stage-[0-9a-f-]{36}$/;
const RETIRED_NAME_PATTERN = /^retired-[0-9a-f-]{36}$/;

/** アクセス保護を適用する際に期待するパスの種別。 */
export type RuntimePathTargetKind = "directory" | "file";
/** 指定パスを期待する種別として保護するプラットフォーム依存処理。保護できなければ失敗させる。 */
export type RuntimePathSecurity = (
  targetPath: string,
  targetKind: RuntimePathTargetKind,
) => Promise<void>;

/** レジストリ公開時に別ファイルへ保存する、アダプター別の認証ドキュメント。 */
export type RuntimeDiscoveryCredentialDocument = {
  adapterKind: string;
  document: unknown;
};

/** 検証済みの登録内容と、それを読み込んだ公開スロットの位置。 */
export type RuntimeDiscoveryRegistryRecord = {
  slotName: string;
  entry: RuntimeDiscoveryRegistryEntry;
  slotDirectoryPath: string;
};

/** 走査時に検出したスロット・登録内容・認証ファイルの異常。認証情報自体は含まない。 */
export type RuntimeDiscoveryRegistryListIssue = {
  slotName: string;
  code:
    | "unsafe_slot"
    | "invalid_entry"
    | "missing_credential"
    | "unsafe_credential";
};

/** 範囲内の公開スロットを走査した結果。認証ファイルの異常がある登録は、登録一覧と問題一覧の両方に現れ得る。 */
export type RuntimeDiscoveryRegistrySnapshot = {
  records: RuntimeDiscoveryRegistryRecord[];
  issues: RuntimeDiscoveryRegistryListIssue[];
};

/** 回収を検討している登録に対し、対応するランタイムが応答するかを確認する処理。 */
export type RuntimeDiscoveryRegistryChallenge = (
  entry: RuntimeDiscoveryRegistryEntry,
  slotDirectoryPath: string,
) => Promise<boolean>;

/** プロセス間ロックで順序付けるレジストリおよび関連状態の更新の種別。 */
type RegistryMutationKind =
  "heartbeat" | "retire" | "unpublish" | "publish" | "rollback" | "projection";
/** 変更ロックを取得した後、今回の更新種別を受け取るテスト用の観測処理。 */
type RegistryMutationObserver = (
  kind: RegistryMutationKind,
) => void | Promise<void>;

/** レジストリの配置先・アクセス保護と回収条件、および運用時刻の設定。 */
export type RuntimeDiscoveryRegistryLayoutOptions = {
  rootDirectoryPath?: string;
  security: RuntimePathSecurity;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  clock?: RuntimeDiscoveryClock;
  /** テスト専用の観測点。プロセス間ロックを取得してから実行する。 */
  mutationObserver?: RegistryMutationObserver;
};

/** 新しい登録の識別情報と認証ドキュメント、回収時の接続確認、および公開前後のフックをまとめた設定。 */
export type PublishRuntimeDiscoveryEntryOptions =
  RuntimeDiscoveryRegistryLayoutOptions & {
    identity: RuntimeDiscoveryIdentity;
    buildChannel: RuntimeBuildChannel;
    process: {
      pid: number;
      startedAt: string;
    };
    credentialDocuments: RuntimeDiscoveryCredentialDocument[];
    challenge: RuntimeDiscoveryRegistryChallenge;
    timers?: RuntimeDiscoveryTimers;
    onHeartbeatError?: (error: unknown) => void;
    /** プロセス間の変更ロックを保持したまま、エントリを公開する直前に実行する。 */
    beforePublicationCommit?: () => Promise<void>;
    /** テスト専用の観測点。公開ロックの取得を待ち始める直前に実行する。 */
    beforePublicationLock?: () => Promise<void>;
    /** 今回の公開を完全にロールバックした後、アダプターが所有する表示用の状態を復元する。 */
    afterPublicationRollback?: () => Promise<void>;
  };

/** 公開中、準備中、退役済みの成果物を分離するためのレジストリ内ディレクトリの絶対パス。 */
type RegistryLayout = {
  rootDirectoryPath: string;
  activeDirectoryPath: string;
  stagingDirectoryPath: string;
  retiredDirectoryPath: string;
};

/** アダプター別の認証ドキュメントを、保存先ファイル名と読み戻し比較用の本文に確定したもの。 */
type SerializedRuntimeDiscoveryCredentialDocument = {
  adapterKind: string;
  credentialFileName: string;
  contents: string;
};

/** 保守処理が退役させた登録数と、準備領域・退役領域から回収した成果物の数。 */
export type RuntimeDiscoveryRegistryMaintenanceResult = {
  retiredEntries: number;
  removedStagingArtifacts: number;
  removedRetiredArtifacts: number;
};

/** 一回の公開に対する所有者ハンドル。リース更新、公開解除、退役後の回収を区別する。 */
export type RuntimeDiscoveryRegistryPublication = {
  readonly entry: RuntimeDiscoveryRegistryEntry;
  readonly slotName: string;
  /** まだ公開中で周期更新がない場合に、リースの定期更新を開始する。 */
  startHeartbeat(): void;
  /** 同じ公開がスロットを所有している場合にリースを更新し、読み戻しで確定できたか返す。 */
  refreshHeartbeat(): Promise<boolean>;
  /** リースの周期更新を止め、キューに入っていた所有者操作の完了を待つ。 */
  stopHeartbeat(): Promise<void>;
  /** 定期更新を止め、自分が所有するスロットを退役領域へ移す。移さなかった場合は false を返す。 */
  unpublish(): Promise<boolean>;
  /** このハンドルが退役させた成果物の所有者を確認し、その成果物を削除できたか返す。 */
  cleanupGeneration(): Promise<boolean>;
};

/** 指定されたルート、または実行環境の既定ルートを絶対パスに解決する。 */
function normalizeRootDirectoryPath(rootDirectoryPath?: string): string {
  return path.resolve(
    rootDirectoryPath ?? resolveDefaultRuntimeDiscoveryRegistryRoot(),
  );
}

/** 各プロセスが同じレジストリの変更を直列化するためのロックパスを解決する。 */
export function resolveRuntimeDiscoveryMutationLockFilePath(
  rootDirectoryPath?: string,
): string {
  return path.join(
    normalizeRootDirectoryPath(rootDirectoryPath),
    REGISTRY_MUTATION_LOCK_FILE_NAME,
  );
}

/** レジストリの変更をプロセス間ロックの下で実行する。変更と解放の失敗を区別し、必要な場合は解放失敗後の復旧も試みる。 */
async function withRegistryMutationLock<T>(
  layout: RegistryLayout,
  kind: RegistryMutationKind,
  observer: RegistryMutationObserver | undefined,
  operation: () => Promise<T>,
  recoverAfterReleaseFailure?: (
    releaseError: unknown,
    result: T,
  ) => Promise<void>,
): Promise<T> {
  const release = await properLockfile.lock(layout.rootDirectoryPath, {
    realpath: false,
    lockfilePath: resolveRuntimeDiscoveryMutationLockFilePath(
      layout.rootDirectoryPath,
    ),
    stale: REGISTRY_MUTATION_LOCK_STALE_MS,
    update: REGISTRY_MUTATION_LOCK_STALE_MS / 4,
    retries: {
      retries: 500,
      factor: 1,
      minTimeout: 50,
      maxTimeout: 50,
    },
  });
  let operationSucceeded = false;
  let result: T | undefined;
  let operationError: unknown;
  try {
    await observer?.(kind);
    result = await operation();
    operationSucceeded = true;
  } catch (error) {
    operationError = error;
  }
  try {
    await release();
  } catch (releaseError) {
    if (operationSucceeded && recoverAfterReleaseFailure) {
      try {
        await recoverAfterReleaseFailure(releaseError, result as T);
      } catch (recoveryError) {
        throw new AggregateError(
          [releaseError, recoveryError],
          "Runtime registry lock release and committed mutation recovery failed.",
        );
      }
    }
    if (!operationSucceeded) {
      throw new AggregateError(
        [operationError, releaseError],
        "Runtime registry mutation and lock release both failed.",
      );
    }
    throw releaseError;
  }
  if (!operationSucceeded) {
    throw operationError;
  }
  return result as T;
}

/** 関連する表示用状態の更新を、公開・回収処理と同じプロセス間ロックで直列化する。 */
export async function withRuntimeDiscoveryRegistryMutationLock<T>(
  rootDirectoryPath: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const root = normalizeRootDirectoryPath(rootDirectoryPath);
  return withRegistryMutationLock(
    {
      rootDirectoryPath: root,
      activeDirectoryPath: path.join(root, ACTIVE_DIRECTORY_NAME),
      stagingDirectoryPath: path.join(root, STAGING_DIRECTORY_NAME),
      retiredDirectoryPath: path.join(root, RETIRED_DIRECTORY_NAME),
    },
    "projection",
    undefined,
    operation,
  );
}

/** ファイルシステム操作の失敗が、対象の消失を示す ENOENT か判定する。 */
function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** スロットの移動が既存ディレクトリとの競合で失敗した場合に扱うエラーコードか調べる。 */
function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

/** リンクを辿らずに対象の属性を読み、対象なしの場合だけ null を返す。 */
async function lstatSafe(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throw error;
  }
}

/** プラットフォームの保護処理を呼び、失敗をレジストリの保護エラーとして伝える。 */
async function applyPathSecurity(
  targetPath: string,
  targetKind: RuntimePathTargetKind,
  security: RuntimePathSecurity,
): Promise<void> {
  try {
    await security(targetPath, targetKind);
  } catch (error) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry path security validation failed.",
      { cause: error },
    );
  }
}

/** ディレクトリを用意し、アクセス保護の適用前後でリンクではないディレクトリであることを確かめる。 */
async function secureDirectory(
  directoryPath: string,
  security: RuntimePathSecurity,
): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const createdStats = await lstat(directoryPath);
  if (!createdStats.isDirectory() || createdStats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry directory is unsafe.",
    );
  }
  await applyPathSecurity(directoryPath, "directory", security);
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry directory is unsafe.",
    );
  }
}

/** レジストリルートと公開・準備・退役用のディレクトリを用意し、それぞれにアクセス保護を適用する。 */
async function ensureRegistryLayout(
  options: RuntimeDiscoveryRegistryLayoutOptions,
): Promise<RegistryLayout> {
  const rootDirectoryPath = normalizeRootDirectoryPath(
    options.rootDirectoryPath,
  );
  const activeDirectoryPath = path.join(
    rootDirectoryPath,
    ACTIVE_DIRECTORY_NAME,
  );
  const stagingDirectoryPath = path.join(
    rootDirectoryPath,
    STAGING_DIRECTORY_NAME,
  );
  const retiredDirectoryPath = path.join(
    rootDirectoryPath,
    RETIRED_DIRECTORY_NAME,
  );
  await secureDirectory(rootDirectoryPath, options.security);
  await secureDirectory(activeDirectoryPath, options.security);
  await secureDirectory(stagingDirectoryPath, options.security);
  await secureDirectory(retiredDirectoryPath, options.security);
  return {
    rootDirectoryPath,
    activeDirectoryPath,
    stagingDirectoryPath,
    retiredDirectoryPath,
  };
}

/** 公開メタデータを、ファイルへ保存する末尾改行付きの JSON に変換する。 */
function serializeEntry(entry: RuntimeDiscoveryRegistryEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/** リンクではない通常ファイルから登録を読み、JSON とスキーマを検査する。 */
async function readEntryFile(
  entryFilePath: string,
): Promise<RuntimeDiscoveryRegistryEntry> {
  const stats = await lstat(entryFilePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry entry file is unsafe.",
    );
  }
  const contents = await readFile(entryFilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry entry is not valid JSON.",
      { cause: error },
    );
  }
  return parseRuntimeDiscoveryRegistryEntry(parsed);
}

/** 番号付きの公開スロットを調べ、登録を読み取る。認証ファイルだけの異常では登録を捨てず、問題を併記する。 */
async function readRecordFromSlot(
  activeDirectoryPath: string,
  slotName: string,
): Promise<{
  record: RuntimeDiscoveryRegistryRecord | null;
  issue?: RuntimeDiscoveryRegistryListIssue;
}> {
  const slotDirectoryPath = path.join(activeDirectoryPath, slotName);
  const slotStats = await lstatSafe(slotDirectoryPath);
  if (!slotStats) {
    return { record: null };
  }
  if (!slotStats.isDirectory() || slotStats.isSymbolicLink()) {
    return { record: null, issue: { slotName, code: "unsafe_slot" } };
  }
  let entry: RuntimeDiscoveryRegistryEntry;
  try {
    entry = await readEntryFile(
      path.join(slotDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
    );
  } catch {
    return { record: null, issue: { slotName, code: "invalid_entry" } };
  }
  let credentialIssue: RuntimeDiscoveryRegistryListIssue | undefined;
  for (const adapter of entry.adapters) {
    if (
      adapter.credentialFileName !==
      buildRuntimeDiscoveryCredentialFileName(entry, adapter.adapterKind)
    ) {
      return { record: null, issue: { slotName, code: "invalid_entry" } };
    }
    const credentialPath = path.join(
      slotDirectoryPath,
      adapter.credentialFileName,
    );
    let credentialStats: Awaited<ReturnType<typeof lstatSafe>>;
    try {
      credentialStats = await lstatSafe(credentialPath);
    } catch {
      credentialIssue ??= { slotName, code: "unsafe_credential" };
      continue;
    }
    if (!credentialStats) {
      credentialIssue ??= { slotName, code: "missing_credential" };
      continue;
    }
    if (!credentialStats.isFile() || credentialStats.isSymbolicLink()) {
      credentialIssue ??= { slotName, code: "unsafe_credential" };
    }
  }
  return {
    record: { slotName, entry, slotDirectoryPath },
    ...(credentialIssue ? { issue: credentialIssue } : {}),
  };
}

/** 上限内の公開スロットを順に読み、登録と問題を集める。公開領域がまだ存在しなければ空とする。 */
export async function listRuntimeDiscoveryRegistryEntries(
  rootDirectoryPath?: string,
  limitsOverride: Partial<RuntimeDiscoveryRegistryLimits> = {},
): Promise<RuntimeDiscoveryRegistrySnapshot> {
  const limits = normalizeRuntimeDiscoveryRegistryLimits(limitsOverride);
  const activeDirectoryPath = path.join(
    normalizeRootDirectoryPath(rootDirectoryPath),
    ACTIVE_DIRECTORY_NAME,
  );
  const activeStats = await lstatSafe(activeDirectoryPath);
  if (!activeStats) {
    return { records: [], issues: [] };
  }
  if (!activeStats.isDirectory() || activeStats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry active directory is unsafe.",
    );
  }
  const records: RuntimeDiscoveryRegistryRecord[] = [];
  const issues: RuntimeDiscoveryRegistryListIssue[] = [];
  for (let index = 0; index < limits.maxEntries; index += 1) {
    const result = await readRecordFromSlot(
      activeDirectoryPath,
      buildRuntimeDiscoverySlotName(index),
    );
    if (result.record) {
      records.push(result.record);
    }
    if (result.issue) {
      issues.push(result.issue);
    }
  }
  return { records, issues };
}

/** 登録が参照するアダプターの認証ファイルを読む。参照がないか安全に読み取れない場合は null を返す。 */
export async function readRuntimeDiscoveryCredential(
  record: RuntimeDiscoveryRegistryRecord,
  adapterKind: string,
): Promise<string | null> {
  const reference = record.entry.adapters.find(
    (adapter) => adapter.adapterKind === adapterKind,
  );
  if (!reference) {
    return null;
  }
  const credentialPath = path.join(
    record.slotDirectoryPath,
    reference.credentialFileName,
  );
  try {
    const stats = await lstatSafe(credentialPath);
    if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
      return null;
    }
    return await readFile(credentialPath, "utf8");
  } catch {
    return null;
  }
}

/** ファイルを排他的に作成し、内容の読み戻し後にアクセス保護を適用して種別を再確認する。 */
async function writeExclusiveSecureFile(
  targetPath: string,
  contents: string | Uint8Array,
  security: RuntimePathSecurity,
): Promise<void> {
  await writeExclusiveFileWithReadBack(targetPath, contents);
  await applyPathSecurity(targetPath, "file", security);
  const stats = await lstat(targetPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry file is unsafe.",
    );
  }
}

/** 既存パスを上書きせずにファイルを作り、同期・クローズ後に種別と保存バイト列を検証する。 */
async function writeExclusiveFileWithReadBack(
  targetPath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const handle = await open(targetPath, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const writtenStats = await lstat(targetPath);
  if (!writtenStats.isFile() || writtenStats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry file is unsafe.",
    );
  }
  const readBack = await readFile(targetPath);
  const expected =
    typeof contents === "string"
      ? Buffer.from(contents, "utf8")
      : Buffer.from(contents);
  if (!readBack.equals(expected)) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_io",
      "Runtime registry file read-back failed.",
    );
  }
}

/** ハートビート更新用の置換ファイルをスロット内に準備し、作成に失敗した一時ファイルは除去する。 */
async function prepareEntryReplacement(
  slotDirectoryPath: string,
  entry: RuntimeDiscoveryRegistryEntry,
): Promise<string> {
  const temporaryFilePath = path.join(
    slotDirectoryPath,
    `entry-${randomUUID()}.tmp`,
  );
  try {
    // 公開前にスロットディレクトリのアクセスを制限し、設定を読み戻して確認済み。
    // 内部に作成したファイルはその ACL を継承するため、ハートビート処理は
    // OS ユーザー単位の変更ロックを保持中に、プラットフォームの ACL ヘルパーを起動しない。
    await writeExclusiveFileWithReadBack(
      temporaryFilePath,
      serializeEntry(entry),
    );
    return temporaryFilePath;
  } catch (error) {
    await rm(temporaryFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 時刻の差をミリ秒で返し、基準時刻より新しい値の経過時間はゼロとする。 */
function elapsedSince(timestamp: string, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(timestamp));
}

/** スロットを再読し、所有者・公開 ID・ハートビートが観測時とすべて等しい場合だけ登録を返す。 */
async function readUnchangedRecord(
  record: RuntimeDiscoveryRegistryRecord,
): Promise<RuntimeDiscoveryRegistryRecord | null> {
  const result = await readRecordFromSlot(
    path.dirname(record.slotDirectoryPath),
    record.slotName,
  );
  if (
    !result.record ||
    !isSameRuntimeDiscoveryIdentity(result.record.entry, record.entry) ||
    result.record.entry.publicationId !== record.entry.publicationId ||
    result.record.entry.lease.heartbeatAt !== record.entry.lease.heartbeatAt
  ) {
    return null;
  }
  return result.record;
}

/** 観測後に所有やリースが変わっていない登録だけを、変更ロック内で公開領域から退役領域に移す。 */
async function retireUnchangedRecord(
  record: RuntimeDiscoveryRegistryRecord,
  layout: RegistryLayout,
  mutationObserver?: RegistryMutationObserver,
): Promise<string | null> {
  return withRegistryMutationLock(
    layout,
    "retire",
    mutationObserver,
    async () => {
      const unchanged = await readUnchangedRecord(record);
      if (!unchanged) {
        return null;
      }
      const destinationPath = path.join(
        layout.retiredDirectoryPath,
        `retired-${randomUUID()}`,
      );
      try {
        await rename(unchanged.slotDirectoryPath, destinationPath);
        return destinationPath;
      } catch (error) {
        if (isMissingError(error) || isAlreadyExistsError(error)) {
          return null;
        }
        throw error;
      }
    },
  );
}

/** 指定形式に合う古い通常ディレクトリを、今回の回収上限まで削除する。既に消えたものは件数に含めない。 */
async function removeAgedArtifacts(
  directoryPath: string,
  namePattern: RegExp,
  minimumAgeMs: number,
  now: Date,
  maximumRemovals: number,
): Promise<number> {
  const names = await readdir(directoryPath);
  let removed = 0;
  for (const name of names) {
    if (!namePattern.test(name)) {
      continue;
    }
    if (removed >= maximumRemovals) {
      break;
    }
    const artifactPath = path.join(directoryPath, name);
    const stats = await lstatSafe(artifactPath);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      continue;
    }
    if (now.getTime() - stats.mtimeMs < minimumAgeMs) {
      continue;
    }
    try {
      await rm(artifactPath, { recursive: true, force: false });
      removed += 1;
    } catch (error) {
      if (!isMissingError(error)) {
        throw error;
      }
    }
  }
  return removed;
}

/** 年齢条件を満たし接続確認に応答しない登録を退役させ、準備・退役領域の古い成果物を上限付きで回収する。 */
export async function maintainRuntimeDiscoveryRegistry(
  options: RuntimeDiscoveryRegistryLayoutOptions & {
    challenge: RuntimeDiscoveryRegistryChallenge;
    capacityPressure?: boolean;
  },
): Promise<RuntimeDiscoveryRegistryMaintenanceResult> {
  const layout = await ensureRegistryLayout(options);
  const limits = normalizeRuntimeDiscoveryRegistryLimits(options.limits);
  const clock = options.clock ?? SYSTEM_RUNTIME_DISCOVERY_CLOCK;
  const now = clock.now();
  const minimumEntryAge = options.capacityPressure
    ? limits.staleThresholdMs + limits.capacityCleanupGraceMs
    : limits.retentionMs;
  const snapshot = await listRuntimeDiscoveryRegistryEntries(
    layout.rootDirectoryPath,
    limits,
  );
  let retiredEntries = 0;
  for (const record of snapshot.records) {
    if (elapsedSince(record.entry.lease.heartbeatAt, now) <= minimumEntryAge) {
      continue;
    }
    let challengeSucceeded = false;
    try {
      challengeSucceeded = await options.challenge(
        record.entry,
        record.slotDirectoryPath,
      );
    } catch {
      challengeSucceeded = false;
    }
    if (challengeSucceeded) {
      continue;
    }
    const retiredPath = await retireUnchangedRecord(
      record,
      layout,
      options.mutationObserver,
    );
    if (retiredPath) {
      retiredEntries += 1;
      await rm(retiredPath, { recursive: true, force: false });
    }
  }
  const removedStagingArtifacts = await removeAgedArtifacts(
    layout.stagingDirectoryPath,
    STAGING_NAME_PATTERN,
    limits.capacityCleanupGraceMs,
    now,
    limits.maxEntries,
  );
  const removedRetiredArtifacts = await removeAgedArtifacts(
    layout.retiredDirectoryPath,
    RETIRED_NAME_PATTERN,
    limits.retentionMs,
    now,
    limits.maxEntries,
  );
  return { retiredEntries, removedStagingArtifacts, removedRetiredArtifacts };
}

/** 一つ以上のアダプターについて重複と JSON 化の可否を検査し、認証ファイル名と保存内容を確定する。 */
function serializeCredentialDocuments(
  identity: RuntimeDiscoveryIdentity,
  credentialDocuments: RuntimeDiscoveryCredentialDocument[],
): SerializedRuntimeDiscoveryCredentialDocument[] {
  if (credentialDocuments.length === 0) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_configuration",
      "At least one runtime credential document is required.",
    );
  }
  const adapterKinds = new Set<string>();
  return credentialDocuments.map(({ adapterKind, document }) => {
    if (adapterKinds.has(adapterKind)) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "Runtime credential adapter kinds must be unique.",
      );
    }
    adapterKinds.add(adapterKind);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(document);
    } catch (error) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "Runtime credential document is not JSON serializable.",
        { cause: error },
      );
    }
    if (serialized === undefined) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "Runtime credential document is not JSON serializable.",
      );
    }
    return {
      adapterKind,
      credentialFileName: buildRuntimeDiscoveryCredentialFileName(
        identity,
        adapterKind,
      ),
      contents: `${serialized}\n`,
    };
  });
}

/** 公開時刻を初回ハートビートにも使い、認証ファイル参照を持つ登録メタデータを構築して検証する。 */
function buildEntry(
  options: PublishRuntimeDiscoveryEntryOptions,
  clock: RuntimeDiscoveryClock,
  publicationId: string,
  credentialDocuments: SerializedRuntimeDiscoveryCredentialDocument[],
): RuntimeDiscoveryRegistryEntry {
  const timestamp = clock.now().toISOString();
  return parseRuntimeDiscoveryRegistryEntry({
    schemaVersion: RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION,
    ...options.identity,
    buildChannel: options.buildChannel,
    process: options.process,
    publicationId,
    publishedAt: timestamp,
    lease: { heartbeatAt: timestamp },
    adapters: credentialDocuments.map(
      ({ adapterKind, credentialFileName }) => ({
        adapterKind,
        credentialFileName,
      }),
    ),
  });
}

/** 登録が参照する認証ファイルの集合と本文が、今回の公開用に用意した内容と一致するか確かめる。 */
async function credentialsMatch(
  record: RuntimeDiscoveryRegistryRecord,
  credentialDocuments: SerializedRuntimeDiscoveryCredentialDocument[],
): Promise<boolean> {
  if (record.entry.adapters.length !== credentialDocuments.length) {
    return false;
  }
  for (const document of credentialDocuments) {
    const current = await readRuntimeDiscoveryCredential(
      record,
      document.adapterKind,
    );
    if (current !== document.contents) {
      return false;
    }
  }
  return true;
}

/** 上限内の公開スロットから、指定したインスタンス・種別・世代の組に一致する登録を探す。 */
async function findExactRecord(
  rootDirectoryPath: string,
  identity: RuntimeDiscoveryIdentity,
  limits: RuntimeDiscoveryRegistryLimits,
): Promise<RuntimeDiscoveryRegistryRecord | null> {
  const snapshot = await listRuntimeDiscoveryRegistryEntries(
    rootDirectoryPath,
    limits,
  );
  return (
    snapshot.records.find((record) =>
      isSameRuntimeDiscoveryIdentity(record.entry, identity),
    ) ?? null
  );
}

/** 公開済みの一件に対し、同じ公開 ID のリース更新と退役・回収だけを扱う所有者ハンドルを作る。 */
function createPublicationHandle(args: {
  layout: RegistryLayout;
  record: RuntimeDiscoveryRegistryRecord;
  clock: RuntimeDiscoveryClock;
  timers: RuntimeDiscoveryTimers;
  limits: RuntimeDiscoveryRegistryLimits;
  onHeartbeatError?: (error: unknown) => void;
  mutationObserver?: RegistryMutationObserver;
}): RuntimeDiscoveryRegistryPublication {
  let currentEntry = args.record.entry;
  let heartbeatHandle: RuntimeDiscoveryTimerHandle | null = null;
  let serializedOperation = Promise.resolve<void>(undefined);
  let retiredDirectoryPath: string | null = null;
  let unpublished = false;

  /** スロットが再利用されても他者を操作しないよう、識別子の組と公開 ID の両方を比較する。 */
  const isOwnedEntry = (entry: RuntimeDiscoveryRegistryEntry): boolean =>
    isSameRuntimeDiscoveryIdentity(entry, currentEntry) &&
    entry.publicationId === currentEntry.publicationId;

  /** 同じハンドルの操作を呼び出し順に実行し、失敗した操作の後も次の操作を進める。 */
  const runSerialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = serializedOperation;
    let release: (() => void) | undefined;
    serializedOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  /** 置換ファイルを準備し、プロセス間ロック内で所有を再確認してからリースを更新する。 */
  const refreshHeartbeat = async (): Promise<boolean> =>
    runSerialized(async () => {
      if (unpublished) {
        return false;
      }
      const nextEntry = {
        ...currentEntry,
        lease: { heartbeatAt: args.clock.now().toISOString() },
      };
      const temporaryFilePath = await prepareEntryReplacement(
        args.record.slotDirectoryPath,
        nextEntry,
      );
      try {
        return await withRegistryMutationLock(
          args.layout,
          "heartbeat",
          args.mutationObserver,
          async () => {
            if (unpublished) {
              return false;
            }
            const readBack = await readRecordFromSlot(
              args.layout.activeDirectoryPath,
              args.record.slotName,
            );
            if (!readBack.record || !isOwnedEntry(readBack.record.entry)) {
              return false;
            }
            await rename(
              temporaryFilePath,
              path.join(
                readBack.record.slotDirectoryPath,
                RUNTIME_DISCOVERY_ENTRY_FILE_NAME,
              ),
            );
            const committed = await readRecordFromSlot(
              args.layout.activeDirectoryPath,
              args.record.slotName,
            );
            if (
              !committed.record ||
              !isOwnedEntry(committed.record.entry) ||
              committed.record.entry.lease.heartbeatAt !==
                nextEntry.lease.heartbeatAt
            ) {
              throw new RuntimeDiscoveryRegistryError(
                "registry_io",
                "Runtime registry heartbeat read-back failed.",
              );
            }
            currentEntry = committed.record.entry;
            return true;
          },
        );
      } finally {
        await rm(temporaryFilePath, { force: true }).catch(() => undefined);
      }
    });

  /** 定期更新の予約を解除し、その時点までにキューに入った操作の終了を待つ。 */
  const stopHeartbeat = async (): Promise<void> => {
    if (heartbeatHandle) {
      args.timers.clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
    await serializedOperation;
  };

  /** リースの定期更新を止め、なお所有する公開スロットだけを退役領域へ移し、回収先を保持する。 */
  const unpublish = async (): Promise<boolean> => {
    await stopHeartbeat();
    return runSerialized(() =>
      withRegistryMutationLock(
        args.layout,
        "unpublish",
        args.mutationObserver,
        async () => {
          if (unpublished) {
            return false;
          }
          const readBack = await readRecordFromSlot(
            args.layout.activeDirectoryPath,
            args.record.slotName,
          );
          if (!readBack.record || !isOwnedEntry(readBack.record.entry)) {
            unpublished = true;
            return false;
          }
          const destinationPath = path.join(
            args.layout.retiredDirectoryPath,
            `retired-${randomUUID()}`,
          );
          try {
            await rename(readBack.record.slotDirectoryPath, destinationPath);
            retiredDirectoryPath = destinationPath;
            unpublished = true;
            return true;
          } catch (error) {
            if (isMissingError(error)) {
              unpublished = true;
              return false;
            }
            if (isAlreadyExistsError(error)) {
              return false;
            }
            throw error;
          }
        },
      ),
    );
  };

  /** 退役先に残る自分の登録を確かめ、その公開に由来するディレクトリを回収する。 */
  const cleanupGeneration = async (): Promise<boolean> =>
    runSerialized(async () => {
      if (!retiredDirectoryPath) {
        return false;
      }
      try {
        const entry = await readEntryFile(
          path.join(retiredDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
        );
        if (!isOwnedEntry(entry)) {
          return false;
        }
        await rm(retiredDirectoryPath, { recursive: true, force: false });
        retiredDirectoryPath = null;
        return true;
      } catch (error) {
        if (isMissingError(error)) {
          retiredDirectoryPath = null;
          return false;
        }
        throw error;
      }
    });

  return {
    /** 最後に公開または読み戻しで確認した登録メタデータを返す。 */
    get entry() {
      return currentEntry;
    },
    slotName: args.record.slotName,
    /** 定期更新の二重登録と公開解除後の再開を防ぎ、更新の失敗は観測用コールバックへ伝える。 */
    startHeartbeat() {
      if (heartbeatHandle || unpublished) {
        return;
      }
      heartbeatHandle = args.timers.setInterval(() => {
        void refreshHeartbeat().catch((error) =>
          args.onHeartbeatError?.(error),
        );
      }, args.limits.heartbeatMs);
    },
    refreshHeartbeat,
    stopHeartbeat,
    unpublish,
    cleanupGeneration,
  };
}

/** 今回確保したスロットに同じ公開 ID が残っていれば撤回し、同じ識別子の登録が公開領域に残るかを確認する。 */
async function rollbackRuntimeDiscoveryPublication(input: {
  layout: RegistryLayout;
  entry: RuntimeDiscoveryRegistryEntry;
  publicationId: string;
  claimedSlotPath: string | null;
  limits: RuntimeDiscoveryRegistryLimits;
}): Promise<boolean> {
  if (input.claimedSlotPath) {
    const slotName = path.basename(input.claimedSlotPath);
    const readBack = await readRecordFromSlot(
      input.layout.activeDirectoryPath,
      slotName,
    ).catch(() => ({ record: null }));
    if (
      readBack.record &&
      isSameRuntimeDiscoveryIdentity(readBack.record.entry, input.entry) &&
      readBack.record.entry.publicationId === input.publicationId
    ) {
      const rollbackPath = path.join(
        input.layout.retiredDirectoryPath,
        `retired-${randomUUID()}`,
      );
      try {
        await rename(input.claimedSlotPath, rollbackPath);
        await rm(rollbackPath, { recursive: true, force: false });
      } catch (rollbackError) {
        if (!isMissingError(rollbackError)) {
          const current = await readRecordFromSlot(
            input.layout.activeDirectoryPath,
            slotName,
          );
          if (
            current.record &&
            isSameRuntimeDiscoveryIdentity(current.record.entry, input.entry) &&
            current.record.entry.publicationId === input.publicationId
          ) {
            await rm(input.claimedSlotPath, { recursive: true, force: false });
          }
        }
      }
    }
  }
  return !(await findExactRecord(
    input.layout.rootDirectoryPath,
    input.entry,
    input.limits,
  ));
}

/** 準備領域に保護済みの登録と認証ファイルをそろえ、空きスロットへまとめて移動して公開する。読み戻しに成功した場合のみ所有者ハンドルを返す。 */
export async function publishRuntimeDiscoveryEntry(
  options: PublishRuntimeDiscoveryEntryOptions,
): Promise<RuntimeDiscoveryRegistryPublication> {
  const limits = normalizeRuntimeDiscoveryRegistryLimits(options.limits);
  const clock = options.clock ?? SYSTEM_RUNTIME_DISCOVERY_CLOCK;
  const timers = options.timers ?? SYSTEM_RUNTIME_DISCOVERY_TIMERS;
  const layout = await ensureRegistryLayout(options);
  const credentialDocuments = serializeCredentialDocuments(
    options.identity,
    options.credentialDocuments,
  );
  const publicationId = randomUUID();
  const entry = buildEntry(options, clock, publicationId, credentialDocuments);

  const existing = await findExactRecord(
    layout.rootDirectoryPath,
    options.identity,
    limits,
  );
  if (existing) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_conflict",
      "The runtime identity tuple is already owned by another publication.",
    );
  }

  await maintainRuntimeDiscoveryRegistry({
    ...options,
    capacityPressure: false,
  });
  let snapshot = await listRuntimeDiscoveryRegistryEntries(
    layout.rootDirectoryPath,
    limits,
  );
  let occupiedSlots = new Set(
    snapshot.records.map((record) => record.slotName),
  );
  for (const issue of snapshot.issues) {
    occupiedSlots.add(issue.slotName);
  }
  if (occupiedSlots.size >= limits.maxEntries) {
    await maintainRuntimeDiscoveryRegistry({
      ...options,
      capacityPressure: true,
    });
    snapshot = await listRuntimeDiscoveryRegistryEntries(
      layout.rootDirectoryPath,
      limits,
    );
    occupiedSlots = new Set(snapshot.records.map((record) => record.slotName));
    for (const issue of snapshot.issues) {
      occupiedSlots.add(issue.slotName);
    }
  }

  if (occupiedSlots.size >= limits.maxEntries) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_capacity",
      "The runtime discovery registry has no safe publication capacity.",
    );
  }

  const stagingDirectoryPath = path.join(
    layout.stagingDirectoryPath,
    `stage-${randomUUID()}`,
  );
  await mkdir(stagingDirectoryPath, { recursive: false, mode: 0o700 });
  let committedRecord: RuntimeDiscoveryRegistryRecord | null = null;
  let claimedSlotPath: string | null = null;
  let publicationProjectionPrepared = false;
  /** 今回の登録を撤回し、表示用状態の準備後かつ撤回が確認できた場合に限り、表示側の復旧フックを呼ぶ。 */
  const rollbackPreparedPublication = async (): Promise<void> => {
    const rollbackComplete = await rollbackRuntimeDiscoveryPublication({
      layout,
      entry,
      publicationId,
      claimedSlotPath,
      limits,
    });
    if (publicationProjectionPrepared && rollbackComplete) {
      await options.afterPublicationRollback?.();
    }
  };
  try {
    const stagingStats = await lstat(stagingDirectoryPath);
    if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_security",
        "Runtime registry staging directory is unsafe.",
      );
    }
    await applyPathSecurity(
      stagingDirectoryPath,
      "directory",
      options.security,
    );
    const securedStagingStats = await lstat(stagingDirectoryPath);
    if (
      !securedStagingStats.isDirectory() ||
      securedStagingStats.isSymbolicLink()
    ) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_security",
        "Runtime registry staging directory is unsafe.",
      );
    }
    for (const document of credentialDocuments) {
      await writeExclusiveSecureFile(
        path.join(stagingDirectoryPath, document.credentialFileName),
        document.contents,
        options.security,
      );
    }
    await writeExclusiveSecureFile(
      path.join(stagingDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
      serializeEntry(entry),
      options.security,
    );
    await readEntryFile(
      path.join(stagingDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
    );

    await options.beforePublicationLock?.();
    await withRegistryMutationLock(
      layout,
      "publish",
      options.mutationObserver,
      async () => {
        try {
          const lockedSnapshot = await listRuntimeDiscoveryRegistryEntries(
            layout.rootDirectoryPath,
            limits,
          );
          occupiedSlots = new Set(
            lockedSnapshot.records.map((record) => record.slotName),
          );
          for (const issue of lockedSnapshot.issues) {
            occupiedSlots.add(issue.slotName);
          }
          if (
            lockedSnapshot.records.some((record) =>
              isSameRuntimeDiscoveryIdentity(record.entry, options.identity),
            )
          ) {
            throw new RuntimeDiscoveryRegistryError(
              "registry_conflict",
              "The runtime identity tuple is already owned by another publication.",
            );
          }

          for (let index = 0; index < limits.maxEntries; index += 1) {
            const slotName = buildRuntimeDiscoverySlotName(index);
            if (occupiedSlots.has(slotName)) {
              continue;
            }
            const slotDirectoryPath = path.join(
              layout.activeDirectoryPath,
              slotName,
            );
            try {
              if (!publicationProjectionPrepared) {
                publicationProjectionPrepared = true;
                await options.beforePublicationCommit?.();
              }
              await rename(stagingDirectoryPath, slotDirectoryPath);
              claimedSlotPath = slotDirectoryPath;
            } catch (error) {
              const exactAfterFailure = await findExactRecord(
                layout.rootDirectoryPath,
                options.identity,
                limits,
              );
              if (
                exactAfterFailure &&
                exactAfterFailure.entry.publicationId === publicationId &&
                (await credentialsMatch(exactAfterFailure, credentialDocuments))
              ) {
                claimedSlotPath = exactAfterFailure.slotDirectoryPath;
                const readBackAfterFailure = await readRecordFromSlot(
                  layout.activeDirectoryPath,
                  exactAfterFailure.slotName,
                );
                if (
                  !readBackAfterFailure.record ||
                  readBackAfterFailure.record.entry.publicationId !==
                    publicationId ||
                  !isSameRuntimeDiscoveryIdentity(
                    readBackAfterFailure.record.entry,
                    entry,
                  ) ||
                  !(await credentialsMatch(
                    readBackAfterFailure.record,
                    credentialDocuments,
                  ))
                ) {
                  throw new RuntimeDiscoveryRegistryError(
                    "registry_io",
                    "Runtime registry publication read-back failed.",
                  );
                }
                committedRecord = readBackAfterFailure.record;
                break;
              }
              if (isAlreadyExistsError(error)) {
                occupiedSlots.add(slotName);
                continue;
              }
              throw error;
            }
            const securedSlotStats = await lstat(slotDirectoryPath);
            if (
              !securedSlotStats.isDirectory() ||
              securedSlotStats.isSymbolicLink()
            ) {
              throw new RuntimeDiscoveryRegistryError(
                "registry_security",
                "Runtime registry slot directory is unsafe.",
              );
            }
            const result = await readRecordFromSlot(
              layout.activeDirectoryPath,
              slotName,
            );
            if (
              !result.record ||
              !isSameRuntimeDiscoveryIdentity(result.record.entry, entry) ||
              result.record.entry.publicationId !== publicationId ||
              !(await credentialsMatch(result.record, credentialDocuments))
            ) {
              throw new RuntimeDiscoveryRegistryError(
                "registry_io",
                "Runtime registry publication read-back failed.",
              );
            }
            committedRecord = result.record;
            break;
          }
          if (!committedRecord) {
            throw new RuntimeDiscoveryRegistryError(
              "registry_capacity",
              "The runtime discovery registry filled during publication.",
            );
          }
        } catch (error) {
          await rollbackPreparedPublication();
          throw error;
        }
      },
      async () => {
        // proper-lockfile は、ロックディレクトリを削除する前に所有権の更新を停止する。
        // 削除に失敗するとロックディレクトリが残り、
        // 期限切れからの復旧まで他のプロセスを排除し続ける。
        // そのため、確定済みの公開状態を整合させてから呼び出し元に失敗を返す。
        await rollbackPreparedPublication();
      },
    );
  } finally {
    await rm(stagingDirectoryPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  if (!committedRecord) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_io",
      "Runtime registry publication did not commit.",
    );
  }

  return createPublicationHandle({
    layout,
    record: committedRecord,
    clock,
    timers,
    limits,
    onHeartbeatError: options.onHeartbeatError,
    mutationObserver: options.mutationObserver,
  });
}
