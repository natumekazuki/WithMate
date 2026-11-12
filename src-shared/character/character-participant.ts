import { z } from "zod";
import { isUnknownCharacterOwnerId, normalizeCharacterOwnerId, NEUTRAL_CHARACTER_ID } from "./character-owner.js";

export const LOCAL_USER_ID = "local-user" as const;
export const conversationParticipantSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: z.literal(LOCAL_USER_ID) }).strict(),
  z.object({ type: z.literal("character"), id: z.string().trim().min(1).refine((id) => !isUnknownCharacterOwnerId(id) && id !== NEUTRAL_CHARACTER_ID) }).strict(),
]);
export type ConversationParticipant = z.infer<typeof conversationParticipantSchema>;
export const characterPublicProfileSchema = z.object({ id: z.string(), name: z.string(), description: z.string() }).strict();
export type CharacterPublicProfile = z.infer<typeof characterPublicProfileSchema>;

/** Public identity is saved Session metadata, never the current catalog or a persona instruction. */
export function projectCharacterPublicProfile(session: {
  characterId?: string; character?: string; characterDescription?: string;
  characterRuntimeSnapshot?: { name: string; description: string } | null;
}): CharacterPublicProfile | null {
  const id = normalizeCharacterOwnerId(session.characterId);
  if (!id || isUnknownCharacterOwnerId(id) || id === NEUTRAL_CHARACTER_ID) return null;
  return { id, name: session.characterRuntimeSnapshot?.name ?? session.character ?? "",
    description: session.characterRuntimeSnapshot?.description ?? session.characterDescription ?? "" };
}

export function participantMemoryTag(participant: ConversationParticipant) {
  return { type: `participant-${participant.type}`, value: participant.id };
}

export function affectMatchesParticipant(component: { targetType: string; targetId: string }, participant: ConversationParticipant | null): boolean {
  // Older user targets used free-form IDs; all refer to this installation's one human.
  if (component.targetType === "user") return participant?.type === "user";
  return component.targetType !== "user" && component.targetType !== "character"
    || participant !== null && component.targetType === participant.type && component.targetId === participant.id;
}
