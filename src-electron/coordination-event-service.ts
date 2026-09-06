import { createHash } from "node:crypto";

import {
  CoordinationEventValidationError,
  type CoordinationEvent,
  type CoordinationEventCancelInput,
  type CoordinationEventConsumeInput,
  type CoordinationEventCorrectInput,
  type CoordinationEventCorrectionResult,
  type CoordinationEventCreateInput,
  type CoordinationEventTrustedResolveInput,
  type CoordinationEventGetInput,
  type CoordinationEventListInput,
  type CoordinationEventListResult,
  type CoordinationEventTrustedListInput,
  type CoordinationEventResolveInput,
  type PendingCoordinationResponse,
} from "../src/coordination-event.js";
import { isAgentMutationProof, type MutationAuthorityProof } from "../src/session-authority.js";
import type { ResolvedAgentRuntimeBinding } from "./agent-runtime-binding.js";
import {
  CoordinationEventStorageV6,
  type CoordinationMutationPrincipal,
} from "./coordination-event-storage-v6.js";

export class CoordinationEventPublicationError extends Error {
  readonly code = "COORDINATION_EVENT_PUBLICATION_FAILED";
  readonly retryable = true;
  readonly effect = "applied" as const;
  constructor(readonly eventId: string) {
    super("The coordination event committed, but its GUI refresh signal could not be published.");
    this.name = "CoordinationEventPublicationError";
  }
}

export type CoordinationEventServiceDeps = {
  storage: CoordinationEventStorageV6;
  publishCommitted(event: CoordinationEvent): void;
  now?(): Date;
};

export class CoordinationEventService {
  constructor(private readonly deps: CoordinationEventServiceDeps) {}

  create(input: CoordinationEventCreateInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): CoordinationEvent {
    const principal = sessionPrincipal(binding, proof);
    const result = this.deps.storage.create({
      principal,
      kind: input.kind,
      payload: input.payload,
      executionId: input.executionId ?? null,
      targetSessionId: input.targetSessionId ?? null,
      options: input.options ?? [],
      expectedContainerRevision: input.expectedContainerRevision,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint("coordination.event.create", principal, withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(result.event);
    return result.event;
  }

  list(input: CoordinationEventListInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): CoordinationEventListResult {
    const principal = sessionPrincipal(binding, proof);
    const beforeSequence = input.cursor ? decodeCursor(principal.sessionId, input, input.cursor) : null;
    const result = this.deps.storage.list(principal, input, beforeSequence);
    return {
      ...result,
      ...(result.nextCursor
        ? { nextCursor: encodeCursor(principal.sessionId, input, Number(result.nextCursor)) }
        : {}),
    };
  }

  listAllFromTrustedGui(input: CoordinationEventTrustedListInput): CoordinationEventListResult {
    const beforeSequence = input.cursor ? decodeTrustedCursor(input, input.cursor) : null;
    const result = this.deps.storage.listTrusted(input, beforeSequence);
    return {
      ...result,
      ...(result.nextCursor ? { nextCursor: encodeTrustedCursor(input, Number(result.nextCursor)) } : {}),
    };
  }

  getFromCoordinationWindow(eventId: string): CoordinationEvent {
    return this.deps.storage.getTrusted(eventId);
  }

  resolveFromCoordinationWindow(input: CoordinationEventTrustedResolveInput): CoordinationEvent {
    const outcome = this.deps.storage.resolveFromTrustedGui({
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      optionId: "optionId" in input ? input.optionId ?? null : null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: trustedFingerprint("coordination.event.resolve", withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(outcome.event);
    return outcome.event;
  }

  cancelFromCoordinationWindow(input: CoordinationEventCancelInput): CoordinationEvent {
    const outcome = this.deps.storage.cancelFromTrustedGui({
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: trustedFingerprint("coordination.event.cancel", withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(outcome.event);
    return outcome.event;
  }

  get(input: CoordinationEventGetInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): CoordinationEvent {
    const principal = sessionPrincipal(binding, proof);
    return "eventId" in input && input.eventId
      ? this.deps.storage.getVisible(principal, input.eventId)
      : this.deps.storage.getByIdempotencyKey(principal, input.idempotencyKey!);
  }

  resolve(input: CoordinationEventResolveInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): CoordinationEvent {
    return this.resolveAs(input, sessionPrincipal(binding, proof));
  }

  listPendingResponsesForSession(
    sessionId: string,
  ): PendingCoordinationResponse[] {
    return this.deps.storage.listPendingResponses(sessionId);
  }

  consume(input: CoordinationEventConsumeInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): CoordinationEvent {
    const principal = sessionPrincipal(binding, proof);
    const outcome = this.deps.storage.consume({
      principal,
      eventId: input.eventId,
      expectedResolutionSequence: input.expectedResolutionSequence,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint("coordination.event.consume", principal, withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(outcome.event);
    return outcome.event;
  }

  cancel(input: CoordinationEventCancelInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): CoordinationEvent {
    return this.cancelAs(input, sessionPrincipal(binding, proof));
  }

  correct(input: CoordinationEventCorrectInput, binding: ResolvedAgentRuntimeBinding, proof: MutationAuthorityProof): CoordinationEventCorrectionResult {
    const principal = sessionPrincipal(binding, proof);
    const outcome = this.deps.storage.correct({
      principal,
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
      executionId: input.executionId ?? null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint("coordination.event.correct", principal, withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(outcome.result.correction);
    return outcome.result;
  }

  private resolveAs(
    input: CoordinationEventResolveInput | CoordinationEventTrustedResolveInput,
    principal: CoordinationMutationPrincipal,
  ): CoordinationEvent {
    const outcome = this.deps.storage.resolve({
      principal,
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      optionId: "optionId" in input ? input.optionId ?? null : null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint("coordination.event.resolve", principal, withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(outcome.event);
    return outcome.event;
  }

  private cancelAs(input: CoordinationEventCancelInput, principal: CoordinationMutationPrincipal): CoordinationEvent {
    const outcome = this.deps.storage.cancel({
      principal,
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      optionId: null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint("coordination.event.cancel", principal, withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(outcome.event);
    return outcome.event;
  }

  private publish(event: CoordinationEvent): void {
    try {
      this.deps.publishCommitted(event);
    } catch {
      throw new CoordinationEventPublicationError(event.eventId);
    }
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

function sessionPrincipal(
  binding: ResolvedAgentRuntimeBinding,
  proof: MutationAuthorityProof,
): CoordinationMutationPrincipal {
  if (!isAgentMutationProof(proof)
    || proof.principal.actorSessionId !== binding.actorSessionId
    || proof.principal.runtimeGeneration !== binding.executionGeneration
    || proof.providerId !== binding.providerId) {
    throw new CoordinationEventValidationError(
      "The coordination authority proof does not match the runtime binding.",
      { field: "agentRuntimeBinding" },
      "SESSION_BINDING_FORBIDDEN",
    );
  }
  return {
    sessionId: binding.actorSessionId,
    proof,
  };
}

function withoutKey<T extends { idempotencyKey: string }>(input: T): Omit<T, "idempotencyKey"> {
  const { idempotencyKey: _key, ...rest } = input;
  return rest;
}

function fingerprint(operation: string, principal: CoordinationMutationPrincipal, input: unknown): string {
  return createHash("sha256").update(stableJson({
    operation,
    principalSessionId: principal.sessionId,
    principalType: principal.proof.principal.kind,
    input,
  }), "utf8").digest("hex");
}

function trustedFingerprint(operation: string, input: unknown): string {
  return createHash("sha256").update(stableJson({
    operation,
    principalType: "user",
    principalId: "local-user",
    input,
  }), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function encodeCursor(principalSessionId: string, input: CoordinationEventListInput, beforeSequence: number): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    operation: "coordination.event.list",
    principalSessionId,
    scope: input.scope,
    kind: input.kind ?? null,
    state: input.state ?? null,
    beforeSequence,
  }), "utf8").toString("base64url");
}

function decodeCursor(principalSessionId: string, input: CoordinationEventListInput, cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.version !== 1
      || value.operation !== "coordination.event.list"
      || value.principalSessionId !== principalSessionId
      || value.scope !== input.scope
      || value.kind !== (input.kind ?? null)
      || value.state !== (input.state ?? null)
      || !Number.isSafeInteger(value.beforeSequence)
      || (value.beforeSequence as number) < 1) {
      throw new Error("invalid cursor");
    }
    return value.beforeSequence as number;
  } catch {
    throw new CoordinationEventValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}

function encodeTrustedCursor(input: CoordinationEventTrustedListInput, beforeSequence: number): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    operation: "coordination.event.list.trusted",
    sessionId: input.sessionId ?? null,
    category: input.category ?? null,
    kind: input.kind ?? null,
    state: input.state ?? null,
    beforeSequence,
  }), "utf8").toString("base64url");
}

function decodeTrustedCursor(input: CoordinationEventTrustedListInput, cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.version !== 1
      || value.operation !== "coordination.event.list.trusted"
      || value.sessionId !== (input.sessionId ?? null)
      || value.category !== (input.category ?? null)
      || value.kind !== (input.kind ?? null)
      || value.state !== (input.state ?? null)
      || !Number.isSafeInteger(value.beforeSequence)
      || (value.beforeSequence as number) < 1) {
      throw new Error("invalid cursor");
    }
    return value.beforeSequence as number;
  } catch {
    throw new CoordinationEventValidationError("The pagination cursor is invalid.", { field: "cursor" }, "INVALID_CURSOR");
  }
}
