import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import {
  normalizeSessionWindowRestoreIds,
  type SessionWindowRestoreResult,
} from "../src/session-window-restore.js";

type SessionWindowRestoreStorageLike = {
  loadSnapshot(): Promise<string[]>;
  saveSnapshot(sessionIds: readonly string[]): Promise<void>;
};

type SessionWindowRestoreServiceDeps = {
  storage: SessionWindowRestoreStorageLike;
  getSession(sessionId: string): Awaitable<unknown | null>;
  openSessionWindow(sessionId: string): Promise<unknown>;
  onSnapshotSaved?(sessionIds: readonly string[]): void;
};

export class SessionWindowRestoreService {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionWindowRestoreServiceDeps) {}

  async getSnapshot(): Promise<string[]> {
    await this.writeTail;
    return this.deps.storage.loadSnapshot();
  }

  saveSnapshot(sessionIds: readonly string[]): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(sessionIds);
    if (!normalized) {
      return Promise.reject(new TypeError("Session Window restore snapshot が不正です。"));
    }
    const write = this.writeTail
      .catch(() => undefined)
      .then(() => this.deps.storage.saveSnapshot(normalized))
      .then(() => this.deps.onSnapshotSaved?.(normalized));
    this.writeTail = write;
    return write;
  }

  async restoreSnapshot(): Promise<SessionWindowRestoreResult> {
    const requestedSessionIds = await this.getSnapshot();
    const openedSessionIds: string[] = [];
    const failures: SessionWindowRestoreResult["failures"] = [];

    for (const sessionId of requestedSessionIds) {
      let session: unknown | null;
      try {
        session = await this.deps.getSession(sessionId);
      } catch {
        failures.push({ sessionId, reason: "unreadable" });
        continue;
      }
      if (!session) {
        failures.push({ sessionId, reason: "missing" });
        continue;
      }
      try {
        await this.deps.openSessionWindow(sessionId);
        openedSessionIds.push(sessionId);
      } catch {
        failures.push({ sessionId, reason: "open-failed" });
      }
    }

    return { requestedSessionIds, openedSessionIds, failures };
  }
}
