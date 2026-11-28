import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/** レジストリの登録ファイルが従うスキーマ識別子。 */
export const RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION =
  "withmate-runtime-discovery-entry-v1" as const;
/** WithMate のデータ領域内でランタイム検出用レジストリを置くディレクトリ名。 */
export const RUNTIME_DISCOVERY_REGISTRY_DIRECTORY_NAME =
  "runtime-discovery" as const;
/** ディスク上のレジストリレイアウトの版を分離するためのディレクトリ名。 */
export const RUNTIME_DISCOVERY_REGISTRY_VERSION_DIRECTORY_NAME = "v1" as const;
/** 各公開スロットに一つ置く登録メタデータファイルの名前。 */
export const RUNTIME_DISCOVERY_ENTRY_FILE_NAME = "entry.json" as const;

/** 公開側がリース時刻を更新する既定間隔。 */
export const RUNTIME_DISCOVERY_DEFAULT_HEARTBEAT_MS = 5_000;
/** 最後のリース更新からこの時間を超えると、既定では期限切れとみなす。 */
export const RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS = 20_000;
/** 容量逼迫時に期限切れで応答不能な登録を回収するまでの既定の猶予。 */
export const RUNTIME_DISCOVERY_DEFAULT_CAPACITY_CLEANUP_GRACE_MS = 60_000;
/** 通常時の期限切れ登録や一時・退役成果物の回収に使う既定の保持期間。 */
export const RUNTIME_DISCOVERY_DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** 有効な登録が占有できるスロット数の既定の上限。 */
export const RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES = 64;
/** レジストリのレイアウトが許容するスロット番号の総数。 */
export const RUNTIME_DISCOVERY_SLOT_COUNT = 64;

/** 利用者が候補を区別するために使う、実行中ビルドの配布・起動区分。 */
export type RuntimeBuildChannel =
  "installed" | "development" | "visual-check" | "unknown";
/** 検出レジストリを共有するランタイムの種別。既知の種別以外も登録できる。 */
export type RuntimeKind = "memory" | (string & {});

/** 同一アプリケーション内でも種別と起動世代を区別する、登録の識別子の組。 */
export type RuntimeDiscoveryIdentity = {
  applicationInstanceId: string;
  runtimeKind: RuntimeKind;
  runtimeGenerationId: string;
};

/** 登録スロットと同じディレクトリにある、アダプター別認証情報ファイルへの参照。 */
export type RuntimeDiscoveryAdapterReference = {
  adapterKind: string;
  credentialFileName: string;
};

/** 公開しても安全なレジストリの表示用データからは、認証情報の中身が分からないようにする。 */
export type RuntimeDiscoveryCredentialEnvelope<T = unknown> = {
  schemaVersion: "withmate-runtime-credential-v1";
  applicationInstanceId: string;
  runtimeKind: RuntimeKind;
  adapterKind: string;
  runtimeGenerationId: string;
  credential: T;
};

/** 一つのランタイム公開の識別情報、プロセス、リースおよび認証ファイル参照。秘密情報の本文は別ファイルに置く。 */
export type RuntimeDiscoveryRegistryEntry = RuntimeDiscoveryIdentity & {
  schemaVersion: typeof RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION;
  buildChannel: RuntimeBuildChannel;
  process: {
    pid: number;
    startedAt: string;
  };
  publicationId: string;
  publishedAt: string;
  lease: {
    heartbeatAt: string;
  };
  adapters: RuntimeDiscoveryAdapterReference[];
};

/** 最終ハートビートと現在時刻の差に基づくリース状態。接続の成立までは表さない。 */
export type RuntimeDiscoveryLeaseState = "fresh" | "expired";

/** 候補の診断に渡せるメタデータ。認証情報ファイル名や本文は含まない。 */
export type SafeRuntimeDiscoveryMetadata = RuntimeDiscoveryIdentity & {
  buildChannel: RuntimeBuildChannel;
  pid: number;
  processStartedAt: string;
  publicationId: string;
  publishedAt: string;
  leaseHeartbeatAt: string;
  leaseState: RuntimeDiscoveryLeaseState;
};

/** 候補を一意に選べない場合に、呼び出し側が原因を区別するためのコード。 */
export type RuntimeDiscoverySelectionOutcomeCode =
  | "runtime_unavailable"
  | "runtime_instance_mismatch"
  | "runtime_generation_changed"
  | "runtime_ambiguous"
  | "runtime_stale"
  | "runtime_registry_capacity"
  | "runtime_selector_invalid"
  | "runtime_credential_unavailable"
  | "runtime_invalid";

/** 検索対象の種別と、任意で絞り込むアプリケーションおよびランタイム世代。 */
export type RuntimeDiscoverySelector = {
  runtimeKind: RuntimeKind;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
};

/** 検出した候補の識別情報とメタデータ、または選択を成立させなかった理由。 */
export type RuntimeDiscoverySelectionOutcome =
  | {
      kind: "selected";
      identity: RuntimeDiscoveryIdentity;
      metadata: SafeRuntimeDiscoveryMetadata;
    }
  | {
      kind: "error";
      code: RuntimeDiscoverySelectionOutcomeCode;
      metadata?: SafeRuntimeDiscoveryMetadata[];
    };

/** レジストリの設定、競合、容量、保護、内容、入出力の失敗を区別するコード。 */
export type RuntimeDiscoveryRegistryErrorCode =
  | "registry_configuration"
  | "registry_capacity"
  | "registry_conflict"
  | "registry_invalid_entry"
  | "registry_security"
  | "registry_io";

/** レジストリ操作の失敗を、呼び出し側が処理を分けられる分類コード付きで伝える。 */
export class RuntimeDiscoveryRegistryError extends Error {
  readonly code: RuntimeDiscoveryRegistryErrorCode;

  /** 分類コードと説明を保存し、必要な場合は元の失敗を原因として保持する。 */
  constructor(
    code: RuntimeDiscoveryRegistryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeDiscoveryRegistryError";
    this.code = code;
  }
}

/** リース更新と回収の時間条件、および登録容量を制御する設定。 */
export type RuntimeDiscoveryRegistryLimits = {
  heartbeatMs: number;
  staleThresholdMs: number;
  capacityCleanupGraceMs: number;
  retentionMs: number;
  maxEntries: number;
};

/** 上書き指定がない場合の、リース・回収・スロット容量の設定一式。 */
export const DEFAULT_RUNTIME_DISCOVERY_REGISTRY_LIMITS: Readonly<RuntimeDiscoveryRegistryLimits> =
  {
    heartbeatMs: RUNTIME_DISCOVERY_DEFAULT_HEARTBEAT_MS,
    staleThresholdMs: RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
    capacityCleanupGraceMs: RUNTIME_DISCOVERY_DEFAULT_CAPACITY_CLEANUP_GRACE_MS,
    retentionMs: RUNTIME_DISCOVERY_DEFAULT_RETENTION_MS,
    maxEntries: RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES,
  };

/** リース管理と回収判定で参照する、差し替え可能な時刻源。 */
export type RuntimeDiscoveryClock = {
  /** 今回の経過時間判定や書き込みに使う現在時刻を返す。 */
  now(): Date;
};

/** リース更新に使う周期タイマーを停止するためのハンドル。 */
export type RuntimeDiscoveryTimerHandle = ReturnType<typeof setInterval>;

/** レジストリ公開の周期更新を開始・解除する、差し替え可能なタイマー操作。 */
export type RuntimeDiscoveryTimers = {
  /** 指定したミリ秒間隔で更新処理を予約し、解除に使うハンドルを返す。 */
  setInterval(
    callback: () => void,
    intervalMs: number,
  ): RuntimeDiscoveryTimerHandle;
  /** 指定の周期更新を解除し、新たなタイマー呼び出しを止める。 */
  clearInterval(handle: RuntimeDiscoveryTimerHandle): void;
};

/** 通常運用でレジストリの時刻を実行環境の時計から取得する。 */
export const SYSTEM_RUNTIME_DISCOVERY_CLOCK: RuntimeDiscoveryClock = {
  /** 呼び出した時点のシステム時刻を返す。 */
  now: () => new Date(),
};

/** 通常運用でランタイムの周期処理に Node.js のタイマーを使う。 */
export const SYSTEM_RUNTIME_DISCOVERY_TIMERS: RuntimeDiscoveryTimers = {
  /** Node.js の周期タイマーにハートビート処理を登録する。 */
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  /** 発行済みの Node.js 周期タイマーを解除する。 */
  clearInterval: (handle) => clearInterval(handle),
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ADAPTER_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CREDENTIAL_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,126}\.json$/;
const BUILD_CHANNELS = new Set<RuntimeBuildChannel>([
  "installed",
  "development",
  "visual-check",
  "unknown",
]);

/** 未知の JSON 値が、プロパティを検査できる非配列のオブジェクトか判定する。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 入力の列挙可能な文字列キーがスキーマで列挙したものと過不足なく一致するか調べる。 */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

/** 時刻値が Date で解釈でき、ISO 形式に戻した表記も入力と一致するか調べる。 */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

/** 登録の識別子として受け付ける UUID の構文を検査する。 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** POSIX と Windows の両方で絶対パスでも区切り付きでもない、認証ファイル参照の文字列表記か調べる。 */
export function isSafeRelativeRuntimeDiscoveryReference(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    path.posix.basename(value) === value
  );
}

/** インスタンス ID とランタイム世代 ID が UUID で、種別が所定の文字形式か検査する。 */
export function isRuntimeDiscoveryIdentity(
  value: unknown,
): value is RuntimeDiscoveryIdentity {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.applicationInstanceId === "string" &&
    UUID_PATTERN.test(value.applicationInstanceId) &&
    typeof value.runtimeGenerationId === "string" &&
    UUID_PATTERN.test(value.runtimeGenerationId) &&
    typeof value.runtimeKind === "string" &&
    RUNTIME_KIND_PATTERN.test(value.runtimeKind)
  );
}

/** アダプター種別と認証ファイル名の形式を検査し、登録メタデータ名を使った参照を拒否する。 */
export function isRuntimeDiscoveryAdapterReference(
  value: unknown,
): value is RuntimeDiscoveryAdapterReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["adapterKind", "credentialFileName"])
  ) {
    return false;
  }
  if (
    typeof value.adapterKind !== "string" ||
    !ADAPTER_KIND_PATTERN.test(value.adapterKind)
  ) {
    return false;
  }
  if (
    typeof value.credentialFileName !== "string" ||
    !CREDENTIAL_FILE_NAME_PATTERN.test(value.credentialFileName) ||
    !isSafeRelativeRuntimeDiscoveryReference(value.credentialFileName) ||
    value.credentialFileName === RUNTIME_DISCOVERY_ENTRY_FILE_NAME
  ) {
    return false;
  }
  return true;
}

/** 種別と任意の ID を検査し、アプリケーションを指定せず世代だけを指定した検索を拒否する。 */
export function isRuntimeDiscoverySelector(
  value: unknown,
): value is RuntimeDiscoverySelector {
  if (
    !isRecord(value) ||
    typeof value.runtimeKind !== "string" ||
    !RUNTIME_KIND_PATTERN.test(value.runtimeKind)
  ) {
    return false;
  }
  if (
    value.applicationInstanceId !== undefined &&
    !isUuid(value.applicationInstanceId)
  ) {
    return false;
  }
  if (
    value.runtimeGenerationId !== undefined &&
    !isUuid(value.runtimeGenerationId)
  ) {
    return false;
  }
  return (
    value.runtimeGenerationId === undefined ||
    value.applicationInstanceId !== undefined
  );
}

/** スロット名と認証情報の名前にはハッシュを使い、識別情報の値をファイル名に出さない。 */
export function buildRuntimeDiscoveryEntryFileName(
  identity: RuntimeDiscoveryIdentity,
): string {
  return `entry-${hashRuntimeDiscoveryIdentity(identity)}.json`;
}

/** 登録の識別子とアダプター種別から決定的な認証ファイル名を得る。種別が所定の形式でなければ拒否する。 */
export function buildRuntimeDiscoveryCredentialFileName(
  identity: RuntimeDiscoveryIdentity,
  adapterKind: string,
): string {
  if (!ADAPTER_KIND_PATTERN.test(adapterKind)) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_configuration",
      "Invalid adapter kind.",
    );
  }
  const digest = createHash("sha256")
    .update(
      `${identity.applicationInstanceId}\0${identity.runtimeKind}\0${identity.runtimeGenerationId}\0${adapterKind}`,
    )
    .digest("hex");
  return `credential-${digest}.json`;
}

/** インスタンス・種別・世代を区切ってハッシュにし、識別子を直接公開しない名前の材料を得る。 */
export function hashRuntimeDiscoveryIdentity(
  identity: RuntimeDiscoveryIdentity,
): string {
  return createHash("sha256")
    .update(
      `${identity.applicationInstanceId}\0${identity.runtimeKind}\0${identity.runtimeGenerationId}`,
    )
    .digest("hex");
}

/** 有効な範囲のスロット番号から固定桁のディレクトリ名を作る。範囲外は設定エラーとする。 */
export function buildRuntimeDiscoverySlotName(slot: number): string {
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    slot >= RUNTIME_DISCOVERY_SLOT_COUNT
  ) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_configuration",
      "Runtime registry slot is out of range.",
    );
  }
  return `slot-${String(slot).padStart(2, "0")}`;
}

/** 登録のスキーマとリース・プロセスの値、アダプター参照の形式と一意性を検査する。不正なら登録エラーを返す。 */
export function parseRuntimeDiscoveryRegistryEntry(
  value: unknown,
): RuntimeDiscoveryRegistryEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "applicationInstanceId",
      "runtimeKind",
      "runtimeGenerationId",
      "buildChannel",
      "process",
      "publicationId",
      "publishedAt",
      "lease",
      "adapters",
    ])
  ) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry entry has an invalid shape.",
    );
  }
  if (
    value.schemaVersion !== RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION ||
    !isRuntimeDiscoveryIdentity(value) ||
    typeof (value as RuntimeDiscoveryRegistryEntry).buildChannel !== "string" ||
    !BUILD_CHANNELS.has(
      (value as RuntimeDiscoveryRegistryEntry)
        .buildChannel as RuntimeBuildChannel,
    ) ||
    !isUuid((value as RuntimeDiscoveryRegistryEntry).publicationId) ||
    !isIsoTimestamp((value as RuntimeDiscoveryRegistryEntry).publishedAt)
  ) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry entry metadata is invalid.",
    );
  }
  const entry = value as RuntimeDiscoveryRegistryEntry;
  if (
    !isRecord(entry.process) ||
    !hasExactKeys(entry.process, ["pid", "startedAt"]) ||
    typeof entry.process.pid !== "number" ||
    !Number.isSafeInteger(entry.process.pid) ||
    entry.process.pid <= 0 ||
    !isIsoTimestamp(entry.process.startedAt)
  ) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry process metadata is invalid.",
    );
  }
  if (
    !isRecord(entry.lease) ||
    !hasExactKeys(entry.lease, ["heartbeatAt"]) ||
    !isIsoTimestamp(entry.lease.heartbeatAt)
  ) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry lease metadata is invalid.",
    );
  }
  if (
    !Array.isArray(entry.adapters) ||
    entry.adapters.length === 0 ||
    !entry.adapters.every(isRuntimeDiscoveryAdapterReference)
  ) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry adapter references are invalid.",
    );
  }
  const adapterKinds = new Set<string>();
  const credentialFileNames = new Set<string>();
  for (const adapter of entry.adapters) {
    if (
      adapterKinds.has(adapter.adapterKind) ||
      credentialFileNames.has(adapter.credentialFileName)
    ) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_invalid_entry",
        "Runtime registry adapter references must be unique.",
      );
    }
    adapterKinds.add(adapter.adapterKind);
    credentialFileNames.add(adapter.credentialFileName);
  }
  return value as RuntimeDiscoveryRegistryEntry;
}

/** 公開 ID やスロット位置に依存せず、インスタンス・種別・世代がすべて等しいか判定する。 */
export function isSameRuntimeDiscoveryIdentity(
  left: RuntimeDiscoveryIdentity,
  right: RuntimeDiscoveryIdentity,
): boolean {
  return (
    left.applicationInstanceId === right.applicationInstanceId &&
    left.runtimeKind === right.runtimeKind &&
    left.runtimeGenerationId === right.runtimeGenerationId
  );
}

/** 最後のハートビートからの経過が閾値を超えた場合に限り、リースを期限切れとする。 */
export function getRuntimeDiscoveryLeaseState(
  entry: RuntimeDiscoveryRegistryEntry,
  now: Date,
  staleThresholdMs = RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
): RuntimeDiscoveryLeaseState {
  return now.getTime() - Date.parse(entry.lease.heartbeatAt) > staleThresholdMs
    ? "expired"
    : "fresh";
}

/** 登録から認証ファイル参照を除外し、観測時刻で算出したリース状態とともに返す。 */
export function toSafeRuntimeDiscoveryMetadata(
  entry: RuntimeDiscoveryRegistryEntry,
  now: Date,
  staleThresholdMs = RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
): SafeRuntimeDiscoveryMetadata {
  return {
    applicationInstanceId: entry.applicationInstanceId,
    runtimeKind: entry.runtimeKind,
    runtimeGenerationId: entry.runtimeGenerationId,
    buildChannel: entry.buildChannel,
    pid: entry.process.pid,
    processStartedAt: entry.process.startedAt,
    publicationId: entry.publicationId,
    publishedAt: entry.publishedAt,
    leaseHeartbeatAt: entry.lease.heartbeatAt,
    leaseState: getRuntimeDiscoveryLeaseState(entry, now, staleThresholdMs),
  };
}

/** Windows では絶対パスの LOCALAPPDATA、その他ではユーザー単位の一時領域を基準に、版別のレジストリルートを決める。 */
export function resolveDefaultRuntimeDiscoveryRegistryRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData || !path.win32.isAbsolute(localAppData)) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "LOCALAPPDATA must identify an absolute Windows directory.",
      );
    }
    return path.win32.join(
      localAppData,
      "WithMate",
      RUNTIME_DISCOVERY_REGISTRY_DIRECTORY_NAME,
      RUNTIME_DISCOVERY_REGISTRY_VERSION_DIRECTORY_NAME,
    );
  }

  const ownerSegment =
    typeof process.getuid === "function"
      ? `uid-${process.getuid()}`
      : "local-user";
  return path.join(
    tmpdir(),
    "withmate",
    ownerSegment,
    RUNTIME_DISCOVERY_REGISTRY_DIRECTORY_NAME,
    RUNTIME_DISCOVERY_REGISTRY_VERSION_DIRECTORY_NAME,
  );
}

/** 個別設定を既定値に重ね、正の整数であることと利用可能なスロット数を超えないことを検査する。 */
export function normalizeRuntimeDiscoveryRegistryLimits(
  overrides: Partial<RuntimeDiscoveryRegistryLimits> = {},
): RuntimeDiscoveryRegistryLimits {
  const limits = { ...DEFAULT_RUNTIME_DISCOVERY_REGISTRY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        `Runtime registry limit ${name} must be a positive integer.`,
      );
    }
  }
  if (limits.maxEntries > RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_configuration",
      `Runtime registry maxEntries must not exceed ${RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES}.`,
    );
  }
  return limits;
}
