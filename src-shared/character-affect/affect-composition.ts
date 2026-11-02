import { z } from "zod";
import { CHARACTER_AFFECT_FAMILIES, type AffectEventInput } from "./affect-contract.js";

export type AffectCandidate = Pick<AffectEventInput,
  "layer" | "targetType" | "targetId" | "family" | "value" | "intensity" | "reason" | "evidence"
> & { sourceTurnId: number };

export type AffectCompositionOutput =
  | { kind: "events"; candidates: AffectCandidate[] }
  | { kind: "no_change" };

const text = z.string().refine((value) => value.trim().length > 0, "Must not be empty.");
const dimension = z.number().finite().min(-1).max(1);
const candidateSchema = z.object({
  layer: z.enum(["relationship", "session"]),
  targetType: z.enum(["user", "relationship", "task", "bug", "artifact", "self"]),
  targetId: text,
  family: z.enum(CHARACTER_AFFECT_FAMILIES),
  value: z.object({
    label: text,
    valence: dimension,
    arousal: dimension.optional(),
    dimensions: z.record(text, dimension).optional(),
  }).strict(),
  intensity: z.number().finite().min(0).max(1),
  reason: text,
  evidence: text,
  sourceTurnId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((candidate) => candidate.layer !== "relationship"
  || candidate.targetType === "user" || candidate.targetType === "relationship", {
  message: "Relationship affect may only target the user or relationship.", path: ["targetType"],
});

export const affectCompositionOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("events"), candidates: z.array(candidateSchema).min(1).max(10) }).strict(),
  z.object({ kind: z.literal("no_change") }).strict(),
]);

/** The model final is untrusted, including when a transport has already parsed its JSON. */
export function validateAffectCompositionOutput(value: unknown): AffectCompositionOutput {
  return affectCompositionOutputSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
}

export const AFFECT_COMPOSITION_INSTRUCTIONS = [
  "取得時点のCharacter定義・保存済み会話・既存Affectから、Characterの次の感情を構成する。主会話Agentの非公開の内面を復元・診断したとは扱わない。",
  "会話を基本材料とし、作業結果の裏付けが必要な場合だけ操作の成否と必要な詳細を参照する。欠落した情報は補完しない。",
  "原因・感情の対象・sourceTurnIdを保ち、作業上の失敗を根拠なくユーザーへの敵意へ変換しない。",
  "構造化finalはeventsまたはno_changeだけを返す。変化がなければno_changeを返し、memoryEpisode・保存先identity・authority・保存keyを含めない。",
].join("\n");
