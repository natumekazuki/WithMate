export const AFFECT_SCHEMA_VERSION = "withmate-affect-v1" as const;

export type AffectLayer = "relationship" | "session";
export type AffectTargetType = "user" | "relationship" | "task" | "bug" | "artifact" | "self";

export type AffectValue = {
  label: string;
  valence: number;
  arousal?: number;
  dimensions?: Record<string, number>;
};

export type AffectBaselineComponent = {
  targetType: "self" | "relationship";
  targetId: string;
  value: AffectValue;
  intensity: number;
  reason: string;
};

export type AffectEventInput = {
  schemaVersion: typeof AFFECT_SCHEMA_VERSION;
  characterId: string;
  userId: string;
  sessionId: string;
  layer: AffectLayer;
  targetType: AffectTargetType;
  targetId: string;
  value: AffectValue;
  intensity: number;
  reason: string;
  evidence: string;
  occurredAt: string;
  idempotencyKey: string;
  memoryEpisode?: AffectMemoryEpisodeCandidate;
};

export type AffectMemoryEpisodeCandidate = {
  title: string;
  body: string;
  preview: string;
  motif?: string;
  salience: number;
};

export type AffectConversationEvent = {
  sessionId: string;
  summary: string;
  occurredAt: string;
  sourceMessageId?: string;
};

export type AffectEvaluationContext = {
  characterId: string;
  userId: string;
  characterDefinition: string;
  baseline: readonly AffectBaselineComponent[];
  current: EffectiveAffectState;
  event: AffectConversationEvent;
};

export type AffectEvaluator = {
  evaluate(context: AffectEvaluationContext): Promise<readonly AffectEventInput[]>;
};

export type EffectiveAffectComponent = {
  targetType: AffectTargetType;
  targetId: string;
  label: string;
  valence: number;
  arousal?: number;
  dimensions: Record<string, number>;
  intensity: number;
  reasons: string[];
  eventIds: string[];
  contributingLayers: Array<"baseline" | AffectLayer>;
};

export type EffectiveAffectState = {
  schemaVersion: typeof AFFECT_SCHEMA_VERSION;
  characterId: string;
  userId: string;
  sessionId: string;
  layers: EffectiveAffectComponent[];
  components: EffectiveAffectComponent[];
};

export function assertValidAffectEvent(input: AffectEventInput): void {
  if (input.schemaVersion !== AFFECT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${AFFECT_SCHEMA_VERSION}.`);
  }
  requireNonEmpty(input.characterId, "characterId");
  requireNonEmpty(input.userId, "userId");
  requireNonEmpty(input.sessionId, "sessionId");
  requireNonEmpty(input.targetId, "targetId");
  requireNonEmpty(input.value.label, "value.label");
  requireNonEmpty(input.reason, "reason");
  requireNonEmpty(input.evidence, "evidence");
  requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertFiniteRange(input.value.valence, -1, 1, "value.valence");
  if (input.value.arousal !== undefined) {
    assertFiniteRange(input.value.arousal, -1, 1, "value.arousal");
  }
  for (const [key, value] of Object.entries(input.value.dimensions ?? {})) {
    requireNonEmpty(key, "value.dimensions key");
    assertFiniteRange(value, -1, 1, `value.dimensions.${key}`);
  }
  assertFiniteRange(input.intensity, 0, 1, "intensity");
  assertCanonicalUtcTimestamp(input.occurredAt, "occurredAt");
  if (input.layer === "relationship" && input.targetType !== "user" && input.targetType !== "relationship") {
    throw new Error("Relationship affect may only target the user or relationship.");
  }
  if (input.memoryEpisode) {
    requireNonEmpty(input.memoryEpisode.title, "memoryEpisode.title");
    requireNonEmpty(input.memoryEpisode.body, "memoryEpisode.body");
    requireNonEmpty(input.memoryEpisode.preview, "memoryEpisode.preview");
    if (input.memoryEpisode.motif !== undefined) {
      requireNonEmpty(input.memoryEpisode.motif, "memoryEpisode.motif");
    }
    assertFiniteRange(input.memoryEpisode.salience, 0, 1, "memoryEpisode.salience");
  }
}

export function assertValidAffectBaseline(component: AffectBaselineComponent): void {
  requireNonEmpty(component.targetId, "baseline.targetId");
  requireNonEmpty(component.value.label, "baseline.value.label");
  requireNonEmpty(component.reason, "baseline.reason");
  assertFiniteRange(component.value.valence, -1, 1, "baseline.value.valence");
  if (component.value.arousal !== undefined) {
    assertFiniteRange(component.value.arousal, -1, 1, "baseline.value.arousal");
  }
  for (const [key, value] of Object.entries(component.value.dimensions ?? {})) {
    requireNonEmpty(key, "baseline.value.dimensions key");
    assertFiniteRange(value, -1, 1, `baseline.value.dimensions.${key}`);
  }
  assertFiniteRange(component.intensity, 0, 1, "baseline.intensity");
}

export function assertCanonicalUtcTimestamp(value: string, field: string): void {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC timestamp.`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`${field} must not be empty.`);
  }
}

function assertFiniteRange(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  }
}
