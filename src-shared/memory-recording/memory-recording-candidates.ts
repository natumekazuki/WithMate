import { z } from "zod";
import type { CharacterMemoryEpisodeInput } from "../character-context/character-context-contract.js";
import {
  CharacterContextValidationError,
  validateCharacterMemoryEpisodeInput,
} from "../character-context/character-context-validation.js";
import {
  MEMORY_ENTRY_KINDS,
  type MemoryEntryContent,
  type MemoryEntryKind,
  type MemoryTag,
  type MemoryTargetSelector,
} from "../memory/memory-contract.js";
import { validateMemoryEntryContent } from "../memory/memory-validation.js";
import type { SessionHistoryReadScope } from "../session/session-history-read-scope.js";

const indexSchema = z.number().int().nonnegative();
export const memoryRecordingEvidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), seq: indexSchema }).strict(),
  z.object({ kind: z.literal("operation"), seq: indexSchema, index: indexSchema }).strict(),
  z.object({ kind: z.literal("run_check"), seq: indexSchema, index: indexSchema }).strict(),
]);
export type EvidenceRef = z.infer<typeof memoryRecordingEvidenceRefSchema>;

const basisSchema = z.enum([
  "user_statement", "shared_exchange", "agreed_decision", "execution_result", "character_interpretation",
]);
export type Grounding = Readonly<{
  basis: z.infer<typeof basisSchema>;
  refs: readonly [EvidenceRef, ...EvidenceRef[]];
}>;

/** The caller supplies only saved evidence in its captured source; unknown is never inferred as success. */
export type MemoryRecordingEvidenceContext = Readonly<{
  history: Pick<SessionHistoryReadScope, "fromMessageSeq" | "throughMessageSeq">;
  messages: readonly Readonly<{
    seq: number;
    processing: boolean;
    operations: readonly Readonly<{ index: number; outcome: "succeeded" | "failed" | "unknown" }>[];
    runChecks: readonly Readonly<{ index: number; outcome: "succeeded" | "failed" | "unknown" }>[];
  }>[];
}>;
export type CharacterMemoryTarget = Extract<MemoryTargetSelector, { owner: "character"; scope: "character" }>;
export type CharacterMemoryValidationContext = MemoryRecordingEvidenceContext & Readonly<{ target: CharacterMemoryTarget }>;
export type TargetMemoryValidationContext = MemoryRecordingEvidenceContext & Readonly<{
  allowedTargets: ReadonlyMap<string, MemoryTargetSelector>;
}>;

export type CharacterEpisodeCandidate = Readonly<{
  episode: CharacterMemoryEpisodeInput;
  grounding: readonly [Grounding, ...Grounding[]];
}>;
export type CharacterMemoryFinal =
  | { outcome: "candidates"; episodes: readonly [CharacterEpisodeCandidate, ...CharacterEpisodeCandidate[]] }
  | { outcome: "no_candidates" };
export type TargetMemoryCandidate = Readonly<{
  targetSlot: string;
  kind: MemoryEntryKind;
  title: string;
  body: string;
  preview: string;
  tags?: readonly MemoryTag[];
  grounding: readonly [Grounding, ...Grounding[]];
}>;
export type TargetMemoryFinal =
  | { outcome: "candidates"; entries: readonly [TargetMemoryCandidate, ...TargetMemoryCandidate[]] }
  | { outcome: "no_candidates" };

const contentShape = {
  kind: z.enum(MEMORY_ENTRY_KINDS),
  title: z.string(),
  body: z.string(),
  preview: z.string(),
  tags: z.array(z.object({ type: z.string(), value: z.string() }).strict()).optional(),
};

function normalizeContent(value: Record<string, unknown>, ctx: z.RefinementCtx): MemoryEntryContent | undefined {
  const result = validateMemoryEntryContent(value);
  if (result.ok) return result.value;
  ctx.addIssue({ code: "custom", message: result.error.message, path: result.error.field ? [result.error.field] : [] });
  return undefined;
}

const episodeSchema = z.object({
  title: z.string(), body: z.string(), preview: z.string(),
  motif: z.string().optional(), observedFact: z.string().optional(), characterObservation: z.string().optional(),
}).strict().transform((value, ctx) => {
  let episode: CharacterMemoryEpisodeInput;
  try {
    episode = validateCharacterMemoryEpisodeInput(value);
  } catch (error) {
    if (!(error instanceof CharacterContextValidationError)) throw error;
    ctx.addIssue({ code: "custom", message: error.message, path: [error.field] });
    return z.NEVER;
  }
  const content = normalizeContent({ ...episode, kind: "context",
    tags: episode.motif ? [{ type: "motif", value: episode.motif }] : [] }, ctx);
  if (!content) return z.NEVER;
  return { ...episode, title: content.title, body: content.body, preview: content.preview };
});

function createGroundingSchema(context: MemoryRecordingEvidenceContext, allowInterpretation: boolean) {
  const messages = new Map(context.messages.map((message) => [message.seq, message]));
  return z.object({
    basis: basisSchema,
    refs: z.tuple([memoryRecordingEvidenceRefSchema], memoryRecordingEvidenceRefSchema),
  }).strict().superRefine((grounding, ctx) => {
    if (!allowInterpretation && grounding.basis === "character_interpretation") {
      ctx.addIssue({ code: "custom", path: ["basis"], message: "Character interpretation is not target knowledge." });
    }
    if (grounding.basis === "execution_result" && grounding.refs.every((ref) => ref.kind === "message")) {
      ctx.addIssue({ code: "custom", path: ["refs"], message: "Execution confirmation requires a saved operation or check result." });
    }
    grounding.refs.forEach((ref, index) => {
      const message = messages.get(ref.seq);
      if (ref.seq < context.history.fromMessageSeq || ref.seq > context.history.throughMessageSeq || !message) {
        ctx.addIssue({ code: "custom", path: ["refs", index], message: "Evidence is outside the saved, authorized history." });
        return;
      }
      if (ref.kind === "message") return;
      const evidence = (ref.kind === "operation" ? message.operations : message.runChecks).find((item) => item.index === ref.index);
      if (!evidence) {
        ctx.addIssue({ code: "custom", path: ["refs", index], message: "The saved evidence does not exist." });
      } else if (grounding.basis === "execution_result" && evidence.outcome !== "succeeded") {
        ctx.addIssue({ code: "custom", path: ["refs", index], message: "Failed or unknown evidence cannot confirm execution success." });
      }
    });
  });
}

function checkProcessingEvidence(grounding: readonly Grounding[], context: MemoryRecordingEvidenceContext, ctx: z.RefinementCtx): void {
  if (!grounding.some((item) => item.refs.some((ref) => context.messages.some((message) => message.seq === ref.seq && message.processing)))) {
    ctx.addIssue({ code: "custom", path: ["grounding"], message: "A candidate requires evidence in the processing range." });
  }
}

const noCandidatesSchema = z.object({ outcome: z.literal("no_candidates") }).strict();

/** Parse output, or use z.toJSONSchema(schema, { io: "input" }) for its structural generation schema. */
export function createCharacterMemoryFinalSchema(context: MemoryRecordingEvidenceContext) {
  const grounding = createGroundingSchema(context, true);
  const candidate = z.object({ episode: episodeSchema, grounding: z.tuple([grounding], grounding) }).strict()
    .superRefine((value, ctx) => checkProcessingEvidence(value.grounding, context, ctx));
  return z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("candidates"), episodes: z.tuple([candidate], candidate) }).strict(),
    noCandidatesSchema,
  ]);
}

export function createTargetMemoryFinalSchema(context: TargetMemoryValidationContext) {
  const grounding = createGroundingSchema(context, false);
  const candidate = z.object({ ...contentShape,
    targetSlot: z.enum([...context.allowedTargets.keys()]),
    grounding: z.tuple([grounding], grounding),
  }).strict().superRefine((value, ctx) => checkProcessingEvidence(value.grounding, context, ctx))
    .transform((value, ctx) => {
      const content = normalizeContent(value, ctx);
      if (!content) return z.NEVER;
      return { ...content, targetSlot: value.targetSlot, grounding: value.grounding,
        target: context.allowedTargets.get(value.targetSlot)! };
    });
  return z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("candidates"), entries: z.tuple([candidate], candidate) }).strict(),
    noCandidatesSchema,
  ]);
}

export function validateCharacterMemoryFinal(value: unknown, context: CharacterMemoryValidationContext): {
  target: CharacterMemoryTarget; final: CharacterMemoryFinal;
} {
  return { target: context.target, final: createCharacterMemoryFinalSchema(context).parse(value) };
}

export function validateTargetMemoryFinal(value: unknown, context: TargetMemoryValidationContext) {
  return createTargetMemoryFinalSchema(context).parse(value);
}

export type ValidatedTargetMemoryFinal = ReturnType<typeof validateTargetMemoryFinal>;
