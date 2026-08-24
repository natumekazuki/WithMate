export type GlossaryProactiveTurnHandle = Readonly<{
  actorSessionId: string;
  providerId: string;
}>;

type ProactiveTurnState = {
  limit: number | null | undefined;
  requestFingerprint: string | null;
};

function turnKey(actorSessionId: string, providerId: string): string {
  return `${actorSessionId}\0${providerId}`;
}

export class GlossaryProactiveTurnCoordinator {
  readonly #activeByActor = new Map<string, GlossaryProactiveTurnHandle>();
  readonly #stateByHandle = new WeakMap<GlossaryProactiveTurnHandle, ProactiveTurnState>();

  begin(input: {
    actorSessionId: string;
    providerId: string;
    proactiveCreateLimit: number | null | undefined;
  }): GlossaryProactiveTurnHandle {
    const key = turnKey(input.actorSessionId, input.providerId);
    if (this.#activeByActor.has(key)) {
      throw new Error("A provider Session turn is already active for this actor.");
    }
    const handle = Object.freeze({
      actorSessionId: input.actorSessionId,
      providerId: input.providerId,
    });
    this.#activeByActor.set(key, handle);
    this.#stateByHandle.set(handle, {
      limit: input.proactiveCreateLimit,
      requestFingerprint: null,
    });
    return handle;
  }

  end(handle: GlossaryProactiveTurnHandle): void {
    const key = turnKey(handle.actorSessionId, handle.providerId);
    if (this.#activeByActor.get(key) === handle) {
      this.#activeByActor.delete(key);
    }
    this.#stateByHandle.delete(handle);
  }

  admit(input: {
    actorSessionId: string;
    providerId: string;
    requestFingerprint: string;
    entryCount: number;
  }): { ok: true; proactiveCreateLimit: number } | { ok: false; reason: "inactive" | "invalid-limit" | "limit-exceeded" | "second-request" } {
    const handle = this.#activeByActor.get(turnKey(input.actorSessionId, input.providerId));
    const state = handle ? this.#stateByHandle.get(handle) : null;
    if (!state) {
      return { ok: false, reason: "inactive" };
    }
    if (state.requestFingerprint === null) {
      state.requestFingerprint = input.requestFingerprint;
    } else if (state.requestFingerprint !== input.requestFingerprint) {
      return { ok: false, reason: "second-request" };
    }
    if (
      !Number.isInteger(state.limit)
      || state.limit === null
      || state.limit === undefined
      || state.limit < 0
      || state.limit > 100
    ) {
      return { ok: false, reason: "invalid-limit" };
    }
    if (state.limit === 0 || input.entryCount > state.limit) {
      return { ok: false, reason: "limit-exceeded" };
    }
    return { ok: true, proactiveCreateLimit: state.limit };
  }
}
