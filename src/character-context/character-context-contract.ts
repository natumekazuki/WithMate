import type { MemorySearchHit, MemoryEntrySummary } from "../memory-v6/memory-state.js";
import type { MemoryForgetReason, MemoryTag, ProjectTargetRef } from "../memory-v6/memory-contract.js";
import type {
  AffectEventInput,
  AffectLayer,
  AffectTargetType,
  CharacterAffectFamily,
} from "../character-affect/affect-contract.js";

export const CHARACTER_CONTEXT_SCHEMA_VERSION = "withmate-character-context-v1" as const;

export type CharacterOperationAuthority =
  | { kind: "conversation" }
  | { kind: "explicit_user_instruction"; reason: string }
  | { kind: "operator"; reason: string };

export type CharacterContextErrorCode =
  | "invalid_input"
  | "unknown_character"
  | "unknown_scope"
  | "authority_denied"
  | "version_conflict"
  | "idempotent_replay"
  | "storage_unavailable"
  | "migration_required"
  | "partial_failure"
  | "internal_error";

export type CharacterContextErrorResponse = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  error: {
    code: CharacterContextErrorCode;
    message: string;
    field?: string;
    retryable: boolean;
    conversationMayContinue: boolean;
    effect?: "none" | "committed" | "partial" | "unknown";
    details?: Record<string, unknown>;
  };
};

export type CharacterContextGetRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  query?: string;
  memoryLimit?: number;
};

export type CharacterAffectSummary = {
  contributingLayers: Array<"baseline" | AffectLayer>;
  targetType: AffectTargetType;
  targetId: string;
  family: CharacterAffectFamily | null;
  label: string;
  valence: number;
  arousal?: number;
  dimensions?: Record<string, number>;
  intensity: number;
};

export type CharacterContextResponse = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  baseline: {
    definitionSha256: string;
    snapshotAt: string;
  };
  affect: {
    mode: "shadow" | "active";
    effective: CharacterAffectSummary[];
    evaluatedAt: string;
    version: string;
    updatedAt: string | null;
  };
  memory: {
    items: MemorySearchHit[];
    relatedTags?: MemoryTag[];
    updatedAt: string | null;
  };
  scope: {
    userId: "local-user";
    characterId: string;
    sessionId: string;
  };
};

export type CharacterAffectAppraiseRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  expectedVersion?: string;
  authority: CharacterOperationAuthority;
  candidates: AffectEventInput[];
};

export type CharacterAffectAppraiseResponse = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  saved: Array<{
    candidateIndex: number;
    eventId: string;
    memoryEntryId: string | null;
    replayed: boolean;
  }>;
  rejected: Array<{
    candidateIndex: number;
    code: "invalid_input" | "authority_denied";
    message: string;
  }>;
  version: string;
  updatedAt: string | null;
};

export type CharacterAffectInspectRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  authority: CharacterOperationAuthority;
};

export type CharacterAffectCorrectRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  eventId: string;
  expectedVersion: string;
  authority: CharacterOperationAuthority;
  reason: string;
  replacement: AffectEventInput;
};

export type CharacterAffectResetRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  layer: AffectLayer;
  expectedVersion: string;
  authority: CharacterOperationAuthority;
  reason: string;
  resetAt: string;
  idempotencyKey: string;
};

export type CharacterMemoryScopeInput =
  | { scope: "character" }
  | { scope: "project"; project: ProjectTargetRef };

export type CharacterMemorySearchRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  query: string;
  limit?: number;
  scope: CharacterMemoryScopeInput;
};

export type CharacterMemorySearchResponse = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  scope: CharacterMemoryScopeInput;
  items: MemorySearchHit[];
  relatedTags?: MemoryTag[];
  sourceVersion: string | null;
};

type CharacterMemoryEpisodeBase = {
  title: string;
  body: string;
  preview: string;
  motif?: string;
};

export type CharacterMemoryEpisodeInput = CharacterMemoryEpisodeBase & (
  | { observedFact: string; characterObservation?: string }
  | { observedFact?: string; characterObservation: string }
);

export type CharacterMemoryAppendEpisodeRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  sessionId: string;
  authority: CharacterOperationAuthority;
  idempotencyKey: string;
  episode: CharacterMemoryEpisodeInput;
};

export type CharacterMemoryCorrectRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  entryId: string;
  authority: CharacterOperationAuthority;
  reason: string;
  idempotencyKey: string;
  replacement: CharacterMemoryEpisodeInput;
};

export type CharacterMemoryForgetRequest = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  entryId: string;
  authority: CharacterOperationAuthority;
  reason: MemoryForgetReason;
  idempotencyKey: string;
};

export type CharacterMemoryMutationResponse = {
  schemaVersion: typeof CHARACTER_CONTEXT_SCHEMA_VERSION;
  characterId: string;
  operation: "append_episode" | "correct" | "forget";
  entry: MemoryEntrySummary | null;
  previousEntryId?: string;
  created?: boolean;
  replayed?: boolean;
  readBack: "active" | "superseded" | "forgotten" | "not_found";
  sourceVersion: string | null;
};

export type CharacterContextServiceResult<T> = T | CharacterContextErrorResponse;

export function createCharacterContextError(
  code: CharacterContextErrorCode,
  message: string,
  options: Omit<CharacterContextErrorResponse["error"], "code" | "message">,
): CharacterContextErrorResponse {
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    error: { code, message, ...options },
  };
}

export function isCharacterContextError(value: unknown): value is CharacterContextErrorResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schemaVersion?: unknown; error?: unknown };
  return candidate.schemaVersion === CHARACTER_CONTEXT_SCHEMA_VERSION
    && Boolean(candidate.error && typeof candidate.error === "object");
}
