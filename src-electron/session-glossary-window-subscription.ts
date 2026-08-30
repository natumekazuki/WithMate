import type { SessionGlossaryProjection } from "../src/glossary-contract.js";

export type SessionGlossaryWindowLike = {
  id: number;
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
};

export type SessionGlossaryWindowSubscriptionDeps<TWindow extends SessionGlossaryWindowLike> = {
  getWindow: (sessionId: string) => TWindow | null;
  subscribe: (
    sessionId: string,
    listener: (projection: SessionGlossaryProjection) => void,
  ) => Promise<() => void>;
  deliver: (window: TWindow, projection: SessionGlossaryProjection) => void;
};

type SubscriptionState =
  | { kind: "starting"; windowId: number; promise: Promise<void> }
  | { kind: "active"; windowId: number; dispose: () => void };

export class SessionGlossaryWindowSubscriptionCoordinator<
  TWindow extends SessionGlossaryWindowLike,
> {
  readonly #deps: SessionGlossaryWindowSubscriptionDeps<TWindow>;
  readonly #states = new Map<string, SubscriptionState>();

  constructor(deps: SessionGlossaryWindowSubscriptionDeps<TWindow>) {
    this.#deps = deps;
  }

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
      this.#states.set(sessionId, { kind: "starting", windowId: window.id, promise: attempt });
      await attempt;
    }
  }

  async #start(sessionId: string, expectedWindow: TWindow): Promise<void> {
    const dispose = await this.#deps.subscribe(sessionId, (projection) => {
      const currentWindow = this.#deps.getWindow(sessionId);
      if (currentWindow && !currentWindow.isDestroyed()) {
        this.#deps.deliver(currentWindow, projection);
      }
    });
    const currentWindow = this.#deps.getWindow(sessionId);
    if (
      !currentWindow
      || currentWindow.isDestroyed()
      || currentWindow.id !== expectedWindow.id
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
      if (current?.kind === "active" && current.windowId === expectedWindow.id) {
        current.dispose();
        this.#states.delete(sessionId);
      }
    });
  }
}
