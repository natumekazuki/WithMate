import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeSessionWindowRestoreIds } from "../src/session-window-restore.js";

const SNAPSHOT_FILE_NAME = "session-window-restore-set.json";
const SNAPSHOT_VERSION = 1;

type SnapshotDocument = {
  version: typeof SNAPSHOT_VERSION;
  sessionIds: string[];
};

export class SessionWindowRestoreStorage {
  private readonly snapshotPath: string;

  constructor(userDataPath: string) {
    this.snapshotPath = join(userDataPath, SNAPSHOT_FILE_NAME);
  }

  async loadSnapshot(): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as Partial<SnapshotDocument> | null;
    const sessionIds = parsed?.version === SNAPSHOT_VERSION
      ? normalizeSessionWindowRestoreIds(parsed.sessionIds)
      : null;
    if (!sessionIds) {
      throw new Error("Session Window restore snapshot が不正です。");
    }
    return sessionIds;
  }

  async saveSnapshot(sessionIds: readonly string[]): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(sessionIds);
    if (!normalized) {
      throw new TypeError("Session Window restore snapshot が不正です。");
    }
    const document: SnapshotDocument = {
      version: SNAPSHOT_VERSION,
      sessionIds: normalized,
    };
    const directoryPath = dirname(this.snapshotPath);
    const temporaryPath = join(
      directoryPath,
      `.${SNAPSHOT_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(directoryPath, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
      await rename(temporaryPath, this.snapshotPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
