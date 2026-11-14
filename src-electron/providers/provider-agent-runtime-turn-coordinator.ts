import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

export type ProviderAgentRuntimeTurnHandle = Readonly<{
  actorSessionId: string;
  providerId: string;
  capability: string;
  revocationState: SharedArrayBuffer;
  executionOptions?: SessionExecutionOptions;
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

  begin(input: {
    actorSessionId: string;
    providerId: string;
    executionOptions?: SessionExecutionOptions;
  }): ProviderAgentRuntimeTurnHandle {
    const key = turnKey(input.actorSessionId, input.providerId);
    if (this.#activeByActor.has(key)) {
      throw new Error("A provider Session turn is already active for this actor.");
    }
    const handle = Object.freeze({
      actorSessionId: input.actorSessionId,
      providerId: input.providerId,
      ...(input.executionOptions ? { executionOptions: Object.freeze({ ...input.executionOptions }) } : {}),
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
  }):
    | { ok: true; handle: ProviderAgentRuntimeTurnHandle }
    | { ok: false; reason: "inactive" } {
    const handle = this.#activeByActor.get(turnKey(input.actorSessionId, input.providerId));
    if (!handle || handle.actorSessionId !== input.actorSessionId || handle.providerId !== input.providerId
      || !equalCapability(input.turnCapability, handle.capability)) {
      return { ok: false, reason: "inactive" };
    }
    return { ok: true, handle };
  }

  end(handle: ProviderAgentRuntimeTurnHandle): void {
    const key = turnKey(handle.actorSessionId, handle.providerId);
    if (this.#activeByActor.get(key) === handle) {
      Atomics.store(new Int32Array(handle.revocationState), 0, 1);
      this.#activeByActor.delete(key);
    }
  }
}
