import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat as fsStat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

/** テキスト Blob の保存に使用する圧縮形式。現行形式は Brotli。 */
export type BlobCodec = "br";
/** Blob ID の算出にも使う、格納する本文のメディア種別。 */
export type BlobContentType = "text/plain" | "application/json";

/** 圧縮本文を参照・検証するための ID、形式、圧縮前後のバイト数と SHA-256。 */
export type BlobRef = {
  blobId: string;
  codec: BlobCodec;
  contentType: BlobContentType;
  originalBytes: number;
  storedBytes: number;
  rawSha256: string;
  storedSha256: string;
};

/** 本文を展開する前に、メタデータ上の原文バイト数に適用する読み込み上限。 */
export type BlobReadOptions = {
  maxOriginalBytes?: number;
};

/** 整理から除外する参照済み ID、試行実行の指定、更新から削除までの猶予時間を指定する。 */
export type BlobGcInput = {
  referencedBlobIds?: readonly string[];
  dryRun?: boolean;
  graceMs?: number;
};

/** 孤立・欠損・除外を分類し、実際に削除した Blob と圧縮本文の削除バイト数を示す。 */
export type BlobGcReport = {
  dryRun: boolean;
  orphanBlobIds: string[];
  deletedBlobIds: string[];
  missingBlobIds: string[];
  skippedBlobIds: string[];
  bytesDeleted: number;
};

const CODEC: BlobCodec = "br";
const BLOB_ID_PATTERN = /^[a-f0-9]{64}$/;

/** メタデータ上の原文サイズが読み込み上限を超えたことを、対象 ID とサイズを添えて通知する。 */
export class TextBlobSizeLimitError extends Error {
  readonly blobId: string;
  readonly originalBytes: number;
  readonly maxOriginalBytes: number;

  /** 上限を超えた Blob の ID、メタデータに記録された原文バイト数、許容上限を保持する。 */
  constructor(blobId: string, originalBytes: number, maxOriginalBytes: number) {
    super(
      `Blob ${blobId} is ${originalBytes} bytes, which exceeds maxOriginalBytes=${maxOriginalBytes}`,
    );
    this.name = "TextBlobSizeLimitError";
    this.blobId = blobId;
    this.originalBytes = originalBytes;
    this.maxOriginalBytes = maxOriginalBytes;
  }
}

/** 圧縮本文と検証用メタデータをファイルに保存し、非同期の読み書きと孤立 Blob の整理を提供する。 */
export class TextBlobStore {
  private readonly rootPath: string;

  /** 指定された Blob 保管場所を絶対パスとして保持する。ディレクトリの作成は書き込み時に行う。 */
  constructor(blobRootPath: string) {
    this.rootPath = path.resolve(blobRootPath);
  }

  /** 本文とメディア種別から ID を決めて Brotli 圧縮し、同じ ID の本文がなければ保存する。メタデータを別ファイルに記録する。 */
  async putText(input: {
    contentType: BlobContentType;
    text: string;
  }): Promise<BlobRef> {
    const raw = Buffer.from(input.text, "utf8");
    const rawSha256 = sha256(raw);
    const blobId = sha256(
      Buffer.concat([
        Buffer.from(`${input.contentType}\0${rawSha256}\0`, "utf8"),
        raw,
      ]),
    );
    const compressed = await compress(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    });
    const ref: BlobRef = {
      blobId,
      codec: CODEC,
      contentType: input.contentType,
      originalBytes: raw.byteLength,
      storedBytes: compressed.byteLength,
      rawSha256,
      storedSha256: sha256(compressed),
    };

    const paths = this.pathsFor(blobId);
    await mkdir(paths.directoryPath, { recursive: true });
    await writeAtomicIfMissing(paths.blobPath, compressed);
    await writeAtomic(
      paths.metadataPath,
      Buffer.from(`${JSON.stringify(ref)}\n`, "utf8"),
    );
    return ref;
  }

  /** 値を JSON に直列化し、JSON のメディア種別で圧縮保存する。 */
  async putJson(input: { value: unknown }): Promise<BlobRef> {
    return this.putText({
      contentType: "application/json",
      text: JSON.stringify(input.value),
    });
  }

  /** メタデータのサイズ上限を本文読み出し前に確認し、圧縮データと展開後のデータを照合して UTF-8 テキストを返す。 */
  async getText(
    blobId: string,
    options: BlobReadOptions = {},
  ): Promise<string> {
    const ref = await this.statOrThrow(blobId);
    assertWithinMax(ref, options.maxOriginalBytes);

    const paths = this.pathsFor(blobId);
    const stored = await readFile(paths.blobPath);
    if (sha256(stored) !== ref.storedSha256) {
      throw new Error(`Blob ${blobId} stored sha256 mismatch`);
    }

    const raw = await decompress(stored);
    if (raw.byteLength !== ref.originalBytes || sha256(raw) !== ref.rawSha256) {
      throw new Error(`Blob ${blobId} raw sha256 mismatch`);
    }
    return raw.toString("utf8");
  }

  /** 整合性を確認した本文を JSON として解析する。型引数の形状までは検証しない。 */
  async getJson<T>(blobId: string, options: BlobReadOptions = {}): Promise<T> {
    const text = await this.getText(blobId, options);
    return JSON.parse(text) as T;
  }

  /** 指定 ID に対応するメタデータと本文ファイルの存在を確認する。欠損や不正なメタデータは null とし、本文のハッシュは照合しない。 */
  async stat(blobId: string): Promise<BlobRef | null> {
    validateBlobId(blobId);
    const paths = this.pathsFor(blobId);
    const metadata = await readMetadata(paths.metadataPath);
    if (!metadata || metadata.blobId !== blobId) {
      return null;
    }

    try {
      await fsStat(paths.blobPath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    return metadata;
  }

  /** 呼び出し側が未参照と判定した ID の本文とメタデータを削除し、欠損は報告に含める。 */
  async deleteUnreferenced(blobIds: readonly string[]): Promise<BlobGcReport> {
    const report = createGcReport(false);
    const uniqueBlobIds = [...new Set(blobIds)];
    for (const blobId of uniqueBlobIds) {
      validateBlobId(blobId);
      const ref = await this.stat(blobId);
      if (!ref) {
        report.missingBlobIds.push(blobId);
        continue;
      }
      const deletedBytes = await this.deleteBlobFiles(blobId, false);
      report.deletedBlobIds.push(blobId);
      report.bytesDeleted += deletedBytes;
    }
    return report;
  }

  /** 保管先を走査し、参照中または猶予期間内の Blob を除いて孤立候補を集める。試行実行では削除しない。 */
  async collectGarbage(input: BlobGcInput = {}): Promise<BlobGcReport> {
    const dryRun = input.dryRun === true;
    const graceMs = input.graceMs ?? 0;
    const referencedBlobIds = input.referencedBlobIds
      ? new Set(input.referencedBlobIds)
      : null;
    const report = createGcReport(dryRun);
    const now = Date.now();

    if (referencedBlobIds) {
      for (const blobId of referencedBlobIds) {
        validateBlobId(blobId);
      }
    }

    for (const blobId of await this.listStoredBlobIds()) {
      if (referencedBlobIds?.has(blobId)) {
        report.skippedBlobIds.push(blobId);
        continue;
      }

      const ref = await this.stat(blobId);
      if (!ref) {
        const paths = this.pathsFor(blobId);
        let blobStat;
        try {
          blobStat = await fsStat(paths.blobPath);
        } catch {
          report.missingBlobIds.push(blobId);
          continue;
        }
        if (graceMs > 0 && now - blobStat.mtimeMs < graceMs) {
          report.skippedBlobIds.push(blobId);
          continue;
        }
        report.missingBlobIds.push(blobId);
        report.orphanBlobIds.push(blobId);
        if (!dryRun) {
          const deletedBytes = await this.deleteBlobFiles(blobId, false);
          report.deletedBlobIds.push(blobId);
          report.bytesDeleted += deletedBytes;
        }
        continue;
      }

      const paths = this.pathsFor(blobId);
      let blobStat;
      try {
        blobStat = await fsStat(paths.blobPath);
      } catch {
        report.missingBlobIds.push(blobId);
        continue;
      }

      if (graceMs > 0 && now - blobStat.mtimeMs < graceMs) {
        report.skippedBlobIds.push(blobId);
        continue;
      }

      report.orphanBlobIds.push(blobId);
      if (!dryRun) {
        const deletedBytes = await this.deleteBlobFiles(blobId, false);
        report.deletedBlobIds.push(blobId);
        report.bytesDeleted += deletedBytes;
      }
    }

    return report;
  }

  /** 読み込みに必要なメタデータを得る。本文または有効なメタデータが見つからなければ失敗する。 */
  private async statOrThrow(blobId: string): Promise<BlobRef> {
    const ref = await this.stat(blobId);
    if (!ref) {
      throw new Error(`Blob ${blobId} not found`);
    }
    return ref;
  }

  /** 2 段の索引ディレクトリから、本文かメタデータの少なくとも一方に現れる Blob ID を重複なく列挙する。 */
  private async listStoredBlobIds(): Promise<string[]> {
    const blobIds = new Set<string>();
    const firstLevel = await readdirSafe(this.rootPath);
    for (const firstShard of firstLevel) {
      if (!/^[a-f0-9]{2}$/.test(firstShard)) {
        continue;
      }
      const firstShardPath = path.join(this.rootPath, firstShard);
      const secondLevel = await readdirSafe(firstShardPath);
      for (const secondShard of secondLevel) {
        if (!/^[a-f0-9]{2}$/.test(secondShard)) {
          continue;
        }
        const directoryPath = path.join(firstShardPath, secondShard);
        for (const entry of await readdirSafe(directoryPath)) {
          if (!entry.endsWith(".json") && !entry.endsWith(`.${CODEC}`)) {
            continue;
          }
          const blobId = entry.endsWith(".json")
            ? entry.slice(0, -".json".length)
            : entry.slice(0, -`.${CODEC}`.length);
          if (BLOB_ID_PATTERN.test(blobId)) {
            blobIds.add(blobId);
          }
        }
      }
    }
    return [...blobIds].sort();
  }

  /** 圧縮本文のサイズを集計し、試行実行でなければ本文とメタデータの両方を削除する。 */
  private async deleteBlobFiles(
    blobId: string,
    dryRun: boolean,
  ): Promise<number> {
    const paths = this.pathsFor(blobId);
    let bytesDeleted = 0;
    try {
      bytesDeleted = (await fsStat(paths.blobPath)).size;
    } catch {
      bytesDeleted = 0;
    }

    if (!dryRun) {
      await rm(paths.blobPath, { force: true });
      await rm(paths.metadataPath, { force: true });
    }
    return bytesDeleted;
  }

  /** ID の書式を確認し、先頭 4 桁による 2 段の索引下に本文とメタデータのパスを組み立てる。 */
  private pathsFor(blobId: string): {
    directoryPath: string;
    blobPath: string;
    metadataPath: string;
  } {
    validateBlobId(blobId);
    const directoryPath = path.join(
      this.rootPath,
      blobId.slice(0, 2),
      blobId.slice(2, 4),
    );
    return {
      directoryPath,
      blobPath: path.join(directoryPath, `${blobId}.${CODEC}`),
      metadataPath: path.join(directoryPath, `${blobId}.json`),
    };
  }
}

/** 非同期版と同じ圧縮形式・ファイル配置を使い、同期呼び出しでテキスト Blob を読み書きする。 */
export class SyncTextBlobStore {
  private readonly rootPath: string;

  /** 同期読み書きに使う Blob 保管場所を絶対パスとして保持する。書き込むまでディレクトリは作らない。 */
  constructor(blobRootPath: string) {
    this.rootPath = path.resolve(blobRootPath);
  }

  /** 本文とメディア種別から非同期版と同じ ID を求め、同期圧縮した本文と検証用メタデータを保存する。 */
  putText(input: { contentType: BlobContentType; text: string }): BlobRef {
    const raw = Buffer.from(input.text, "utf8");
    const rawSha256 = sha256(raw);
    const blobId = sha256(
      Buffer.concat([
        Buffer.from(`${input.contentType}\0${rawSha256}\0`, "utf8"),
        raw,
      ]),
    );
    const compressed = brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    });
    const ref: BlobRef = {
      blobId,
      codec: CODEC,
      contentType: input.contentType,
      originalBytes: raw.byteLength,
      storedBytes: compressed.byteLength,
      rawSha256,
      storedSha256: sha256(compressed),
    };

    const paths = this.pathsFor(blobId);
    mkdirSync(paths.directoryPath, { recursive: true });
    writeAtomicIfMissingSync(paths.blobPath, compressed);
    writeAtomicSync(
      paths.metadataPath,
      Buffer.from(`${JSON.stringify(ref)}\n`, "utf8"),
    );
    return ref;
  }

  /** 値を JSON に直列化し、JSON のメディア種別で同期保存する。 */
  putJson(input: { value: unknown }): BlobRef {
    return this.putText({
      contentType: "application/json",
      text: JSON.stringify(input.value),
    });
  }

  /** メタデータの原文サイズを先に確認し、同期読み出しした圧縮本文と展開結果を照合してテキストを返す。 */
  getText(blobId: string, options: BlobReadOptions = {}): string {
    const ref = this.statOrThrow(blobId);
    assertWithinMax(ref, options.maxOriginalBytes);

    const paths = this.pathsFor(blobId);
    const stored = readFileSync(paths.blobPath);
    if (sha256(stored) !== ref.storedSha256) {
      throw new Error(`Blob ${blobId} stored sha256 mismatch`);
    }

    const raw = brotliDecompressSync(stored);
    if (raw.byteLength !== ref.originalBytes || sha256(raw) !== ref.rawSha256) {
      throw new Error(`Blob ${blobId} raw sha256 mismatch`);
    }
    return raw.toString("utf8");
  }

  /** 同期読み込みした本文を JSON として解析する。型引数に適合するかは検証しない。 */
  getJson<T>(blobId: string, options: BlobReadOptions = {}): T {
    const text = this.getText(blobId, options);
    return JSON.parse(text) as T;
  }

  /** 本文と対応するメタデータがあるとき、そのメタデータを同期取得する。欠損や不正なメタデータは null とする。 */
  stat(blobId: string): BlobRef | null {
    validateBlobId(blobId);
    const paths = this.pathsFor(blobId);
    const metadata = readMetadataSync(paths.metadataPath);
    if (!metadata || metadata.blobId !== blobId) {
      return null;
    }

    try {
      statSync(paths.blobPath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    return metadata;
  }

  /** 呼び出し側が未参照と判断した ID の本文とメタデータを同期削除し、欠損と削除量を報告する。 */
  deleteUnreferenced(blobIds: readonly string[]): BlobGcReport {
    const report = createGcReport(false);
    const uniqueBlobIds = [...new Set(blobIds)];
    for (const blobId of uniqueBlobIds) {
      validateBlobId(blobId);
      const ref = this.stat(blobId);
      if (!ref) {
        report.missingBlobIds.push(blobId);
        continue;
      }
      const deletedBytes = this.deleteBlobFiles(blobId, false);
      report.deletedBlobIds.push(blobId);
      report.bytesDeleted += deletedBytes;
    }
    return report;
  }

  /** 同期読み込みに必要なメタデータを取得する。本文または有効なメタデータがなければ失敗する。 */
  private statOrThrow(blobId: string): BlobRef {
    const ref = this.stat(blobId);
    if (!ref) {
      throw new Error(`Blob ${blobId} not found`);
    }
    return ref;
  }

  /** 圧縮本文のサイズを取得し、試行実行でなければ本文とメタデータを同期削除する。 */
  private deleteBlobFiles(blobId: string, dryRun: boolean): number {
    const paths = this.pathsFor(blobId);
    let bytesDeleted = 0;
    try {
      bytesDeleted = statSync(paths.blobPath).size;
    } catch {
      bytesDeleted = 0;
    }

    if (!dryRun) {
      rmSync(paths.blobPath, { force: true });
      rmSync(paths.metadataPath, { force: true });
    }
    return bytesDeleted;
  }

  /** 非同期版と同じ 2 段の索引に従い、有効な ID から同期読み書き用のパスを得る。 */
  private pathsFor(blobId: string): {
    directoryPath: string;
    blobPath: string;
    metadataPath: string;
  } {
    validateBlobId(blobId);
    const directoryPath = path.join(
      this.rootPath,
      blobId.slice(0, 2),
      blobId.slice(2, 4),
    );
    return {
      directoryPath,
      blobPath: path.join(directoryPath, `${blobId}.${CODEC}`),
      metadataPath: path.join(directoryPath, `${blobId}.json`),
    };
  }
}

/** メタデータに記録された原文バイト数が指定上限を超えていれば、本文を読む前に拒否する。 */
function assertWithinMax(
  ref: BlobRef,
  maxOriginalBytes: number | undefined,
): void {
  if (maxOriginalBytes !== undefined && ref.originalBytes > maxOriginalBytes) {
    throw new TextBlobSizeLimitError(
      ref.blobId,
      ref.originalBytes,
      maxOriginalBytes,
    );
  }
}

/** メタデータを読み取り、ファイルがない場合は null、それ以外の読み取り失敗は例外として伝える。 */
async function readMetadata(metadataPath: string): Promise<BlobRef | null> {
  let metadata: string;
  try {
    metadata = await readFile(metadataPath, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    return null;
  }
  return parseMetadata(metadata);
}

/** メタデータを同期読み取りし、ファイルがない場合は null、それ以外の読み取り失敗は例外として伝える。 */
function readMetadataSync(metadataPath: string): BlobRef | null {
  let metadata: string;
  try {
    metadata = readFileSync(metadataPath, "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
    return null;
  }
  return parseMetadata(metadata);
}

/** メタデータを解析し、ID・形式・種別・バイト数・ハッシュ欄が所定の書式に合えば Blob 参照として返す。 */
function parseMetadata(metadata: string): BlobRef | null {
  let parsed: Partial<BlobRef>;
  try {
    parsed = JSON.parse(metadata) as Partial<BlobRef>;
  } catch {
    return null;
  }
  if (
    typeof parsed.blobId === "string" &&
    BLOB_ID_PATTERN.test(parsed.blobId) &&
    parsed.codec === CODEC &&
    (parsed.contentType === "text/plain" ||
      parsed.contentType === "application/json") &&
    Number.isSafeInteger(parsed.originalBytes) &&
    Number.isSafeInteger(parsed.storedBytes) &&
    typeof parsed.rawSha256 === "string" &&
    BLOB_ID_PATTERN.test(parsed.rawSha256) &&
    typeof parsed.storedSha256 === "string" &&
    BLOB_ID_PATTERN.test(parsed.storedSha256)
  ) {
    return parsed as BlobRef;
  }
  return null;
}

/** ファイルが見つからないことを示す ENOENT を、それ以外のファイル操作エラーと区別する。 */
function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** 一時ファイルへの書き込み後に改名して公開する。EEXIST または EPERM で保存先が既に見える場合は許容し、一時ファイルを片付ける。 */
async function writeAtomic(
  destinationPath: string,
  bytes: Buffer,
): Promise<void> {
  const tempPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, bytes, { flag: "wx" });
    try {
      await rename(tempPath, destinationPath);
    } catch (error) {
      const writeError = error as NodeJS.ErrnoException;
      if (
        (writeError.code === "EEXIST" || writeError.code === "EPERM") &&
        (await fileExists(destinationPath))
      ) {
        return;
      }
      throw error;
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** 保存先の存在を確認できれば既存の本文を使い、確認できなければ一時ファイル経由の書き込みを試す。 */
async function writeAtomicIfMissing(
  destinationPath: string,
  bytes: Buffer,
): Promise<void> {
  try {
    await fsStat(destinationPath);
    return;
  } catch {
    await writeAtomic(destinationPath, bytes);
  }
}

/** 一時ファイルを書き終えてから同期改名で公開する。EEXIST または EPERM でも保存先の存在を確認できれば許容する。 */
function writeAtomicSync(destinationPath: string, bytes: Buffer): void {
  const tempPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, bytes, { flag: "wx" });
    try {
      renameSync(tempPath, destinationPath);
    } catch (error) {
      const writeError = error as NodeJS.ErrnoException;
      if (
        (writeError.code === "EEXIST" || writeError.code === "EPERM") &&
        fileExistsSync(destinationPath)
      ) {
        return;
      }
      throw error;
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/** 同期確認で既存ファイルが見つかれば本文を書き直さず、確認に失敗した場合に限って書き込みを試す。 */
function writeAtomicIfMissingSync(
  destinationPath: string,
  bytes: Buffer,
): void {
  try {
    statSync(destinationPath);
    return;
  } catch {
    writeAtomicSync(destinationPath, bytes);
  }
}

/** 改名失敗時の判断に使う保存先の存在確認。ファイル情報の取得に失敗すれば false を返す。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

/** 保存先のファイル情報を同期取得できたか返す。取得失敗の理由は区別しない。 */
function fileExistsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 整理時にディレクトリの項目名を読み、一覧取得に失敗した場合は空として扱う。 */
async function readdirSafe(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch {
    return [];
  }
}

/** ファイルパスの組み立て前に、ID が小文字の 16 進数 64 桁でなければ例外にする。 */
function validateBlobId(blobId: string): void {
  if (!BLOB_ID_PATTERN.test(blobId)) {
    throw new Error(`Invalid blob id: ${blobId}`);
  }
}

/** Blob の識別と整合性照合に使用する SHA-256 を小文字の 16 進文字列で得る。 */
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 試行実行かどうかを保持し、分類ごとの一覧と削除バイト数を空の状態で初期化する。 */
function createGcReport(dryRun: boolean): BlobGcReport {
  return {
    dryRun,
    orphanBlobIds: [],
    deletedBlobIds: [],
    missingBlobIds: [],
    skippedBlobIds: [],
    bytesDeleted: 0,
  };
}
