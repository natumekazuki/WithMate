import { randomUUID } from "node:crypto";
import { AFFECT_SCHEMA_VERSION, assertCanonicalUtcTimestamp, assertValidAffectEvent, type AffectEventInput } from "../../src-shared/character-affect/affect-contract.js";
import { validateAffectCompositionOutput } from "../../src-shared/character-affect/affect-composition.js";
import { getSessionIncarnationId, isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import { matchesSessionHistorySource, type SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";
import { RuntimeTurnInactiveError, assertRuntimeTurnAdmission, runWithRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { AgentRuntimeBindingRegistry } from "../providers/agent-runtime-binding.js";
import type { BackgroundExecution } from "../providers/background-execution-service.js";
import type { ProviderAgentRuntimeTurnCoordinator } from "../providers/provider-agent-runtime-turn-coordinator.js";
import type { CharacterAffectService } from "./character-affect-service.js";
import { CharacterAffectIdempotencyConflictError, CharacterAffectVersionConflictError } from "./character-affect-storage.js";

/** App-owned saved Main data, not model output. Read only Main turns within the supplied scope. */
export type BackgroundAffectMainSource = {
  session: Pick<Session, "id" | "incarnationId" | "characterId" | "accessMode" | "sourceSchemaVersion" | "sessionKind">;
  ownerIdentity: string;
  turns: readonly Pick<SessionTurnRecord, "id" | "sessionId" | "phase" | "completedAt" | "assistantMessageSeq">[];
};

export type BackgroundAffectSaved = {
  candidateIndex: number;
  eventId: string;
  created: boolean;
  replayed: boolean;
};

export type BackgroundAffectFailureCode = "invalid_output" | "unsupported_source" | "authority_denied"
  | "source_unavailable" | "canceled" | "version_conflict" | "idempotency_conflict" | "save_failed";

export type BackgroundAffectResult =
  | { kind: "no_change" }
  | { kind: "saved"; saved: BackgroundAffectSaved[] }
  | { kind: "stopped"; saved: BackgroundAffectSaved[];
      failure: { code: BackgroundAffectFailureCode; candidateIndex: number | null; effect: "none" | "unknown" };
      unattemptedCandidateIndexes: number[] | null };

class ScopeError extends Error {
  constructor(readonly code: BackgroundAffectFailureCode, readonly candidateIndex: number | null = null) { super(code); }
}

/** Trusted app orchestration only. Does not expose a model write route, retry, or own the execution lifetime. */
export class BackgroundAffectApplicationService {
  constructor(private readonly deps: {
    bindings: Pick<AgentRuntimeBindingRegistry, "resolveIdentity">;
    turns: Pick<ProviderAgentRuntimeTurnCoordinator, "admit">;
    readMainSource(scope: SessionHistoryReadScope): Promise<BackgroundAffectMainSource | null>;
    affectService: Pick<CharacterAffectService, "recordAppraisal">;
  }) {}

  async apply(execution: BackgroundExecution, final: unknown): Promise<BackgroundAffectResult> {
    let output;
    try {
      output = validateAffectCompositionOutput(final);
    } catch {
      return { kind: "stopped", saved: [], failure: { code: "invalid_output", candidateIndex: null, effect: "none" }, unattemptedCandidateIndexes: null };
    }
    const candidates = output.kind === "events" ? output.candidates : [];
    const indexes = candidates.map((_, index) => index);
    let events: AffectEventInput[];
    try {
      events = await runWithRuntimeTurnAdmission(execution.admission, async () => {
        const resolved = this.deps.bindings.resolveIdentity(execution.binding.bindingReference);
        const binding = resolved.ok ? resolved.binding : null;
        const admitted = this.deps.turns.admit({ actorSessionId: execution.handle.actorSessionId,
          providerId: execution.handle.providerId, bindingId: execution.handle.bindingId,
          turnCapability: execution.handle.capability });
        if (!binding || binding.bindingId !== execution.binding.bindingId || binding.bindingId !== execution.handle.bindingId
          || binding.executionGeneration !== execution.binding.executionGeneration
          || binding.actorSessionId !== execution.handle.actorSessionId || binding.providerId !== execution.handle.providerId
          || !admitted.ok || admitted.handle !== execution.handle || execution.admission.state !== execution.handle.revocationState
          || binding.backgroundScope?.purpose !== "affect" || binding.authoritySnapshot.userId !== "local-user") {
          throw new ScopeError("authority_denied");
        }
        const scope = binding.backgroundScope;
        if (scope.history.source.kind !== "main") throw new ScopeError("unsupported_source");
        const source = await this.deps.readMainSource(scope.history);
        assertRuntimeTurnAdmission();
        if (!source) throw new ScopeError("source_unavailable");
        const session = source.session;
        if (session.id !== binding.actorSessionId || session.id !== scope.history.source.sessionId
          || !matchesSessionHistorySource(scope.history.source, {
            incarnationId: getSessionIncarnationId(session), ownerIdentity: source.ownerIdentity,
          })
          || !session.characterId || session.characterId !== binding.authoritySnapshot.characterId
          || isReadOnlySession(session) || session.sessionKind === "character-authoring") {
          throw new ScopeError("authority_denied");
        }
        return candidates.map(({ sourceTurnId, ...candidate }, candidateIndex) => {
          const turn = source.turns.find((item) => item.id === sourceTurnId);
          if (!turn || turn.sessionId !== session.id || turn.phase === "running" || !turn.completedAt
            || sourceTurnId <= (scope.processing.afterTurnId ?? 0) || sourceTurnId > scope.processing.throughTurnId
            || turn.assistantMessageSeq === undefined || turn.assistantMessageSeq < scope.history.fromMessageSeq
            || turn.assistantMessageSeq > scope.history.throughMessageSeq) throw new ScopeError("invalid_output", candidateIndex);
          try { assertCanonicalUtcTimestamp(turn.completedAt, "completedAt"); }
          catch { throw new ScopeError("source_unavailable", candidateIndex); }
          const event: AffectEventInput = { ...candidate, schemaVersion: AFFECT_SCHEMA_VERSION,
            characterId: session.characterId, sessionId: session.id, userId: "local-user",
            occurredAt: turn.completedAt, idempotencyKey: randomUUID() };
          assertValidAffectEvent(event);
          return event;
        });
      });
    } catch (error) {
      return { kind: "stopped", saved: [], failure: {
        code: error instanceof RuntimeTurnInactiveError ? "canceled" : error instanceof ScopeError ? error.code : "source_unavailable",
        candidateIndex: error instanceof ScopeError ? error.candidateIndex : null, effect: "none",
      }, unattemptedCandidateIndexes: indexes };
    }
    if (output.kind === "no_change") return { kind: "no_change" };
    const saved: BackgroundAffectSaved[] = [];
    for (const [candidateIndex, event] of events.entries()) {
      let dispatched = false;
      try {
        const result = await runWithRuntimeTurnAdmission(execution.admission, () => {
          dispatched = true;
          return this.deps.affectService.recordAppraisal(event);
        });
        saved.push({ candidateIndex, eventId: result.event.id, created: result.created, replayed: !result.created });
      } catch (error) {
        const code = error instanceof RuntimeTurnInactiveError ? "canceled"
          : error instanceof CharacterAffectVersionConflictError ? "version_conflict"
          : error instanceof CharacterAffectIdempotencyConflictError ? "idempotency_conflict" : "save_failed";
        const effect = !dispatched || error instanceof RuntimeTurnInactiveError
          || error instanceof CharacterAffectVersionConflictError || error instanceof CharacterAffectIdempotencyConflictError ? "none" : "unknown";
        return { kind: "stopped", saved, failure: { code, effect, candidateIndex },
          unattemptedCandidateIndexes: indexes.slice(candidateIndex + 1) };
      }
    }
    return { kind: "saved", saved };
  }
}
