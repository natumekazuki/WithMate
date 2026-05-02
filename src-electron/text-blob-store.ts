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
import { mkdir, readdir, readFile, rename, rm, stat as fsStat, writeFile } from "node:fs/promises";
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

export type BlobCodec = "br";
export type BlobContentType = "text/plain" | "application/json";

export type BlobRef = {
  blobId: string;
  codec: BlobCodec;
  contentType: BlobContentType;
  originalBytes: number;
  storedBytes: number;
  rawSha256: string;
  storedSha256: string;
};

export type BlobReadOptions = {
  maxOriginalBytes?: number;
};

export type BlobGcInput = {
  referencedBlobIds?: readonly string[];
  dryRun?: boolean;
  graceMs?: number;
};

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

export class TextBlobSizeLimitError extends Error {
  readonly blobId: string;
  readonly originalBytes: number;
  readonly maxOriginalBytes: number;

  constructor(blobId: string, originalBytes: number, maxOriginalBytes: number) {
    super(`Blob ${blobId} is ${originalBytes} bytes, which exceeds maxOriginalBytes=${maxOriginalBytes}`);
    this.name = "TextBlobSizeLimitError";
    this.blobId = blobId;
    this.originalBytes = originalBytes;
    this.maxOriginalBytes = maxOriginalBytes;
  }
}

export class TextBlobStore {
  private readonly rootPath: string;

  constructor(blobRootPath: string) {
    this.rootPath = path.resolve(blobRootPath);
  }

  async putText(input: { contentType: BlobContentType; text: string }): Promise<BlobRef> {
    const raw = Buffer.from(input.text, "utf8");
    const rawSha256 = sha256(raw);
    const blobId = sha256(Buffer.concat([Buffer.from(`${input.contentType}\0${rawSha256}\0`, "utf8"), raw]));
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
    await writeAtomic(paths.metadataPath, Buffer.from(`${JSON.stringify(ref)}\n`, "utf8"));
    return ref;
  }

  async putJson(input: { value: unknown }): Promise<BlobRef> {
    return this.putText({
      contentType: "application/json",
      text: JSON.stringify(input.value),
    });
  }

  async getText(blobId: string, options: BlobReadOptions = {}): Promise<string> {
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

  async getJson<T>(blobId: string, options: BlobReadOptions = {}): Promise<T> {
    const text = await this.getText(blobId, options);
    return JSON.parse(text) as T;
  }

  async stat(blobId: string): Promise<BlobRef | null> {
    validateBlobId(blobId);
    const paths = this.pathsFor(blobId);
    const metadata = await readMetadata(paths.metadataPath);
    if (!metadata || metadata.blobId !== blobId) {
      return null;
    }

    try {
      await fsStat(paths.blobPath);
    } catch {
      return null;
    }
    return metadata;
  }

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

  async collectGarbage(input: BlobGcInput = {}): Promise<BlobGcReport> {
    const dryRun = input.dryRun === true;
    const graceMs = input.graceMs ?? 0;
    const referencedBlobIds = input.referencedBlobIds ? new Set(input.referencedBlobIds) : null;
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

  private async statOrThrow(blobId: string): Promise<BlobRef> {
    const ref = await this.stat(blobId);
    if (!ref) {
      throw new Error(`Blob ${blobId} not found`);
    }
    return ref;
  }

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

  private async deleteBlobFiles(blobId: string, dryRun: boolean): Promise<number> {
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

  private pathsFor(blobId: string): { directoryPath: string; blobPath: string; metadataPath: string } {
    validateBlobId(blobId);
    const directoryPath = path.join(this.rootPath, blobId.slice(0, 2), blobId.slice(2, 4));
    return {
      directoryPath,
      blobPath: path.join(directoryPath, `${blobId}.${CODEC}`),
      metadataPath: path.join(directoryPath, `${blobId}.json`),
    };
  }
}

export class SyncTextBlobStore {
  private readonly rootPath: string;

  constructor(blobRootPath: string) {
    this.rootPath = path.resolve(blobRootPath);
  }

  putText(input: { contentType: BlobContentType; text: string }): BlobRef {
    const raw = Buffer.from(input.text, "utf8");
    const rawSha256 = sha256(raw);
    const blobId = sha256(Buffer.concat([Buffer.from(`${input.contentType}\0${rawSha256}\0`, "utf8"), raw]));
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
    writeAtomicSync(paths.metadataPath, Buffer.from(`${JSON.stringify(ref)}\n`, "utf8"));
    return ref;
  }

  putJson(input: { value: unknown }): BlobRef {
    return this.putText({
      contentType: "application/json",
      text: JSON.stringify(input.value),
    });
  }

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

  getJson<T>(blobId: string, options: BlobReadOptions = {}): T {
    const text = this.getText(blobId, options);
    return JSON.parse(text) as T;
  }

  stat(blobId: string): BlobRef | null {
    validateBlobId(blobId);
    const paths = this.pathsFor(blobId);
    const metadata = readMetadataSync(paths.metadataPath);
    if (!metadata || metadata.blobId !== blobId) {
      return null;
    }

    try {
      statSync(paths.blobPath);
    } catch {
      return null;
    }
    return metadata;
  }

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

  private statOrThrow(blobId: string): BlobRef {
    const ref = this.stat(blobId);
    if (!ref) {
      throw new Error(`Blob ${blobId} not found`);
    }
    return ref;
  }

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

  private pathsFor(blobId: string): { directoryPath: string; blobPath: string; metadataPath: string } {
    validateBlobId(blobId);
    const directoryPath = path.join(this.rootPath, blobId.slice(0, 2), blobId.slice(2, 4));
    return {
      directoryPath,
      blobPath: path.join(directoryPath, `${blobId}.${CODEC}`),
      metadataPath: path.join(directoryPath, `${blobId}.json`),
    };
  }
}

function assertWithinMax(ref: BlobRef, maxOriginalBytes: number | undefined): void {
  if (maxOriginalBytes !== undefined && ref.originalBytes > maxOriginalBytes) {
    throw new TextBlobSizeLimitError(ref.blobId, ref.originalBytes, maxOriginalBytes);
  }
}

async function readMetadata(metadataPath: string): Promise<BlobRef | null> {
  try {
    return parseMetadata(await readFile(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

function readMetadataSync(metadataPath: string): BlobRef | null {
  try {
    return parseMetadata(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

function parseMetadata(metadata: string): BlobRef | null {
  const parsed = JSON.parse(metadata) as Partial<BlobRef>;
  if (
    typeof parsed.blobId === "string" &&
    BLOB_ID_PATTERN.test(parsed.blobId) &&
    parsed.codec === CODEC &&
    (parsed.contentType === "text/plain" || parsed.contentType === "application/json") &&
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

async function writeAtomic(destinationPath: string, bytes: Buffer): Promise<void> {
  const tempPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, bytes, { flag: "wx" });
    try {
      await rename(tempPath, destinationPath);
    } catch (error) {
      const writeError = error as NodeJS.ErrnoException;
      if ((writeError.code === "EEXIST" || writeError.code === "EPERM") && await fileExists(destinationPath)) {
        return;
      }
      throw error;
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function writeAtomicIfMissing(destinationPath: string, bytes: Buffer): Promise<void> {
  try {
    await fsStat(destinationPath);
    return;
  } catch {
    await writeAtomic(destinationPath, bytes);
  }
}

function writeAtomicSync(destinationPath: string, bytes: Buffer): void {
  const tempPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, bytes, { flag: "wx" });
    try {
      renameSync(tempPath, destinationPath);
    } catch (error) {
      const writeError = error as NodeJS.ErrnoException;
      if ((writeError.code === "EEXIST" || writeError.code === "EPERM") && fileExistsSync(destinationPath)) {
        return;
      }
      throw error;
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function writeAtomicIfMissingSync(destinationPath: string, bytes: Buffer): void {
  try {
    statSync(destinationPath);
    return;
  } catch {
    writeAtomicSync(destinationPath, bytes);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

function fileExistsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function readdirSafe(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch {
    return [];
  }
}

function validateBlobId(blobId: string): void {
  if (!BLOB_ID_PATTERN.test(blobId)) {
    throw new Error(`Invalid blob id: ${blobId}`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
