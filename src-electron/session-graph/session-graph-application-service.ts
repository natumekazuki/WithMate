import type { SessionGraphIdentity, SessionGraphOperation, SessionGraphOperationResult, SessionGraphOwner, SessionGraphRequest } from "../../src-shared/session-graph/session-graph-contract.js";
import { assertRuntimeTurnAdmission, runWithRuntimeTurnAdmission, type RuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import { sessionGraphStorageRequestSchemas, type SessionGraphStorageOperation, type SessionGraphStorageRequest, type SessionGraphStorageResult, type SessionGraphUiReadOperation, type SessionGraphUiReadRequest, type SessionGraphUiReadResult } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";

export type ResolvedSessionGraphSession = {
  owner: SessionGraphOwner;
  identity: SessionGraphIdentity;
  providerId: string;
  generation: object | string;
};
export type SessionGraphStore = {
  execute<K extends SessionGraphStorageOperation>(owner: SessionGraphOwner, operation: K, request: SessionGraphStorageRequest<K>, identity?: SessionGraphIdentity, actorSnapshots?: SessionGraphIdentity[]): Promise<SessionGraphStorageResult<K>>;
};
export type SessionGraphReadOperation = SessionGraphUiReadOperation;
export const sameSessionGraphOwner = (left: SessionGraphOwner, right: SessionGraphOwner): boolean => left.sessionId === right.sessionId && left.incarnationId === right.incarnationId;

export type SessionGraphApplicationServiceDeps = {
    getStore: () => SessionGraphStore;
    resolveSession: (id: string) => ResolvedSessionGraphSession | null | Promise<ResolvedSessionGraphSession | null>;
};
export class SessionGraphApplicationService {
  readonly #deps: SessionGraphApplicationServiceDeps;
  readonly #listeners = new Set<(sessionId: string) => void>();
  constructor(deps: SessionGraphApplicationServiceDeps) { this.#deps = deps; }

  resolveSession(id: string) { return this.#deps.resolveSession(id); }
  subscribe(listener: (sessionId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  read<K extends SessionGraphReadOperation>(sessionId: string, operation: K, request: SessionGraphUiReadRequest<K>) {
    return this.readTrusted(sessionId, operation, request, () => true);
  }
  async executeTrusted<K extends SessionGraphOperation>(sessionId: string, operation: K, request: SessionGraphRequest<K>, guard: () => boolean, admission?: RuntimeTurnAdmission, expectedOwner?: SessionGraphOwner): Promise<SessionGraphOperationResult<K>> {
    return this.execute(sessionId, operation, request, guard, admission, expectedOwner) as Promise<SessionGraphOperationResult<K>>;
  }
  readTrusted<K extends SessionGraphReadOperation>(sessionId: string, operation: K, request: SessionGraphUiReadRequest<K>, guard: () => boolean, expectedOwner?: SessionGraphOwner): Promise<SessionGraphUiReadResult<K>> {
    return this.execute(sessionId, operation, request, guard, undefined, expectedOwner) as Promise<SessionGraphUiReadResult<K>>;
  }
  private async execute<K extends SessionGraphStorageOperation>(sessionId: string, operation: K, request: SessionGraphStorageRequest<K>, guard: () => boolean, admission?: RuntimeTurnAdmission, expectedOwner?: SessionGraphOwner): Promise<SessionGraphStorageResult<K>> {
    const parsed = sessionGraphStorageRequestSchemas[operation].parse(request) as SessionGraphStorageRequest<K>;
    const captured = await this.#deps.resolveSession(sessionId);
    if (!captured || (expectedOwner && !sameSessionGraphOwner(expectedOwner, captured.owner))) throw new Error("Session Graph owner is unavailable.");
    const store = this.#deps.getStore();
    const check = async () => {
      assertRuntimeTurnAdmission();
      const current = await this.#deps.resolveSession(sessionId);
      if (!guard() || !current || current.generation !== captured.generation || this.#deps.getStore() !== store
        || !sameSessionGraphOwner(current.owner, captured.owner) || current.providerId !== captured.providerId
        || current.identity.sessionId !== captured.identity.sessionId || current.identity.character?.id !== captured.identity.character?.id) {
        throw new Error("Session Graph authority changed.");
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
            throw new Error("Session Graph actor is outside the parent Session.");
          }
          actors.push(actor.identity);
        }
      }
      await check();
      const result = await store.execute(captured.owner, operation, parsed, captured.identity, actors);
      await check();
      if (operation === "apply" && result.status === "ok") {
        for (const listener of this.#listeners) listener(captured.owner.sessionId);
      }
      return result;
    };
    return admission ? runWithRuntimeTurnAdmission(admission, run) : run();
  }
}
