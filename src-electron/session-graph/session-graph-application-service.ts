import type { SessionGraphIdentity, SessionGraphOperation, SessionGraphOperationResult, SessionGraphOwner, SessionGraphRequest, SessionGraphSource, SessionGraphStorageAuthority } from "../../src-shared/session-graph/session-graph-contract.js";
import { assertRuntimeTurnAdmission, runWithRuntimeTurnAdmission, type RuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import { sessionGraphStorageRequestSchemas, type SessionGraphStorageOperation, type SessionGraphStorageRequest, type SessionGraphStorageResult, type SessionGraphUiReadOperation, type SessionGraphUiReadRequest, type SessionGraphUiReadResult } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";

export type ResolvedSessionGraphSession = {
  owner: SessionGraphOwner;
  identity: SessionGraphIdentity;
  providerId: string;
  generation: object | string;
  source: SessionGraphSource;
};
export type SessionGraphStore = {
  execute<K extends SessionGraphStorageOperation>(owner: SessionGraphOwner, operation: K, request: SessionGraphStorageRequest<K>, identity?: SessionGraphIdentity, actorSnapshots?: SessionGraphIdentity[], authority?: SessionGraphStorageAuthority): Promise<SessionGraphStorageResult<K>>;
};
export type SessionGraphReadOperation = SessionGraphUiReadOperation;
export const sameSessionGraphOwner = (left: SessionGraphOwner, right: SessionGraphOwner): boolean => left.sessionId === right.sessionId && left.incarnationId === right.incarnationId;

export type SessionGraphApplicationServiceDeps = {
    getStore: () => SessionGraphStore;
    resolveSession: (id: string, source?: { kind: "main" | "auxiliary"; incarnationId?: string }) => ResolvedSessionGraphSession | null | Promise<ResolvedSessionGraphSession | null>;
};
export class SessionGraphApplicationService {
  readonly #deps: SessionGraphApplicationServiceDeps;
  readonly #listeners = new Set<(sessionId: string) => void>();
  constructor(deps: SessionGraphApplicationServiceDeps) { this.#deps = deps; }

  resolveSession(id: string, source?: { kind: "main" | "auxiliary"; incarnationId?: string }) { return this.#deps.resolveSession(id, source); }
  subscribe(listener: (sessionId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  read<K extends SessionGraphReadOperation>(sessionId: string, operation: K, request: SessionGraphUiReadRequest<K>) {
    return this.readTrusted(sessionId, operation, request, () => true);
  }
  async executeTrusted<K extends SessionGraphOperation>(sessionId: string, operation: K, request: SessionGraphRequest<K>, guard: () => boolean, admission?: RuntimeTurnAdmission, expectedOwner?: SessionGraphOwner, source?: SessionGraphSource): Promise<SessionGraphOperationResult<K>> {
    return this.execute(sessionId, operation, request, guard, admission, expectedOwner, source) as Promise<SessionGraphOperationResult<K>>;
  }
  readTrusted<K extends SessionGraphReadOperation>(sessionId: string, operation: K, request: SessionGraphUiReadRequest<K>, guard: () => boolean, expectedOwner?: SessionGraphOwner): Promise<SessionGraphUiReadResult<K>> {
    return this.execute(sessionId, operation, request, guard, undefined, expectedOwner, { kind: "main" }) as Promise<SessionGraphUiReadResult<K>>;
  }
  private async execute<K extends SessionGraphStorageOperation>(sessionId: string, operation: K, request: SessionGraphStorageRequest<K>, guard: () => boolean, admission?: RuntimeTurnAdmission, expectedOwner?: SessionGraphOwner, source?: { kind: "main" | "auxiliary"; incarnationId?: string }): Promise<SessionGraphStorageResult<K>> {
    const parsed = sessionGraphStorageRequestSchemas[operation].parse(request) as SessionGraphStorageRequest<K>;
    const captured = await this.#deps.resolveSession(sessionId, source);
    if (!captured || (expectedOwner && !sameSessionGraphOwner(expectedOwner, captured.owner))) throw new Error("Session Graph owner is unavailable.");
    const requestedOwner = "graphOwner" in parsed ? parsed.graphOwner : undefined;
    const target = requestedOwner ? await this.#deps.resolveSession(requestedOwner.sessionId, { kind: "main", incarnationId: requestedOwner.incarnationId }) : captured;
    if (!target || (requestedOwner && (!sameSessionGraphOwner(requestedOwner, target.owner) || target.identity.sessionId !== requestedOwner.sessionId || target.identity.role !== "main"))
      || target.generation !== captured.generation) throw new Error("Session Graph read target is unavailable.");
    const store = this.#deps.getStore();
    const check = async () => {
      assertRuntimeTurnAdmission();
      const current = await this.#deps.resolveSession(sessionId, captured.source);
      if (!guard() || !current || current.generation !== captured.generation || this.#deps.getStore() !== store
        || !sameSessionGraphOwner(current.owner, captured.owner) || current.providerId !== captured.providerId
        || current.identity.sessionId !== captured.identity.sessionId || current.identity.role !== captured.identity.role
        || current.source.kind !== captured.source.kind || current.source.incarnationId !== captured.source.incarnationId || current.identity.character?.id !== captured.identity.character?.id) {
        throw new Error("Session Graph authority changed.");
      }
      if (requestedOwner) {
        const currentTarget = await this.#deps.resolveSession(requestedOwner.sessionId, { kind: "main", incarnationId: requestedOwner.incarnationId });
        if (!currentTarget || currentTarget.generation !== captured.generation || !sameSessionGraphOwner(currentTarget.owner, requestedOwner)
          || currentTarget.identity.sessionId !== requestedOwner.sessionId || currentTarget.identity.role !== "main") throw new Error("Session Graph read target changed.");
      }
      assertRuntimeTurnAdmission();
    };
    const run = async () => {
      await check();
      const actors: SessionGraphIdentity[] = [];
      if (operation === "apply") {
        for (const record of (parsed as SessionGraphRequest<"apply">).records ?? []) {
          if (!record.actor) continue;
          const actor = await this.#deps.resolveSession(record.actor.sessionId);
          if (!actor || actor.generation !== captured.generation || !sameSessionGraphOwner(actor.owner, captured.owner)) {
            throw new Error("Session Graph actor is outside the parent Crew.");
          }
          actors.push(actor.identity);
        }
      }
      await check();
      const authority = { caller: { ...captured.source, sessionId }, callerOwner: captured.owner };
      const result = await store.execute(target.owner, operation, parsed, captured.identity, actors, authority);
      await check();
      if (operation === "apply" && result.status === "ok") {
        for (const listener of this.#listeners) listener(captured.owner.sessionId);
      }
      return result;
    };
    return admission ? runWithRuntimeTurnAdmission(admission, run) : run();
  }
}
