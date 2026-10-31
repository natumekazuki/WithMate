import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { NEUTRAL_CHARACTER_ID } from "../../src-shared/character/character-owner.js";
import type { Session } from "../../src-shared/session/session-state.js";

/** Resolves one definition for the whole turn without mutating the saved Session. */
export async function refreshSessionCharacterRuntimeSnapshot(
  session: Session,
  refreshSnapshot: (
    characterId: string,
    previousSnapshot: CharacterRuntimeSnapshot | null,
  ) => Promise<CharacterRuntimeSnapshot>,
): Promise<Session> {
  if (session.characterId === NEUTRAL_CHARACTER_ID && !session.characterRuntimeSnapshot) {
    return session;
  }
  const snapshot = await refreshSnapshot(session.characterId, session.characterRuntimeSnapshot);
  return { ...session, characterRuntimeSnapshot: snapshot };
}
