import {
  CHARACTER_CONTEXT_SCHEMA_VERSION,
  type CharacterAffectAppraiseRequest,
  type CharacterAffectCorrectRequest,
  type CharacterAffectInspectRequest,
  type CharacterAffectResetRequest,
  type CharacterContextGetRequest,
  type CharacterMemoryAppendEpisodeRequest,
  type CharacterMemoryCorrectRequest,
  type CharacterMemoryEpisodeInput,
  type CharacterMemoryForgetRequest,
  type CharacterMemorySearchRequest,
  type CharacterOperationAuthority,
} from "./character-context-contract.js";

export class CharacterContextValidationError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "CharacterContextValidationError";
  }
}

function record(value: unknown, field = "request"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CharacterContextValidationError(`${field} must be an object.`, field);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field = "request"): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new CharacterContextValidationError(`${field}.${unknown} is not supported.`, `${field}.${unknown}`);
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CharacterContextValidationError(`${field} must be a non-empty string.`, field);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field);
}

function integer(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CharacterContextValidationError(`${field} must be an integer between ${minimum} and ${maximum}.`, field);
  }
  return value as number;
}

function schemaVersion(value: Record<string, unknown>): void {
  if (value.schemaVersion !== CHARACTER_CONTEXT_SCHEMA_VERSION) {
    throw new CharacterContextValidationError(
      `schemaVersion must be ${CHARACTER_CONTEXT_SCHEMA_VERSION}.`,
      "schemaVersion",
    );
  }
}

function authority(value: unknown, field = "authority"): CharacterOperationAuthority {
  const input = record(value, field);
  exactKeys(input, ["kind", "reason"], field);
  if (input.kind === "conversation") {
    if (input.reason !== undefined) {
      throw new CharacterContextValidationError(`${field}.reason is not allowed for conversation authority.`, `${field}.reason`);
    }
    return { kind: "conversation" };
  }
  if (input.kind === "explicit_user_instruction" || input.kind === "operator") {
    return { kind: input.kind, reason: text(input.reason, `${field}.reason`) };
  }
  throw new CharacterContextValidationError(`${field}.kind is not supported.`, `${field}.kind`);
}

function episode(value: unknown, field = "episode"): CharacterMemoryEpisodeInput {
  const input = record(value, field);
  exactKeys(input, ["title", "body", "preview", "motif", "observedFact", "characterObservation"], field);
  const observedFact = optionalText(input.observedFact, `${field}.observedFact`);
  const characterObservation = optionalText(input.characterObservation, `${field}.characterObservation`);
  if (!observedFact && !characterObservation) {
    throw new CharacterContextValidationError(
      `${field} must distinguish an observed fact or Character observation.`,
      field,
    );
  }
  const base = {
    title: text(input.title, `${field}.title`),
    body: text(input.body, `${field}.body`),
    preview: text(input.preview, `${field}.preview`),
    ...(input.motif === undefined ? {} : { motif: text(input.motif, `${field}.motif`) }),
  };
  return observedFact
    ? { ...base, observedFact, ...(characterObservation ? { characterObservation } : {}) }
    : { ...base, characterObservation: characterObservation! };
}

export function validateCharacterContextGetRequest(value: unknown): CharacterContextGetRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "sessionId", "query", "memoryLimit"]);
  schemaVersion(input);
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: text(input.characterId, "characterId"),
    sessionId: text(input.sessionId, "sessionId"),
    ...(input.query === undefined ? {} : { query: text(input.query, "query") }),
    memoryLimit: integer(input.memoryLimit, "memoryLimit", 0, 10, 3),
  };
}

export function validateCharacterAffectAppraiseRequest(value: unknown): CharacterAffectAppraiseRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "sessionId", "expectedVersion", "authority", "candidates"]);
  schemaVersion(input);
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > 10) {
    throw new CharacterContextValidationError("candidates must contain between 1 and 10 items.", "candidates");
  }
  const characterId = text(input.characterId, "characterId");
  const sessionId = text(input.sessionId, "sessionId");
  const candidates = input.candidates.map((candidate, index) => {
    const typed = record(candidate, `candidates[${index}]`) as CharacterAffectAppraiseRequest["candidates"][number];
    if (typed.characterId !== characterId || typed.sessionId !== sessionId || typed.userId !== "local-user") {
      throw new CharacterContextValidationError(
        "Affect candidate owner must match the request owner.",
        `candidates[${index}]`,
      );
    }
    return typed;
  });
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId,
    sessionId,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: text(input.expectedVersion, "expectedVersion") }),
    authority: authority(input.authority),
    candidates,
  };
}

export function validateCharacterAffectInspectRequest(value: unknown): CharacterAffectInspectRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "sessionId", "authority"]);
  schemaVersion(input);
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: text(input.characterId, "characterId"),
    sessionId: text(input.sessionId, "sessionId"),
    authority: authority(input.authority),
  };
}

export function validateCharacterAffectCorrectRequest(value: unknown): CharacterAffectCorrectRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "sessionId", "eventId", "expectedVersion", "authority", "reason", "replacement"]);
  schemaVersion(input);
  const characterId = text(input.characterId, "characterId");
  const sessionId = text(input.sessionId, "sessionId");
  const replacement = record(input.replacement, "replacement") as CharacterAffectCorrectRequest["replacement"];
  if (replacement.characterId !== characterId || replacement.sessionId !== sessionId || replacement.userId !== "local-user") {
    throw new CharacterContextValidationError("replacement owner must match the request owner.", "replacement");
  }
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId,
    sessionId,
    eventId: text(input.eventId, "eventId"),
    expectedVersion: text(input.expectedVersion, "expectedVersion"),
    authority: authority(input.authority),
    reason: text(input.reason, "reason"),
    replacement,
  };
}

export function validateCharacterAffectResetRequest(value: unknown): CharacterAffectResetRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "sessionId", "layer", "expectedVersion", "authority", "reason", "resetAt", "idempotencyKey"]);
  schemaVersion(input);
  if (input.layer !== "session" && input.layer !== "relationship") {
    throw new CharacterContextValidationError("layer is not supported.", "layer");
  }
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: text(input.characterId, "characterId"),
    sessionId: text(input.sessionId, "sessionId"),
    layer: input.layer,
    expectedVersion: text(input.expectedVersion, "expectedVersion"),
    authority: authority(input.authority),
    reason: text(input.reason, "reason"),
    resetAt: text(input.resetAt, "resetAt"),
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey"),
  };
}

export function validateCharacterMemorySearchRequest(value: unknown): CharacterMemorySearchRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "query", "limit", "scope"]);
  schemaVersion(input);
  const scope = record(input.scope, "scope");
  if (scope.scope === "character") {
    exactKeys(scope, ["scope"], "scope");
    return {
      schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
      characterId: text(input.characterId, "characterId"),
      query: text(input.query, "query"),
      limit: integer(input.limit, "limit", 1, 20, 5),
      scope: { scope: "character" },
    };
  }
  if (scope.scope !== "project") {
    throw new CharacterContextValidationError("scope.scope is not supported.", "scope.scope");
  }
  exactKeys(scope, ["scope", "project"], "scope");
  const project = record(scope.project, "scope.project");
  exactKeys(project, ["type", "id", "path"], "scope.project");
  const projectRef = project.type === "id"
    ? { type: "id" as const, id: text(project.id, "scope.project.id") }
    : project.type === "path"
      ? { type: "path" as const, path: text(project.path, "scope.project.path") }
      : null;
  if (!projectRef) {
    throw new CharacterContextValidationError("scope.project.type is not supported.", "scope.project.type");
  }
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: text(input.characterId, "characterId"),
    query: text(input.query, "query"),
    limit: integer(input.limit, "limit", 1, 20, 5),
    scope: { scope: "project", project: projectRef },
  };
}

export function validateCharacterMemoryAppendEpisodeRequest(value: unknown): CharacterMemoryAppendEpisodeRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "sessionId", "authority", "idempotencyKey", "episode"]);
  schemaVersion(input);
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: text(input.characterId, "characterId"),
    sessionId: text(input.sessionId, "sessionId"),
    authority: authority(input.authority),
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey"),
    episode: episode(input.episode),
  };
}

export function validateCharacterMemoryCorrectRequest(value: unknown): CharacterMemoryCorrectRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "entryId", "authority", "reason", "idempotencyKey", "replacement"]);
  schemaVersion(input);
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: text(input.characterId, "characterId"),
    entryId: text(input.entryId, "entryId"),
    authority: authority(input.authority),
    reason: text(input.reason, "reason"),
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey"),
    replacement: episode(input.replacement, "replacement"),
  };
}

export function validateCharacterMemoryForgetRequest(value: unknown): CharacterMemoryForgetRequest {
  const input = record(value);
  exactKeys(input, ["schemaVersion", "characterId", "entryId", "authority", "reason", "idempotencyKey"]);
  schemaVersion(input);
  const reason = text(input.reason, "reason");
  if (!(["user_request", "incorrect", "outdated", "privacy", "other"] as const).includes(
    reason as CharacterMemoryForgetRequest["reason"],
  )) {
    throw new CharacterContextValidationError("reason is not supported.", "reason");
  }
  return {
    schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    characterId: text(input.characterId, "characterId"),
    entryId: text(input.entryId, "entryId"),
    authority: authority(input.authority),
    reason: reason as CharacterMemoryForgetRequest["reason"],
    idempotencyKey: text(input.idempotencyKey, "idempotencyKey"),
  };
}
