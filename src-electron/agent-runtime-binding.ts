import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getProviderAgentRuntimeBindingCapability } from "./provider-agent-runtime-binding.js";

export type AgentRuntimeOperation = string;

export type AgentRuntimeAuthoritySnapshot = Readonly<Record<string, unknown>>;

export type AgentRuntimeBindingRecord = {
  bindingId: string;
  bindingReferenceHash: string;
  actorSessionId: string;
  providerId: string;
  executionGeneration: string;
  authoritySnapshot: AgentRuntimeAuthoritySnapshot;
  operationGrants: readonly AgentRuntimeOperation[];
  createdAt: string;
  expiresAt: string | null;
};

export type ProviderAgentRuntimeBindingProjection = {
  bindingId: string;
  bindingReference: string;
  providerId: string;
  executionGeneration: string;
  transport: "env" | "unsupported";
  expiresAt: string | null;
};

export type ResolvedAgentRuntimeBinding = Omit<
  AgentRuntimeBindingRecord,
  "bindingReferenceHash"
> & {
  bindingIdHash: string;
};

export type AgentRuntimeBindingResolveResult =
  | { ok: true; binding: ResolvedAgentRuntimeBinding }
  | {
      ok: false;
      code:
        | "SESSION_BINDING_REQUIRED"
        | "SESSION_BINDING_INVALID"
        | "SESSION_BINDING_FORBIDDEN";
    };

export type IssueAgentRuntimeBindingInput = {
  actorSessionId: string;
  providerId: string;
  authoritySnapshot?: AgentRuntimeAuthoritySnapshot;
  operationGrants: readonly AgentRuntimeOperation[];
  now?: Date;
  expiresAt?: string | null;
};

export type AgentRuntimeBindingChange = {
  actorSessionId: string;
  providerId: string;
  previousExecutionGeneration: string | null;
  executionGeneration: string | null;
};

type ActiveBinding = {
  record: AgentRuntimeBindingRecord;
  reference: string;
  authorityFingerprint: string;
};

function hashBindingReference(reference: string): string {
  return createHash("sha256").update(reference, "utf8").digest("base64url");
}

function bindingKey(actorSessionId: string, providerId: string): string {
  return `${actorSessionId}\0${providerId}`;
}

function isExpired(record: AgentRuntimeBindingRecord, now: Date): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now.getTime());
}

function normalizeExpiresAt(expiresAt: string | null | undefined): string | null {
  if (expiresAt === null || expiresAt === undefined) {
    return null;
  }
  const normalizedInput = expiresAt.trim();
  const timestamp = Date.parse(normalizedInput);
  if (!normalizedInput || !Number.isFinite(timestamp)) {
    throw new Error("Agent runtime binding expiresAt must be a valid date-time.");
  }
  return new Date(timestamp).toISOString();
}

function sameGrants(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((grant, index) => grant === right[index]);
}

function stableAuthorityValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableAuthorityValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableAuthorityValue(item)]),
    );
  }
  return value;
}

function authorityFingerprint(snapshot: AgentRuntimeAuthoritySnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(stableAuthorityValue(snapshot)), "utf8")
    .digest("base64url");
}

export class AgentRuntimeBindingRegistry {
  private readonly bindingsByKey = new Map<string, ActiveBinding>();
  private readonly keysByReferenceHash = new Map<string, string>();
  private readonly changeListeners = new Set<(change: AgentRuntimeBindingChange) => void>();

  subscribeChanges(listener: (change: AgentRuntimeBindingChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  issueOrReuse(input: IssueAgentRuntimeBindingInput): ProviderAgentRuntimeBindingProjection {
    const actorSessionId = input.actorSessionId.trim();
    const providerId = input.providerId.trim();
    if (!actorSessionId || !providerId) {
      throw new Error("Agent runtime binding requires actor Session and provider IDs.");
    }

    const expiresAt = normalizeExpiresAt(input.expiresAt);

    const transport = getProviderAgentRuntimeBindingCapability(providerId).transport;
    if (transport === "unsupported") {
      this.revokeProviderExecution(actorSessionId, providerId);
      return {
        bindingId: randomUUID(),
        bindingReference: "",
        providerId,
        executionGeneration: randomUUID(),
        transport: "unsupported",
        expiresAt,
      };
    }

    const key = bindingKey(actorSessionId, providerId);
    const now = input.now ?? new Date();
    const operationGrants = [...new Set(input.operationGrants)].sort();
    const authoritySnapshot = structuredClone(input.authoritySnapshot ?? {});
    const nextAuthorityFingerprint = authorityFingerprint(authoritySnapshot);
    const existing = this.bindingsByKey.get(key);
    if (
      existing
      && !isExpired(existing.record, now)
      && sameGrants(existing.record.operationGrants, operationGrants)
      && existing.authorityFingerprint === nextAuthorityFingerprint
      && existing.record.expiresAt === expiresAt
    ) {
      return this.project(existing, transport);
    }
    const bindingReference = randomBytes(32).toString("base64url");
    const record: AgentRuntimeBindingRecord = {
      bindingId: randomUUID(),
      bindingReferenceHash: hashBindingReference(bindingReference),
      actorSessionId,
      providerId,
      executionGeneration: randomUUID(),
      authoritySnapshot,
      operationGrants,
      createdAt: now.toISOString(),
      expiresAt,
    };
    const active = {
      record,
      reference: bindingReference,
      authorityFingerprint: nextAuthorityFingerprint,
    };
    if (existing) {
      this.removeActiveBinding(key, existing);
    }
    this.bindingsByKey.set(key, active);
    this.keysByReferenceHash.set(record.bindingReferenceHash, key);
    this.emitChange({
      actorSessionId,
      providerId,
      previousExecutionGeneration: existing?.record.executionGeneration ?? null,
      executionGeneration: record.executionGeneration,
    });
    return this.project(active, transport);
  }

  resolve(
    bindingReference: string | null | undefined,
    operation: AgentRuntimeOperation,
    now = new Date(),
  ): AgentRuntimeBindingResolveResult {
    const reference = bindingReference?.trim();
    if (!reference) {
      return { ok: false, code: "SESSION_BINDING_REQUIRED" };
    }
    const referenceHash = hashBindingReference(reference);
    const key = this.keysByReferenceHash.get(referenceHash);
    const active = key ? this.bindingsByKey.get(key) : undefined;
    if (!key || !active || active.record.bindingReferenceHash !== referenceHash) {
      return { ok: false, code: "SESSION_BINDING_INVALID" };
    }
    if (isExpired(active.record, now)) {
      this.revokeActiveBinding(key, active);
      return { ok: false, code: "SESSION_BINDING_INVALID" };
    }
    if (!active.record.operationGrants.includes(operation)) {
      return { ok: false, code: "SESSION_BINDING_FORBIDDEN" };
    }
    return {
      ok: true,
      binding: {
        bindingId: active.record.bindingId,
        bindingIdHash: active.record.bindingReferenceHash,
        actorSessionId: active.record.actorSessionId,
        providerId: active.record.providerId,
        executionGeneration: active.record.executionGeneration,
        authoritySnapshot: structuredClone(active.record.authoritySnapshot),
        operationGrants: [...active.record.operationGrants],
        createdAt: active.record.createdAt,
        expiresAt: active.record.expiresAt,
      },
    };
  }

  revokeProviderExecution(actorSessionId: string, providerId: string): void {
    const key = bindingKey(actorSessionId.trim(), providerId.trim());
    const active = this.bindingsByKey.get(key);
    if (active) {
      this.revokeActiveBinding(key, active);
    }
  }

  revokeSession(actorSessionId: string): void {
    for (const [key, active] of [...this.bindingsByKey.entries()]) {
      if (active.record.actorSessionId === actorSessionId) {
        this.revokeActiveBinding(key, active);
      }
    }
  }

  revokeAll(): void {
    for (const [key, active] of [...this.bindingsByKey.entries()]) {
      this.revokeActiveBinding(key, active);
    }
  }

  getActiveBindingCount(now = new Date()): number {
    for (const [key, active] of [...this.bindingsByKey.entries()]) {
      if (isExpired(active.record, now)) {
        this.revokeActiveBinding(key, active);
      }
    }
    return this.bindingsByKey.size;
  }

  getExecutionGeneration(
    actorSessionId: string,
    providerId: string,
    now = new Date(),
  ): string | null {
    const key = bindingKey(actorSessionId.trim(), providerId.trim());
    const active = this.bindingsByKey.get(key);
    if (!active) {
      return null;
    }
    if (isExpired(active.record, now)) {
      this.revokeActiveBinding(key, active);
      return null;
    }
    return active.record.executionGeneration;
  }

  private project(active: ActiveBinding, transport: "env"): ProviderAgentRuntimeBindingProjection {
    return {
      bindingId: active.record.bindingId,
      bindingReference: active.reference,
      providerId: active.record.providerId,
      executionGeneration: active.record.executionGeneration,
      transport,
      expiresAt: active.record.expiresAt,
    };
  }

  private revokeActiveBinding(key: string, active: ActiveBinding): void {
    this.removeActiveBinding(key, active);
    this.emitChange({
      actorSessionId: active.record.actorSessionId,
      providerId: active.record.providerId,
      previousExecutionGeneration: active.record.executionGeneration,
      executionGeneration: null,
    });
  }

  private removeActiveBinding(key: string, active: ActiveBinding): void {
    this.bindingsByKey.delete(key);
    this.keysByReferenceHash.delete(active.record.bindingReferenceHash);
  }

  private emitChange(change: AgentRuntimeBindingChange): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener({ ...change });
      } catch {
        // Binding state transitions must not fail because a projection listener failed.
      }
    }
  }
}
