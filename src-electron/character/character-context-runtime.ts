import type { Session } from "../../src-shared/session/session-state.js";
import { CHARACTER_CONTEXT_SCHEMA_VERSION, isCharacterContextError, type CharacterContextErrorResponse } from "../../src-shared/character-context/character-context-contract.js";
import type { CharacterContextApplicationService } from "./character-context-application-service.js";
import type { AffectSessionSource } from "./character-affect-storage.js";

/** Reads the state available now; a foreground turn never waits for background generation. */
export async function resolveRuntimeCharacterContext(input: {
  session: Session;
  query: string;
  service: Pick<CharacterContextApplicationService, "getContext"> | null | undefined;
  sessionSource: AffectSessionSource;
  onFailure(session: Session, error: CharacterContextErrorResponse): void;
}) {
  const { session, service } = input;
  if (session.sessionKind !== "default" || !session.characterId || !service) return null;
  const result = await service.getContext({
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: session.characterId,
    sessionId: session.id,
    query: input.query,
    memoryLimit: 3,
  }, "lifecycle", session.characterRuntimeSnapshot, input.sessionSource);
  if (isCharacterContextError(result)) {
    input.onFailure(session, result);
    return null;
  }
  return result;
}
