import { AFFECT_SCHEMA_VERSION, type AffectEventInput } from "../src/character-affect/affect-contract.js";
import type { CharacterContextResponse } from "../src/character-context/character-context-contract.js";
import type { CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";

export const CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          layer: { type: "string", enum: ["relationship", "session"] },
          targetType: {
            type: "string",
            enum: ["user", "relationship", "task", "bug", "artifact", "self"],
          },
          targetId: { type: "string" },
          label: { type: "string" },
          valence: { type: "number", minimum: -1, maximum: 1 },
          arousal: {
            anyOf: [
              { type: "number", minimum: -1, maximum: 1 },
              { type: "null" },
            ],
          },
          intensity: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          evidence: { type: "string" },
        },
        required: [
          "layer",
          "targetType",
          "targetId",
          "label",
          "valence",
          "arousal",
          "intensity",
          "reason",
          "evidence",
        ],
      },
    },
  },
  required: ["candidates"],
} as const;

type TurnAffectCandidate = {
  layer: AffectEventInput["layer"];
  targetType: AffectEventInput["targetType"];
  targetId: string;
  label: string;
  valence: number;
  arousal: number | null;
  intensity: number;
  reason: string;
  evidence: string;
};

export type CharacterAffectTurnEvaluation = {
  candidates: TurnAffectCandidate[];
};

export type CharacterAffectTurnPromptInput = {
  character: CharacterRuntimeSnapshot;
  context: CharacterContextResponse | null;
  userMessage: string;
  assistantMessage: string;
};

export function buildCharacterAffectTurnPrompt(input: CharacterAffectTurnPromptInput): {
  systemText: string;
  userText: string;
  outputSchema: typeof CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA;
} {
  return {
    systemText: [
      "You evaluate the Character's own affect after one WithMate conversation turn.",
      "Do not diagnose or label the user's emotions.",
      "Return only structured candidates grounded in the supplied event.",
      "Use relationship scope only for affect toward the user or the relationship.",
      "Use session scope for a task, bug, artifact, self, or turn-local reaction.",
      "Return an empty candidates array when no meaningful state change is supported.",
      "Do not invent facts, repeat the conversation, or include secrets in evidence.",
    ].join("\n"),
    userText: JSON.stringify({
      character: {
        id: input.character.characterId,
        definition: input.character.definitionMarkdown,
      },
      currentAffect: input.context
        ? {
            effective: input.context.affect.effective,
            version: input.context.affect.version,
            scope: input.context.scope,
          }
        : null,
      event: {
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
      },
    }),
    outputSchema: CHARACTER_AFFECT_TURN_OUTPUT_SCHEMA,
  };
}

export function normalizeCharacterAffectTurnEvaluation(value: unknown): CharacterAffectTurnEvaluation | null {
  if (!value || typeof value !== "object" || !Array.isArray((value as { candidates?: unknown }).candidates)) {
    return null;
  }
  const candidates: TurnAffectCandidate[] = [];
  for (const raw of (value as { candidates: unknown[] }).candidates.slice(0, 4)) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const candidate = raw as Record<string, unknown>;
    if (
      (candidate.layer !== "relationship" && candidate.layer !== "session")
      || !["user", "relationship", "task", "bug", "artifact", "self"].includes(String(candidate.targetType))
      || !isNonEmptyString(candidate.targetId)
      || !isNonEmptyString(candidate.label)
      || !isRange(candidate.valence, -1, 1)
      || (candidate.arousal !== null && !isRange(candidate.arousal, -1, 1))
      || !isRange(candidate.intensity, 0, 1)
      || !isNonEmptyString(candidate.reason)
      || !isNonEmptyString(candidate.evidence)
    ) {
      return null;
    }
    candidates.push(candidate as TurnAffectCandidate);
  }
  return { candidates };
}

export function toAffectEventInputs(input: {
  evaluation: CharacterAffectTurnEvaluation;
  characterId: string;
  sessionId: string;
  userId: string;
  occurredAt: string;
  idempotencyPrefix: string;
}): AffectEventInput[] {
  return input.evaluation.candidates.map((candidate, index) => ({
    schemaVersion: AFFECT_SCHEMA_VERSION,
    characterId: input.characterId,
    userId: input.userId,
    sessionId: input.sessionId,
    layer: candidate.layer,
    targetType: candidate.targetType,
    targetId: candidate.targetId,
    value: {
      label: candidate.label,
      valence: candidate.valence,
      ...(candidate.arousal === null ? {} : { arousal: candidate.arousal }),
    },
    intensity: candidate.intensity,
    reason: candidate.reason,
    evidence: candidate.evidence,
    occurredAt: input.occurredAt,
    idempotencyKey: `${input.idempotencyPrefix}:${index}`,
  }));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
