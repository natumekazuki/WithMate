import { randomBytes, timingSafeEqual } from "node:crypto";

export type ProviderAgentRuntimeTurnHandle = Readonly<{
  actorSessionId: string;
  providerId: string;
  capability: string;
  revocationState: SharedArrayBuffer;
  bindingId?: string;
}>;

function turnKey(actorSessionId: string, providerId: string): string {
  return `${actorSessionId}\0${providerId}`;
}

function equalCapability(actual: string | null | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class ProviderAgentRuntimeTurnCoordinator {
  readonly #activeByActor = new Map<string, ProviderAgentRuntimeTurnHandle>();
  readonly #backgroundByBinding = new Map<string, ProviderAgentRuntimeTurnHandle>();

  begin(input: {
    actorSessionId: string;
    providerId: string;
  }): ProviderAgentRuntimeTurnHandle {
    const key = turnKey(input.actorSessionId, input.providerId);
    if (this.#activeByActor.has(key)) {
      throw new Error("A provider Session turn is already active for this actor.");
    }
    const handle = Object.freeze({
      actorSessionId: input.actorSessionId,
      providerId: input.providerId,
      capability: randomBytes(32).toString("base64url"),
      revocationState: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    });
    this.#activeByActor.set(key, handle);
    return handle;
  }

  admit(input: {
    actorSessionId: string;
    providerId: string;
    turnCapability: string | null | undefined;
    bindingId?: string;
  }):
    | { ok: true; handle: ProviderAgentRuntimeTurnHandle }
    | { ok: false; reason: "inactive" } {
    const handle = (input.bindingId ? this.#backgroundByBinding.get(input.bindingId) : undefined)
      ?? this.#activeByActor.get(turnKey(input.actorSessionId, input.providerId));
    if (!handle || handle.actorSessionId !== input.actorSessionId || handle.providerId !== input.providerId
      || !equalCapability(input.turnCapability, handle.capability)) {
      return { ok: false, reason: "inactive" };
    }
    return { ok: true, handle };
  }

  beginBackground(input: { actorSessionId: string; providerId: string; bindingId: string }): ProviderAgentRuntimeTurnHandle {
    if (!input.bindingId || this.#backgroundByBinding.has(input.bindingId)) throw new Error("Background execution is already active.");
    const handle = Object.freeze({ ...input, capability: randomBytes(32).toString("base64url"),
      revocationState: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) });
    this.#backgroundByBinding.set(input.bindingId, handle);
    return handle;
  }

  end(handle: ProviderAgentRuntimeTurnHandle): void {
    if (handle.bindingId) {
      if (this.#backgroundByBinding.get(handle.bindingId) === handle) {
        Atomics.store(new Int32Array(handle.revocationState), 0, 1);
        this.#backgroundByBinding.delete(handle.bindingId);
      }
      return;
    }
    const key = turnKey(handle.actorSessionId, handle.providerId);
    if (this.#activeByActor.get(key) === handle) {
      Atomics.store(new Int32Array(handle.revocationState), 0, 1);
      this.#activeByActor.delete(key);
    }
  }
}
