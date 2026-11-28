import type { SessionGlossaryProjection } from "../../src-shared/glossary/glossary-contract.js";

/** 用語一覧の配信先を識別し、破棄と閉じた通知を確認するために必要な Window の部分契約。 */
export type SessionGlossaryWindowLike = {
  id: number;
  /** 配信候補がすでに破棄された Window かを確認する。 */
  isDestroyed(): boolean;
  /** その Window が閉じたときに、購読の解放処理を一度呼び出すよう登録する。 */
  once(event: "closed", listener: () => void): unknown;
};

/** Session の現在の Window と用語集購読を結び、投影された内容を渡すための依存。 */
export type SessionGlossaryWindowSubscriptionDeps<
  TWindow extends SessionGlossaryWindowLike,
> = {
  getWindow: (sessionId: string) => TWindow | null;
  subscribe: (
    sessionId: string,
    listener: (projection: SessionGlossaryProjection) => void,
  ) => Promise<() => void>;
  deliver: (window: TWindow, projection: SessionGlossaryProjection) => void;
};

/** 購読開始中の試行と配信中の購読を区別し、どちらも準備時点の Window ID にひも付ける。 */
type SubscriptionState =
  | { kind: "starting"; windowId: number; promise: Promise<void> }
  | { kind: "active"; windowId: number; dispose: () => void };

/** Session ごとに購読の多重開始を防ぎ、対象 Window が閉じたり置き換わったときに購読を解放する。 */
export class SessionGlossaryWindowSubscriptionCoordinator<
  TWindow extends SessionGlossaryWindowLike,
> {
  readonly #deps: SessionGlossaryWindowSubscriptionDeps<TWindow>;
  readonly #states = new Map<string, SubscriptionState>();

  /** Window の解決、購読解除の取得、用語集の配信を行う処理を設定する。 */
  constructor(deps: SessionGlossaryWindowSubscriptionDeps<TWindow>) {
    this.#deps = deps;
  }

  /** 現在の Window に購読がなければ用意する。開始中の試行を待ち、現行の Window と一致するまで確認する。 */
  async ensure(sessionId: string): Promise<void> {
    for (;;) {
      const window = this.#deps.getWindow(sessionId);
      const state = this.#states.get(sessionId);
      if (!window || window.isDestroyed()) {
        if (state?.kind === "active") {
          state.dispose();
        }
        if (this.#states.get(sessionId) === state) {
          this.#states.delete(sessionId);
        }
        return;
      }
      if (state?.kind === "active") {
        if (state.windowId === window.id) {
          return;
        }
        state.dispose();
        this.#states.delete(sessionId);
        continue;
      }
      if (state?.kind === "starting") {
        await state.promise.catch(() => undefined);
        continue;
      }

      let attempt!: Promise<void>;
      attempt = this.#start(sessionId, window).finally(() => {
        const current = this.#states.get(sessionId);
        if (current?.kind === "starting" && current.promise === attempt) {
          this.#states.delete(sessionId);
        }
      });
      this.#states.set(sessionId, {
        kind: "starting",
        windowId: window.id,
        promise: attempt,
      });
      await attempt;
    }
  }

  /** 購読を開始し、投影は配信時点の有効な Window へ渡す。開始完了時に Window が変わっていたら取得した購読を解放する。 */
  async #start(sessionId: string, expectedWindow: TWindow): Promise<void> {
    const dispose = await this.#deps.subscribe(sessionId, (projection) => {
      const currentWindow = this.#deps.getWindow(sessionId);
      if (currentWindow && !currentWindow.isDestroyed()) {
        this.#deps.deliver(currentWindow, projection);
      }
    });
    const currentWindow = this.#deps.getWindow(sessionId);
    if (
      !currentWindow ||
      currentWindow.isDestroyed() ||
      currentWindow.id !== expectedWindow.id
    ) {
      dispose();
      return;
    }

    this.#states.set(sessionId, {
      kind: "active",
      windowId: expectedWindow.id,
      dispose,
    });
    expectedWindow.once("closed", () => {
      const current = this.#states.get(sessionId);
      if (
        current?.kind === "active" &&
        current.windowId === expectedWindow.id
      ) {
        current.dispose();
        this.#states.delete(sessionId);
      }
    });
  }
}
