import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  applicationRunInteractionCollectionWireBytes,
  applicationRunInteractionWireItemBytes,
} from "../../../shared/application-run-interaction-limits.js";
import {
  CODEX_ADAPTER_COMMAND_DECISIONS,
  CODEX_ADAPTER_LIMITS,
  type CodexAdapterPermissionCategory,
  type CodexAdapterCommandDecision,
  type CodexAdapterInteractionHandle,
  type CodexAdapterInteractionKind,
  type CodexAdapterInteractionOwner,
  type CodexAdapterInteractionResponse,
  type CodexAdapterInteractionResponseReservation,
  type CodexAdapterInteractionResponseReserveResult,
  type CodexAdapterInteractionResponseResult,
  type CodexAdapterInteractionSnapshot,
  type CodexAdapterInteractionUnavailableDisplay,
  type CodexAdapterServerRequestPort,
  isCodexAdapterCommandDecision,
} from "./codex-adapter-contract.js";
import {
  canonicalizeCodexInteractionResponse,
  encodeCanonicalCodexInteractionResponse,
} from "./codex-interaction-definition.js";
import {
  CODEX_PROVIDER_DEFINITION_VERSION,
  CODEX_PROVIDER_ID,
  codexProviderDefinition,
} from "./codex-provider-definition.js";
import { canonicalizeWorkspaceRelativePath, projectCodexCommandDisplay } from "./codex-interaction-codec.js";
import type { CodexServerRequestIdentity } from "./protocol-session.js";
import { CodexTransportError } from "./transport-error.js";

export type CodexInteractionFileChange = Readonly<{
  path: string;
  kind: "add" | "update" | "delete" | "move";
}>;

export type CodexInteractionAdmission = Readonly<{
  event?: Readonly<{
    kind: "interaction_pending";
    handle: CodexAdapterInteractionHandle;
    owner: CodexAdapterInteractionOwner;
    snapshot: CodexAdapterInteractionSnapshot;
  }>;
  failClosed: boolean;
  interrupt: boolean;
  resourceLimit: boolean;
  protocolFailure: boolean;
}>;

export type CodexInteractionResolution =
  | Readonly<{
      kind: "resolved";
      event: Readonly<{
        kind: "interaction_resolved";
        handle: CodexAdapterInteractionHandle;
        owner: CodexAdapterInteractionOwner;
      }>;
    }>
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "invalid" }>;

type AnswerEncoder = (response: CodexAdapterInteractionResponse) => unknown;

type ServerRequestCapability = Readonly<{
  identity: CodexServerRequestIdentity;
  respond: (result: unknown) => Promise<void>;
}>;

type PendingInteraction = {
  readonly handle: CodexAdapterInteractionHandle;
  readonly owner: CodexAdapterInteractionOwner;
  readonly request: ServerRequestCapability;
  readonly kind: CodexAdapterInteractionKind;
  readonly encoder: AnswerEncoder;
  snapshot: CodexAdapterInteractionSnapshot | undefined;
  projectionBytes: number;
  state: "pending" | "reserved" | "write_started" | "released";
  providerResolved: boolean;
  terminalObserved: boolean;
  reservedWire: unknown;
  reservation: CodexAdapterInteractionResponseReservation | undefined;
};

type InteractionTombstone = {
  handle: CodexAdapterInteractionHandle;
  owner: CodexAdapterInteractionOwner;
  identity: CodexServerRequestIdentity;
  providerResolved: boolean;
};

type ReservationRecord = Readonly<{ state: "reserved"; pending: PendingInteraction }> | Readonly<{ state: "used" }>;

type ProjectedInteraction = Readonly<{
  kind: CodexAdapterInteractionKind;
  display: CodexAdapterInteractionSnapshot["display"];
  answerable: boolean;
  unavailableReason?: CodexAdapterInteractionUnavailableDisplay["unavailableReason"];
  encoder: AnswerEncoder;
}>;

type FileChangeObservation = Readonly<{
  owner: Readonly<{ threadId: string; turnId: string; itemId: string }>;
  changes: readonly CodexInteractionFileChange[];
  changeCount: number;
  utf8Bytes: number;
}>;

const INTERACTION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/u;
const USED_RESERVATION = Object.freeze({ state: "used" as const });

export class CodexAdapterInteractionManager {
  readonly #generation = randomUUID();
  readonly #pending = new Map<CodexAdapterInteractionHandle, PendingInteraction>();
  readonly #pendingByIdentity = new Map<CodexServerRequestIdentity, PendingInteraction>();
  readonly #tombstones = new Map<CodexAdapterInteractionHandle, InteractionTombstone>();
  readonly #tombstonesByIdentity = new Map<CodexServerRequestIdentity, InteractionTombstone>();
  readonly #reservations = new WeakMap<object, ReservationRecord>();
  readonly #fileChanges = new Map<string, FileChangeObservation>();
  readonly #failedFileChanges = new Set<string>();
  readonly #mcpToolResolvedTurns = new Set<string>();
  #projectionBytes = 0;
  #fileChangeCount = 0;
  #fileChangeBytes = 0;
  #closed = false;

  get generation(): string {
    return this.#generation;
  }

  observeFileChanges(
    threadId: string,
    turnId: string,
    itemId: string,
    changes: readonly CodexInteractionFileChange[],
  ): Readonly<{ kind: "observed" | "resource_limit" }> {
    if (this.#closed) return Object.freeze({ kind: "resource_limit" });
    const key = ownerItemKey(threadId, turnId, itemId);
    const previous = this.#fileChanges.get(key);
    let snapshot: readonly CodexInteractionFileChange[] | undefined;
    let utf8Bytes = 0;
    try {
      if (
        identifier(threadId) === undefined ||
        identifier(turnId) === undefined ||
        identifier(itemId) === undefined ||
        changes.length === 0 ||
        changes.length > CODEX_ADAPTER_LIMITS.maxInteractionFileChanges
      ) {
        throw new RangeError("invalid file observation");
      }
      snapshot = Object.freeze(
        changes.map((change) => {
          if (
            typeof change.path !== "string" ||
            hasUnpairedSurrogate(change.path) ||
            !["add", "update", "delete", "move"].includes(change.kind)
          ) {
            throw new TypeError("invalid file observation");
          }
          utf8Bytes += Buffer.byteLength(change.path, "utf8");
          return Object.freeze({ path: change.path, kind: change.kind });
        }),
      );
      const nextObservationCount = this.#fileChanges.size + (previous === undefined ? 1 : 0);
      const nextChangeCount = this.#fileChangeCount - (previous?.changeCount ?? 0) + snapshot.length;
      const nextBytes = this.#fileChangeBytes - (previous?.utf8Bytes ?? 0) + utf8Bytes;
      if (
        nextObservationCount > CODEX_ADAPTER_LIMITS.maxInteractionFileObservations ||
        nextChangeCount > CODEX_ADAPTER_LIMITS.maxInteractionObservedFileChanges ||
        nextBytes > CODEX_ADAPTER_LIMITS.maxInteractionObservedFileChangeBytes
      ) {
        throw new RangeError("file observation resource limit");
      }
      this.#fileChanges.set(
        key,
        Object.freeze({
          owner: Object.freeze({ threadId, turnId, itemId }),
          changes: snapshot,
          changeCount: snapshot.length,
          utf8Bytes,
        }),
      );
      this.#fileChangeCount = nextChangeCount;
      this.#fileChangeBytes = nextBytes;
      this.#failedFileChanges.delete(key);
      return Object.freeze({ kind: "observed" });
    } catch {
      this.#deleteFileObservation(key);
      if (this.#failedFileChanges.size < CODEX_ADAPTER_LIMITS.maxInteractionFileObservations) {
        this.#failedFileChanges.add(key);
      }
      return Object.freeze({ kind: "resource_limit" });
    }
  }

  admit(
    request: CodexAdapterServerRequestPort,
    workspacePath: string | undefined,
    isActiveTurn: (threadId: string, turnId: string) => boolean,
  ): CodexInteractionAdmission {
    if (this.#closed) return noAdmission(true, false, false, false);
    if (this.#pendingByIdentity.has(request.identity) || this.#tombstonesByIdentity.has(request.identity)) {
      return noAdmission(true, false, false, true);
    }
    const canonicalization = codexProviderDefinition.canonicalizeInteractionRequest(
      request.method,
      request.params,
      workspacePath === undefined ? undefined : { workspacePath },
    );
    if (canonicalization.kind === "protocol-invalid") return noAdmission(true, false, false, true);
    const canonical = canonicalization.request;
    const owner = decodeOwner(canonical.params, canonical.method, this.#generation);
    if (owner === undefined || !isActiveTurn(owner.threadId, owner.turnId)) {
      return noAdmission(true, canonical.interactionKind === "codex.user_input", false, false);
    }
    const projected =
      canonicalization.kind === "unavailable"
        ? unavailableProjection(
            canonical.interactionKind as CodexAdapterInteractionKind,
            canonical.interactionKind === "codex.user_input" && canonicalUserInputIsSecret(canonical.params)
              ? "secret_input"
              : canonicalization.reason,
          )
        : this.#project(canonical.method, canonical.params, owner, workspacePath);
    if (projected === undefined) return noAdmission(true, false, false, true);
    if (this.#pending.size >= CODEX_ADAPTER_LIMITS.maxPendingInteractions || this.#pendingHasSameRequest(request)) {
      return noAdmission(true, projected.kind === "codex.user_input", true, false);
    }

    const interactionId = this.#newInteractionId();
    const handle = Object.freeze(Object.create(null)) as CodexAdapterInteractionHandle;
    const earlyMcpForm =
      projected.kind === "codex.mcp_server_form" && !this.#mcpToolResolvedTurns.has(ownerTurnKey(owner));
    const answerable = projected.answerable && !earlyMcpForm;
    const candidateSnapshot = Object.freeze({
      interactionId,
      providerId: CODEX_PROVIDER_ID,
      definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
      kind: projected.kind,
      answerable,
      display: answerable
        ? projected.display
        : Object.freeze({
            summary: unavailableSummary(projected.kind),
            unavailableReason: earlyMcpForm
              ? "unsupported_shape"
              : (projected.unavailableReason ?? "unsafe_projection"),
          }),
    });
    let snapshot: CodexAdapterInteractionSnapshot;
    try {
      snapshot = codexProviderDefinition.canonicalizeInteractionSnapshot(
        candidateSnapshot,
      ) as CodexAdapterInteractionSnapshot;
    } catch {
      snapshot = codexProviderDefinition.canonicalizeInteractionSnapshot({
        interactionId,
        providerId: CODEX_PROVIDER_ID,
        definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
        kind: projected.kind,
        answerable: false,
        display: {
          summary: unavailableSummary(projected.kind),
          unavailableReason: "unsafe_projection",
        },
      }) as CodexAdapterInteractionSnapshot;
    }
    const projectionBytes = applicationRunInteractionWireItemBytes(snapshot);
    if (
      applicationRunInteractionCollectionWireBytes(this.#projectionBytes + projectionBytes, this.#pending.size + 1) >
      CODEX_ADAPTER_LIMITS.maxInteractionProjectionBytes
    ) {
      return noAdmission(true, projected.kind === "codex.user_input", true, false);
    }
    const pending: PendingInteraction = {
      handle,
      owner,
      request: responseCapability(request),
      kind: projected.kind,
      encoder: projected.encoder,
      snapshot,
      projectionBytes,
      state: "pending",
      providerResolved: false,
      terminalObserved: false,
      reservedWire: undefined,
      reservation: undefined,
    };
    this.#pending.set(handle, pending);
    this.#pendingByIdentity.set(request.identity, pending);
    this.#projectionBytes += projectionBytes;
    return Object.freeze({
      event: Object.freeze({ kind: "interaction_pending", handle, owner, snapshot }),
      failClosed: !answerable,
      interrupt: earlyMcpForm || (!answerable && projected.kind === "codex.user_input"),
      resourceLimit: false,
      protocolFailure: false,
    });
  }

  async failClosed(handle: CodexAdapterInteractionHandle): Promise<void> {
    const pending = this.#pending.get(handle);
    if (pending === undefined || pending.state !== "pending") return;
    const wire = declineWireResponse(pending.kind);
    pending.state = "write_started";
    this.#releaseSnapshot(pending);
    if (wire === undefined) return;
    await pending.request.respond(wire);
  }

  async failClosedRequest(request: CodexAdapterServerRequestPort): Promise<void> {
    const kind = kindForMethod(request.method, request.params);
    const wire = kind === undefined ? undefined : declineWireResponse(kind);
    if (wire === undefined) return;
    await request.respond(wire);
  }

  async respond(
    handle: CodexAdapterInteractionHandle,
    response: unknown,
  ): Promise<CodexAdapterInteractionResponseResult> {
    if (this.#closed) return notSent("closed");
    const pending = this.#pending.get(handle);
    if (pending === undefined) {
      const tombstone = this.#tombstones.get(handle);
      return tombstone === undefined
        ? notSent("unknown_handle")
        : notSent(tombstone.providerResolved ? "resolved" : "closed");
    }
    if (pending.providerResolved) return notSent("resolved");
    if (pending.state !== "pending") return notSent("already_used");
    const snapshot = pending.snapshot;
    if (snapshot === undefined || !snapshot.answerable) return notSent("already_used");
    try {
      canonicalizeCodexInteractionResponse(snapshot, response);
    } catch {
      return notSent("invalid_input");
    }
    const reserved = this.reserve(handle, response);
    return reserved.kind === "reserved" ? this.writeReserved(reserved.reservation) : notSent("write_rejected");
  }

  reserve(handle: CodexAdapterInteractionHandle, response: unknown): CodexAdapterInteractionResponseReserveResult {
    if (this.#closed) return notReserved("write_rejected");
    const pending = this.#pending.get(handle);
    if (pending === undefined || pending.state !== "pending" || pending.providerResolved) {
      return notReserved("write_rejected");
    }
    const snapshot = pending.snapshot;
    if (snapshot === undefined || !snapshot.answerable) return notReserved("write_rejected");
    let canonical: CodexAdapterInteractionResponse;
    try {
      canonical = canonicalizeCodexInteractionResponse(snapshot, response).response;
      pending.reservedWire = pending.encoder(canonical);
    } catch {
      return notReserved("write_rejected");
    }
    pending.state = "reserved";
    this.#releaseSnapshot(pending);
    const token = Object.freeze(Object.create(null)) as object;
    const reservation = Object.freeze({ token });
    pending.reservation = reservation;
    this.#reservations.set(reservation, Object.freeze({ state: "reserved", pending }));
    return Object.freeze({ kind: "reserved", reservation });
  }

  writeReserved(
    reservation: CodexAdapterInteractionResponseReservation,
  ): Promise<CodexAdapterInteractionResponseResult> {
    if (this.#closed) return Promise.resolve(notSent("closed"));
    const record = this.#reservations.get(reservation);
    if (record === undefined) return Promise.resolve(notSent("unknown_handle"));
    if (record.state === "used") return Promise.resolve(notSent("already_used"));
    const pending = record.pending;
    if (pending.state !== "reserved") return Promise.resolve(notSent("already_used"));
    pending.state = "write_started";
    const wire = pending.reservedWire;
    pending.reservedWire = undefined;
    pending.reservation = undefined;
    this.#reservations.set(reservation, USED_RESERVATION);
    const write = pending.request.respond(wire);
    if (pending.providerResolved || pending.terminalObserved) this.#retire(pending, pending.providerResolved);
    return Promise.resolve(write).then(
      () =>
        Object.freeze({
          kind: "write_attempted",
          effect: "unknown",
          providerResolution: pending.providerResolved ? "resolved" : "pending",
        }),
      (error: unknown) => {
        const failure = snapshotTransportFailure(error);
        if (failure === "write_rejected") return notSent("write_rejected");
        if (failure === "closed") return notSent("closed");
        return Object.freeze({
          kind: "ambiguous",
          effect: "unknown",
          code: failure ?? "write_failed",
          providerResolution: pending.providerResolved ? "resolved" : "pending",
        });
      },
    );
  }

  releaseReservation(reservation: CodexAdapterInteractionResponseReservation): void {
    const record = this.#reservations.get(reservation);
    if (record === undefined || record.state !== "reserved" || record.pending.state !== "reserved") return;
    const pending = record.pending;
    pending.state = "released";
    pending.reservedWire = undefined;
    pending.reservation = undefined;
    this.#reservations.set(reservation, USED_RESERVATION);
    this.#retire(pending, pending.providerResolved);
  }

  resolve(identity: CodexServerRequestIdentity, threadId: string): CodexInteractionResolution {
    if (this.#closed) return Object.freeze({ kind: "invalid" });
    const pending = this.#pendingByIdentity.get(identity);
    if (pending !== undefined) {
      if (pending.owner.threadId !== threadId || pending.providerResolved) return Object.freeze({ kind: "invalid" });
      pending.providerResolved = true;
      if (pending.kind === "codex.mcp_tool_approval") this.#mcpToolResolvedTurns.add(ownerTurnKey(pending.owner));
      if (pending.state !== "reserved") this.#retire(pending, true);
      return Object.freeze({
        kind: "resolved",
        event: Object.freeze({ kind: "interaction_resolved", handle: pending.handle, owner: pending.owner }),
      });
    }
    const tombstone = this.#tombstonesByIdentity.get(identity);
    if (tombstone === undefined || tombstone.owner.threadId !== threadId || tombstone.providerResolved) {
      return Object.freeze({ kind: "invalid" });
    }
    tombstone.providerResolved = true;
    return Object.freeze({
      kind: "resolved",
      event: Object.freeze({ kind: "interaction_resolved", handle: tombstone.handle, owner: tombstone.owner }),
    });
  }

  completeTurn(threadId: string, turnId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.owner.threadId === threadId && pending.owner.turnId === turnId) {
        pending.terminalObserved = true;
        if (pending.state !== "reserved") this.#retire(pending, pending.providerResolved);
      }
    }
    for (const [key, observation] of this.#fileChanges) {
      if (observation.owner.threadId === threadId && observation.owner.turnId === turnId)
        this.#deleteFileObservation(key);
    }
    for (const key of this.#failedFileChanges)
      if (key.startsWith(`${threadId.length}:${threadId}${turnId.length}:${turnId}`))
        this.#failedFileChanges.delete(key);
    this.#mcpToolResolvedTurns.delete(ownerTurnKey({ threadId, turnId }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#pending.values()]) {
      pending.terminalObserved = true;
      if (pending.state === "reserved") {
        const reservation = pending.reservation;
        if (reservation !== undefined) this.#reservations.delete(reservation);
        pending.state = "released";
      }
      this.#forget(pending);
    }
    this.#tombstones.clear();
    this.#tombstonesByIdentity.clear();
    this.#fileChanges.clear();
    this.#failedFileChanges.clear();
    this.#fileChangeCount = 0;
    this.#fileChangeBytes = 0;
    this.#mcpToolResolvedTurns.clear();
  }

  #project(
    method: string,
    params: Readonly<Record<string, unknown>>,
    owner: CodexAdapterInteractionOwner,
    workspacePath: string | undefined,
  ): ProjectedInteraction | undefined {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return projectCommand(params, workspacePath);
      case "item/fileChange/requestApproval": {
        const key = ownerItemKey(owner.threadId, owner.turnId, owner.itemId as string);
        const observation = this.#fileChanges.get(key);
        const failed = this.#failedFileChanges.delete(key);
        this.#deleteFileObservation(key);
        return failed
          ? unavailableProjection("codex.file_change_approval", "resource_limit")
          : projectFileChange(params, owner, observation);
      }
      case "item/permissions/requestApproval":
        return projectPermission(params, workspacePath);
      case "item/tool/requestUserInput":
        return projectUserInput(params);
      case "mcpServer/elicitation/request":
        return projectMcp(params);
      default:
        return undefined;
    }
  }

  #newInteractionId(): string {
    for (;;) {
      const candidate = randomUUID();
      if (
        candidate.length <= CODEX_ADAPTER_LIMITS.maxInteractionIdCharacters &&
        INTERACTION_ID_PATTERN.test(candidate) &&
        ![...this.#pending.values()].some((entry) => entry.snapshot?.interactionId === candidate)
      ) {
        return candidate;
      }
    }
  }

  #pendingHasSameRequest(request: CodexAdapterServerRequestPort): boolean {
    return this.#pendingByIdentity.has(request.identity);
  }

  #releaseSnapshot(pending: PendingInteraction): void {
    if (pending.snapshot === undefined) return;
    this.#projectionBytes -= pending.projectionBytes;
    pending.snapshot = undefined;
    pending.projectionBytes = 0;
  }

  #rememberTombstone(pending: PendingInteraction, providerResolved: boolean): void {
    const tombstone = {
      handle: pending.handle,
      owner: pending.owner,
      identity: pending.request.identity,
      providerResolved,
    };
    this.#tombstones.set(pending.handle, tombstone);
    this.#tombstonesByIdentity.set(tombstone.identity, tombstone);
    while (this.#tombstones.size > CODEX_ADAPTER_LIMITS.maxInteractionTombstones) {
      const oldest = this.#tombstones.keys().next().value as CodexAdapterInteractionHandle | undefined;
      if (oldest === undefined) break;
      const removed = this.#tombstones.get(oldest);
      this.#tombstones.delete(oldest);
      if (removed !== undefined) this.#tombstonesByIdentity.delete(removed.identity);
    }
  }

  #forget(pending: PendingInteraction): void {
    this.#pending.delete(pending.handle);
    this.#pendingByIdentity.delete(pending.request.identity);
    this.#releaseSnapshot(pending);
    pending.reservedWire = undefined;
    pending.reservation = undefined;
  }

  #retire(pending: PendingInteraction, providerResolved: boolean): void {
    this.#forget(pending);
    this.#rememberTombstone(pending, providerResolved);
  }

  #deleteFileObservation(key: string): void {
    const previous = this.#fileChanges.get(key);
    if (previous === undefined) return;
    this.#fileChanges.delete(key);
    this.#fileChangeCount -= previous.changeCount;
    this.#fileChangeBytes -= previous.utf8Bytes;
  }
}

function responseCapability(request: CodexAdapterServerRequestPort): ServerRequestCapability {
  return Object.freeze({
    identity: request.identity,
    respond: (result: unknown) => request.respond(result),
  });
}

function projectCommand(
  params: Readonly<Record<string, unknown>>,
  workspacePath: string | undefined,
): ProjectedInteraction {
  const command = codePointString(params.command, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints);
  const displayCommand = projectCodexCommandDisplay(command, workspacePath);
  const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
  const availableDecisions = commandApprovalDecisions(params.availableDecisions);
  const answerable =
    command !== undefined &&
    displayCommand !== undefined &&
    workspacePath !== undefined &&
    samePath(cwd, workspacePath) &&
    availableDecisions !== undefined &&
    commandApprovalSupportsPlainDecision(params, command);
  return Object.freeze({
    kind: "codex.command_approval",
    answerable,
    display: answerable
      ? Object.freeze({
          summary: "Codex requests permission to run a command.",
          command: displayCommand,
          availableDecisions,
        })
      : unavailableDisplay("codex.command_approval"),
    encoder: encodeCanonicalCodexInteractionResponse,
  });
}

function commandApprovalDecisions(value: unknown): readonly CodexAdapterCommandDecision[] | undefined {
  const entries = denseArray(value, CODEX_ADAPTER_COMMAND_DECISIONS.length);
  if (entries === undefined || entries.length === 0) return undefined;
  const unique = new Set<CodexAdapterCommandDecision>();
  const decisions: CodexAdapterCommandDecision[] = [];
  for (const entry of entries) {
    if (!isCodexAdapterCommandDecision(entry) || unique.has(entry)) return undefined;
    unique.add(entry);
    decisions.push(entry);
  }
  return Object.freeze(decisions);
}

function projectFileChange(
  params: Readonly<Record<string, unknown>>,
  owner: CodexAdapterInteractionOwner,
  observation: FileChangeObservation | undefined,
): ProjectedInteraction {
  const changes =
    observation !== undefined && observation.owner.itemId === owner.itemId
      ? projectFileChanges(observation.changes)
      : undefined;
  const answerable = changes !== undefined && isNullish(params.grantRoot);
  return Object.freeze({
    kind: "codex.file_change_approval",
    answerable,
    display: !answerable
      ? unavailableDisplay("codex.file_change_approval")
      : Object.freeze({ summary: "Codex requests permission to apply file changes.", changes }),
    encoder: encodeCanonicalCodexInteractionResponse,
  });
}

function commandApprovalSupportsPlainDecision(
  params: Readonly<Record<string, unknown>>,
  displayedCommand: string,
): boolean {
  if (!isNullish(params.networkApprovalContext) || !isNullish(params.proposedNetworkPolicyAmendments)) return false;
  if (!boundedExecpolicyAmendment(params.proposedExecpolicyAmendment)) return false;
  if (isNullish(params.commandActions)) return true;
  const actions = denseArray(params.commandActions, 1);
  if (actions?.length !== 1) return false;
  const action = inspectRecord(actions[0], 4);
  const actionCommand = codePointString(action?.command, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints);
  return actionCommand !== undefined && action?.type === "unknown" && actionCommand === displayedCommand;
}

function boundedExecpolicyAmendment(value: unknown): boolean {
  if (isNullish(value)) return true;
  const entries = denseArray(value, 16);
  return (
    entries !== undefined &&
    entries.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256)
  );
}

function isNullish(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function projectPermission(
  params: Readonly<Record<string, unknown>>,
  workspacePath: string | undefined,
): ProjectedInteraction {
  const decoded = decodePermissions(params.permissions, workspacePath);
  return Object.freeze({
    kind: "codex.permission_approval",
    answerable: decoded !== undefined,
    display:
      decoded === undefined
        ? unavailableDisplay("codex.permission_approval")
        : Object.freeze({
            summary: "Codex requests additional permissions for this Turn.",
            permissions: decoded.publicPermissions,
          }),
    encoder: (response) => encodeCanonicalCodexInteractionResponse(response, decoded?.wirePermissions),
  });
}

function projectUserInput(params: Readonly<Record<string, unknown>>): ProjectedInteraction {
  const questions = decodeQuestions(params.questions);
  const secretInput = hasSecretQuestion(params.questions);
  return Object.freeze({
    kind: "codex.user_input",
    answerable: questions !== undefined,
    ...(secretInput ? { unavailableReason: "secret_input" as const } : {}),
    display: questions === undefined ? unavailableDisplay("codex.user_input") : Object.freeze({ questions }),
    encoder: encodeCanonicalCodexInteractionResponse,
  });
}

function hasSecretQuestion(value: unknown): boolean {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxInteractionQuestions);
  if (entries === undefined) return false;
  return entries.some((entry) => inspectRecord(entry, 6)?.isSecret === true);
}

function projectMcp(params: Readonly<Record<string, unknown>>): ProjectedInteraction | undefined {
  const meta = mcpMeta(params);
  const discriminator = meta?.codex_approval_kind;
  if (discriminator === "mcp_tool_call") return projectMcpTool(params, meta as Readonly<Record<string, unknown>>);
  if (discriminator !== undefined || params.mode !== "form") return undefined;
  return projectMcpForm(params);
}

function projectMcpTool(
  params: Readonly<Record<string, unknown>>,
  meta: Readonly<Record<string, unknown>>,
): ProjectedInteraction {
  const server = codePointString(params.serverName, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
  const toolName = codePointString(meta.tool_name, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
  const description = codePointString(meta.tool_description, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints);
  const tool = toolName ?? description;
  const requestedSchema = inspectRecord(params.requestedSchema, 4);
  const properties = requestedSchema === undefined ? undefined : inspectRecord(requestedSchema.properties, 0);
  const toolParams = meta.tool_params === undefined ? Object.freeze({}) : inspectRecord(meta.tool_params, 0);
  const answerable =
    server !== undefined &&
    tool !== undefined &&
    params.mode === "form" &&
    requestedSchema?.type === "object" &&
    properties !== undefined &&
    Object.keys(properties).length === 0 &&
    (requestedSchema.required === undefined || isEmptyDenseArray(requestedSchema.required)) &&
    toolParams !== undefined &&
    Object.keys(toolParams).length === 0;
  return Object.freeze({
    kind: "codex.mcp_tool_approval",
    answerable,
    display: answerable
      ? Object.freeze({ server, tool, summary: description ?? `Allow ${tool} on ${server}?` })
      : unavailableDisplay("codex.mcp_tool_approval"),
    encoder: encodeCanonicalCodexInteractionResponse,
  });
}

function projectMcpForm(params: Readonly<Record<string, unknown>>): ProjectedInteraction {
  const server = codePointString(params.serverName, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
  const message = codePointString(params.message, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints);
  const fields = decodeMcpFields(params.requestedSchema);
  const answerable = server !== undefined && message !== undefined && fields !== undefined;
  return Object.freeze({
    kind: "codex.mcp_server_form",
    answerable,
    display: answerable ? Object.freeze({ server, message, fields }) : unavailableDisplay("codex.mcp_server_form"),
    encoder: encodeCanonicalCodexInteractionResponse,
  });
}

function decodeOwner(
  params: Readonly<Record<string, unknown>>,
  method: string,
  generation: string,
): CodexAdapterInteractionOwner | undefined {
  const threadId = codePointString(params.threadId, 1, CODEX_ADAPTER_LIMITS.maxIdentifierCharacters);
  const turnId = codePointString(params.turnId, 1, CODEX_ADAPTER_LIMITS.maxIdentifierCharacters);
  if (threadId === undefined || turnId === undefined) return undefined;
  if (method === "mcpServer/elicitation/request") {
    if (params.itemId !== undefined && params.itemId !== null) return undefined;
    return Object.freeze({ connectionGeneration: generation, threadId, turnId });
  }
  const itemId = codePointString(params.itemId, 1, CODEX_ADAPTER_LIMITS.maxIdentifierCharacters);
  return itemId === undefined
    ? undefined
    : Object.freeze({ connectionGeneration: generation, threadId, turnId, itemId });
}

function decodeQuestions(value: unknown):
  | readonly Readonly<{
      questionId: string;
      header: string;
      prompt: string;
      allowOther: boolean;
      options: readonly Readonly<{ label: string; description?: string }>[];
    }>[]
  | undefined {
  const entries = denseArray(value, CODEX_ADAPTER_LIMITS.maxInteractionQuestions);
  if (entries === undefined || entries.length === 0) return undefined;
  const ids = new Set<string>();
  const output = [];
  for (const entry of entries) {
    const record = inspectRecord(entry, 6);
    if (record === undefined || !hasOnlyKeys(record, ["id", "header", "question", "isSecret", "isOther", "options"]))
      return undefined;
    const questionId = identifier(record.id);
    const header = codePointString(record.header, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
    const prompt = codePointString(record.question, 1, CODEX_ADAPTER_LIMITS.maxInteractionBodyCodePoints);
    const optionsRaw = denseArray(record.options, CODEX_ADAPTER_LIMITS.maxInteractionOptionsPerQuestion);
    if (
      questionId === undefined ||
      ids.has(questionId) ||
      header === undefined ||
      prompt === undefined ||
      record.isSecret === true ||
      (record.isSecret !== undefined && record.isSecret !== false) ||
      typeof record.isOther !== "boolean" ||
      optionsRaw === undefined ||
      optionsRaw.length < 2
    )
      return undefined;
    ids.add(questionId);
    const labels = new Set<string>();
    const options = [];
    for (const option of optionsRaw) {
      const optionRecord = inspectRecord(option, 2);
      if (optionRecord === undefined || !hasOnlyKeys(optionRecord, ["label", "description"])) return undefined;
      const label = codePointString(optionRecord.label, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
      const description =
        optionRecord.description === undefined
          ? undefined
          : codePointString(optionRecord.description, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
      if (
        label === undefined ||
        labels.has(label) ||
        (optionRecord.description !== undefined && description === undefined)
      )
        return undefined;
      labels.add(label);
      options.push(Object.freeze({ label, ...(description === undefined ? {} : { description }) }));
    }
    output.push(
      Object.freeze({ questionId, header, prompt, allowOther: record.isOther, options: Object.freeze(options) }),
    );
  }
  return Object.freeze(output);
}

function decodeMcpFields(value: unknown):
  | readonly Readonly<{
      fieldId: string;
      label: string;
      inputType: "string";
      required: boolean;
      maxLength: number;
    }>[]
  | undefined {
  const schema = inspectRecord(value, 5);
  if (schema === undefined || !hasOnlyKeys(schema, ["type", "properties", "required", "additionalProperties"]))
    return undefined;
  if (schema.type !== "object" || (schema.additionalProperties !== undefined && schema.additionalProperties !== false))
    return undefined;
  const properties = inspectRecord(schema.properties, CODEX_ADAPTER_LIMITS.maxInteractionFormFields);
  const requiredEntries =
    schema.required === undefined ? [] : denseArray(schema.required, CODEX_ADAPTER_LIMITS.maxInteractionFormFields);
  if (properties === undefined || requiredEntries === undefined || Object.keys(properties).length === 0)
    return undefined;
  const required = new Set<string>();
  for (const entry of requiredEntries) {
    const id = identifier(entry);
    if (id === undefined || required.has(id)) return undefined;
    required.add(id);
  }
  const output = [];
  for (const [fieldIdRaw, fieldValue] of Object.entries(properties)) {
    const fieldId = identifier(fieldIdRaw);
    const field = inspectRecord(fieldValue, 3);
    if (fieldId === undefined || field === undefined || !hasOnlyKeys(field, ["type", "title", "maxLength"]))
      return undefined;
    const label = codePointString(field.title ?? fieldId, 1, CODEX_ADAPTER_LIMITS.maxInteractionSummaryCodePoints);
    const maxLength =
      field.maxLength === undefined ? CODEX_ADAPTER_LIMITS.maxInteractionFormValueCodePoints : field.maxLength;
    if (
      field.type !== "string" ||
      label === undefined ||
      !Number.isSafeInteger(maxLength) ||
      (maxLength as number) < 1 ||
      (maxLength as number) > CODEX_ADAPTER_LIMITS.maxInteractionFormValueCodePoints
    )
      return undefined;
    output.push(
      Object.freeze({
        fieldId,
        label,
        inputType: "string" as const,
        required: required.has(fieldId),
        maxLength: maxLength as number,
      }),
    );
  }
  if ([...required].some((fieldId) => !Object.hasOwn(properties, fieldId))) return undefined;
  return Object.freeze(output);
}

function decodePermissions(
  value: unknown,
  workspacePath: string | undefined,
): Readonly<{ publicPermissions: readonly CodexAdapterPermissionCategory[]; wirePermissions: unknown }> | undefined {
  if (workspacePath === undefined) return undefined;
  const permissions = inspectRecord(value, 2);
  if (permissions === undefined || !hasOnlyKeys(permissions, ["fileSystem", "network"])) return undefined;
  const publicPermissions: CodexAdapterPermissionCategory[] = [];
  if (permissions.fileSystem !== undefined && permissions.fileSystem !== null) {
    const fileSystem = inspectRecord(permissions.fileSystem, 4);
    if (fileSystem === undefined || !hasOnlyKeys(fileSystem, ["entries", "write", "read", "globScanMaxDepth"]))
      return undefined;
    if (fileSystem.globScanMaxDepth !== undefined && fileSystem.globScanMaxDepth !== null) return undefined;
    const entries =
      fileSystem.entries === undefined || fileSystem.entries === null ? [] : denseArray(fileSystem.entries, 32);
    const legacyWrite =
      fileSystem.write === undefined || fileSystem.write === null ? [] : denseArray(fileSystem.write, 32);
    const legacyRead = fileSystem.read === undefined || fileSystem.read === null ? [] : denseArray(fileSystem.read, 32);
    if (entries === undefined || legacyWrite === undefined || legacyRead === undefined || legacyRead.length > 0)
      return undefined;
    const canonicalEntries = [];
    for (const entry of entries) {
      const entryRecord = inspectRecord(entry, 2);
      const pathRecord = entryRecord === undefined ? undefined : inspectRecord(entryRecord.path, 2);
      if (
        entryRecord === undefined ||
        !hasExactKeys(entryRecord, ["access", "path"]) ||
        entryRecord.access !== "write" ||
        pathRecord === undefined ||
        !hasExactKeys(pathRecord, ["type", "path"]) ||
        pathRecord.type !== "path" ||
        !samePath(typeof pathRecord.path === "string" ? pathRecord.path : undefined, workspacePath)
      )
        return undefined;
      canonicalEntries.push(
        Object.freeze({ access: "write", path: Object.freeze({ type: "path", path: workspacePath }) }),
      );
    }
    for (const candidate of legacyWrite)
      if (!samePath(typeof candidate === "string" ? candidate : undefined, workspacePath)) return undefined;
    if (canonicalEntries.length + legacyWrite.length === 0) return undefined;
    publicPermissions.push("workspace_write");
  }
  if (permissions.network !== undefined && permissions.network !== null) {
    const network = inspectRecord(permissions.network, 1);
    if (network === undefined || !hasExactKeys(network, ["enabled"]) || network.enabled !== true) return undefined;
    publicPermissions.push("network");
  }
  if (publicPermissions.length === 0) return undefined;
  return Object.freeze({ publicPermissions: Object.freeze(publicPermissions), wirePermissions: permissions });
}

function projectFileChanges(changes: readonly CodexInteractionFileChange[]):
  | readonly Readonly<{
      displayPath: string;
      changeKind: "add" | "update" | "delete" | "move";
    }>[]
  | undefined {
  if (changes.length === 0 || changes.length > CODEX_ADAPTER_LIMITS.maxInteractionFileChanges) return undefined;
  const output = [];
  for (const change of changes) {
    if (change.kind === "move") return undefined;
    const displayPath = safeWorkspaceRelativePath(change.path);
    if (displayPath === undefined) return undefined;
    output.push(Object.freeze({ displayPath, changeKind: change.kind }));
  }
  return Object.freeze(output);
}

function safeWorkspaceRelativePath(value: unknown): string | undefined {
  return canonicalizeWorkspaceRelativePath(value);
}

function mcpMeta(params: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  if (Object.hasOwn(params, "meta") && Object.hasOwn(params, "_meta")) return undefined;
  const value = Object.hasOwn(params, "meta") ? params.meta : params._meta;
  return inspectRecord(value, 16);
}

function declineWireResponse(kind: CodexAdapterInteractionKind): unknown | undefined {
  switch (kind) {
    case "codex.command_approval":
    case "codex.file_change_approval":
      return Object.freeze({ decision: "decline" });
    case "codex.permission_approval":
      return Object.freeze({ permissions: Object.freeze({}), scope: "turn", strictAutoReview: null });
    case "codex.mcp_tool_approval":
    case "codex.mcp_server_form":
      return Object.freeze({ action: "decline", content: null });
    case "codex.user_input":
      return undefined;
  }
}

function kindForMethod(method: string, params: unknown): CodexAdapterInteractionKind | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "codex.command_approval";
    case "item/fileChange/requestApproval":
      return "codex.file_change_approval";
    case "item/permissions/requestApproval":
      return "codex.permission_approval";
    case "item/tool/requestUserInput":
      return "codex.user_input";
    case "mcpServer/elicitation/request": {
      const record = inspectRecord(params, 32);
      const meta = record === undefined ? undefined : mcpMeta(record);
      return meta?.codex_approval_kind === "mcp_tool_call" ? "codex.mcp_tool_approval" : "codex.mcp_server_form";
    }
    default:
      return undefined;
  }
}

function unavailableDisplay(
  kind: CodexAdapterInteractionKind,
): Readonly<{ summary: string; unavailableReason: "unsafe_projection" }> {
  return Object.freeze({
    summary: unavailableSummary(kind),
    unavailableReason: "unsafe_projection",
  });
}

function unavailableProjection(
  kind: CodexAdapterInteractionKind,
  reason: "resource_limit" | "unsafe_projection" | "unsupported_shape" | "secret_input",
): ProjectedInteraction {
  return Object.freeze({
    kind,
    answerable: false,
    unavailableReason: reason,
    display: Object.freeze({ summary: unavailableSummary(kind), unavailableReason: reason }),
    encoder: encodeCanonicalCodexInteractionResponse,
  });
}

function canonicalUserInputIsSecret(params: Readonly<Record<string, unknown>>): boolean {
  return (
    Array.isArray(params.questions) &&
    params.questions.some(
      (question) =>
        typeof question === "object" &&
        question !== null &&
        !Array.isArray(question) &&
        (question as Readonly<Record<string, unknown>>).isSecret === true,
    )
  );
}

function unavailableSummary(kind: CodexAdapterInteractionKind): string {
  switch (kind) {
    case "codex.command_approval":
      return "A command approval request is unavailable.";
    case "codex.file_change_approval":
      return "A file change approval request is unavailable.";
    case "codex.permission_approval":
      return "A permission approval request is unavailable.";
    case "codex.user_input":
      return "A user input request is unavailable.";
    case "codex.mcp_tool_approval":
      return "An MCP tool approval request is unavailable.";
    case "codex.mcp_server_form":
      return "An MCP server form is unavailable.";
  }
}

function noAdmission(
  failClosed: boolean,
  interrupt: boolean,
  resourceLimit: boolean,
  protocolFailure: boolean,
): CodexInteractionAdmission {
  return Object.freeze({ failClosed, interrupt, resourceLimit, protocolFailure });
}

function notReserved(
  code: Extract<CodexAdapterInteractionResponseReserveResult, { kind: "not_reserved" }>["code"],
): CodexAdapterInteractionResponseReserveResult {
  return Object.freeze({ kind: "not_reserved", code });
}

function notSent(
  code: Extract<CodexAdapterInteractionResponseResult, { kind: "not_sent" }>["code"],
): CodexAdapterInteractionResponseResult {
  return Object.freeze({ kind: "not_sent", effect: "none", code });
}

function snapshotTransportFailure(
  error: unknown,
): "write_rejected" | "closed" | "timeout" | "aborted" | "connection_lost" | "write_failed" | undefined {
  try {
    if (!(error instanceof CodexTransportError)) return undefined;
    const failure = error.failure;
    if (failure.kind === "request_not_sent") {
      if (failure.code === "write_rejected") return "write_rejected";
      if (failure.code === "closing" || failure.code === "not_ready" || failure.code === "server_request_settled")
        return "closed";
      return undefined;
    }
    return failure.kind === "response_unknown" ? failure.code : undefined;
  } catch {
    return undefined;
  }
}

function ownerTurnKey(owner: Readonly<{ threadId: string; turnId: string }>): string {
  return `${owner.threadId.length}:${owner.threadId}${owner.turnId}`;
}

function ownerItemKey(threadId: string, turnId: string, itemId: string): string {
  return `${threadId.length}:${threadId}${turnId.length}:${turnId}${itemId}`;
}

function identifier(value: unknown): string | undefined {
  return codePointString(value, 1, 128)?.match(INTERACTION_ID_PATTERN)?.[0];
}

function codePointString(value: unknown, minimum: number, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const length = [...value].length;
  return length >= minimum && length <= maximum ? value : undefined;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined || !path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function inspectRecord(value: unknown, maximumKeys: number): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) return undefined;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      snapshot[key] = descriptor.value as unknown;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

function denseArray(value: unknown, maximumItems: number): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximumItems)
      return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key))))
      return undefined;
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      output.push(descriptor.value as unknown);
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
}

function isEmptyDenseArray(value: unknown): boolean {
  return denseArray(value, 0)?.length === 0;
}

function hasOnlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function hasExactKeys(record: Readonly<Record<string, unknown>>, required: readonly string[]): boolean {
  return Object.keys(record).length === required.length && required.every((key) => Object.hasOwn(record, key));
}
