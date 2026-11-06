import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import {
  normalizeSessionWindowRestoreIds,
  type SessionWindowRestoreResult,
} from "../../src-shared/window/session-window-restore.js";
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
  private currentSessionIds: string[] = [];
  private writeTail: Promise<void>;

  constructor(private readonly deps: SessionWindowRestoreServiceDeps) {
    this.restoreSetLoaded = this.deps.storage.loadSnapshot().then((sessionIds) => {
      const normalized = normalizeSessionWindowRestoreIds(sessionIds);
      if (!normalized) {
        throw new Error("The Session Window restore snapshot is invalid.");
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
    return [...this.restoreSet];
  }

  saveSnapshot(sessionIds: readonly string[]): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(sessionIds);
    if (!normalized) {
      return Promise.reject(new TypeError("The Session Window restore snapshot is invalid."));
    }
    const previousSessionIds = this.currentSessionIds;
    this.currentSessionIds = normalized;
    const snapshot = this.restoreSetLoaded.then(() => {
      const closedSessionIds = new Set(previousSessionIds.filter((sessionId) => !normalized.includes(sessionId)));
      const previousRestoreSetSize = this.restoreSet.length;
      this.restoreSet = this.restoreSet.filter((sessionId) => !closedSessionIds.has(sessionId));
      if (this.restoreSet.length !== previousRestoreSetSize) this.notifyRestoreSetChanged();
      return normalizeSessionWindowRestoreIds([...this.restoreSet, ...normalized])!;
    }, () => normalized);
    const write = this.writeTail.then(async () => this.deps.storage.saveSnapshot(await snapshot));
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
    const candidates = restoreSessionIds.filter(
      (sessionId) => initialWindowStates.get(sessionId)?.kind !== "settled-open",
    );
    this.restoreSet = this.restoreSet.filter((sessionId) => initialWindowStates.get(sessionId)?.kind !== "settled-open");
    const requestedSessionIds: string[] = [];
    const openedSessionIds: string[] = [];
    const failures: SessionWindowRestoreResult["failures"] = [];

    for (const sessionId of candidates) {
      // A manual open followed by close can consume a not-yet-processed target.
      if (!this.restoreSet.includes(sessionId)) continue;
      requestedSessionIds.push(sessionId);
      const initialWindowState = initialWindowStates.get(sessionId);
      if (initialWindowState?.kind === "opening") {
        const openingResult = await openingResults.get(sessionId);
        if (openingResult === "opened") {
          openedSessionIds.push(sessionId);
          this.restoreSet = this.restoreSet.filter((candidate) => candidate !== sessionId);
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
      if (!this.restoreSet.includes(sessionId)) {
        requestedSessionIds.pop();
        continue;
      }
      try {
        await this.deps.openSessionWindow(sessionId);
        openedSessionIds.push(sessionId);
        this.restoreSet = this.restoreSet.filter((candidate) => candidate !== sessionId);
      } catch {
        failures.push({ sessionId, reason: "open-failed" });
      }
    }

    this.notifyRestoreSetChanged();

    return { requestedSessionIds, openedSessionIds, failures };
  }

  private notifyRestoreSetChanged(): void {
    try {
      this.deps.onRestoreSetChanged?.(this.restoreSet);
    } catch {
      // The invoke result remains the canonical projection when a renderer notification fails.
    }
  }
}
