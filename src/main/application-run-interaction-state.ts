import { APPLICATION_RUN_LIMITS, type ApplicationRunInteraction } from "../shared/application-run-model.js";
import {
  APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS,
  applicationRunInteractionCollectionWireBytes,
  applicationRunInteractionWireItemBytes,
} from "../shared/application-run-interaction-limits.js";

type ApplicationRunInteractionHandle = object;

type ApplicationRunInteractionAdapterOwner = Readonly<{
  connectionGeneration: string;
  threadId: string;
  turnId: string;
  itemId?: string;
}>;

type ApplicationRunInteractionAdapterSnapshot = Readonly<{
  interactionId: string;
  providerId: string;
  definitionVersion: string;
  kind: string;
  answerable: boolean;
  display: unknown;
}>;

export const APPLICATION_RUN_INTERACTION_LIMITS = Object.freeze({
  maxPendingPerAttempt: APPLICATION_RUN_LIMITS.interactionsMaxItems,
  maxProjectionBytesPerAttempt: APPLICATION_RUN_INTERACTION_TRANSPORT_LIMITS.maxCollectionWireBytes,
  maxTombstonesPerAttempt: 128,
} as const);

export type ApplicationRunInteractionAttemptOwner = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
  bindingId: string;
  workspaceKey: string;
  providerId: string;
  definitionVersion: string;
  persistenceMode: "persistent" | "ephemeral";
  ephemeralOwnerToken: string | null;
  runtimeGenerationId: string;
  externalConversationId: string;
}>;

export type ApplicationRunInteractionStateLimits = Readonly<{
  maxPending?: number;
  maxProjectionBytes?: number;
  maxTombstones?: number;
}>;

export type ApplicationRunInteractionActivityClassifier = (
  providerId: string,
  definitionVersion: string,
  kind: string,
) => "waiting_input" | "waiting_approval" | undefined;

type CompositeOwner = ApplicationRunInteractionAttemptOwner &
  Readonly<{
    adapterConnectionGeneration: string;
    externalExecutionId: string;
    providerItemId: string | null;
  }>;

export type ApplicationRunInteractionClaim = Readonly<{
  handle: ApplicationRunInteractionHandle;
  owner: CompositeOwner;
  snapshot: ApplicationRunInteraction;
}>;

type PendingEntry = {
  handle: ApplicationRunInteractionHandle;
  owner: CompositeOwner;
  adapterOwner: ApplicationRunInteractionAdapterOwner;
  snapshot: ApplicationRunInteraction;
  snapshotJson: string;
  projection: ApplicationRunInteraction;
  projectionBytes: number;
  activity: "waiting_input" | "waiting_approval";
};

type Tombstone = Readonly<{
  handle: ApplicationRunInteractionHandle;
  adapterOwner: ApplicationRunInteractionAdapterOwner;
  interactionId: string | null;
}>;

export class ApplicationRunInteractionState {
  readonly #attempt: ApplicationRunInteractionAttemptOwner;
  readonly #maxPending: number;
  readonly #maxProjectionBytes: number;
  readonly #maxTombstones: number;
  readonly #classifyActivity: ApplicationRunInteractionActivityClassifier;
  readonly #pending = new Map<ApplicationRunInteractionHandle, PendingEntry>();
  readonly #publicIds = new Set<string>();
  readonly #tombstones = new Map<ApplicationRunInteractionHandle, Tombstone>();
  #adapterConnectionGeneration: string | null = null;
  #externalExecutionId: string | null = null;
  #projectionBytes = 0;
  #closed = false;

  constructor(
    owner: ApplicationRunInteractionAttemptOwner,
    classifyActivity: ApplicationRunInteractionActivityClassifier,
    limits: ApplicationRunInteractionStateLimits = {},
  ) {
    this.#attempt = snapshotAttemptOwner(owner);
    this.#maxPending = positiveLimit(limits.maxPending ?? APPLICATION_RUN_INTERACTION_LIMITS.maxPendingPerAttempt);
    this.#maxProjectionBytes = positiveLimit(
      limits.maxProjectionBytes ?? APPLICATION_RUN_INTERACTION_LIMITS.maxProjectionBytesPerAttempt,
    );
    this.#maxTombstones = positiveLimit(
      limits.maxTombstones ?? APPLICATION_RUN_INTERACTION_LIMITS.maxTombstonesPerAttempt,
    );
    this.#classifyActivity = classifyActivity;
  }

  pending(
    handle: ApplicationRunInteractionHandle,
    owner: ApplicationRunInteractionAdapterOwner,
    snapshot: ApplicationRunInteractionAdapterSnapshot,
  ): void {
    if (this.#closed) return;
    interactionHandle(handle);
    const adapterOwner = snapshotAdapterOwner(owner);
    this.#validateAdapterOwner(adapterOwner);
    const existing = this.#pending.get(handle);
    if (existing !== undefined) {
      const projection = projectInteraction(snapshot, this.#attempt);
      const projectionJson = JSON.stringify(projection);
      if (!sameAdapterOwner(existing.adapterOwner, adapterOwner) || existing.snapshotJson !== projectionJson) {
        throw new TypeError("Pending Run interaction conflicts with its existing owner or projection.");
      }
      return;
    }
    const tombstone = this.#tombstones.get(handle);
    if (tombstone !== undefined) {
      if (!sameAdapterOwner(tombstone.adapterOwner, adapterOwner)) {
        throw new TypeError("Resolved Run interaction handle was reused by another owner.");
      }
      return;
    }

    const projection = projectInteraction(snapshot, this.#attempt);
    if (this.#publicIds.has(projection.interactionId)) {
      throw new TypeError("Run interaction public identity is duplicated.");
    }
    const projectionJson = JSON.stringify(projection);
    const projectionBytes = applicationRunInteractionWireItemBytes(projection);
    const activity = this.#classifyActivity(projection.providerId, projection.definitionVersion, projection.kind);
    if (activity === undefined) throw new TypeError("Run interaction activity classification is unavailable.");
    if (this.#pending.size >= this.#maxPending) {
      throw new RangeError("Run interaction pending capacity was reached.");
    }
    const prospectiveProjectionBytes = applicationRunInteractionCollectionWireBytes(
      this.#projectionBytes + projectionBytes,
      this.#pending.size + 1,
    );
    if (prospectiveProjectionBytes > this.#maxProjectionBytes) {
      throw new RangeError("Run interaction projection capacity was reached.");
    }
    const compositeOwner = Object.freeze({
      ...this.#attempt,
      adapterConnectionGeneration: adapterOwner.connectionGeneration,
      externalExecutionId: adapterOwner.turnId,
      providerItemId: adapterOwner.itemId ?? null,
    });
    this.#pending.set(handle, {
      handle,
      owner: compositeOwner,
      adapterOwner,
      snapshot: projection,
      snapshotJson: projectionJson,
      projection,
      projectionBytes,
      activity,
    });
    this.#publicIds.add(projection.interactionId);
    this.#projectionBytes += projectionBytes;
  }

  resolved(handle: ApplicationRunInteractionHandle, owner: ApplicationRunInteractionAdapterOwner): void {
    if (this.#closed) return;
    interactionHandle(handle);
    const adapterOwner = snapshotAdapterOwner(owner);
    this.#validateAdapterOwner(adapterOwner);
    const existing = this.#pending.get(handle);
    if (existing !== undefined) {
      if (!sameAdapterOwner(existing.adapterOwner, adapterOwner)) {
        throw new TypeError("Run interaction resolution owner does not match the pending owner.");
      }
      this.#pending.delete(handle);
      this.#projectionBytes -= existing.projectionBytes;
      this.#rememberResolved(handle, adapterOwner, existing.projection.interactionId);
      return;
    }
    const tombstone = this.#tombstones.get(handle);
    if (tombstone !== undefined) {
      if (!sameAdapterOwner(tombstone.adapterOwner, adapterOwner)) {
        throw new TypeError("Run interaction resolution conflicts with its tombstone owner.");
      }
      return;
    }
    this.#rememberResolved(handle, adapterOwner, null);
  }

  activate(externalExecutionId: string): void {
    if (this.#closed) return;
    const executionId = identifier(externalExecutionId);
    if (this.#externalExecutionId !== null && this.#externalExecutionId !== executionId) {
      throw new TypeError("Run interaction execution owner changed after activation.");
    }
    this.#externalExecutionId = executionId;
    for (const entry of [...this.#pending.values()]) {
      if (entry.owner.externalExecutionId === executionId) continue;
      this.#pending.delete(entry.handle);
      this.#projectionBytes -= entry.projectionBytes;
      this.#rememberResolved(entry.handle, entry.adapterOwner, entry.projection.interactionId);
    }
  }

  snapshot(): readonly ApplicationRunInteraction[] {
    if (this.#closed || this.#externalExecutionId === null) return Object.freeze([]);
    return Object.freeze(
      [...this.#pending.values()]
        .filter((entry) => entry.owner.externalExecutionId === this.#externalExecutionId)
        .map((entry) => entry.projection),
    );
  }

  activity(): "waiting_input" | "waiting_approval" | null {
    if (this.#closed || this.#externalExecutionId === null) return null;
    const entries = [...this.#pending.values()].filter(
      (entry) => entry.owner.externalExecutionId === this.#externalExecutionId,
    );
    if (entries.some((entry) => entry.activity === "waiting_input")) {
      return "waiting_input";
    }
    return entries.some((entry) => entry.activity === "waiting_approval") ? "waiting_approval" : null;
  }

  matchesActiveExecution(externalExecutionId: string): boolean {
    return !this.#closed && this.#externalExecutionId === externalExecutionId;
  }

  lookup(interactionId: string, kind: string): ApplicationRunInteractionClaim | null {
    if (this.#closed || this.#externalExecutionId === null) return null;
    const publicId = identifier(interactionId);
    const interactionKind = identifier(kind);
    const entry = [...this.#pending.values()].find(
      (candidate) =>
        candidate.owner.externalExecutionId === this.#externalExecutionId &&
        candidate.snapshot.interactionId === publicId &&
        candidate.snapshot.kind === interactionKind,
    );
    if (entry === undefined) return null;
    return Object.freeze({ handle: entry.handle, owner: entry.owner, snapshot: entry.snapshot });
  }

  markResponseAdmitted(claim: ApplicationRunInteractionClaim): boolean {
    if (this.#closed) return false;
    const entry = this.#pending.get(claim.handle);
    if (entry === undefined) return false;
    if (
      entry.owner !== claim.owner ||
      entry.snapshot !== claim.snapshot ||
      entry.owner.externalExecutionId !== this.#externalExecutionId
    ) {
      throw new TypeError("Run interaction claim is stale.");
    }
    const projection = Object.freeze({
      interactionId: entry.snapshot.interactionId,
      providerId: entry.snapshot.providerId,
      definitionVersion: entry.snapshot.definitionVersion,
      kind: entry.snapshot.kind,
      answerable: false,
      display: Object.freeze({
        summary: "A response was admitted for this interaction.",
        unavailableReason: "response_admitted",
      }),
    }) satisfies ApplicationRunInteraction;
    const projectionBytes = applicationRunInteractionWireItemBytes(projection);
    const totalProjectionBytes = this.#projectionBytes - entry.projectionBytes + projectionBytes;
    if (
      applicationRunInteractionCollectionWireBytes(totalProjectionBytes, this.#pending.size) > this.#maxProjectionBytes
    ) {
      throw new RangeError("Run interaction projection capacity was reached.");
    }
    entry.projection = projection;
    this.#projectionBytes = totalProjectionBytes;
    entry.projectionBytes = projectionBytes;
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending.clear();
    this.#publicIds.clear();
    this.#tombstones.clear();
    this.#projectionBytes = 0;
  }

  #validateAdapterOwner(owner: ApplicationRunInteractionAdapterOwner): void {
    if (owner.threadId !== this.#attempt.externalConversationId) {
      throw new TypeError("Run interaction conversation owner does not match the Attempt.");
    }
    if (this.#externalExecutionId !== null && owner.turnId !== this.#externalExecutionId) {
      throw new TypeError("Run interaction execution owner does not match the active Attempt.");
    }
    if (this.#adapterConnectionGeneration === null) {
      this.#adapterConnectionGeneration = owner.connectionGeneration;
    } else if (owner.connectionGeneration !== this.#adapterConnectionGeneration) {
      throw new TypeError("Run interaction Adapter connection generation changed within an Attempt.");
    }
  }

  #rememberResolved(
    handle: ApplicationRunInteractionHandle,
    adapterOwner: ApplicationRunInteractionAdapterOwner,
    interactionId: string | null,
  ): void {
    this.#tombstones.set(handle, Object.freeze({ handle, adapterOwner, interactionId }));
    while (this.#tombstones.size > this.#maxTombstones) {
      const oldest = this.#tombstones.entries().next().value as
        [ApplicationRunInteractionHandle, Tombstone] | undefined;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest[0]);
      if (oldest[1].interactionId !== null) this.#publicIds.delete(oldest[1].interactionId);
    }
  }
}

function snapshotAttemptOwner(owner: ApplicationRunInteractionAttemptOwner): ApplicationRunInteractionAttemptOwner {
  const persistenceMode = owner.persistenceMode;
  if (persistenceMode !== "persistent" && persistenceMode !== "ephemeral") {
    throw new TypeError("Run interaction persistence owner is invalid.");
  }
  const ephemeralOwnerToken = owner.ephemeralOwnerToken;
  if (
    (persistenceMode === "persistent" && ephemeralOwnerToken !== null) ||
    (persistenceMode === "ephemeral" && ephemeralOwnerToken === null)
  ) {
    throw new TypeError("Run interaction ephemeral owner tuple is invalid.");
  }
  return Object.freeze({
    sessionId: identifier(owner.sessionId),
    runId: identifier(owner.runId),
    attemptId: identifier(owner.attemptId),
    bindingId: identifier(owner.bindingId),
    workspaceKey: identifier(owner.workspaceKey),
    providerId: identifier(owner.providerId),
    definitionVersion: identifier(owner.definitionVersion),
    persistenceMode,
    ephemeralOwnerToken: ephemeralOwnerToken === null ? null : identifier(ephemeralOwnerToken),
    runtimeGenerationId: identifier(owner.runtimeGenerationId),
    externalConversationId: identifier(owner.externalConversationId),
  });
}

function snapshotAdapterOwner(owner: ApplicationRunInteractionAdapterOwner): ApplicationRunInteractionAdapterOwner {
  return Object.freeze({
    connectionGeneration: identifier(owner.connectionGeneration),
    threadId: identifier(owner.threadId),
    turnId: identifier(owner.turnId),
    ...(owner.itemId === undefined ? {} : { itemId: identifier(owner.itemId) }),
  });
}

function sameAdapterOwner(
  left: ApplicationRunInteractionAdapterOwner,
  right: ApplicationRunInteractionAdapterOwner,
): boolean {
  return (
    left.connectionGeneration === right.connectionGeneration &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.itemId === right.itemId
  );
}

function projectInteraction(
  snapshot: ApplicationRunInteractionAdapterSnapshot,
  attempt: ApplicationRunInteractionAttemptOwner,
): ApplicationRunInteraction {
  const interactionId = identifier(snapshot.interactionId);
  const providerId = identifier(snapshot.providerId);
  const definitionVersion = identifier(snapshot.definitionVersion);
  const kind = identifier(snapshot.kind);
  if (providerId !== attempt.providerId || definitionVersion !== attempt.definitionVersion) {
    throw new TypeError("Run interaction definition owner does not match the execution snapshot.");
  }
  if (typeof snapshot.answerable !== "boolean") throw new TypeError("Run interaction answerability is invalid.");
  const display = snapshotJsonObject(snapshot.display);
  return Object.freeze({
    interactionId,
    providerId,
    definitionVersion,
    kind,
    answerable: snapshot.answerable,
    display,
  });
}

function snapshotJsonObject(value: unknown): Readonly<{ [key: string]: ApplicationRunInteraction["display"][string] }> {
  const snapshot = snapshotJson(value, 0);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError("Run interaction display must be a JSON object.");
  }
  return snapshot as Readonly<{ [key: string]: ApplicationRunInteraction["display"][string] }>;
}

function snapshotJson(value: unknown, depth: number): ApplicationRunInteraction["display"][string] {
  if (depth > 32) throw new TypeError("Run interaction display is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Run interaction display number is invalid.");
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new TypeError("Run interaction display array is invalid.");
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("Run interaction display array is sparse.");
      output.push(snapshotJson(value[index], depth + 1));
    }
    return Object.freeze(output);
  }
  if (typeof value !== "object" || value === null) throw new TypeError("Run interaction display value is invalid.");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Run interaction display object is invalid.");
  const output: Record<string, ApplicationRunInteraction["display"][string]> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Run interaction display key is invalid.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Run interaction display property is invalid.");
    }
    Object.defineProperty(output, key, {
      value: snapshotJson(descriptor.value, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(output);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || value.includes("\0")) {
    throw new TypeError("Run interaction identifier is invalid.");
  }
  return value;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Run interaction limit is invalid.");
  return value;
}

function interactionHandle(value: unknown): asserts value is object {
  if (typeof value !== "object" || value === null) throw new TypeError("Run interaction handle is invalid.");
}
