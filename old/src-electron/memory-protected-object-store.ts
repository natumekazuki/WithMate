import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_OBJECTS_ROOT = "memory-objects";
const MEMORY_OBJECTS_VERSION_DIRECTORY = "v6";
const STAGING_DIRECTORY = ".staging";
const OBJECT_FILE_EXTENSION = ".bin";
const OBJECT_ID_PATTERN = /^[a-f0-9]{32}$/;

export type MemoryProtectedObjectWriteResult = {
  objectId: string;
  storedBytes: number;
};

export type MemoryProtectedObjectFileGcCandidate = {
  objectId: string;
  bytes: number;
};

export type MemoryProtectedObjectStagingGcReport = {
  candidates: number;
  deleted: number;
  failed: number;
};

export function createMemoryProtectedObjectId(): string {
  return randomUUID().replaceAll("-", "");
}

export function resolveMemoryProtectedObjectStoreRoot(userDataPath: string): string {
  return join(userDataPath, MEMORY_OBJECTS_ROOT, MEMORY_OBJECTS_VERSION_DIRECTORY);
}

function assertObjectId(objectId: string): void {
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error("Memory protected object ID is invalid.");
  }
}

export class MemoryProtectedObjectStore {
  constructor(private readonly rootPath: string) {}

  static fromUserDataPath(userDataPath: string): MemoryProtectedObjectStore {
    return new MemoryProtectedObjectStore(resolveMemoryProtectedObjectStoreRoot(userDataPath));
  }

  resolveObjectPath(objectId: string): string {
    assertObjectId(objectId);
    return join(this.resolveShardDirectory(objectId), `${objectId}${OBJECT_FILE_EXTENSION}`);
  }

  async writeObject(input: { objectId?: string; payload: Uint8Array }): Promise<MemoryProtectedObjectWriteResult> {
    const objectId = input.objectId ?? createMemoryProtectedObjectId();
    assertObjectId(objectId);
    const shardDirectory = this.resolveShardDirectory(objectId);
    const objectPath = this.resolveObjectPath(objectId);
    const stagingPath = join(this.rootPath, STAGING_DIRECTORY, `${objectId}.${createMemoryProtectedObjectId()}.tmp`);

    await mkdir(join(this.rootPath, STAGING_DIRECTORY), { recursive: true });
    await mkdir(shardDirectory, { recursive: true });
    try {
      await writeFile(stagingPath, input.payload, { flag: "wx" });
      await linkObject(stagingPath, objectPath);
      await removeBestEffort(stagingPath);
      return {
        objectId,
        storedBytes: input.payload.byteLength,
      };
    } catch (error) {
      await removeBestEffort(stagingPath);
      throw error;
    }
  }

  async readObject(objectId: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const objectPath = this.resolveObjectPath(objectId);
    if (options.maxBytes !== undefined) {
      const fileStats = await stat(objectPath);
      if (!fileStats.isFile() || fileStats.size > options.maxBytes) {
        throw new Error("Memory protected object exceeds read size limit.");
      }
    }
    const payload = await readFile(objectPath);
    if (options.maxBytes !== undefined && payload.byteLength > options.maxBytes) {
      throw new Error("Memory protected object exceeds read size limit.");
    }
    return payload;
  }

  async objectExists(objectId: string): Promise<boolean> {
    try {
      await access(this.resolveObjectPath(objectId), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async deleteObject(objectId: string): Promise<boolean> {
    const objectPath = this.resolveObjectPath(objectId);
    const exists = await this.objectExists(objectId);
    if (!exists) {
      return false;
    }
    await rm(objectPath, { force: true });
    return true;
  }

  async listObjectFilesForGc(input: { graceMs: number; limit: number }): Promise<MemoryProtectedObjectFileGcCandidate[]> {
    const candidates: MemoryProtectedObjectFileGcCandidate[] = [];
    const shardNames = await this.listDirectoryNames(this.rootPath);
    for (const shardName of shardNames) {
      if (shardName === STAGING_DIRECTORY || shardName.length !== 2) {
        continue;
      }
      const shardPath = join(this.rootPath, shardName);
      const fileNames = await this.listFileNames(shardPath);
      for (const fileName of fileNames) {
        if (candidates.length >= input.limit) {
          return candidates;
        }
        if (!fileName.endsWith(OBJECT_FILE_EXTENSION)) {
          continue;
        }
        const objectId = fileName.slice(0, -OBJECT_FILE_EXTENSION.length);
        if (!OBJECT_ID_PATTERN.test(objectId) || objectId.slice(0, 2) !== shardName) {
          continue;
        }
        const filePath = join(shardPath, fileName);
        let fileStats;
        try {
          fileStats = await stat(filePath);
        } catch {
          continue;
        }
        if (!fileStats.isFile() || !isOlderThanGrace(fileStats.mtimeMs, input.graceMs)) {
          continue;
        }
        candidates.push({ objectId, bytes: fileStats.size });
      }
    }
    return candidates;
  }

  async collectStagingGarbage(input: { dryRun: boolean; graceMs: number; limit: number }): Promise<MemoryProtectedObjectStagingGcReport> {
    const stagingPath = join(this.rootPath, STAGING_DIRECTORY);
    const fileNames = await this.listFileNames(stagingPath);
    let candidates = 0;
    let deleted = 0;
    let failed = 0;
    for (const fileName of fileNames) {
      if (candidates >= input.limit) {
        break;
      }
      const filePath = join(stagingPath, fileName);
      try {
        const fileStats = await stat(filePath);
        if (!fileStats.isFile() || !isOlderThanGrace(fileStats.mtimeMs, input.graceMs)) {
          continue;
        }
        candidates += 1;
        if (!input.dryRun) {
          await rm(filePath, { force: true });
          deleted += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return { candidates, deleted, failed };
  }

  async listStagingFileNames(): Promise<string[]> {
    try {
      return await readdir(join(this.rootPath, STAGING_DIRECTORY));
    } catch {
      return [];
    }
  }

  private resolveShardDirectory(objectId: string): string {
    assertObjectId(objectId);
    return join(this.rootPath, objectId.slice(0, 2));
  }

  private async listDirectoryNames(directoryPath: string): Promise<string[]> {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async listFileNames(directoryPath: string): Promise<string[]> {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

function isOlderThanGrace(mtimeMs: number, graceMs: number): boolean {
  return Date.now() - mtimeMs >= Math.max(0, graceMs);
}

async function linkObject(stagingPath: string, objectPath: string): Promise<void> {
  try {
    await link(stagingPath, objectPath);
    return;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error("Memory protected object already exists.");
    }
    throw error;
  }
}

async function removeBestEffort(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // Keep the original write/link error. Stale staging files are GC candidates.
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
