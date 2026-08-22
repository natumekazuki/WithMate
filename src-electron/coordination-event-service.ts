import { createHash } from "node:crypto";

import {
  CoordinationEventValidationError,
  type CoordinationEvent,
  type CoordinationEventCancelInput,
  type CoordinationEventConsumeInput,
  type CoordinationEventCorrectInput,
  type CoordinationEventCorrectionResult,
  type CoordinationEventCreateInput,
  type CoordinationEventDecisionResolveInput,
  type CoordinationEventGetInput,
  type CoordinationEventListInput,
  type CoordinationEventListResult,
  type CoordinationEventTrustedListInput,
  type CoordinationEventResolveInput,
  type CoordinationEventRoleSnapshot,
  type PendingCoordinationAnswer,
} from "../src/coordination-event.js";
import { requireSessionRoleBinding, type SessionRoleBinding } from "../src/session-role-binding.js";
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
  getSessionRoleBinding?(sessionId: string): SessionRoleBinding | null;
  now?(): Date;
};

export class CoordinationEventService {
  constructor(private readonly deps: CoordinationEventServiceDeps) {}

  create(input: CoordinationEventCreateInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    const principal = sessionPrincipal(binding);
    const result = this.deps.storage.create({
      principal,
      kind: input.kind,
      payload: input.payload,
      executionId: input.executionId ?? null,
      targetSessionId: input.targetSessionId ?? null,
      options: input.options ?? [],
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint("coordination.event.create", principal, withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(result.event);
    return result.event;
  }

  list(input: CoordinationEventListInput, binding: ResolvedAgentRuntimeBinding): CoordinationEventListResult {
    const principal = sessionPrincipal(binding);
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

  resolveFromCoordinationWindow(input: CoordinationEventDecisionResolveInput): CoordinationEvent {
    return this.resolveAs(input, this.coordinationWindowPrincipalFor(input.eventId));
  }

  cancelFromCoordinationWindow(input: CoordinationEventCancelInput): CoordinationEvent {
    return this.cancelAs(input, this.coordinationWindowPrincipalFor(input.eventId));
  }

  get(input: CoordinationEventGetInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    const principal = sessionPrincipal(binding);
    return "eventId" in input && input.eventId
      ? this.deps.storage.getVisible(principal, input.eventId)
      : this.deps.storage.getByIdempotencyKey(principal, input.idempotencyKey!);
  }

  resolve(input: CoordinationEventResolveInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    return this.resolveAs(input, sessionPrincipal(binding));
  }

  listPendingAnswersForSession(
    sessionId: string,
    roleBinding: CoordinationEventRoleSnapshot,
  ): PendingCoordinationAnswer[] {
    return this.deps.storage.listPendingAnswers({ sessionId, actorType: "session", roleBinding });
  }

  consume(input: CoordinationEventConsumeInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    const principal = sessionPrincipal(binding);
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

  cancel(input: CoordinationEventCancelInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    return this.cancelAs(input, sessionPrincipal(binding));
  }

  correct(input: CoordinationEventCorrectInput, binding: ResolvedAgentRuntimeBinding): CoordinationEventCorrectionResult {
    const principal = sessionPrincipal(binding);
    const outcome = this.deps.storage.correct({
      principal,
      eventId: input.eventId,
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
    input: CoordinationEventResolveInput | CoordinationEventDecisionResolveInput,
    principal: CoordinationMutationPrincipal,
  ): CoordinationEvent {
    const outcome = this.deps.storage.resolve({
      principal,
      eventId: input.eventId,
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
      optionId: null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint("coordination.event.cancel", principal, withoutKey(input)),
      createdAt: this.now(),
    });
    this.publish(outcome.event);
    return outcome.event;
  }

  private coordinationWindowPrincipalFor(eventId: string): CoordinationMutationPrincipal {
    const event = this.deps.storage.getTrusted(eventId);
    const roleBinding = this.deps.getSessionRoleBinding?.(event.actorSessionId) ?? null;
    if (!roleBinding) throw new CoordinationEventValidationError(
      "The event owner no longer has a canonical Session Role binding.",
      { field: "eventId" },
      "SESSION_BINDING_FORBIDDEN",
    );
    return { sessionId: event.actorSessionId, actorType: "trusted_gui", roleBinding };
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

function sessionPrincipal(binding: ResolvedAgentRuntimeBinding): CoordinationMutationPrincipal {
  const snapshot = binding.authoritySnapshot.sessionRoleBinding;
  if (binding.authoritySnapshot.sessionKind !== "default" || !snapshot) {
    throw new CoordinationEventValidationError(
      "Coordination events require a normal Session Role binding.",
      { field: "agentRuntimeBinding" },
      "SESSION_BINDING_FORBIDDEN",
    );
  }
  return {
    sessionId: binding.actorSessionId,
    actorType: "session",
    roleBinding: requireSessionRoleBinding(binding.actorSessionId, snapshot),
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
    principalType: principal.actorType,
    roleSnapshot: principal.roleBinding,
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
