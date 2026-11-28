import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import {
  normalizeSessionWindowRestoreIds,
  type SessionWindowRestoreResult,
} from "../../src-shared/window/session-window-restore.js";
import type {
  SessionWindowOpenOptions,
  SessionWindowRestoreState,
} from "./session-window-bridge.js";

/** 次回起動で復元する Session ID の永続化境界。 */
type SessionWindowRestoreStorageLike = {
  /** 前回保存した復元対象の ID を読み込む。 */
  loadSnapshot(): Promise<string[]>;
  /** 復元対象の ID の集合を現在のスナップショットとして保存する。 */
  saveSnapshot(sessionIds: readonly string[]): Promise<void>;
};

/** 復元対象を保存・検証し、既存ウィンドウの状態と照合するための接続口。 */
type SessionWindowRestoreServiceDeps = {
  storage: SessionWindowRestoreStorageLike;
  /** 復元前に対象 Session が残っているか確認する。未存在と読み取り失敗は区別する。 */
  getSession(sessionId: string): Awaitable<unknown | null>;
  /** 復元開始時に確定済みと作成途中のウィンドウを区別する。 */
  getSessionWindowRestoreStates(): ReadonlyMap<
    string,
    SessionWindowRestoreState
  >;
  /** 未作成なら指定の表示方法で開き、作成中ならその処理に合流する。 */
  openSessionWindow(
    sessionId: string,
    options: SessionWindowOpenOptions,
  ): Promise<unknown>;
  /** 現在の復元候補を購読側へ通知する。通知の失敗で復元結果を覆さない。 */
  onRestoreSetChanged?(sessionIds: readonly string[]): void;
};

/** 前回からの復元候補と今回開いたウィンドウを別々に管理し、保存と復元に反映する。 */
export class SessionWindowRestoreService {
  private restoreSetLoaded: Promise<void> | null;
  private restoreSet: string[] = [];
  private restoreSetKnown = false;
  private currentSessionIds: string[] = [];
  private writeTail: Promise<void>;

  /** 前回のスナップショットを先に読み、初回の読み込み結果にかかわらず後続保存を待ち行列に載せられるようにする。 */
  constructor(private readonly deps: SessionWindowRestoreServiceDeps) {
    this.restoreSetLoaded = this.loadRestoreSet(false);
    this.writeTail = this.restoreSetLoaded.then(
      () => undefined,
      () => undefined,
    );
  }

  /** 未復元の ID のコピーを返し、まだ読み取りが確定していないときだけ先行保存後に再試行する。 */
  async getSnapshot(): Promise<string[]> {
    // 復元対象の集合が不明な場合にだけ、先行する書き込みを待って読み取りを再試行する。
    // その間に保存が成功し、スナップショットが既に修復されている場合がある。
    const loading = (this.restoreSetLoaded ??= this.writeTail.then(() => {
      if (!this.restoreSetKnown) return this.loadRestoreSet(true);
    }));
    try {
      await loading;
    } catch (error) {
      if (this.restoreSetLoaded === loading) this.restoreSetLoaded = null;
      throw error;
    }
    return [...this.restoreSet];
  }

  /** 実際に開いたウィンドウを記録し、前回からの未処理候補と突き合わせて保存を直列化する。 */
  saveSnapshot(sessionIds: readonly string[]): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(sessionIds);
    if (!normalized) {
      return Promise.reject(
        new TypeError("The Session Window restore snapshot is invalid."),
      );
    }
    const previousSessionIds = this.currentSessionIds;
    this.currentSessionIds = normalized;
    const snapshot = (this.restoreSetLoaded ?? Promise.resolve()).then(
      () => {
        if (!this.restoreSetKnown) return normalized;
        const closedSessionIds = new Set(
          previousSessionIds.filter(
            (sessionId) => !normalized.includes(sessionId),
          ),
        );
        const previousRestoreSetSize = this.restoreSet.length;
        this.restoreSet = this.restoreSet.filter(
          (sessionId) => !closedSessionIds.has(sessionId),
        );
        if (this.restoreSet.length !== previousRestoreSetSize)
          this.notifyRestoreSetChanged();
        return normalizeSessionWindowRestoreIds([
          ...this.restoreSet,
          ...normalized,
        ])!;
      },
      () => normalized,
    );
    const write = this.writeTail.then(async () => {
      const sessionIds = await snapshot;
      await this.deps.storage.saveSnapshot(sessionIds);
      if (!this.restoreSetKnown) {
        // 復旧の書き込みを待っている間に出された終了要求のほうが新しい意思を示す。
        this.restoreSet = sessionIds.filter((sessionId) =>
          this.currentSessionIds.includes(sessionId),
        );
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

  /** 作成途中のウィンドウには合流し、未作成の対象は最小化して開く。対象別の失敗は後続処理を止めない。 */
  async restoreSnapshot(): Promise<SessionWindowRestoreResult> {
    const initialWindowStates = this.deps.getSessionWindowRestoreStates();
    const openingResults = new Map<string, Promise<"opened" | "open-failed">>();
    for (const [sessionId, state] of initialWindowStates.entries()) {
      if (state.kind !== "opening") {
        continue;
      }
      openingResults.set(
        sessionId,
        this.deps
          .openSessionWindow(sessionId, { presentation: "minimized" })
          .then(
            () => "opened",
            () => "open-failed",
          ),
      );
    }
    const restoreSessionIds = await this.getSnapshot();
    const candidates = restoreSessionIds.filter(
      (sessionId) =>
        initialWindowStates.get(sessionId)?.kind !== "settled-open",
    );
    this.restoreSet = this.restoreSet.filter(
      (sessionId) =>
        initialWindowStates.get(sessionId)?.kind !== "settled-open",
    );
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
          this.restoreSet = this.restoreSet.filter(
            (candidate) => candidate !== sessionId,
          );
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
        await this.deps.openSessionWindow(sessionId, {
          presentation: "minimized",
        });
        openedSessionIds.push(sessionId);
        this.restoreSet = this.restoreSet.filter(
          (candidate) => candidate !== sessionId,
        );
      } catch {
        failures.push({ sessionId, reason: "open-failed" });
      }
    }

    this.notifyRestoreSetChanged();

    return { requestedSessionIds, openedSessionIds, failures };
  }

  /** 更新後の復元候補を通知する。通知の例外は読み取りや復元の結果へ伝えない。 */
  private notifyRestoreSetChanged(): void {
    try {
      this.deps.onRestoreSetChanged?.(this.restoreSet);
    } catch {
      // renderer への通知に失敗しても、invoke の結果が正規の投影結果であることは変わらない。
    }
  }

  /** 保存済みの ID を検証して復元候補を確定し、指定時だけ更新を通知する。 */
  private async loadRestoreSet(notify: boolean): Promise<void> {
    const normalized = normalizeSessionWindowRestoreIds(
      await this.deps.storage.loadSnapshot(),
    );
    if (!normalized)
      throw new Error("The Session Window restore snapshot is invalid.");
    this.restoreSet = normalized;
    this.restoreSetKnown = true;
    if (notify) this.notifyRestoreSetChanged();
  }
}
