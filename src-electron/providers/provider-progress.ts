import type { ProviderAgentRuntimeBindingRedactor } from "./provider-agent-runtime-binding.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type {
  RunSessionTurnProgressChanges,
  RunSessionTurnProgressHandler,
} from "./provider-runtime.js";

/** 別のコレクション所有者を持たずに、Main の既存スナップショットを更新する。 */
export function applyProviderProgressChanges<T extends { id: string }>(
  current: T[],
  changes: { upserts: T[]; removes: string[] },
): T[] {
  if (!changes.upserts.length && !changes.removes.length) return current;
  const items = new Map(current.map((item) => [item.id, item]));
  for (const id of changes.removes) items.delete(id);
  for (const item of changes.upserts) items.set(item.id, item);
  return [...items.values()];
}

/** プロバイダーの所有元で変更を追跡し、変わっていない詳細は再度反映しない。 */
export class ProviderProgressMap<T extends { id: string }> extends Map<
  string,
  T
> {
  private readonly changed = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly projected = new Map<string, T>();
  private redactor: ProviderAgentRuntimeBindingRedactor | undefined;

  /** 生の進捗項目と未配信差分を空の状態で初期化する。 */
  constructor() {
    super();
  }

  /** 更新を次回の配信対象にし、同じキーに対する未配信の削除を取り消す。 */
  override set(key: string, value: T): this {
    super.set(key, value);
    this.changed.add(key);
    this.removed.delete(key);
    return this;
  }

  /** 存在する項目だけを削除し、未配信の更新を削除に置き換える。 */
  override delete(key: string): boolean {
    if (!super.delete(key)) return false;
    this.changed.delete(key);
    this.removed.add(key);
    return true;
  }

  /** 現在の全項目を削除として記録し、配信前の更新を破棄する。 */
  override clear(): void {
    for (const key of this.keys()) this.removed.add(key);
    this.changed.clear();
    super.clear();
  }

  /** 秘匿化済み差分を取り出して消費する。秘匿化処理の切り替え時は既存項目も更新し、必要な場合だけスナップショットを返す。 */
  takeProgress(
    redactor: ProviderAgentRuntimeBindingRedactor,
    includeSnapshot = true,
  ): {
    snapshot: T[];
    changes: { upserts: T[]; removes: string[] };
  } {
    if (this.redactor !== redactor) {
      for (const key of this.keys()) this.changed.add(key);
      this.redactor = redactor;
    }
    const upserts: T[] = [];
    for (const key of this.changed) {
      const value = redactor.sanitize(this.get(key)!);
      this.projected.set(key, value);
      upserts.push(value);
    }
    const removes = [...this.removed].map(
      (key) => this.projected.get(key)?.id ?? redactor.sanitizeText(key),
    );
    for (const key of this.removed) this.projected.delete(key);
    this.changed.clear();
    this.removed.clear();
    return {
      snapshot: includeSnapshot ? [...this.projected.values()] : [],
      changes: { upserts, removes },
    };
  }
}

/** スナップショットを保持したり、重複するペイロードのサイズを計算したりせず、必要な進捗を転送する。 */
export class ProviderProgressDelivery {
  private readonly pending = new Set<Promise<void>>();

  /** 転送先と、同期・非同期を問わず転送失敗を受け取る処理を設定する。 */
  constructor(
    private readonly handler: RunSessionTurnProgressHandler | undefined,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  /** 転送先がなければ何もせず、あれば完了まで追跡する。失敗は通知し、返す Promise も拒否する。 */
  deliver(
    state: LiveSessionRunState,
    changes: RunSessionTurnProgressChanges,
  ): Promise<void> {
    if (!this.handler) return Promise.resolve();
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(this.handler(state, changes));
    } catch (error) {
      operation = Promise.reject(error);
    }
    const completion = operation
      .catch((error) => {
        this.onFailure(error);
        throw error;
      })
      .finally(() => {
        this.pending.delete(completion);
      });
    this.pending.add(completion);
    void completion.catch(() => undefined);
    return completion;
  }

  /** 呼び出し時点で未完了の転送を待ち、そのいずれかの失敗を伝える。 */
  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}
