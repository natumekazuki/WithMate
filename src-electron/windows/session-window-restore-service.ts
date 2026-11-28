import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import {
  normalizeSessionWindowRestoreIds,
  type SessionWindowRestoreResult,
} from "../../src-shared/window/session-window-restore.js";
import type { SessionWindowOpenOptions, SessionWindowRestoreState } from "./session-window-bridge.js";

type SessionWindowRestoreStorageLike = {
  loadSnapshot(): Promise<string[]>;
  saveSnapshot(sessionIds: readonly string[]): Promise<void>;
};

type SessionWindowRestoreServiceDeps = {
  storage: SessionWindowRestoreStorageLike;
  getSession(sessionId: string): Awaitable<unknown | null>;
  getSessionWindowRestoreStates(): ReadonlyMap<string, SessionWindowRestoreState>;
  openSessionWindow(sessionId: string, options: SessionWindowOpenOptions): Promise<unknown>;
  onRestoreSetChanged?(sessionIds: readonly string[]): void;
};

export class SessionWindowRestoreService {
  private restoreSetLoaded: Promise<void> | null;
  private restoreSet: string[] = [];
  private restoreSetKnown = false;
  private currentSessionIds: string[] = [];
  private writeTail: Promise<void>;

  constructor(private readonly deps: SessionWindowRestoreServiceDeps) {
    this.restoreSetLoaded = this.loadRestoreSet(false);
    this.writeTail = this.restoreSetLoaded.then(
      () => undefined,
      () => undefined,
    );
  }

  async getSnapshot(): Promise<string[]> {
    // 復元対象の集合が不明な場合にだけ、先行する書き込みを待って読み取りを再試行する。
    // その間に保存が成功し、スナップショットが既に修復されている場合がある。
    const loading = this.restoreSetLoaded ??= this.writeTail.then(() => {
      if (!this.restoreSetKnown) return this.loadRestoreSet(true);
    });
    try {
      await loading;
    } catch (error) {
      if (this.restoreSetLoaded === loading) this.restoreSetLoaded = null;
      throw error;
    }
    return [...this.restoreSet];
  }

  saveSnapshot(sessionIds: readonly string[]): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(sessionIds);
    if (!normalized) {
      return Promise.reject(new TypeError("The Session Window restore snapshot is invalid."));
    }
    const previousSessionIds = this.currentSessionIds;
    this.currentSessionIds = normalized;
    const snapshot = (this.restoreSetLoaded ?? Promise.resolve()).then(() => {
      if (!this.restoreSetKnown) return normalized;
      const closedSessionIds = new Set(previousSessionIds.filter((sessionId) => !normalized.includes(sessionId)));
      const previousRestoreSetSize = this.restoreSet.length;
      this.restoreSet = this.restoreSet.filter((sessionId) => !closedSessionIds.has(sessionId));
      if (this.restoreSet.length !== previousRestoreSetSize) this.notifyRestoreSetChanged();
      return normalizeSessionWindowRestoreIds([...this.restoreSet, ...normalized])!;
    }, () => normalized);
    const write = this.writeTail.then(async () => {
      const sessionIds = await snapshot;
      await this.deps.storage.saveSnapshot(sessionIds);
      if (!this.restoreSetKnown) {
        // 復旧の書き込みを待っている間に出された終了要求のほうが新しい意思を示す。
        this.restoreSet = sessionIds.filter((sessionId) => this.currentSessionIds.includes(sessionId));
        this.restoreSetKnown = true;
        this.restoreSetLoaded = Promise.resolve();
        this.notifyRestoreSetChanged();
      }
    });
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
      openingResults.set(sessionId, this.deps.openSessionWindow(sessionId, { presentation: "minimized" }).then(
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
      // 手動で開いてから閉じると、まだ復元処理していない対象が消費されることがある。
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
        await this.deps.openSessionWindow(sessionId, { presentation: "minimized" });
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
      // renderer への通知に失敗しても、invoke の結果が正規の投影結果であることは変わらない。
    }
  }

  private async loadRestoreSet(notify: boolean): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(await this.deps.storage.loadSnapshot());
    if (!normalized) throw new Error("The Session Window restore snapshot is invalid.");
    this.restoreSet = normalized;
    this.restoreSetKnown = true;
    if (notify) this.notifyRestoreSetChanged();
  }
}
