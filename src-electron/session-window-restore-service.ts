import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import {
  normalizeSessionWindowRestoreIds,
  type SessionWindowRestoreResult,
} from "../src/session-window-restore.js";
import type { SessionWindowRestoreState } from "./session-window-bridge.js";

type SessionWindowRestoreStorageLike = {
  loadSnapshot(): Promise<string[]>;
  saveSnapshot(sessionIds: readonly string[]): Promise<void>;
};

type SessionWindowRestoreServiceDeps = {
  storage: SessionWindowRestoreStorageLike;
  getSession(sessionId: string): Awaitable<unknown | null>;
  getSessionWindowRestoreStates(): ReadonlyMap<string, SessionWindowRestoreState>;
  openSessionWindow(sessionId: string): Promise<unknown>;
  onRestoreSetChanged?(sessionIds: readonly string[]): void;
};

export class SessionWindowRestoreService {
  private readonly restoreSetLoaded: Promise<void>;
  private restoreSet: string[] = [];
  private writeTail: Promise<void>;

  constructor(private readonly deps: SessionWindowRestoreServiceDeps) {
    this.restoreSetLoaded = this.deps.storage.loadSnapshot().then((sessionIds) => {
      const normalized = normalizeSessionWindowRestoreIds(sessionIds);
      if (!normalized) {
        throw new Error("Session Window restore snapshot が不正です。");
      }
      this.restoreSet = normalized;
    });
    this.writeTail = this.restoreSetLoaded.then(
      () => undefined,
      () => undefined,
    );
  }

  async getSnapshot(): Promise<string[]> {
    await this.restoreSetLoaded;
    await this.writeTail;
    return [...this.restoreSet];
  }

  saveSnapshot(sessionIds: readonly string[]): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(sessionIds);
    if (!normalized) {
      return Promise.reject(new TypeError("Session Window restore snapshot が不正です。"));
    }
    const write = this.writeTail.then(() => this.deps.storage.saveSnapshot(normalized));
    this.writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  async restoreSnapshot(): Promise<SessionWindowRestoreResult> {
    const initialWindowStates = this.deps.getSessionWindowRestoreStates();
    const openingResults = new Map<string, Promise<"opened" | "open-failed">>();
    for (const [sessionId, state] of initialWindowStates.entries()) {
      if (state.kind !== "opening") {
        continue;
      }
      openingResults.set(sessionId, this.deps.openSessionWindow(sessionId).then(
        () => "opened",
        () => "open-failed",
      ));
    }
    const restoreSessionIds = await this.getSnapshot();
    const requestedSessionIds = restoreSessionIds.filter(
      (sessionId) => initialWindowStates.get(sessionId)?.kind !== "settled-open",
    );
    const openedSessionIds: string[] = [];
    const failures: SessionWindowRestoreResult["failures"] = [];

    for (const sessionId of requestedSessionIds) {
      const initialWindowState = initialWindowStates.get(sessionId);
      if (initialWindowState?.kind === "opening") {
        const openingResult = await openingResults.get(sessionId);
        if (openingResult === "opened") {
          openedSessionIds.push(sessionId);
        } else {
          failures.push({ sessionId, reason: "open-failed" });
        }
        continue;
      }

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

    this.restoreSet = failures.map(({ sessionId }) => sessionId);
    try {
      this.deps.onRestoreSetChanged?.(this.restoreSet);
    } catch {
      // The invoke result remains the canonical projection when a renderer notification fails.
    }

    return { requestedSessionIds, openedSessionIds, failures };
  }
}
