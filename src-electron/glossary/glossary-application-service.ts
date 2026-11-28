import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { watch, type FSWatcher, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parseDocument, stringify } from "yaml";

import {
  GLOSSARY_LIMITS,
  GLOSSARY_RELATIVE_PATH,
  GLOSSARY_SCHEMA_VERSION,
  normalizeGlossaryLookup,
  type GlossaryCheckoutSummary,
  type GlossaryCreateBatchRequest,
  type GlossaryCreateRequest,
  type GlossaryDeleteRequest,
  type GlossaryEntry,
  type GlossaryEntryInput,
  type GlossaryGetResult,
  type GlossaryListResult,
  type GlossaryMutationResult,
  type GlossaryOperationError,
  type GlossaryOperationErrorCode,
  type GlossaryOperationResult,
  type GlossaryPageRequest,
  type GlossaryProjectionState,
  type GlossarySearchRequest,
  type GlossarySnapshot,
  type GlossaryUpdateRequest,
  type GlossaryValidationIssue,
  type GlossaryValidationResult,
} from "../../src-shared/glossary/glossary-contract.js";

const execFileAsync = promisify(execFile);
const NORMALIZED_REVISION_PATTERN = /^[a-f0-9]{64}$/;

/** 同じパスのファイルやディレクトリが入れ替わったかを見分けるデバイス番号と inode 番号。 */
export type GlossaryFileIdentity = {
  device: bigint;
  inode: bigint;
};

/** チェックアウトのルートパス・実パスと、ルートおよび .git マーカーの実体情報。 */
export type ResolvedGlossaryCheckout = {
  rootPath: string;
  rootRealPath: string;
  rootIdentity: GlossaryFileIdentity;
  gitMarkerIdentity: GlossaryFileIdentity;
};

/** バインディングに保持できるよう、チェックアウトの実体情報を文字列で記録した権限スナップショット。 */
export type GlossaryCheckoutAuthoritySnapshot = {
  rootPath: string;
  rootRealPath: string;
  rootDevice: string;
  rootInode: string;
  gitMarkerDevice: string;
  gitMarkerInode: string;
};

/** 書き込み前に現在許可されているチェックアウトを再取得し、権限が失われた場合は null を返す。 */
export type GlossaryMutationGuard =
  () => Promise<ResolvedGlossaryCheckout | null>;

/** 用語集の監視で使うイベント登録と終了操作だけに絞った監視ハンドル。 */
export type GlossaryWatchHandle = Pick<FSWatcher, "close" | "on">;

/** 指定したパスの変更を通知し、購読を終了できるハンドルを返す監視関数。 */
export type GlossaryWatchPath = (
  targetPath: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => GlossaryWatchHandle;

/** 正常な用語集の読み取り結果に、変更検出に使う原文とファイル実体を加えた内部表現。 */
type ValidRead = Extract<GlossarySnapshot, { status: "valid" }> & {
  raw: string;
  fileIdentity: GlossaryFileIdentity;
};

/** 用語集ファイルが存在せず、リビジョンも取得できない状態。 */
type MissingRead = Extract<GlossarySnapshot, { status: "missing" }>;
/** 不正な文書または未対応のスキーマの判定に、確認時の原文とファイル実体を添えた内部結果。 */
type InvalidRead = Exclude<
  GlossarySnapshot,
  { status: "valid" } | { status: "missing" }
> & {
  raw: string;
  fileIdentity: GlossaryFileIdentity;
};
/** ファイルの欠落・有効・不正・未対応を区別する、読み取り処理の内部結果。 */
type InternalRead = MissingRead | ValidRead | InvalidRead;

/** 用語集ディレクトリの指定パスと実パス、および再確認に使う実体情報。 */
type DirectoryIdentity = {
  path: string;
  realPath: string;
  identity: GlossaryFileIdentity;
};

/** 変更後の全項目と変更前の状態、および他の処理で要求どおりになったかを判定する条件。 */
type MutationPlan = {
  entries: GlossaryEntry[];
  previous: InternalRead;
  isConverged: (snapshot: GlossarySnapshot) => boolean;
};

/** Git とファイル入出力の差し替え、および監視の間隔指定に使う任意の依存設定。 */
export type GlossaryApplicationServiceDeps = {
  runGit?: (cwd: string, args: readonly string[]) => Promise<string>;
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void>;
  renamePath?: (oldPath: string, newPath: string) => Promise<void>;
  watchPath?: GlossaryWatchPath;
  watchDebounceMs?: number;
  watchRetryMs?: number;
  readFileHandle?: (
    handle: FileHandle,
    maxBytes: number,
  ) => Promise<{ raw: string; oversized: boolean }>;
};

/** 処理途中で用語集の操作エラーを送出し、公開操作の境界で結果へ戻すための例外。 */
class GlossaryServiceFailure extends Error {
  readonly error: GlossaryOperationError;

  /** 呼び出し元へ返す構造化エラーを、例外メッセージとともに保持する。 */
  constructor(error: GlossaryOperationError) {
    super(error.message);
    this.name = "GlossaryServiceFailure";
    this.error = error;
  }
}

/** ワークスペースに対象となる Git チェックアウトがないことを、その他の解決失敗と区別する例外。 */
export class GlossaryNotApplicableError extends Error {
  readonly reason = "not-git" as const;

  /** Git 管理外として扱う場合の固定メッセージを持つ例外を作る。 */
  constructor() {
    super("Primary workspace is not a supported Git checkout.");
    this.name = "GlossaryNotApplicableError";
  }
}

/** 用語集の対象外を示す例外かどうかを判別する。 */
export function isGlossaryNotApplicableError(
  error: unknown,
): error is GlossaryNotApplicableError {
  return error instanceof GlossaryNotApplicableError;
}

/** 用語集のファイルがない状態とは区別して、Git 管理外の表示状態を返す。 */
function notApplicableProjectionState(): Extract<
  GlossaryProjectionState,
  { status: "not-applicable" }
> {
  return {
    status: "not-applicable",
    relativePath: GLOSSARY_RELATIVE_PATH,
    revision: null,
    reason: "not-git",
  };
}

/** Git の終了コードと標準エラーの両方から、リポジトリが見つからないことを示す診断か確認する。 */
function isGitNotRepositoryDiagnostic(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const stderr = (error as { stderr?: unknown }).stderr;
  return (
    (code === 128 || code === "128") &&
    typeof stderr === "string" &&
    /^fatal: not a git repository \(or any of the parent directories\): \.git$/u.test(
      stderr.trim(),
    )
  );
}

/** ワークスペースから親をたどって .git マーカーを探す。存在の確認自体が失敗した場合もマーカーなしとは判定しない。 */
async function hasGitMarkerInAncestors(
  workspacePath: string,
): Promise<boolean> {
  let currentPath = path.resolve(workspacePath);
  while (true) {
    try {
      await lstat(path.join(currentPath, ".git"));
      return true;
    } catch (error) {
      if (
        !isNodeError(error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      ) {
        // マーカーを確認できないことを理由に、実際の Git エラーを未設定状態として扱わない。
        return true;
      }
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return false;
    }
    currentPath = parentPath;
  }
}

/** Git の対象外とみなせるのは、該当する診断があり、祖先に .git マーカーも見つからない場合に限る。 */
async function isGitCheckoutResolutionMiss(
  error: unknown,
  workspacePath: string,
): Promise<boolean> {
  if (!isGitNotRepositoryDiagnostic(error)) {
    return false;
  }
  // Git は不正なマーカーや読み取れないマーカーでも同じ診断を出す。
  // ワークスペースの祖先にマーカーがあれば、この診断は実際のチェックアウト失敗として扱う。
  return !(await hasGitMarkerInAncestors(workspacePath));
}

/** 失敗コード・効果・再試行可否と、該当する場合の検証指摘を操作エラーにまとめる。 */
function operationError(
  code: GlossaryOperationErrorCode,
  message: string,
  effect: GlossaryOperationError["effect"] = "none",
  retryable = false,
  issues?: GlossaryValidationIssue[],
): GlossaryOperationError {
  return {
    ok: false,
    code,
    message,
    effect,
    retryable,
    ...(issues ? { issues } : {}),
  };
}

/** 失敗した時点の効果と再試行可否を持つ、構造化された操作例外を送出する。 */
function fail(
  code: GlossaryOperationErrorCode,
  message: string,
  effect: GlossaryOperationError["effect"] = "none",
  retryable = false,
  issues?: GlossaryValidationIssue[],
): never {
  throw new GlossaryServiceFailure(
    operationError(code, message, effect, retryable, issues),
  );
}

/** エラーコードを持つ Error に絞り込み、ファイル操作の失敗を分類できるようにする。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** ファイル操作の失敗が ENOENT によるものか判定する。 */
function isMissingError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

/** ファイルの差し替えを判定できるよう、統計情報からデバイス番号と inode 番号を取得する。 */
function identityFromStats(stats: Stats): GlossaryFileIdentity {
  return {
    device: BigInt(stats.dev),
    inode: BigInt(stats.ino),
  };
}

/** デバイス番号と inode 番号がともに一致するか判定する。 */
function sameIdentity(
  left: GlossaryFileIdentity,
  right: GlossaryFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

/** ルートのパスと実パスに加え、ルートと .git マーカーの実体がどちらも同じか判定する。 */
export function areResolvedGlossaryCheckoutsEqual(
  left: ResolvedGlossaryCheckout,
  right: ResolvedGlossaryCheckout,
): boolean {
  return (
    path.resolve(left.rootPath) === path.resolve(right.rootPath) &&
    left.rootRealPath === right.rootRealPath &&
    sameIdentity(left.rootIdentity, right.rootIdentity) &&
    sameIdentity(left.gitMarkerIdentity, right.gitMarkerIdentity)
  );
}

/** 実体の番号を文字列に変換し、チェックアウトの認可情報として保存できる形にする。 */
export function projectGlossaryCheckoutAuthority(
  target: ResolvedGlossaryCheckout,
): GlossaryCheckoutAuthoritySnapshot {
  return {
    rootPath: target.rootPath,
    rootRealPath: target.rootRealPath,
    rootDevice: target.rootIdentity.device.toString(),
    rootInode: target.rootIdentity.inode.toString(),
    gitMarkerDevice: target.gitMarkerIdentity.device.toString(),
    gitMarkerInode: target.gitMarkerIdentity.inode.toString(),
  };
}

/** 権限スナップショットの番号を bigint に戻す。現在のチェックアウトとの一致判定は呼び出し側で行う。 */
export function restoreGlossaryCheckoutAuthority(
  snapshot: GlossaryCheckoutAuthoritySnapshot,
): ResolvedGlossaryCheckout {
  return {
    rootPath: snapshot.rootPath,
    rootRealPath: snapshot.rootRealPath,
    rootIdentity: {
      device: BigInt(snapshot.rootDevice),
      inode: BigInt(snapshot.rootInode),
    },
    gitMarkerIdentity: {
      device: BigInt(snapshot.gitMarkerDevice),
      inode: BigInt(snapshot.gitMarkerInode),
    },
  };
}

/** 用語や定義の長さ制限に使う Unicode コードポイント数を返す。 */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** UTF-8 の原文から、書式も含めた変更を識別できるリビジョンを算出する。 */
function rawRevision(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** 開いているファイルの先頭から指定バイト数までを読み、UTF-8 へ変換する。サイズ超過の事前判定は呼び出し側で行う。 */
async function readFileHandleBounded(
  handle: FileHandle,
  maxBytes: number,
): Promise<{ raw: string; oversized: boolean }> {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes)));
  let position = 0;
  while (position < maxBytes) {
    const remaining = maxBytes - position;
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, remaining),
      position,
    );
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return {
    raw: Buffer.concat(chunks, position).toString("utf8"),
    oversized: false,
  };
}

/** 上限超過で本文を読まない場合に、ファイル実体・サイズ・時刻からリビジョンを作る。 */
function oversizedRevision(stats: Stats): string {
  return rawRevision(
    JSON.stringify([
      "oversized-v1",
      stats.dev.toString(),
      stats.ino.toString(),
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
    ]),
  );
}

/** 正式語・定義・別名の内容と並び順が完全に一致するか判定する。 */
function exactEntryEqual(left: GlossaryEntry, right: GlossaryEntry): boolean {
  return (
    left.term === right.term &&
    left.definition === right.definition &&
    left.aliases.length === right.aliases.length &&
    left.aliases.every((alias, index) => alias === right.aliases[index])
  );
}

/** 用語の項目と別名配列を、元の読み取り結果から独立した値に複製する。 */
function cloneEntry(entry: GlossaryEntry): GlossaryEntry {
  return {
    term: entry.term,
    aliases: [...entry.aliases],
    definition: entry.definition,
  };
}

/** 用語・別名・定義の型、空値と長さを検査し、項目番号付きの指摘と整形した項目を返す。 */
function validateEntry(
  input: GlossaryEntryInput,
  entryIndex: number,
): {
  entry: GlossaryEntry;
  issues: GlossaryValidationIssue[];
} {
  const issues: GlossaryValidationIssue[] = [];
  const pathPrefix = `entries[${entryIndex}]`;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      entry: { term: "", aliases: [], definition: "" },
      issues: [
        {
          path: pathPrefix,
          code: "INVALID_ENTRY",
          message: "Entry must be an object.",
        },
      ],
    };
  }

  const term = typeof input.term === "string" ? input.term : "";
  const definition =
    typeof input.definition === "string" ? input.definition : "";
  const aliases =
    input.aliases === undefined
      ? []
      : Array.isArray(input.aliases) &&
          input.aliases.every((alias) => typeof alias === "string")
        ? [...input.aliases]
        : [];

  if (typeof input.term !== "string") {
    issues.push({
      path: `${pathPrefix}.term`,
      code: "INVALID_TYPE",
      message: "term must be a string.",
    });
  } else if (!term.trim()) {
    issues.push({
      path: `${pathPrefix}.term`,
      code: "EMPTY_VALUE",
      message: "term must not be empty.",
    });
  } else if (codePointLength(term) > GLOSSARY_LIMITS.maxTermCodePoints) {
    issues.push({
      path: `${pathPrefix}.term`,
      code: "LIMIT_EXCEEDED",
      message: "term is too long.",
    });
  }

  if (
    input.aliases !== undefined &&
    (!Array.isArray(input.aliases) ||
      !input.aliases.every((alias) => typeof alias === "string"))
  ) {
    issues.push({
      path: `${pathPrefix}.aliases`,
      code: "INVALID_TYPE",
      message: "aliases must be an array of strings.",
    });
  } else if (aliases.length > GLOSSARY_LIMITS.maxAliasesPerEntry) {
    issues.push({
      path: `${pathPrefix}.aliases`,
      code: "LIMIT_EXCEEDED",
      message: "aliases contains too many values.",
    });
  }
  aliases.forEach((alias, aliasIndex) => {
    if (!alias.trim()) {
      issues.push({
        path: `${pathPrefix}.aliases[${aliasIndex}]`,
        code: "EMPTY_VALUE",
        message: "alias must not be empty.",
      });
    } else if (codePointLength(alias) > GLOSSARY_LIMITS.maxTermCodePoints) {
      issues.push({
        path: `${pathPrefix}.aliases[${aliasIndex}]`,
        code: "LIMIT_EXCEEDED",
        message: "alias is too long.",
      });
    }
  });

  if (typeof input.definition !== "string") {
    issues.push({
      path: `${pathPrefix}.definition`,
      code: "INVALID_TYPE",
      message: "definition must be a string.",
    });
  } else if (!definition.trim()) {
    issues.push({
      path: `${pathPrefix}.definition`,
      code: "EMPTY_VALUE",
      message: "definition must not be empty.",
    });
  } else if (
    codePointLength(definition) > GLOSSARY_LIMITS.maxDefinitionCodePoints
  ) {
    issues.push({
      path: `${pathPrefix}.definition`,
      code: "LIMIT_EXCEEDED",
      message: "definition is too long.",
    });
  }

  return { entry: { term, aliases, definition }, issues };
}

/** 全項目の上限と個別制約を検証し、正規化後の正式語や別名が同じ検索キーを持つ場合に衝突を報告する。 */
function validateEntries(inputs: readonly GlossaryEntryInput[]): {
  entries: GlossaryEntry[];
  issues: GlossaryValidationIssue[];
} {
  const issues: GlossaryValidationIssue[] = [];
  if (inputs.length > GLOSSARY_LIMITS.maxEntries) {
    issues.push({
      path: "entries",
      code: "LIMIT_EXCEEDED",
      message: "Glossary contains too many entries.",
    });
  }
  const entries = inputs.map((input, index) => {
    const validated = validateEntry(input, index);
    issues.push(...validated.issues);
    return validated.entry;
  });

  const owners = new Map<string, string>();
  entries.forEach((entry, entryIndex) => {
    [entry.term, ...entry.aliases].forEach((displayValue, valueIndex) => {
      const normalized = normalizeGlossaryLookup(displayValue);
      if (!normalized) {
        return;
      }
      const valuePath =
        valueIndex === 0
          ? `entries[${entryIndex}].term`
          : `entries[${entryIndex}].aliases[${valueIndex - 1}]`;
      const existing = owners.get(normalized);
      if (existing) {
        issues.push({
          path: valuePath,
          code: "AMBIGUOUS_LOOKUP",
          message: `Normalized term or alias conflicts with ${existing}.`,
        });
      } else {
        owners.set(normalized, valuePath);
      }
    });
  });

  return { entries, issues };
}

/** 文書の構造として扱える、通常のオブジェクトまたはプロトタイプを持たないオブジェクトかを判定する。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 受理するキーの集合に含まれない、列挙可能な自前のフィールド名を返す。 */
function unknownKeys(
  value: Record<string, unknown>,
  supportedKeys: readonly string[],
): string[] {
  const supported = new Set(supportedKeys);
  return Object.keys(value).filter((key) => !supported.has(key));
}

/** 原文のリビジョンを保持しつつ YAML を読み取り、サイズ・構造・項目を検証する。未対応のスキーマと不正な文書は区別する。 */
export function parseGlossaryDocument(raw: string): GlossarySnapshot {
  const revision = rawRevision(raw);
  if (Buffer.byteLength(raw, "utf8") > GLOSSARY_LIMITS.maxFileBytes) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: [
        {
          path: "$",
          code: "LIMIT_EXCEEDED",
          message: "Glossary file is too large.",
        },
      ],
    };
  }

  const document = parseDocument(raw, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: document.errors.map((error) => ({
        path: "$",
        code: "INVALID_YAML",
        message: error.message,
      })),
    };
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: [
        {
          path: "$",
          code: "INVALID_YAML",
          message:
            error instanceof Error ? error.message : "YAML conversion failed.",
        },
      ],
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues: [
        {
          path: "$",
          code: "INVALID_DOCUMENT",
          message: "Glossary document must be an object.",
        },
      ],
    };
  }

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== GLOSSARY_SCHEMA_VERSION) {
    return {
      status: "unsupported",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      schemaVersion:
        typeof schemaVersion === "number" || typeof schemaVersion === "string"
          ? schemaVersion
          : null,
      issues: [
        {
          path: "schemaVersion",
          code: "UNSUPPORTED_SCHEMA",
          message: "Unsupported glossary schemaVersion.",
        },
      ],
    };
  }

  const issues: GlossaryValidationIssue[] = unknownKeys(parsed, [
    "schemaVersion",
    "entries",
  ]).map((key) => ({
    path: key,
    code: "UNKNOWN_FIELD",
    message: `Unknown document field: ${key}.`,
  }));
  if (!Array.isArray(parsed.entries)) {
    issues.push({
      path: "entries",
      code: "INVALID_TYPE",
      message: "entries must be an array.",
    });
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues,
    };
  }

  const inputs: GlossaryEntryInput[] = parsed.entries.map(
    (candidate, index) => {
      if (!isPlainObject(candidate)) {
        issues.push({
          path: `entries[${index}]`,
          code: "INVALID_ENTRY",
          message: "Entry must be an object.",
        });
        return { term: "", aliases: [], definition: "" };
      }
      unknownKeys(candidate, ["term", "aliases", "definition"]).forEach(
        (key) => {
          issues.push({
            path: `entries[${index}].${key}`,
            code: "UNKNOWN_FIELD",
            message: `Unknown entry field: ${key}.`,
          });
        },
      );
      return candidate as unknown as GlossaryEntryInput;
    },
  );
  const validated = validateEntries(inputs);
  issues.push(...validated.issues);
  if (issues.length > 0) {
    return {
      status: "invalid",
      relativePath: GLOSSARY_RELATIVE_PATH,
      revision,
      issues,
    };
  }
  return {
    status: "valid",
    relativePath: GLOSSARY_RELATIVE_PATH,
    revision,
    entries: validated.entries.map(cloneEntry),
  };
}

/** 項目を現行スキーマの YAML へ変換する。空の別名配列は省き、末尾の改行を付ける。 */
export function serializeGlossaryDocument(
  entries: readonly GlossaryEntry[],
): string {
  const raw = stringify(
    {
      schemaVersion: GLOSSARY_SCHEMA_VERSION,
      entries: entries.map((entry) => ({
        term: entry.term,
        ...(entry.aliases.length > 0 ? { aliases: [...entry.aliases] } : {}),
        definition: entry.definition,
      })),
    },
    { lineWidth: 0 },
  );
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

/** 項目一覧を検証し、指摘がある場合は上限超過または不正な要求として失敗させる。 */
function assertValidEntries(
  inputs: readonly GlossaryEntryInput[],
): GlossaryEntry[] {
  const validated = validateEntries(inputs);
  if (validated.issues.length > 0) {
    const limitExceeded = validated.issues.some(
      (issue) => issue.code === "LIMIT_EXCEEDED",
    );
    fail(
      limitExceeded ? "GLOSSARY_LIMIT_EXCEEDED" : "GLOSSARY_INVALID_REQUEST",
      "Glossary entry validation failed.",
      "none",
      false,
      validated.issues,
    );
  }
  return validated.entries;
}

/** 正規化した正式語または別名で一致する項目を探し、元の一致表記と位置を返す。 */
function findEntryByLookup(
  entries: readonly GlossaryEntry[],
  value: string,
): {
  entry: GlossaryEntry;
  matchedText: string;
  index: number;
} | null {
  const normalized = normalizeGlossaryLookup(value);
  if (!normalized) {
    return null;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    for (const candidate of [entry.term, ...entry.aliases]) {
      if (normalizeGlossaryLookup(candidate) === normalized) {
        return { entry, matchedText: candidate, index };
      }
    }
  }
  return null;
}

/** 変更対象の特定に使う正式語だけを正規化して照合し、別名は対象として扱わない。 */
function findEntryByCanonicalTerm(
  entries: readonly GlossaryEntry[],
  value: string,
): {
  entry: GlossaryEntry;
  index: number;
} | null {
  const normalized = normalizeGlossaryLookup(value);
  if (!normalized) {
    return null;
  }
  const index = entries.findIndex(
    (entry) => normalizeGlossaryLookup(entry.term) === normalized,
  );
  return index >= 0 ? { entry: entries[index], index } : null;
}

/** 既定のページ範囲を補い、オフセットとページサイズが許容範囲の整数か確認する。 */
function validatePageRequest(request: GlossaryPageRequest = {}): {
  offset: number;
  pageSize: number;
} {
  const offset = request.offset ?? 0;
  const pageSize = request.pageSize ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    fail("GLOSSARY_INVALID_REQUEST", "offset must be a non-negative integer.");
  }
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > GLOSSARY_LIMITS.maxPageSize
  ) {
    fail("GLOSSARY_LIMIT_EXCEEDED", "pageSize is outside the supported range.");
  }
  return { offset, pageSize };
}

/** 内部の原文とファイル実体を除いて公開結果を作り、項目や検証指摘は複製する。 */
function publicSnapshot(read: InternalRead): GlossarySnapshot {
  switch (read.status) {
    case "missing":
      return { ...read };
    case "valid":
      return {
        status: "valid",
        relativePath: read.relativePath,
        revision: read.revision,
        entries: read.entries.map(cloneEntry),
      };
    case "invalid":
      return {
        status: "invalid",
        relativePath: read.relativePath,
        revision: read.revision,
        issues: read.issues.map((issue) => ({ ...issue })),
      };
    case "unsupported":
      return {
        status: "unsupported",
        relativePath: read.relativePath,
        revision: read.revision,
        schemaVersion: read.schemaVersion,
        issues: read.issues.map((issue) => ({ ...issue })),
      };
  }
}

/** 内部例外を公開の操作結果へ変換し、対象外と一般的な入出力失敗を区別する。 */
async function safeOperation<T>(
  operation: () => Promise<T>,
): Promise<GlossaryOperationResult<T>> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GlossaryServiceFailure) {
      return error.error;
    }
    if (isGlossaryNotApplicableError(error)) {
      // 表示専用の状態が追加される前からの、操作結果に関する契約を維持する。
      return operationError("GLOSSARY_TARGET_INVALID", error.message);
    }
    return operationError(
      "GLOSSARY_IO_ERROR",
      error instanceof Error ? error.message : "Glossary I/O failed.",
      "none",
      true,
    );
  }
}

/** Git チェックアウトを検証し、同じ実体の用語集の検証、変更、監視を扱う。 */
export class GlossaryApplicationService {
  readonly #runGit: (cwd: string, args: readonly string[]) => Promise<string>;
  readonly #beforeRename?: GlossaryApplicationServiceDeps["beforeRename"];
  readonly #renamePath: (oldPath: string, newPath: string) => Promise<void>;
  readonly #watchPath: GlossaryWatchPath;
  readonly #watchDebounceMs: number;
  readonly #watchRetryMs: number;
  readonly #readFileHandle: NonNullable<
    GlossaryApplicationServiceDeps["readFileHandle"]
  >;
  readonly #mutationTails = new Map<string, Promise<void>>();

  /** Git 実行・読み取り・置換・監視の既定実装を用意し、指定された依存設定があれば差し替える。 */
  constructor(deps: GlossaryApplicationServiceDeps = {}) {
    this.#runGit =
      deps.runGit ??
      (async (cwd, args) => {
        const result = await execFileAsync("git", ["-C", cwd, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            // チェックアウトの分類に使う診断がロケールによって変わらないようにする。
            LC_ALL: "C",
            LANG: "C",
          },
          timeout: 5_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        return result.stdout.trim();
      });
    this.#beforeRename = deps.beforeRename;
    this.#renamePath = deps.renamePath ?? rename;
    this.#watchPath =
      deps.watchPath ??
      ((targetPath, listener) =>
        watch(targetPath, { persistent: false }, listener));
    this.#watchDebounceMs = deps.watchDebounceMs ?? 60;
    this.#watchRetryMs = deps.watchRetryMs ?? 1_000;
    this.#readFileHandle = deps.readFileHandle ?? readFileHandleBounded;
  }

  /** 絶対パスのワークスペースからチェックアウトを確定し、ルートと .git の実体を記録する。対象外と安全に解決できない状態を区別する。 */
  async resolvePrimaryCheckout(
    workspacePath: string,
  ): Promise<ResolvedGlossaryCheckout> {
    const normalizedWorkspacePath = workspacePath.trim();
    if (!normalizedWorkspacePath || !path.isAbsolute(normalizedWorkspacePath)) {
      fail(
        "GLOSSARY_TARGET_INVALID",
        "Primary checkout workspacePath must be absolute.",
      );
    }
    let gitRoot: string;
    try {
      gitRoot = await this.#runGit(normalizedWorkspacePath, [
        "rev-parse",
        "--show-toplevel",
      ]);
    } catch (error) {
      if (await isGitCheckoutResolutionMiss(error, normalizedWorkspacePath)) {
        throw new GlossaryNotApplicableError();
      }
      throw error;
    }
    const rootPath = path.resolve(gitRoot);
    const rootStats = await lstat(rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      fail(
        "GLOSSARY_TARGET_INVALID",
        "Git checkout root must be a real directory.",
      );
    }
    const rootRealPath = await realpath(rootPath);
    const gitMarkerStats = await lstat(path.join(rootPath, ".git"));
    if (gitMarkerStats.isSymbolicLink()) {
      fail(
        "GLOSSARY_TARGET_INVALID",
        "Git checkout marker must not be a symbolic link or junction.",
      );
    }
    return {
      rootPath,
      rootRealPath,
      rootIdentity: identityFromStats(rootStats),
      gitMarkerIdentity: identityFromStats(gitMarkerStats),
    };
  }

  /** チェックアウトの実体を再確認して用語集を読み、公開用のスナップショットを返す。 */
  async read(target: ResolvedGlossaryCheckout): Promise<GlossarySnapshot> {
    return publicSnapshot(
      await this.#readInternal(await this.#revalidateCheckout(target)),
    );
  }

  /** 検証したチェックアウトの表示名と現在のブランチを返し、ブランチ名が空なら detached HEAD と表示する。 */
  async describeCheckout(
    target: ResolvedGlossaryCheckout,
  ): Promise<GlossaryCheckoutSummary> {
    const current = await this.#revalidateCheckout(target);
    const branch = (
      await this.#runGit(current.rootPath, ["branch", "--show-current"])
    ).trim();
    const pathLabel = path.basename(current.rootPath);
    return {
      repositoryName: pathLabel,
      branch: branch || "(detached HEAD)",
      pathLabel,
    };
  }

  /** 用語集の検証結果をスナップショットで返す。ファイル内容の不正や未対応はスナップショットの状態で示す。 */
  async validate(
    target: ResolvedGlossaryCheckout,
  ): Promise<GlossaryValidationResult> {
    return { ok: true, snapshot: await this.read(target) };
  }

  /** チェックアウトと用語集ディレクトリの変化を購読して更新後の状態を通知し、監視とタイマーを解除する関数を返す。 */
  subscribe(
    target: ResolvedGlossaryCheckout,
    listener: (state: GlossaryProjectionState) => void,
  ): () => void {
    let disposed = false;
    let reloadTimer: NodeJS.Timeout | null = null;
    let recoveryTimer: NodeJS.Timeout | null = null;
    let rootWatcher: GlossaryWatchHandle | null = null;
    let directoryWatcher: GlossaryWatchHandle | null = null;

    /** 購読終了後は何もせず、対象外とその他の監視エラーを区別してリスナーへ通知する。 */
    const emitWatchError = (error: unknown) => {
      if (disposed) {
        return;
      }
      if (isGlossaryNotApplicableError(error)) {
        listener(notApplicableProjectionState());
        return;
      }
      listener({
        status: "watch-error",
        relativePath: GLOSSARY_RELATIVE_PATH,
        revision: null,
        message:
          error instanceof Error ? error.message : "Glossary watcher failed.",
      });
    };

    /** 用語集ディレクトリの監視を閉じ、監視を張り直せるよう参照を消去する。 */
    const closeDirectoryWatcher = () => {
      directoryWatcher?.close();
      directoryWatcher = null;
    };

    /** チェックアウトルートの監視を閉じ、再開時に新しい監視を作れるよう参照を消去する。 */
    const closeRootWatcher = () => {
      rootWatcher?.close();
      rootWatcher = null;
    };

    /** 監視ハンドルのエラーイベントを指定した復旧処理へ接続する。 */
    const attachErrorHandler = (
      watcher: GlossaryWatchHandle,
      onError: (error: unknown) => void,
    ) => {
      watcher.on("error", onError);
    };

    /** 既存の監視を解除して用語集ディレクトリを再確認し、用語集または一時ファイルの変化を監視する。 */
    const armDirectoryWatcher = async () => {
      closeDirectoryWatcher();
      const directory = await this.#inspectGlossaryDirectory(target, false);
      if (!directory || disposed) {
        return;
      }
      directoryWatcher = this.#watchPath(
        directory.path,
        (_eventType, filename) => {
          const name = filename?.toString();
          if (
            !name ||
            name === "glossary.yaml" ||
            name.startsWith(".glossary-")
          ) {
            scheduleReload();
          }
        },
      );
      const armedWatcher = directoryWatcher;
      attachErrorHandler(armedWatcher, (error) => {
        if (directoryWatcher !== armedWatcher) {
          return;
        }
        emitWatchError(error);
        closeDirectoryWatcher();
        scheduleRecovery();
      });
    };

    /** ルート監視が未設定なら開始し、用語集ディレクトリ自体の追加・置換などを再読込の契機にする。 */
    const armRootWatcher = () => {
      if (rootWatcher || disposed) {
        return;
      }
      const armedWatcher = this.#watchPath(
        target.rootPath,
        (_eventType, filename) => {
          const name = filename?.toString();
          if (!name || name === ".withmate") {
            scheduleReload();
          }
        },
      );
      rootWatcher = armedWatcher;
      attachErrorHandler(armedWatcher, (error) => {
        if (rootWatcher !== armedWatcher) {
          return;
        }
        emitWatchError(error);
        closeRootWatcher();
        scheduleRecovery();
      });
    };

    /** 両方の監視先を整え、用語集の最新状態を通知する。失敗した場合は状態を通知して再試行を予約する。 */
    const reload = async () => {
      if (disposed) {
        return;
      }
      try {
        armRootWatcher();
        await armDirectoryWatcher();
        listener(await this.read(target));
      } catch (error) {
        emitWatchError(error);
        scheduleRecovery();
      }
    };

    /** 短時間に届く複数の変更通知を、1回の読み取りにまとめる。 */
    const scheduleReload = () => {
      if (disposed || reloadTimer) {
        return;
      }
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void reload();
      }, this.#watchDebounceMs);
    };

    /** 監視失敗後の再開を遅延して試行し、同時に複数の復旧タイマーを張らない。 */
    const scheduleRecovery = () => {
      if (disposed || recoveryTimer) {
        return;
      }
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        void reload();
      }, this.#watchRetryMs);
    };

    try {
      armRootWatcher();
      void armDirectoryWatcher().catch((error) => {
        emitWatchError(error);
        scheduleRecovery();
      });
    } catch (error) {
      queueMicrotask(() => emitWatchError(error));
      scheduleRecovery();
    }

    return () => {
      disposed = true;
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
      }
      closeDirectoryWatcher();
      closeRootWatcher();
    };
  }

  /** 検証済みの項目を文書順でページングする。ファイルがなければリビジョンなしの空一覧を返す。 */
  async list(
    target: ResolvedGlossaryCheckout,
    request: GlossaryPageRequest = {},
  ): Promise<GlossaryOperationResult<GlossaryListResult>> {
    return safeOperation(async () => {
      const page = validatePageRequest(request);
      const snapshot = await this.#readUsable(target);
      const entries = snapshot.status === "missing" ? [] : snapshot.entries;
      return {
        ok: true,
        revision: snapshot.status === "missing" ? null : snapshot.revision,
        entries: entries
          .slice(page.offset, page.offset + page.pageSize)
          .map(cloneEntry),
        total: entries.length,
        ...page,
      };
    });
  }

  /** 正規化した検索語との一致を順位付けし、同順位は文書順を保ってページングする。検索語が空なら全項目を対象にする。 */
  async search(
    target: ResolvedGlossaryCheckout,
    request: GlossarySearchRequest,
  ): Promise<GlossaryOperationResult<GlossaryListResult>> {
    return safeOperation(async () => {
      if (typeof request?.query !== "string") {
        fail("GLOSSARY_INVALID_REQUEST", "query must be a string.");
      }
      if (codePointLength(request.query) > GLOSSARY_LIMITS.maxQueryCodePoints) {
        fail("GLOSSARY_LIMIT_EXCEEDED", "query is too long.");
      }
      const page = validatePageRequest(request);
      const snapshot = await this.#readUsable(target);
      const entries = snapshot.status === "missing" ? [] : snapshot.entries;
      const query = normalizeGlossaryLookup(request.query);
      const ranked = query
        ? entries
            .map((entry, index) => ({
              entry,
              index,
              rank: this.#searchRank(entry, query),
            }))
            .filter((candidate) => candidate.rank !== null)
            .sort(
              (left, right) =>
                left.rank! - right.rank! || left.index - right.index,
            )
            .map((candidate) => candidate.entry)
        : entries;
      return {
        ok: true,
        revision: snapshot.status === "missing" ? null : snapshot.revision,
        entries: ranked
          .slice(page.offset, page.offset + page.pageSize)
          .map(cloneEntry),
        total: ranked.length,
        ...page,
      };
    });
  }

  /** 正式語または別名の正規化一致で項目を取得する。見つかれば一致した元の表記も返す。 */
  async get(
    target: ResolvedGlossaryCheckout,
    termOrAlias: string,
  ): Promise<GlossaryOperationResult<GlossaryGetResult>> {
    return safeOperation(async () => {
      if (
        typeof termOrAlias !== "string" ||
        !normalizeGlossaryLookup(termOrAlias)
      ) {
        fail("GLOSSARY_INVALID_REQUEST", "termOrAlias must not be empty.");
      }
      const snapshot = await this.#readUsable(target);
      if (snapshot.status === "missing") {
        fail("GLOSSARY_NOT_FOUND", "Glossary entry was not found.");
      }
      const found = findEntryByLookup(snapshot.entries, termOrAlias);
      if (!found) {
        fail("GLOSSARY_NOT_FOUND", "Glossary entry was not found.");
      }
      return {
        ok: true,
        revision: snapshot.revision,
        matchedText: found.matchedText,
        entry: cloneEntry(found.entry),
      };
    });
  }

  /** 新しい項目を1件登録する。完全に同じ項目があれば書き込まず、検索キーの衝突は拒否する。 */
  async create(
    target: ResolvedGlossaryCheckout,
    request: GlossaryCreateRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(() =>
      this.#withMutationLock(target, async () => {
        this.#validateCreateMode(request.mode, 1, request.proactiveCreateLimit);
        const [entry] = assertValidEntries([request.entry]);
        const previous = await this.#readMutable(target);
        if (previous.status === "valid") {
          const current = findEntryByCanonicalTerm(
            previous.entries,
            entry.term,
          );
          if (current && exactEntryEqual(current.entry, entry)) {
            return this.#converged(previous);
          }
          if (
            [entry.term, ...entry.aliases].some((value) =>
              findEntryByLookup(previous.entries, value),
            )
          ) {
            fail(
              "GLOSSARY_CONFLICT",
              "Glossary term already exists with different content.",
            );
          }
        }
        const previousEntries =
          previous.status === "valid" ? previous.entries : [];
        const entries = assertValidEntries([...previousEntries, entry]);
        return this.#commit(target, guard, {
          previous,
          entries,
          /** 同時変更後に、要求した項目がすでに同一内容で存在するか確認する。 */
          isConverged: (snapshot) =>
            snapshot.status === "valid" &&
            Boolean(findEntryByCanonicalTerm(snapshot.entries, entry.term)) &&
            exactEntryEqual(
              findEntryByCanonicalTerm(snapshot.entries, entry.term)!.entry,
              entry,
            ),
        });
      }),
    );
  }

  /** 複数項目を一括登録する。全件がすでに一致すれば書き込まず、一部だけが一致する要求や既存項目との衝突は拒否する。 */
  async createBatch(
    target: ResolvedGlossaryCheckout,
    request: GlossaryCreateBatchRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(() =>
      this.#withMutationLock(target, async () => {
        if (!Array.isArray(request.entries) || request.entries.length < 1) {
          fail(
            "GLOSSARY_INVALID_REQUEST",
            "create-batch requires at least one entry.",
          );
        }
        if (request.entries.length > GLOSSARY_LIMITS.maxBatchEntries) {
          fail(
            "GLOSSARY_LIMIT_EXCEEDED",
            "create-batch contains too many entries.",
          );
        }
        this.#validateCreateMode(
          request.mode,
          request.entries.length,
          request.proactiveCreateLimit,
        );
        const requested = assertValidEntries(request.entries);
        const previous = await this.#readMutable(target);
        const previousEntries =
          previous.status === "valid" ? previous.entries : [];
        const exactMatches = requested.map((entry) => {
          const current = findEntryByCanonicalTerm(previousEntries, entry.term);
          return Boolean(current && exactEntryEqual(current.entry, entry));
        });
        if (exactMatches.every(Boolean)) {
          return this.#converged(previous as ValidRead);
        }
        if (exactMatches.some(Boolean)) {
          fail(
            "GLOSSARY_CONFLICT",
            "create-batch only partially matches the current glossary.",
          );
        }
        requested.forEach((entry) => {
          if (
            [entry.term, ...entry.aliases].some((value) =>
              findEntryByLookup(previousEntries, value),
            )
          ) {
            fail(
              "GLOSSARY_CONFLICT",
              "create-batch conflicts with an existing glossary entry.",
            );
          }
        });
        const entries = assertValidEntries([...previousEntries, ...requested]);
        return this.#commit(target, guard, {
          previous,
          entries,
          /** 書き込み直前の状態が変化していた場合に、要求した項目すべてが同じ内容で登録済みか確認する。 */
          isConverged: (snapshot) => {
            if (snapshot.status !== "valid") {
              return false;
            }
            const matches = requested.map((entry) => {
              const current = findEntryByCanonicalTerm(
                snapshot.entries,
                entry.term,
              );
              return Boolean(current && exactEntryEqual(current.entry, entry));
            });
            return matches.every(Boolean);
          },
        });
      }),
    );
  }

  /** 指定リビジョンの正式語を更新する。リビジョンが違う場合は、望む更新結果がすでに成立しているかを確認する。 */
  async update(
    target: ResolvedGlossaryCheckout,
    request: GlossaryUpdateRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(() =>
      this.#withMutationLock(target, async () => {
        this.#validateExpectedRevision(request.expectedRevision);
        const normalizedTarget = normalizeGlossaryLookup(request.targetTerm);
        if (!normalizedTarget) {
          fail("GLOSSARY_INVALID_REQUEST", "targetTerm must not be empty.");
        }
        const [replacement] = assertValidEntries([request.entry]);
        const previous = await this.#readMutable(target);
        if (previous.status === "missing") {
          fail("GLOSSARY_NOT_FOUND", "Glossary entry was not found.");
        }
        if (previous.revision !== request.expectedRevision) {
          if (
            this.#isUpdateConverged(previous, normalizedTarget, replacement)
          ) {
            return this.#converged(previous);
          }
          fail("GLOSSARY_CONFLICT", "Glossary revision changed before update.");
        }
        const current = findEntryByCanonicalTerm(
          previous.entries,
          normalizedTarget,
        );
        if (!current) {
          fail("GLOSSARY_NOT_FOUND", "Glossary canonical term was not found.");
        }
        const replacementCollides = [
          replacement.term,
          ...replacement.aliases,
        ].some((value) => {
          const resolved = findEntryByLookup(previous.entries, value);
          return Boolean(resolved && resolved.index !== current.index);
        });
        if (replacementCollides) {
          fail(
            "GLOSSARY_CONFLICT",
            "Updated entry conflicts with another glossary entry.",
          );
        }
        const entries = previous.entries.map((entry, index) =>
          index === current.index ? replacement : entry,
        );
        const validatedEntries = assertValidEntries(entries);
        return this.#commit(target, guard, {
          previous,
          entries: validatedEntries,
          /** 変更後の文書で、要求した更新がすでに反映されたとみなせるか確認する。 */
          isConverged: (snapshot) =>
            snapshot.status === "valid" &&
            this.#isUpdateConverged(snapshot, normalizedTarget, replacement),
        });
      }),
    );
  }

  /** 指定リビジョンの正式語を削除する。ファイルがなければ変更不要とし、リビジョンが違う場合は対象語が検索でも解決されないか確認する。 */
  async delete(
    target: ResolvedGlossaryCheckout,
    request: GlossaryDeleteRequest,
    guard?: GlossaryMutationGuard,
  ): Promise<GlossaryOperationResult<GlossaryMutationResult>> {
    return safeOperation(() =>
      this.#withMutationLock(target, async () => {
        this.#validateExpectedRevision(request.expectedRevision);
        const normalizedTarget = normalizeGlossaryLookup(request.targetTerm);
        if (!normalizedTarget) {
          fail("GLOSSARY_INVALID_REQUEST", "targetTerm must not be empty.");
        }
        const previous = await this.#readMutable(target);
        if (previous.status === "missing") {
          return {
            ok: true,
            outcome: "converged",
            effect: "none",
            revision: null,
            entries: [],
          };
        }
        if (previous.revision !== request.expectedRevision) {
          if (this.#isDeleteConverged(previous, normalizedTarget)) {
            return this.#converged(previous);
          }
          fail("GLOSSARY_CONFLICT", "Glossary revision changed before delete.");
        }
        const current = findEntryByCanonicalTerm(
          previous.entries,
          normalizedTarget,
        );
        if (!current) {
          fail("GLOSSARY_NOT_FOUND", "Glossary canonical term was not found.");
        }
        const entries = previous.entries
          .filter((_, index) => index !== current.index)
          .map(cloneEntry);
        return this.#commit(target, guard, {
          previous,
          entries,
          /** 変更後の文書では削除対象が正式語・別名のどちらにも残っていないか確認する。 */
          isConverged: (snapshot) =>
            snapshot.status === "valid" &&
            this.#isDeleteConverged(snapshot, normalizedTarget),
        });
      }),
    );
  }

  /** 同じチェックアウト実体に対する変更を直列化し、先行処理が失敗しても次の処理へ順番を渡す。 */
  async #withMutationLock<T>(
    target: ResolvedGlossaryCheckout,
    operation: () => Promise<T>,
  ): Promise<T> {
    const normalizedRootPath =
      process.platform === "win32"
        ? target.rootRealPath.toLocaleLowerCase("en-US")
        : target.rootRealPath;
    const key = [
      normalizedRootPath,
      target.rootIdentity.device.toString(),
      target.rootIdentity.inode.toString(),
    ].join("\0");
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    /** 現在の変更が終わったときに、その処理の完了を待つ後続へ順番を渡す関数。 */
    let release: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => turn);
    this.#mutationTails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationTails.get(key) === tail) {
        this.#mutationTails.delete(key);
      }
    }
  }

  /** 内容を使う操作のために、欠落または有効な読み取り結果だけを返す。不正と未対応はそれぞれの操作エラーにする。 */
  async #readUsable(
    target: ResolvedGlossaryCheckout,
  ): Promise<MissingRead | ValidRead> {
    const read = await this.#readInternal(
      await this.#revalidateCheckout(target),
    );
    if (read.status === "invalid") {
      fail(
        "GLOSSARY_INVALID_FILE",
        "Glossary file is invalid.",
        "none",
        false,
        read.issues,
      );
    }
    if (read.status === "unsupported") {
      fail(
        "GLOSSARY_UNSUPPORTED_SCHEMA",
        "Glossary schemaVersion is unsupported.",
        "none",
        false,
        read.issues,
      );
    }
    return read;
  }

  /** 変更の起点として、欠落または有効な用語集だけを読み取る。 */
  async #readMutable(
    target: ResolvedGlossaryCheckout,
  ): Promise<MissingRead | ValidRead> {
    return this.#readUsable(target);
  }

  /** ファイルが通常ファイルで、読み取り前後で実体・サイズ・更新時刻が変わっていないことを確認し、検証結果と実体情報を返す。 */
  async #readInternal(target: ResolvedGlossaryCheckout): Promise<InternalRead> {
    const glossaryPath = path.join(
      target.rootPath,
      ".withmate",
      "glossary.yaml",
    );
    let pathStats: Awaited<ReturnType<typeof lstat>>;
    try {
      pathStats = await lstat(glossaryPath);
    } catch (error) {
      if (isMissingError(error)) {
        return {
          status: "missing",
          relativePath: GLOSSARY_RELATIVE_PATH,
          revision: null,
        };
      }
      throw error;
    }
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      fail(
        "GLOSSARY_TARGET_INVALID",
        "glossary.yaml must be a regular file and must not be a symbolic link or junction.",
      );
    }
    const parent = await this.#inspectGlossaryDirectory(target, false);
    if (!parent) {
      fail(
        "GLOSSARY_TARGET_CHANGED",
        "Glossary directory disappeared during read.",
      );
    }
    const handle = await open(glossaryPath, "r");
    try {
      const openedStats = await handle.stat();
      if (
        !sameIdentity(
          identityFromStats(pathStats),
          identityFromStats(openedStats),
        )
      ) {
        fail("GLOSSARY_TARGET_CHANGED", "glossary.yaml changed before read.");
      }
      const initiallyOversized =
        openedStats.size > GLOSSARY_LIMITS.maxFileBytes;
      const content = initiallyOversized
        ? { raw: "", oversized: true }
        : await this.#readFileHandle(handle, openedStats.size);
      const isOversized = initiallyOversized || content.oversized;
      const raw = content.raw;
      const confirmedStats = await handle.stat();
      const confirmedPathStats = await lstat(glossaryPath);
      if (
        !sameIdentity(
          identityFromStats(openedStats),
          identityFromStats(confirmedStats),
        ) ||
        !sameIdentity(
          identityFromStats(openedStats),
          identityFromStats(confirmedPathStats),
        ) ||
        openedStats.size !== confirmedStats.size ||
        openedStats.mtimeMs !== confirmedStats.mtimeMs
      ) {
        fail("GLOSSARY_TARGET_CHANGED", "glossary.yaml changed during read.");
      }
      if (isOversized) {
        return {
          status: "invalid",
          relativePath: GLOSSARY_RELATIVE_PATH,
          revision: oversizedRevision(openedStats),
          issues: [
            {
              path: "$",
              code: "LIMIT_EXCEEDED",
              message: "Glossary file is too large.",
            },
          ],
          raw,
          fileIdentity: identityFromStats(openedStats),
        };
      }
      const parsed = parseGlossaryDocument(raw);
      return {
        ...parsed,
        raw,
        fileIdentity: identityFromStats(openedStats),
      } as InternalRead;
    } finally {
      await handle.close();
    }
  }

  /** チェックアウトを解決し直し、最初に確認したパスや実体と一致しなければ中断する。 */
  async #revalidateCheckout(
    target: ResolvedGlossaryCheckout,
  ): Promise<ResolvedGlossaryCheckout> {
    const current = await this.resolvePrimaryCheckout(target.rootPath);
    if (!areResolvedGlossaryCheckoutsEqual(target, current)) {
      fail("GLOSSARY_TARGET_CHANGED", "Primary checkout identity changed.");
    }
    return current;
  }

  /** 用語集ディレクトリがチェックアウト内の実ディレクトリか確認し、指定された場合に限り欠落時に作成する。 */
  async #inspectGlossaryDirectory(
    target: ResolvedGlossaryCheckout,
    createIfMissing: boolean,
  ): Promise<DirectoryIdentity | null> {
    const directoryPath = path.join(target.rootPath, ".withmate");
    let directoryStats: Awaited<ReturnType<typeof lstat>>;
    try {
      directoryStats = await lstat(directoryPath);
    } catch (error) {
      if (!isMissingError(error)) {
        throw error;
      }
      if (!createIfMissing) {
        return null;
      }
      try {
        await mkdir(directoryPath);
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      directoryStats = await lstat(directoryPath);
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      fail(
        "GLOSSARY_TARGET_INVALID",
        ".withmate must be a real directory and must not be a symbolic link or junction.",
      );
    }
    const directoryRealPath = await realpath(directoryPath);
    const relative = path.relative(target.rootRealPath, directoryRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(
        "GLOSSARY_TARGET_INVALID",
        ".withmate resolves outside the primary checkout.",
      );
    }
    return {
      path: directoryPath,
      realPath: directoryRealPath,
      identity: identityFromStats(directoryStats),
    };
  }

  /** チェックアウトの実体を再確認し、任意の追加ガードが同じ対象を認可しなくなった場合は書き込みを拒否する。 */
  async #runGuard(
    target: ResolvedGlossaryCheckout,
    guard?: GlossaryMutationGuard,
  ): Promise<void> {
    await this.#revalidateCheckout(target);
    if (guard) {
      const guardedTarget = await guard();
      if (
        !guardedTarget ||
        !areResolvedGlossaryCheckoutsEqual(target, guardedTarget)
      ) {
        fail(
          "GLOSSARY_TARGET_CHANGED",
          "Runtime binding no longer authorizes this checkout.",
        );
      }
    }
  }

  /** 一時ファイルで内容を準備し、対象と変更前の状態を再確認してから置き換える。再読込の観測を基に、適用済み・未適用・結果不明を区別する。 */
  async #commit(
    target: ResolvedGlossaryCheckout,
    guard: GlossaryMutationGuard | undefined,
    plan: MutationPlan,
  ): Promise<GlossaryMutationResult> {
    const raw = serializeGlossaryDocument(plan.entries);
    if (Buffer.byteLength(raw, "utf8") > GLOSSARY_LIMITS.maxFileBytes) {
      fail(
        "GLOSSARY_LIMIT_EXCEEDED",
        "Serialized glossary exceeds the file size limit.",
      );
    }

    await this.#runGuard(target, guard);
    const directory = await this.#inspectGlossaryDirectory(target, true);
    if (!directory) {
      fail("GLOSSARY_IO_ERROR", "Glossary directory could not be created.");
    }
    await this.#runGuard(target, guard);
    const confirmedDirectory = await this.#inspectGlossaryDirectory(
      target,
      false,
    );
    if (
      !confirmedDirectory ||
      !sameIdentity(directory.identity, confirmedDirectory.identity)
    ) {
      fail(
        "GLOSSARY_TARGET_CHANGED",
        "Glossary directory identity changed before write.",
      );
    }

    const targetPath = path.join(directory.path, "glossary.yaml");
    const temporaryPath = path.join(
      directory.path,
      `.glossary-${process.pid}-${randomUUID()}.tmp`,
    );
    let handle: FileHandle | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(raw, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;

      await this.#beforeRename?.(temporaryPath, targetPath);
      await this.#runGuard(target, guard);
      const beforeCommitDirectory = await this.#inspectGlossaryDirectory(
        target,
        false,
      );
      if (
        !beforeCommitDirectory ||
        !sameIdentity(directory.identity, beforeCommitDirectory.identity)
      ) {
        fail(
          "GLOSSARY_TARGET_CHANGED",
          "Glossary directory identity changed before commit.",
        );
      }
      const current = await this.#readInternal(target);
      if (!this.#samePreMutationState(plan.previous, current)) {
        if (plan.isConverged(publicSnapshot(current))) {
          if (current.status !== "valid") {
            fail("GLOSSARY_CONFLICT", "Glossary changed before mutation.");
          }
          return this.#converged(current);
        }
        fail("GLOSSARY_CONFLICT", "Glossary changed before mutation.");
      }
      await this.#runGuard(target, guard);

      let renameError: unknown = null;
      try {
        await this.#renamePath(temporaryPath, targetPath);
      } catch (error) {
        renameError = error;
      }

      let after: InternalRead;
      try {
        after = await this.#readInternal(
          await this.#revalidateCheckout(target),
        );
      } catch (error) {
        fail(
          "GLOSSARY_EFFECT_UNKNOWN",
          error instanceof Error
            ? error.message
            : "Glossary mutation effect could not be determined.",
          "unknown",
          false,
        );
      }
      if (after.status === "valid" && after.revision === rawRevision(raw)) {
        return {
          ok: true,
          outcome: "applied",
          effect: "applied",
          revision: after.revision,
          entries: after.entries.map(cloneEntry),
        };
      }
      if (this.#samePreMutationState(plan.previous, after)) {
        fail(
          renameError ? "GLOSSARY_IO_ERROR" : "GLOSSARY_CONFLICT",
          renameError instanceof Error
            ? renameError.message
            : "Glossary postcondition was not applied.",
          "none",
          Boolean(renameError),
        );
      }
      return fail(
        "GLOSSARY_EFFECT_UNKNOWN",
        "Glossary mutation effect could not be classified safely.",
        "unknown",
        false,
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  /** 両方にファイルがなければ同じ状態とし、存在する場合はリビジョンと実体の両方を照合する。 */
  #samePreMutationState(
    previous: InternalRead,
    current: InternalRead,
  ): boolean {
    if (previous.status === "missing" || current.status === "missing") {
      return previous.status === "missing" && current.status === "missing";
    }
    return (
      previous.revision === current.revision &&
      sameIdentity(previous.fileIdentity, current.fileIdentity)
    );
  }

  /** 望む結果がすでに成立している場合に、書き込まなかったことと現在の内容を返す。 */
  #converged(snapshot: ValidRead): GlossaryMutationResult {
    return {
      ok: true,
      outcome: "converged",
      effect: "none",
      revision: snapshot.revision,
      entries: snapshot.entries.map(cloneEntry),
    };
  }

  /** 明示・能動の登録モードを検証し、能動登録は有効な上限があり、要求件数がその範囲に収まる場合だけ許す。 */
  #validateCreateMode(
    mode: string,
    count: number,
    proactiveCreateLimit: number | null | undefined,
  ): void {
    if (mode !== "explicit" && mode !== "proactive") {
      fail(
        "GLOSSARY_INVALID_REQUEST",
        "create mode must be explicit or proactive.",
      );
    }
    if (mode === "proactive") {
      if (
        !Number.isInteger(proactiveCreateLimit) ||
        proactiveCreateLimit === null ||
        proactiveCreateLimit === undefined ||
        proactiveCreateLimit < 0 ||
        proactiveCreateLimit > 100
      ) {
        fail(
          "GLOSSARY_INVALID_REQUEST",
          "A valid proactive create limit is required.",
        );
      }
      if (proactiveCreateLimit === 0 || count > proactiveCreateLimit) {
        fail(
          "GLOSSARY_LIMIT_EXCEEDED",
          "Proactive create is disabled or exceeds the configured limit.",
        );
      }
    }
  }

  /** 変更前の確認に使うリビジョンが小文字16進数64桁であることを検証する。 */
  #validateExpectedRevision(value: string): void {
    if (typeof value !== "string" || !NORMALIZED_REVISION_PATTERN.test(value)) {
      fail(
        "GLOSSARY_INVALID_REQUEST",
        "expectedRevision must be a glossary raw content hash.",
      );
    }
  }

  /** 置換後の正式語に同じ項目があり、旧語が消えているか同じ項目を指す場合に、更新済みと判定する。 */
  #isUpdateConverged(
    snapshot: Extract<GlossarySnapshot, { status: "valid" }>,
    previousTerm: string,
    replacement: GlossaryEntry,
  ): boolean {
    const desired = findEntryByCanonicalTerm(
      snapshot.entries,
      replacement.term,
    );
    if (!desired || !exactEntryEqual(desired.entry, replacement)) {
      return false;
    }
    const oldResolution = findEntryByLookup(snapshot.entries, previousTerm);
    return !oldResolution || oldResolution.index === desired.index;
  }

  /** 削除対象の語が正式語としても別名としても解決されなければ、再度の削除は不要と判定する。 */
  #isDeleteConverged(
    snapshot: Extract<GlossarySnapshot, { status: "valid" }>,
    targetTerm: string,
  ): boolean {
    return findEntryByLookup(snapshot.entries, targetTerm) === null;
  }

  /** 正式語の完全一致、別名の完全一致、前方一致、部分一致、定義の部分一致の順に検索順位を返す。 */
  #searchRank(entry: GlossaryEntry, query: string): number | null {
    const term = normalizeGlossaryLookup(entry.term);
    const aliases = entry.aliases.map(normalizeGlossaryLookup);
    if (term === query) return 0;
    if (aliases.some((alias) => alias === query)) return 1;
    if (
      term.startsWith(query) ||
      aliases.some((alias) => alias.startsWith(query))
    )
      return 2;
    if (term.includes(query) || aliases.some((alias) => alias.includes(query)))
      return 3;
    if (normalizeGlossaryLookup(entry.definition).includes(query)) return 4;
    return null;
  }
}
