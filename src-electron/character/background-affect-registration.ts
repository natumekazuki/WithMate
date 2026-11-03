import { randomUUID } from "node:crypto";
import { z } from "zod";
import { backgroundAffectCandidateSchema } from "../../src-shared/character-affect/affect-composition.js";
import { AFFECT_SCHEMA_VERSION, assertCanonicalUtcTimestamp } from "../../src-shared/character-affect/affect-contract.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION, createCharacterContextError } from "../../src-shared/character-context/character-context-contract.js";
import type { BackgroundRegistrationHandler } from "../providers/background-registration.js";

// The HTTP boundary has already bound these identities and conversation authority.
const boundRequestSchema = z.object({
  schemaVersion: z.literal(CHARACTER_CONTEXT_SCHEMA_VERSION),
  characterId: z.string().min(1),
  sessionId: z.string().min(1),
  authority: z.object({ kind: z.literal("conversation") }).strict(),
  candidates: z.array(backgroundAffectCandidateSchema.safeExtend({
    userId: z.literal("local-user"), characterId: z.string().min(1), sessionId: z.string().min(1),
  })).min(1).max(10),
}).strict();
const rejection = { retryable: false, conversationMayContinue: true, effect: "none" } as const;

export const registerBackgroundAffect: BackgroundRegistrationHandler = async (input, services) => {
  if (input.scope.purpose !== "affect") {
    return createCharacterContextError("authority_denied", "Affect registration requires an Affect execution.", rejection);
  }
  const parsed = boundRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return createCharacterContextError("invalid_input", "Invalid background affect candidates.", rejection);
  }
  const request = parsed.data;
  const source = input.source;
  if (request.characterId !== source.session.characterId || request.sessionId !== source.session.id
    || request.candidates.some((candidate) => candidate.characterId !== request.characterId || candidate.sessionId !== request.sessionId)) {
    return createCharacterContextError("authority_denied", "Affect owner does not match the saved source.", rejection);
  }
  const candidates = [];
  for (const [candidateIndex, { sourceTurnId, ...candidate }] of request.candidates.entries()) {
    const turn = source.turns.find((item) => item.id === sourceTurnId);
    const belongsToSource = input.scope.history.source.kind === "main"
      ? turn?.sessionId === source.session.id && turn.auxiliarySessionId === undefined
      : turn?.sessionId === null && turn.auxiliarySessionId === source.session.id;
    if (!turn || !belongsToSource || !["completed", "failed", "canceled"].includes(turn.phase)
      || !turn.completedAt || sourceTurnId <= (input.scope.processing.afterTurnId ?? 0)
      || sourceTurnId > input.scope.processing.throughTurnId || turn.assistantMessageSeq === undefined
      || turn.assistantMessageSeq < input.scope.history.fromMessageSeq || turn.assistantMessageSeq > input.scope.history.throughMessageSeq) {
      return createCharacterContextError("invalid_input", "sourceTurnId must identify a terminal Turn within the execution scope.", {
        ...rejection, details: { candidateIndex },
      });
    }
    try { assertCanonicalUtcTimestamp(turn.completedAt, "completedAt"); }
    catch {
      return createCharacterContextError("invalid_input", "The saved source Turn has no canonical completion time.", {
        ...rejection, details: { candidateIndex },
      });
    }
    candidates.push({ ...candidate, schemaVersion: AFFECT_SCHEMA_VERSION, occurredAt: turn.completedAt, idempotencyKey: randomUUID() });
  }
  if (!services.character) throw new Error("Character context service is unavailable.");
  return services.character.appraise({ ...request, candidates }, input.transport, input.scope.history.source);
};
