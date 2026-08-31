import { randomBytes, timingSafeEqual } from "node:crypto";

export type ProviderAgentRuntimeTurnHandle = Readonly<{
  actorSessionId: string;
  providerId: string;
  capability: string;
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
  }): ProviderAgentRuntimeTurnHandle {
    const key = turnKey(input.actorSessionId, input.providerId);
    if (this.#activeByActor.has(key)) {
      throw new Error("A provider Session turn is already active for this actor.");
    }
    const handle = Object.freeze({
      actorSessionId: input.actorSessionId,
      providerId: input.providerId,
      capability: randomBytes(32).toString("base64url"),
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
    if (!handle || !equalCapability(input.turnCapability, handle.capability)) {
      return { ok: false, reason: "inactive" };
    }
    return { ok: true, handle };
  }

  end(handle: ProviderAgentRuntimeTurnHandle): void {
    const key = turnKey(handle.actorSessionId, handle.providerId);
    if (this.#activeByActor.get(key) === handle) {
      this.#activeByActor.delete(key);
    }
  }
}
