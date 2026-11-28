import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import {
  getSessionIncarnationId,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";

/** UI の実行設定を個別に持つ Main または Auxiliary の要約。 */
type SelectionOwner = SessionSummary | AuxiliarySessionSummary;
/** 所有者の世代・プロバイダーを保持し、異なる対象へ選択値を流用しないための記録。 */
type CurrentSelection = {
  identity: string;
  provider: string;
  parentSessionId: string | null;
  executionOptions: SessionExecutionOptions;
};

/** Main は incarnation、Auxiliary は所属 Main と作成時刻の組で同一 ID の再利用を区別する。 */
function ownerIdentity(owner: SelectionOwner): string {
  return "createdAt" in owner
    ? `${owner.parentSessionId}\0${owner.createdAt}`
    : getSessionIncarnationId(owner);
}

/** 永続ストアの 1 世代に対する現在の UI 選択値。チェックポイントとは独立している。 */
export class CurrentExecutionSelections {
  private readonly entries = new Map<string, CurrentSelection>();

  /** 実行設定のコピーを保存し、同じ所有者を更新した場合も最新の選択として扱う。 */
  remember(
    owner: SelectionOwner,
    executionOptions: SessionExecutionOptions,
  ): void {
    this.entries.delete(owner.id);
    this.entries.set(owner.id, {
      identity: ownerIdentity(owner),
      provider: owner.provider,
      parentSessionId: "createdAt" in owner ? owner.parentSessionId : null,
      executionOptions: { ...executionOptions },
    });
  }

  /** ID・世代・プロバイダーが一致するときだけ要約に選択値を重ね、異なる場合は元の要約を返す。 */
  apply<T extends SelectionOwner>(owner: T): T {
    const current = this.entries.get(owner.id);
    const selected =
      current &&
      current.identity === ownerIdentity(owner) &&
      current.provider === owner.provider
        ? { ...owner, ...current.executionOptions }
        : owner;
    return selected;
  }

  /** 指定プロバイダーで最後に記録した選択値をコピーして返す。未記録なら null。 */
  latestForProvider(provider: string): SessionExecutionOptions | null {
    const current = Array.from(this.entries.values())
      .reverse()
      .find((entry) => entry.provider === provider);
    if (!current) return null;
    return { ...current.executionOptions };
  }

  /** 存在しない Main とその Auxiliary の設定を除き、Main 自身は世代が変わった場合も忘れる。 */
  retainParents(sessions: readonly SessionSummary[]): void {
    const owners = new Map(sessions.map((session) => [session.id, session]));
    for (const [id, entry] of this.entries) {
      const owner = owners.get(entry.parentSessionId ?? id);
      if (
        !owner ||
        (!entry.parentSessionId && entry.identity !== ownerIdentity(owner))
      ) {
        this.entries.delete(id);
      }
    }
  }

  /** 指定 ID の選択だけを破棄し、親子の別エントリーには触れない。 */
  forget(id: string): void {
    this.entries.delete(id);
  }

  /** 指定の Main と、そこに所属する Auxiliary の選択をまとめて破棄する。 */
  forgetParent(id: string): void {
    for (const [key, entry] of this.entries) {
      if (key === id || entry.parentSessionId === id) this.entries.delete(key);
    }
  }

  /** 現ストア世代に記録されたすべての選択値を破棄する。 */
  clear(): void {
    this.entries.clear();
  }
}
