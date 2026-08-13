import { createHash } from "node:crypto";

import {
  type SessionApprovalInteractionPublicPayload,
  type SessionElicitationField,
  type SessionElicitationInteractionPublicPayload,
  type SessionInteraction,
  type SessionInteractionPublicPayload,
  type SessionInteractionResponse,
} from "../src/session-interaction.js";
import type { LiveApprovalRequest, LiveElicitationRequest } from "../src/runtime-state.js";
import {
  SessionInteractionNotFoundError,
  SessionInteractionStorageV6,
  type RespondToSessionInteractionResult,
} from "./session-interaction-storage-v6.js";

type RegisterSessionInteractionBase = {
  id: string;
  sessionId: string;
  executionId: string;
  createdAt: string;
};

export type SessionElicitationContinuationResponse = Omit<
  Extract<SessionInteractionResponse, { kind: "elicitation" }>,
  "kind"
>;

export type RegisterApprovalInteractionInput = RegisterSessionInteractionBase & {
  publicPayload: SessionApprovalInteractionPublicPayload;
  continueWith: (decision: "approve" | "deny") => void;
};

export type RegisterElicitationInteractionInput = RegisterSessionInteractionBase & {
  publicPayload: SessionElicitationInteractionPublicPayload;
  continueWith: (response: SessionElicitationContinuationResponse) => void;
};

export type RespondToSessionInteractionServiceInput = {
  sessionId: string;
  executionId: string;
  interactionId: string;
  response: SessionInteractionResponse;
  idempotencyKey: string;
  respondedAt: string;
  expiresAt: string;
};

export type RespondToSessionInteractionServiceResult = {
  interaction: SessionInteraction;
  replayed: boolean;
};

type SessionInteractionContinuation =
  | {
    kind: "approval";
    continueWith: (decision: "approve" | "deny") => void;
  }
  | {
    kind: "elicitation";
    continueWith: (response: SessionElicitationContinuationResponse) => void;
  };

export class SessionInteractionKindMismatchError extends Error {
  readonly code = "INTERACTION_RESPONSE_INVALID";

  constructor(readonly interactionId: string) {
    super(`Session interaction response kind does not match the pending interaction: ${interactionId}`);
    this.name = "SessionInteractionKindMismatchError";
  }
}

export class SessionInteractionContinuationUnavailableError extends Error {
  readonly code = "INTERACTION_CONTINUATION_UNAVAILABLE";

  constructor(readonly interactionId: string) {
    super(`Session interaction provider continuation is unavailable: ${interactionId}`);
    this.name = "SessionInteractionContinuationUnavailableError";
  }
}

export class SessionInteractionService {
  private readonly continuations = new Map<string, SessionInteractionContinuation>();
  private readonly observers = new Map<string, Set<() => void>>();

  constructor(private readonly storage: SessionInteractionStorageV6) {}

  registerApproval(input: RegisterApprovalInteractionInput): SessionInteraction {
    const publicPayload = validateApprovalPublicPayload(input.publicPayload);
    const interaction = this.storage.createPending({
      id: input.id,
      sessionId: input.sessionId,
      executionId: input.executionId,
      kind: "approval",
      publicPayload,
      createdAt: input.createdAt,
    });
    this.continuations.set(input.id, {
      kind: "approval",
      continueWith: input.continueWith,
    });
    this.notifyExecutionChanged(input.executionId);
    return toPublicInteraction(interaction);
  }

  registerElicitation(input: RegisterElicitationInteractionInput): SessionInteraction {
    const publicPayload = validateElicitationPublicPayload(input.publicPayload);
    const interaction = this.storage.createPending({
      id: input.id,
      sessionId: input.sessionId,
      executionId: input.executionId,
      kind: "elicitation",
      publicPayload,
      createdAt: input.createdAt,
    });
    this.continuations.set(input.id, {
      kind: "elicitation",
      continueWith: input.continueWith,
    });
    this.notifyExecutionChanged(input.executionId);
    return toPublicInteraction(interaction);
  }

  respond(input: RespondToSessionInteractionServiceInput): RespondToSessionInteractionServiceResult {
    const current = this.storage.get(input.interactionId);
    if (!current) {
      throw new SessionInteractionNotFoundError(input.interactionId);
    }
    if (current.kind !== input.response.kind) {
      throw new SessionInteractionKindMismatchError(input.interactionId);
    }
    validateInteractionResponse(current.publicPayload, input.response);
    const continuation = this.continuations.get(input.interactionId);
    if (current.state === "pending" && (!continuation || continuation.kind !== input.response.kind)) {
      throw new SessionInteractionContinuationUnavailableError(input.interactionId);
    }

    const submittedFields = input.response.kind === "elicitation" && input.response.action === "accept"
      ? Object.keys(input.response.content)
      : [];
    const result = this.storage.respond({
      sessionId: input.sessionId,
      executionId: input.executionId,
      interactionId: input.interactionId,
      action: input.response.kind === "approval" ? input.response.decision : input.response.action,
      submittedFields,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintSessionInteractionResponse(input),
      respondedAt: input.respondedAt,
      expiresAt: input.expiresAt,
    });

    if (!result.replayed) {
      this.continuations.delete(input.interactionId);
      this.notifyExecutionChanged(input.executionId);
      continueProvider(continuation, input.response);
    }
    return projectResponseResult(result);
  }

  getPendingForExecution(executionId: string): SessionInteraction | null {
    const interaction = this.storage.getPendingForExecution(executionId);
    return interaction ? toPublicInteraction(interaction) : null;
  }

  listSessionInteractionsPage(
    sessionId: string,
    afterSequence: number | null,
    limit: number,
    filter: Parameters<SessionInteractionStorageV6["listSessionInteractionsPage"]>[3] = {},
  ): SessionInteraction[] {
    return this.storage.listSessionInteractionsPage(sessionId, afterSequence, limit, filter).map(toPublicInteraction);
  }

  subscribeExecution(executionId: string, observer: () => void): () => void {
    const observers = this.observers.get(executionId) ?? new Set<() => void>();
    observers.add(observer);
    this.observers.set(executionId, observers);
    return () => {
      const current = this.observers.get(executionId);
      current?.delete(observer);
      if (current?.size === 0) {
        this.observers.delete(executionId);
      }
    };
  }

  // Callers publish only after their execution mutation has committed; observers then re-read durable state.
  notifyExecutionChanged(executionId: string): void {
    for (const observer of this.observers.get(executionId) ?? []) {
      // UI observers are post-commit notifications. A disconnected renderer must not
      // turn an already durable interaction transition into a failed response or stop
      // provider continuation settlement for the remaining observers.
      try {
        observer();
      } catch {
        // Observers are best-effort; durable state and provider settlement own success.
      }
    }
  }

  expirePendingForRestart(expiredAt: string): SessionInteraction[] {
    return this.expirePending(this.storage.expirePendingForRestart(expiredAt));
  }

  expirePendingForShutdown(expiredAt: string): SessionInteraction[] {
    return this.expirePending(this.storage.expirePendingForShutdown(expiredAt));
  }

  expirePendingForExecution(
    executionId: string,
    reason: "execution_canceled" | "execution_terminal",
    expiredAt: string,
  ): SessionInteraction[] {
    return this.expirePending(this.storage.expirePendingForExecution(executionId, reason, expiredAt));
  }

  private expirePending(interactions: ReturnType<SessionInteractionStorageV6["expirePendingForRestart"]>): SessionInteraction[] {
    const errors: unknown[] = [];
    for (const interaction of interactions) {
      const continuation = this.continuations.get(interaction.id);
      this.continuations.delete(interaction.id);
      this.notifyExecutionChanged(interaction.executionId);
      if (!continuation) {
        continue;
      }
      try {
        if (continuation.kind === "approval") {
          continuation.continueWith("deny");
        } else {
          continuation.continueWith({ action: "cancel" });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to release one or more expired session interaction continuations.");
    }
    return interactions.map(toPublicInteraction);
  }
}

export function projectApprovalInteractionPublicPayload(
  request: LiveApprovalRequest,
): SessionApprovalInteractionPublicPayload {
  return validateApprovalPublicPayload({
    title: request.title,
    summary: request.summary,
    ...(request.details === undefined ? {} : { details: request.details }),
    ...(request.warning === undefined ? {} : { warning: request.warning }),
  });
}

export function projectElicitationInteractionPublicPayload(
  request: LiveElicitationRequest,
): SessionElicitationInteractionPublicPayload {
  return validateElicitationPublicPayload({
    mode: request.mode,
    message: request.message,
    fields: request.fields.map((field) => ({ ...field })),
    ...(request.url === undefined ? {} : { url: request.url }),
  });
}

export function fingerprintSessionInteractionResponse(
  input: Pick<
    RespondToSessionInteractionServiceInput,
    "sessionId" | "executionId" | "interactionId" | "response"
  >,
): string {
  return createHash("sha256").update(stableJson({
    operation: "interaction.respond",
    sessionId: input.sessionId,
    executionId: input.executionId,
    interactionId: input.interactionId,
    response: input.response,
  })).digest("hex");
}

function continueProvider(
  continuation: SessionInteractionContinuation | undefined,
  response: SessionInteractionResponse,
): void {
  if (continuation?.kind === "approval" && response.kind === "approval") {
    continuation.continueWith(response.decision);
    return;
  }
  if (continuation?.kind === "elicitation" && response.kind === "elicitation") {
    const { kind: _kind, ...providerResponse } = response;
    continuation.continueWith(providerResponse);
    return;
  }
  throw new SessionInteractionContinuationUnavailableError("unknown");
}

function projectResponseResult(result: RespondToSessionInteractionResult): RespondToSessionInteractionServiceResult {
  return {
    interaction: toPublicInteraction(result.interaction),
    replayed: result.replayed,
  };
}

function toPublicInteraction(
  interaction: ReturnType<SessionInteractionStorageV6["get"]> extends infer T ? Exclude<T, null> : never,
): SessionInteraction {
  const { responseFingerprint: _responseFingerprint, ...publicInteraction } = interaction;
  return publicInteraction;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

function validateApprovalPublicPayload(
  payload: SessionApprovalInteractionPublicPayload,
): SessionApprovalInteractionPublicPayload {
  requireNonEmpty(payload.title, "approval.title");
  requireNonEmpty(payload.summary, "approval.summary");
  if (payload.details !== undefined) requireString(payload.details, "approval.details");
  if (payload.warning !== undefined) requireString(payload.warning, "approval.warning");
  return {
    title: payload.title,
    summary: payload.summary,
    ...(payload.details === undefined ? {} : { details: payload.details }),
    ...(payload.warning === undefined ? {} : { warning: payload.warning }),
  };
}

function validateElicitationPublicPayload(
  payload: SessionElicitationInteractionPublicPayload,
): SessionElicitationInteractionPublicPayload {
  requireNonEmpty(payload.message, "elicitation.message");
  if (payload.mode === "url") {
    requireNonEmpty(payload.url, "elicitation.url");
    if (payload.fields.length !== 0) {
      throw new TypeError("URL elicitation must not include fields.");
    }
  } else if (payload.url !== undefined) {
    throw new TypeError("Form elicitation must not include a URL.");
  }
  const names = new Set<string>();
  const fields = payload.fields.map((field, index) => validateElicitationField(field, index, names));
  return {
    mode: payload.mode,
    message: payload.message,
    fields,
    ...(payload.url === undefined ? {} : { url: payload.url }),
  };
}

function validateElicitationField(
  field: SessionElicitationField,
  index: number,
  names: Set<string>,
): SessionElicitationField {
  const path = `elicitation.fields[${index}]`;
  requireNonEmpty(field.name, `${path}.name`);
  requireNonEmpty(field.title, `${path}.title`);
  if (names.has(field.name)) throw new TypeError(`Duplicate elicitation field: ${field.name}`);
  names.add(field.name);
  if (field.description !== undefined) requireString(field.description, `${path}.description`);
  if (typeof field.required !== "boolean") throw new TypeError(`${path}.required must be a boolean.`);
  if (field.type === "select" || field.type === "multi-select") {
    if (field.options.length === 0) throw new TypeError(`${path}.options must not be empty.`);
    const values = new Set<string>();
    for (const option of field.options) {
      requireNonEmpty(option.value, `${path}.options.value`);
      requireNonEmpty(option.label, `${path}.options.label`);
      if (values.has(option.value)) throw new TypeError(`Duplicate elicitation option: ${option.value}`);
      values.add(option.value);
    }
    if (field.type === "select" && field.defaultValue !== undefined && !values.has(field.defaultValue)) {
      throw new TypeError(`${path}.defaultValue must identify an option.`);
    }
    if (field.type === "multi-select") {
      validateOptionalRange(field.minItems, field.maxItems, `${path}.items`, true);
      if (field.defaultValue !== undefined) {
        if (new Set(field.defaultValue).size !== field.defaultValue.length || field.defaultValue.some((value) => !values.has(value))) {
          throw new TypeError(`${path}.defaultValue must contain unique option values.`);
        }
        validateArrayLength(field.defaultValue, field.minItems, field.maxItems, `${path}.defaultValue`);
      }
    }
  } else if (field.type === "text") {
    validateOptionalRange(field.minLength, field.maxLength, `${path}.length`, true);
    if (field.defaultValue !== undefined) {
      validateStringValue(field.defaultValue, field, `${path}.defaultValue`);
    }
  } else if (field.type === "number") {
    validateOptionalRange(field.minimum, field.maximum, `${path}.number`, false);
    if (field.defaultValue !== undefined) {
      validateNumberValue(field.defaultValue, field, `${path}.defaultValue`);
    }
  } else if (field.type !== "boolean") {
    throw new TypeError(`${path}.type is invalid.`);
  }
  return structuredClone(field);
}

function validateInteractionResponse(
  payload: SessionInteractionPublicPayload,
  response: SessionInteractionResponse,
): void {
  if (response.kind !== "elicitation") return;
  if (response.action !== "accept") return;
  if (!("fields" in payload)) throw new TypeError("Elicitation interaction payload is invalid.");
  const fields = new Map(payload.fields.map((field) => [field.name, field]));
  for (const name of Object.keys(response.content)) {
    if (!fields.has(name)) throw new TypeError(`Unknown elicitation response field: ${name}`);
  }
  for (const field of payload.fields) {
    const value = response.content[field.name];
    if (value === undefined) {
      if (field.required) throw new TypeError(`Required elicitation response field is missing: ${field.name}`);
      continue;
    }
    validateElicitationValue(field, value);
  }
}

function validateElicitationValue(field: SessionElicitationField, value: unknown): void {
  const path = `response.content.${field.name}`;
  if (field.type === "select") {
    if (typeof value !== "string" || !field.options.some((option) => option.value === value)) {
      throw new TypeError(`${path} must identify an option.`);
    }
  } else if (field.type === "multi-select") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new TypeError(`${path} must be a string array.`);
    }
    if (new Set(value).size !== value.length || value.some((item) => !field.options.some((option) => option.value === item))) {
      throw new TypeError(`${path} must contain unique option values.`);
    }
    validateArrayLength(value, field.minItems, field.maxItems, path);
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean.`);
  } else if (field.type === "text") {
    validateStringValue(value, field, path);
  } else {
    validateNumberValue(value, field, path);
  }
}

function validateStringValue(
  value: unknown,
  field: Extract<SessionElicitationField, { type: "text" }>,
  path: string,
): void {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
  if (field.minLength !== undefined && value.length < field.minLength) throw new TypeError(`${path} is too short.`);
  if (field.maxLength !== undefined && value.length > field.maxLength) throw new TypeError(`${path} is too long.`);
  if (field.format && !matchesFormat(value, field.format)) throw new TypeError(`${path} has an invalid format.`);
}

function validateNumberValue(
  value: unknown,
  field: Extract<SessionElicitationField, { type: "number" }>,
  path: string,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be a finite number.`);
  if (field.numberKind === "integer" && !Number.isInteger(value)) throw new TypeError(`${path} must be an integer.`);
  if (field.minimum !== undefined && value < field.minimum) throw new TypeError(`${path} is below minimum.`);
  if (field.maximum !== undefined && value > field.maximum) throw new TypeError(`${path} is above maximum.`);
}

function validateOptionalRange(
  minimum: number | undefined,
  maximum: number | undefined,
  path: string,
  integer: boolean,
): void {
  for (const value of [minimum, maximum]) {
    if (value !== undefined && (!Number.isFinite(value) || (integer && (!Number.isInteger(value) || value < 0)))) {
      throw new TypeError(`${path} bounds are invalid.`);
    }
  }
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new TypeError(`${path} minimum exceeds maximum.`);
  }
}

function validateArrayLength(value: unknown[], minimum: number | undefined, maximum: number | undefined, path: string): void {
  if (minimum !== undefined && value.length < minimum) throw new TypeError(`${path} has too few items.`);
  if (maximum !== undefined && value.length > maximum) throw new TypeError(`${path} has too many items.`);
}

function matchesFormat(value: string, format: "email" | "uri" | "date" | "date-time"): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") {
    try { new URL(value); return true; } catch { return false; }
  }
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  return !Number.isNaN(Date.parse(value));
}

function requireNonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${path} must be a non-empty string.`);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string.`);
}
