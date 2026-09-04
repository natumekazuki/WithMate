import {
  ProviderAgentRuntimeTurnCoordinator,
  type ProviderAgentRuntimeTurnHandle,
} from "./provider-agent-runtime-turn-coordinator.js";

export type GlossaryProactiveTurnHandle = ProviderAgentRuntimeTurnHandle;

type ProactiveTurnState = {
  limit: number | null | undefined;
  requestFingerprint: string | null;
};

export class GlossaryProactiveTurnCoordinator {
  readonly #providerTurns: ProviderAgentRuntimeTurnCoordinator;
  readonly #stateByHandle = new WeakMap<GlossaryProactiveTurnHandle, ProactiveTurnState>();

  constructor(providerTurns: ProviderAgentRuntimeTurnCoordinator) {
    this.#providerTurns = providerTurns;
  }

  begin(input: {
    actorSessionId: string;
    providerId: string;
    proactiveCreateLimit: number | null | undefined;
  }): GlossaryProactiveTurnHandle {
    const handle = this.#providerTurns.begin({
      actorSessionId: input.actorSessionId,
      providerId: input.providerId,
    });
    this.#stateByHandle.set(handle, {
      limit: input.proactiveCreateLimit,
      requestFingerprint: null,
    });
    return handle;
  }

  end(handle: GlossaryProactiveTurnHandle): void {
    this.#stateByHandle.delete(handle);
    this.#providerTurns.end(handle);
  }

  admit(input: {
    actorSessionId: string;
    providerId: string;
    turnCapability: string | null | undefined;
    requestFingerprint: string;
    entryCount: number;
  }): { ok: true; proactiveCreateLimit: number } | { ok: false; reason: "inactive" | "invalid-limit" | "limit-exceeded" | "second-request" } {
    const admission = this.#providerTurns.admit(input);
    const state = admission.ok ? this.#stateByHandle.get(admission.handle) : null;
    if (!admission.ok || !state) {
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
