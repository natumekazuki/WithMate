import { z } from "zod";
import {
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
  NEUTRAL_CHARACTER_ID,
} from "./character-owner.js";

/** インストールを使うローカルユーザーを会話の参加者として識別する固定値。 */
export const LOCAL_USER_ID = "local-user" as const;
/** ユーザーと有効なCharacterを区別し、中立や所有者不明のIDは参加者として受け付けない。 */
export const conversationParticipantSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: z.literal(LOCAL_USER_ID) }).strict(),
  z
    .object({
      type: z.literal("character"),
      id: z
        .string()
        .trim()
        .min(1)
        .refine(
          (id) => !isUnknownCharacterOwnerId(id) && id !== NEUTRAL_CHARACTER_ID,
        ),
    })
    .strict(),
]);
/** 会話上の発話や記憶を紐付ける、ユーザーまたはCharacterの識別情報。 */
export type ConversationParticipant = z.infer<
  typeof conversationParticipantSchema
>;
/** 定義や内部メモを含めず、ID・表示名・紹介だけを公開する。 */
export const characterPublicProfileSchema = z
  .object({ id: z.string(), name: z.string(), description: z.string() })
  .strict();
/** Sessionの表示や外部返却に使うCharacterの公開プロフィール。 */
export type CharacterPublicProfile = z.infer<
  typeof characterPublicProfileSchema
>;

/** 公開用の識別情報は Session に保存されたメタデータであり、現行のカタログやペルソナ指示ではない。 */
export function projectCharacterPublicProfile(session: {
  characterId?: string;
  character?: string;
  characterDescription?: string;
  characterRuntimeSnapshot?: { name: string; description: string } | null;
}): CharacterPublicProfile | null {
  const id = normalizeCharacterOwnerId(session.characterId);
  if (!id || isUnknownCharacterOwnerId(id) || id === NEUTRAL_CHARACTER_ID)
    return null;
  return {
    id,
    name: session.characterRuntimeSnapshot?.name ?? session.character ?? "",
    description:
      session.characterRuntimeSnapshot?.description ??
      session.characterDescription ??
      "",
  };
}

/** 参加者の種別をタグ名に、固定IDを値にして記憶に紐付ける。 */
export function participantMemoryTag(participant: ConversationParticipant) {
  return { type: `participant-${participant.type}`, value: participant.id };
}

/** ユーザー宛先は種別で、Character宛先は個体IDで照合し、個別宛先でないものは通す。 */
export function affectMatchesParticipant(
  component: { targetType: string; targetId: string },
  participant: ConversationParticipant | null,
): boolean {
  // 旧形式のユーザー宛先 ID は任意の文字列だったが、すべてこのインストールを使う一人のユーザーを指す。
  if (component.targetType === "user") return participant?.type === "user";
  return (
    (component.targetType !== "user" && component.targetType !== "character") ||
    (participant !== null &&
      component.targetType === participant.type &&
      component.targetId === participant.id)
  );
}
