import { createHash } from "node:crypto";

import {
  CoordinationEventValidationError,
  type CoordinationEvent,
  type CoordinationEventCancelInput,
  type CoordinationEventCorrectInput,
  type CoordinationEventCorrectionResult,
  type CoordinationEventCreateInput,
  type CoordinationEventGetInput,
  type CoordinationEventListInput,
  type CoordinationEventListResult,
  type CoordinationEventTrustedListInput,
  type CoordinationEventResolveInput,
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

  listFromTrustedGui(
    viewerSessionId: string,
    roleBinding: SessionRoleBinding,
    input: CoordinationEventListInput,
  ): CoordinationEventListResult {
    const principal: CoordinationMutationPrincipal = { sessionId: viewerSessionId, roleBinding, actorType: "trusted_gui" };
    const beforeSequence = input.cursor ? decodeCursor(principal.sessionId, input, input.cursor) : null;
    const result = this.deps.storage.list(principal, input, beforeSequence);
    return {
      ...result,
      ...(result.nextCursor ? { nextCursor: encodeCursor(principal.sessionId, input, Number(result.nextCursor)) } : {}),
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

  listFeedFromTrustedGui(
    viewerSessionId: string,
    roleBinding: SessionRoleBinding,
    scope: CoordinationEventListInput["scope"],
  ): CoordinationEventListResult["items"] {
    const openItems: CoordinationEventListResult["items"] = [];
    let cursor: string | undefined;
    do {
      const page = this.listFromTrustedGui(viewerSessionId, roleBinding, {
        scope,
        state: "open",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      openItems.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    const recentItems = this.listFromTrustedGui(viewerSessionId, roleBinding, { scope, limit: 100 }).items;
    const merged = new Map(openItems.map((event) => [event.eventId, event]));
    for (const event of recentItems) merged.set(event.eventId, event);
    return [...merged.values()];
  }

  get(input: CoordinationEventGetInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    const principal = sessionPrincipal(binding);
    return "eventId" in input && input.eventId
      ? this.deps.storage.getVisible(principal, input.eventId)
      : this.deps.storage.getByIdempotencyKey(principal, input.idempotencyKey!);
  }

  getFromTrustedGui(viewerSessionId: string, roleBinding: SessionRoleBinding, eventId: string): CoordinationEvent {
    return this.deps.storage.getVisible(
      { sessionId: viewerSessionId, roleBinding, actorType: "trusted_gui" },
      eventId,
    );
  }

  resolve(input: CoordinationEventResolveInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    return this.resolveAs(input, sessionPrincipal(binding));
  }

  resolveFromTrustedGui(
    viewerSessionId: string,
    roleBinding: SessionRoleBinding,
    input: CoordinationEventResolveInput,
  ): CoordinationEvent {
    return this.resolveAs(input, { sessionId: viewerSessionId, roleBinding, actorType: "trusted_gui" });
  }

  cancel(input: CoordinationEventCancelInput, binding: ResolvedAgentRuntimeBinding): CoordinationEvent {
    return this.cancelAs(input, sessionPrincipal(binding));
  }

  cancelFromTrustedGui(
    viewerSessionId: string,
    roleBinding: SessionRoleBinding,
    input: CoordinationEventCancelInput,
  ): CoordinationEvent {
    return this.cancelAs(input, { sessionId: viewerSessionId, roleBinding, actorType: "trusted_gui" });
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

  private resolveAs(input: CoordinationEventResolveInput, principal: CoordinationMutationPrincipal): CoordinationEvent {
    const outcome = this.deps.storage.resolve({
      principal,
      eventId: input.eventId,
      optionId: input.optionId ?? null,
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
