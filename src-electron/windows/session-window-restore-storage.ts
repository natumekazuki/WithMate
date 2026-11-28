import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeSessionWindowRestoreIds } from "../../src-shared/window/session-window-restore.js";

const SNAPSHOT_FILE_NAME = "session-window-restore-set.json";
const SNAPSHOT_VERSION = 1;

/** ファイルに保存する復元スナップショットの版と対象 ID。 */
type SnapshotDocument = {
  version: typeof SNAPSHOT_VERSION;
  sessionIds: string[];
};

/** userData 配下の版付き JSON ファイルに、復元対象を記録する。 */
export class SessionWindowRestoreStorage {
  private readonly snapshotPath: string;

  /** 指定の userData 内で復元スナップショットの保存先を決める。 */
  constructor(userDataPath: string) {
    this.snapshotPath = join(userDataPath, SNAPSHOT_FILE_NAME);
  }

  /** ファイルがなければ空の候補を返し、読み取れない場合や不正な内容は失敗として返す。 */
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
    const sessionIds =
      parsed?.version === SNAPSHOT_VERSION
        ? normalizeSessionWindowRestoreIds(parsed.sessionIds)
        : null;
    if (!sessionIds) {
      throw new Error("Session Window restore snapshot is invalid.");
    }
    return sessionIds;
  }

  /** ID を正規化し、同じディレクトリの一時ファイルへの書き込み後に保存先を置き換える。 */
  async saveSnapshot(sessionIds: readonly string[]): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(sessionIds);
    if (!normalized) {
      throw new TypeError("Session Window restore snapshot is invalid.");
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
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        flag: "wx",
      });
      await rename(temporaryPath, this.snapshotPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
