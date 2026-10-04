import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { currentTimestampLabel } from "../../src-shared/time-state.js";
import { APPROVAL_MODE_VALUES, DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { getApprovalOptionsForProvider, getDefaultApprovalModeForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import type {
  AuxiliaryRuntimeSelectionMode,
  AuxiliarySession,
  AuxiliarySessionSummary,
  AuxiliaryCreationContext,
  AuxiliaryCreationRequestSnapshot,
  AuxiliaryCreationRequest,
  AuxiliaryCreationResult,
  AuxiliaryCreationStateChange,
  CreateAuxiliarySessionInput,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { resolveAuxiliaryPreview } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  CODEX_SANDBOX_MODE_VALUES,
  DEFAULT_CODEX_SANDBOX_MODE,
} from "../../src-shared/settings/codex-sandbox-mode.js";
import { CODEX_SPEED_VALUES, DEFAULT_CODEX_SPEED } from "../../src-shared/settings/codex-speed.js";
import { DEFAULT_CODEX_REVIEWER } from "../../src-shared/settings/codex-reviewer.js";
import {
  coerceModelSelection,
  getProviderCatalog,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { validateSessionExecutionOptions, type SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type {
  SetExecutionOptionsResult,
  SetAuxiliaryExecutionOptionsRequest,
  SetAuxiliaryTitleRequest,
  SetAuxiliaryMessageBookmarkRequest,
} from "../../src-shared/session/session-mutation-contract.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { selectWeightedRandomLaunchCharacterId } from "../../src-shared/character/launch-character-selection.js";
import type { Awaitable, AuxiliarySessionStorageAccess } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionLaunchSelection } from "../session/session-launch-selection-service.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";
import type { RunCharacterAffectTurnOwnershipExclusive } from "../character/character-affect-turn-ownership-coordinator.js";
import type { AuxiliarySessionThreadPatchInput, AuxiliaryThreadPatchResult, AuxiliaryRuntimeMetadataPatchResult } from "./auxiliary-session-storage.js";
import type { AuxiliarySessionRuntimeMetadataPatchInput } from "./auxiliary-session-storage.js";
import type { AuxiliaryDraftStorageSaveInput, AuxiliaryDraftStorageConsumeInput } from "./auxiliary-session-storage.js";
import { assertCharacterDefinitionSnapshotUpdate } from "../session/session-running-turn-start.js";
import type {
  AuxiliaryDraftConsumeResult,
  AuxiliaryDraftRecord,
  AuxiliaryDraftSaveInput,
  AuxiliaryDraftSaveResult,
  AuxiliarySessionStatus,
} from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

type AuxiliarySessionServiceDeps = {
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  resolveSessionLaunchSelection(providerId?: string | null): Promise<SessionLaunchSelection>;
  getParentSession(parentSessionId: string): Awaitable<Session | null>;
  getStorage(): AuxiliarySessionStorageAccess;
  getModelCatalogSnapshot?(): Awaitable<ModelCatalogSnapshot | null>;
  listActiveCharacters(): Awaitable<readonly CharacterCatalogEntry[]>;
  createCharacterRuntimeSnapshot(characterId: string): Awaitable<CharacterRuntimeSnapshot | null>;
  randomCharacter?: () => number;
  runCharacterAffectTurnOwnershipExclusive?: RunCharacterAffectTurnOwnershipExclusive;
  onCreationStateChanged?(result: AuxiliaryCreationStateChange): void;
  captureStorageIdentity?(): unknown;
  isStorageIdentityCurrent?(identity: unknown): boolean;
  isAuxiliaryRunInFlight?(auxiliarySessionId: string): boolean;
  canAcceptAuxiliaryInput?(auxiliarySessionId: string): boolean;
  rememberExecutionOptions?(session: AuxiliarySessionSummary, options: SessionExecutionOptions): void;
  overlayCurrentExecutionOptions?<T extends AuxiliarySessionSummary>(session: T): T;
};

type AuxiliaryCreationRecord = {
  request: AuxiliaryCreationRequest;
  input?: AuxiliaryCreationRequestSnapshot;
  status: AuxiliaryCreationResult["status"];
  cancelRequested: boolean;
  promise?: Promise<AuxiliarySession>;
  auxiliarySessionId?: string;
};

function normalizeCreationInput(input: CreateAuxiliarySessionInput): AuxiliaryCreationRequestSnapshot {
  const normalized: AuxiliaryCreationRequestSnapshot = {
    parentSessionId: input.parentSessionId.trim(),
    provider: input.provider.trim(),
    clientRequestId: input.clientRequestId?.trim() ?? "",
  };
  if (input.runtimeSelection !== undefined) normalized.runtimeSelection = input.runtimeSelection;
  if (input.model !== undefined) normalized.model = input.model.trim();
  if (input.reasoningEffort !== undefined) normalized.reasoningEffort = input.reasoningEffort;
  if (input.approvalMode !== undefined) normalized.approvalMode = input.approvalMode;
  if (input.codexSandboxMode !== undefined) normalized.codexSandboxMode = input.codexSandboxMode;
  if (input.codexSpeed !== undefined) normalized.codexSpeed = input.codexSpeed;
  if (input.customAgentName !== undefined) normalized.customAgentName = input.customAgentName.trim();
  return normalized;
}

function isCreationContext(value: unknown): value is AuxiliaryCreationContext {
  return typeof value === "object" && value !== null
    && typeof (value as AuxiliaryCreationContext).generationId === "string"
    && typeof (value as AuxiliaryCreationContext).parentIncarnationId === "string";
}

function buildInterruptedMessages(messages: AuxiliarySession["messages"]): AuxiliarySession["messages"] {
  const interruptedMessage = "The previous Auxiliary run may have been interrupted when the app quit. Send again if needed.";
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant" && lastMessage.text === interruptedMessage) {
    return messages;
  }

  return [
    ...messages,
    {
      role: "assistant",
      text: interruptedMessage,
      accent: true,
    },
  ];
}

function resolveInitialModelSelection(input: CreateAuxiliarySessionInput, providerCatalog: ModelCatalogProvider) {
  return coerceModelSelection(
    providerCatalog,
    input.model ?? providerCatalog.defaultModelId,
    input.reasoningEffort ?? providerCatalog.defaultReasoningEffort,
  );
}

function resolveInitialRuntimeOption<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  defaultValue: T,
  fieldName: string,
): T {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "string" && allowedValues.includes(value as T)) {
    return value as T;
  }

  throw new Error(`Could not parse the Auxiliary Session ${fieldName}.`);
}

function resolveRuntimeSelectionMode(value: unknown): AuxiliaryRuntimeSelectionMode {
  if (value === undefined || value === "explicit") {
    return "explicit";
  }
  if (value === "latest-session") {
    return value;
  }
  throw new Error("Could not parse the Auxiliary Session runtime selection.");
}

function assertLatestSessionRuntimeFieldsAbsent(input: CreateAuxiliarySessionInput): void {
  if (
    input.model !== undefined ||
    input.reasoningEffort !== undefined ||
    input.approvalMode !== undefined ||
    input.codexSandboxMode !== undefined ||
    input.codexSpeed !== undefined ||
    input.customAgentName !== undefined
  ) {
    throw new Error("Runtime options cannot be specified when using latest-session selection.");
  }
}

function resolveParentCharacterId(parent: Session): string {
  return parent.characterRuntimeSnapshot?.characterId || parent.characterId || "";
}

export class AuxiliarySessionService {
  private readonly creationRecords = new Map<string, AuxiliaryCreationRecord>();
  private readonly creationOwnerGenerations = new Map<string, string>();
  private readonly pendingDraftSends = new Set<Promise<void>>();
  private readonly failedDraftRestores = new Set<AuxiliaryDraftStorageSaveInput>();
  private creationStorage: AuxiliarySessionStorageAccess | null = null;
  private creationGenerationId = randomUUID();
  private readonly selectionCheckpoints = new Map<string, Promise<void>>();
  private readonly selectionRequestRevisions = new Map<string, number>();

  constructor(private readonly deps: AuxiliarySessionServiceDeps) {}

  private overlayExecutionOptions<T extends AuxiliarySessionSummary>(session: T): T {
    return this.deps.overlayCurrentExecutionOptions?.(session) ?? session;
  }

  private assertStorageIdentity(storage: AuxiliarySessionStorageAccess, identity: unknown): void {
    if (this.deps.getStorage() !== storage
      || (this.deps.isStorageIdentityCurrent && !this.deps.isStorageIdentityCurrent(identity))) {
      throw new Error("The Auxiliary Session storage changed.");
    }
  }

  async getAuxiliaryCreationContext(parentSessionId: string): Promise<AuxiliaryCreationContext> {
    const storage = this.deps.getStorage();
    this.syncCreationStorage(storage);
    const parent = await this.deps.getParentSession(parentSessionId);
    if (!parent) {
      throw new Error("The parent session could not be found.");
    }
    this.syncCreationStorage(this.deps.getStorage());
    return {
      generationId: this.getCreationOwnerGeneration(parentSessionId),
      parentIncarnationId: getSessionIncarnationId(parent),
    };
  }

  async getAuxiliaryCreation(request: AuxiliaryCreationRequest): Promise<AuxiliaryCreationResult> {
    const storage = this.deps.getStorage();
    this.syncCreationStorage(storage);
    const key = this.creationKey(request);
    const record = this.creationRecords.get(key);
    if (record && record.status !== "unknown") {
      return { status: record.status, auxiliarySessionId: record.auxiliarySessionId };
    }
    const existing = (await storage.listAuxiliarySessions(request.parentSessionId))
      .find((summary) => summary.clientRequestId === request.clientRequestId);
    if (record?.cancelRequested && !record.promise && (this.deps.getStorage() !== storage
      || record.status === "expired")) {
      this.syncCreationStorage(this.deps.getStorage());
      this.creationRecords.delete(key);
      return { status: "expired" };
    }
    if (record && record.status !== "unknown") {
      return { status: record.status, auxiliarySessionId: record.auxiliarySessionId };
    }
    if (existing) {
      if (record) {
        record.status = "committed";
        record.auxiliarySessionId = existing.id;
        if (record.cancelRequested && !record.promise && this.creationRecords.get(key) === record) {
          this.creationRecords.delete(key);
        }
        this.notifyCreationState(record, "committed", existing.id);
      }
      return { status: "committed", auxiliarySessionId: existing.id };
    }
    if (record?.status === "unknown" && record.cancelRequested && !record.promise) {
      record.status = "cancelled";
      this.retireCancelledCreation(record);
      this.notifyCreationState(record, "cancelled");
      return { status: "cancelled" };
    }
    if (record?.status === "unknown") {
      return { status: "unknown" };
    }
    return request.creationContext.generationId === this.getCreationOwnerGeneration(request.parentSessionId)
      ? { status: "not-found" }
      : { status: "expired" };
  }

  async cancelAuxiliaryCreation(request: AuxiliaryCreationRequest): Promise<AuxiliaryCreationResult> {
    const storage = this.deps.getStorage();
    this.syncCreationStorage(storage);
    const key = this.creationKey(request);
    const record = this.creationRecords.get(key);
    if (!record) {
      if (request.creationContext.generationId !== this.getCreationOwnerGeneration(request.parentSessionId)) {
        return this.getAuxiliaryCreation(request);
      }
      const tombstone: AuxiliaryCreationRecord = {
        request,
        status: "unknown",
        cancelRequested: true,
      };
      this.creationRecords.set(key, tombstone);
      let existing: AuxiliarySessionSummary | undefined;
      let lookupFailed = false;
      try {
        existing = (await storage.listAuxiliarySessions(request.parentSessionId))
          .find((summary) => summary.clientRequestId === request.clientRequestId);
      } catch {
        lookupFailed = true;
      }
      if (this.deps.getStorage() !== storage || tombstone.status === "expired") {
        this.syncCreationStorage(this.deps.getStorage());
        this.creationRecords.delete(key);
        return { status: "expired" };
      }
      if (tombstone.status !== "unknown") {
        if (tombstone.status === "committed" && this.creationRecords.get(key) === tombstone) {
          this.creationRecords.delete(key);
        }
        return { status: tombstone.status, auxiliarySessionId: tombstone.auxiliarySessionId };
      }
      if (this.creationRecords.get(key) !== tombstone) return { status: "expired" };
      if (lookupFailed) {
        this.notifyCreationState(tombstone, "unknown");
        return { status: "unknown" };
      }
      if (existing) {
        tombstone.status = "committed";
        tombstone.auxiliarySessionId = existing.id;
        this.creationRecords.delete(key);
        this.notifyCreationState(tombstone, "committed", existing.id);
        return { status: "committed", auxiliarySessionId: existing.id };
      }
      tombstone.status = "cancelled";
      this.retireCancelledCreation(tombstone);
      this.notifyCreationState(tombstone, "cancelled");
      return { status: "cancelled" };
    }
    if (record.status === "preparing" || record.status === "queued") {
      record.cancelRequested = true;
      record.status = "cancelled";
      this.notifyCreationState(record, "cancelled");
    }
    return { status: record.status, auxiliarySessionId: record.auxiliarySessionId };
  }

  releaseAuxiliaryCreationOwner(parentSessionId: string): void {
    for (const record of this.creationRecords.values()) {
      if (record.request.parentSessionId === parentSessionId
        && (record.status === "preparing" || record.status === "queued"
          || (record.status === "unknown" && record.cancelRequested && !record.promise))) {
        record.cancelRequested = true;
        record.status = "expired";
        this.notifyCreationState(record, "expired");
      }
      if (record.request.parentSessionId === parentSessionId && record.status === "expired" && !record.promise) {
        this.creationRecords.delete(this.creationKey(record.request));
      }
    }
    this.creationOwnerGenerations.set(parentSessionId, randomUUID());
  }

  async listAuxiliarySessions(parentSessionId: string): Promise<AuxiliarySessionSummary[]> {
    return (await this.deps.getStorage().listAuxiliarySessions(parentSessionId)).map((session) => this.overlayExecutionOptions(session));
  }

  async listAuxiliarySessionSummaries(parentSessionIds: readonly string[]): Promise<AuxiliarySessionSummary[]> {
    return (await this.deps.getStorage().listAuxiliarySessionSummaries(parentSessionIds)).map((session) => this.overlayExecutionOptions(session));
  }

  async listAllAuxiliarySessions(): Promise<AuxiliarySession[]> {
    return (await this.deps.getStorage().listAllAuxiliarySessions()).map((session) => this.overlayExecutionOptions(session));
  }

  async listActiveAuxiliarySessionSummaries(parentSessionIds: readonly string[]): Promise<AuxiliarySessionSummary[]> {
    return (await this.deps.getStorage().listActiveAuxiliarySessionSummaries(parentSessionIds)).map((session) => this.overlayExecutionOptions(session));
  }

  async getActiveAuxiliarySession(parentSessionId: string): Promise<AuxiliarySession | null> {
    const session = await this.deps.getStorage().getActiveAuxiliarySession(parentSessionId);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  async getAuxiliarySession(auxiliarySessionId: string): Promise<AuxiliarySession | null> {
    const session = await this.deps.getStorage().getAuxiliarySession(auxiliarySessionId);
    if (session) this.assertCharacterSnapshotValid(session);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  async getAuxiliarySessionView(auxiliarySessionId: string): Promise<AuxiliarySession | null> {
    const session = await this.deps.getStorage().getAuxiliarySessionView(auxiliarySessionId);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  async getActiveAuxiliarySessionView(parentSessionId: string): Promise<AuxiliarySession | null> {
    const storage = this.deps.getStorage();
    const summary = (await storage.listActiveAuxiliarySessionSummaries([parentSessionId]))[0];
    return summary ? this.getAuxiliarySessionView(summary.id) : null;
  }

  async getAuxiliarySessionSummary(auxiliarySessionId: string): Promise<AuxiliarySessionSummary | null> {
    const session = await this.deps.getStorage().getAuxiliarySessionSummary(auxiliarySessionId);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  private async getMutationTarget(request: {
    auxiliarySessionId: string;
    parentSessionId: string;
    createdAt: string;
  }): Promise<{ storage: AuxiliarySessionStorageAccess; identity: unknown; session: AuxiliarySessionSummary }> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const session = await storage.getAuxiliarySessionSummary(request.auxiliarySessionId);
    this.assertStorageIdentity(storage, identity);
    if (!session
      || session.parentSessionId !== request.parentSessionId
      || session.createdAt !== request.createdAt
      || session.status !== "active") {
      throw new Error("The Auxiliary Session could not be found or has changed.");
    }
    return { storage, identity, session: this.overlayExecutionOptions(session) };
  }

  async setAuxiliaryTitle(request: SetAuxiliaryTitleRequest): Promise<void> {
    const { storage, session } = await this.getMutationTarget(request);
    if (session.runState === "running") throw new Error("A running Auxiliary Session cannot be updated.");
    if (typeof request.title !== "string" || !request.title.trim()) {
      throw new Error("The Auxiliary Session title cannot be empty.");
    }
    const updated = await storage.updateAuxiliaryTitleIfMatches({ ...request, updatedAt: currentTimestampLabel() });
    if (!updated) throw new Error("Saving was canceled because the Auxiliary Session was deleted or changed.");
  }

  async setAuxiliaryMessageBookmark(request: SetAuxiliaryMessageBookmarkRequest): Promise<void> {
    const { storage } = await this.getMutationTarget(request);
    if (!Number.isInteger(request.messageIndex) || request.messageIndex < 0 || typeof request.isBookmarked !== "boolean") {
      throw new Error("The Auxiliary message bookmark is invalid.");
    }
    const updated = await storage.updateAuxiliaryMessageBookmarkIfMatches({ ...request, updatedAt: currentTimestampLabel() });
    if (!updated) throw new Error("Saving was canceled because the Auxiliary Session was deleted or changed.");
  }

  async setAuxiliaryExecutionOptions(request: SetAuxiliaryExecutionOptionsRequest): Promise<SetExecutionOptionsResult> {
    const selectionKey = `${request.auxiliarySessionId}:${request.createdAt}`;
    const revision = (this.selectionRequestRevisions.get(selectionKey) ?? 0) + 1;
    this.selectionRequestRevisions.set(selectionKey, revision);
    const { storage, identity, session } = await this.getMutationTarget(request);
    const snapshot = await this.deps.getModelCatalogSnapshot?.();
    if (this.selectionRequestRevisions.get(selectionKey) !== revision) return { status: "superseded" };
    const current = await storage.getAuxiliarySessionSummary(request.auxiliarySessionId);
    this.assertStorageIdentity(storage, identity);
    if (!current || current.parentSessionId !== request.parentSessionId
      || current.createdAt !== request.createdAt || current.status !== "active") {
      throw new Error("The Auxiliary Session could not be found or has changed.");
    }
    if (this.selectionRequestRevisions.get(selectionKey) !== revision) return { status: "superseded" };
    const fresh = this.overlayExecutionOptions(current);
    const provider = getProviderCatalog(snapshot?.providers ?? [], fresh.provider);
    if (!snapshot || !provider || provider.id !== session.provider) {
      throw new Error("The Auxiliary Session provider is not in the model catalog.");
    }
    const options = validateSessionExecutionOptions(request.executionOptions, provider, snapshot.revision);
    this.assertStorageIdentity(storage, identity);
    if (this.selectionRequestRevisions.get(selectionKey) !== revision) return { status: "superseded" };
    if (fresh.runState === "running" || this.deps.isAuxiliaryRunInFlight?.(fresh.id)) {
      if (options.approvalMode !== fresh.approvalMode || options.codexSandboxMode !== fresh.codexSandboxMode
        || options.codexSpeed !== fresh.codexSpeed || options.codexReviewer !== fresh.codexReviewer
        || options.customAgentName !== fresh.customAgentName) {
        throw new Error("A running Auxiliary Session cannot change these execution options.");
      }
    }
    this.deps.rememberExecutionOptions?.(fresh, options);
    const previous = this.selectionCheckpoints.get(session.id) ?? Promise.resolve();
    const checkpoint = previous.catch(() => {}).then(async () => {
      this.assertStorageIdentity(storage, identity);
      const updated = await storage.updateAuxiliaryExecutionOptionsIfMatches({
        ...request,
        options: { provider: session.provider, ...options },
        updatedAt: currentTimestampLabel(),
      });
      if (!updated) throw new Error("Saving was canceled because the Auxiliary Session was deleted or changed.");
    });
    this.selectionCheckpoints.set(session.id, checkpoint);
    try {
      await checkpoint;
      return { status: "accepted", checkpointSaved: true };
    } catch {
      return { status: "accepted", checkpointSaved: false };
    } finally {
      if (this.selectionCheckpoints.get(session.id) === checkpoint) this.selectionCheckpoints.delete(session.id);
    }
  }

  async setAuxiliaryDisplayAnchor(auxiliarySessionId: string, parentMessageCount: number): Promise<void> {
    if (!Number.isInteger(parentMessageCount) || parentMessageCount < 0) {
      throw new Error("The Auxiliary display anchor is invalid.");
    }
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const session = await storage.getAuxiliarySessionSummary(auxiliarySessionId);
    this.assertStorageIdentity(storage, identity);
    if (!session || session.status !== "active") throw new Error("The Auxiliary Session could not be found.");
    if (session.displayAfterMessageIndex !== null) return;
    const updated = await storage.updateAuxiliaryDisplayAnchorIfMatches({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      createdAt: session.createdAt,
      displayAfterMessageIndex: parentMessageCount - 1,
      updatedAt: currentTimestampLabel(),
    });
    if (!updated) throw new Error("Saving the Auxiliary display anchor was canceled.");
  }

  async listRunningActiveAuxiliarySessions(): Promise<AuxiliarySessionSummary[]> {
    return (await this.deps.getStorage().listRunningActiveAuxiliarySessions()).map((session) => this.overlayExecutionOptions(session));
  }

  async createAuxiliarySession(input: CreateAuxiliarySessionInput): Promise<AuxiliarySession> {
    const requestId = input.clientRequestId?.trim() ?? "";
    const creationContext = input.creationContext;
    if (requestId && creationContext !== undefined && !isCreationContext(creationContext)) {
      throw new Error("Could not parse the Auxiliary Session creation context.");
    }
    if (requestId && creationContext) {
      const storage = this.deps.getStorage();
      this.syncCreationStorage(storage);
      const normalizedInput = normalizeCreationInput(input);
      const request: AuxiliaryCreationRequest = {
        parentSessionId: input.parentSessionId,
        clientRequestId: requestId,
        creationContext,
      };
      const key = this.creationKey(request);
      const existingRecord = this.creationRecords.get(key);
      if (existingRecord) {
        if (existingRecord.status === "cancelled" || existingRecord.status === "expired") {
          throw new Error("The Auxiliary Session creation request was canceled.");
        }
        if (existingRecord.status === "unknown" && !existingRecord.promise) {
          throw new Error("The Auxiliary Session creation cancellation is still being confirmed.");
        }
        if (!existingRecord.input || !isDeepStrictEqual(existingRecord.input, normalizedInput)) {
          throw new Error("The same Auxiliary creation request ID cannot be used with different input.");
        }
        if (!existingRecord.promise) {
          throw new Error("The Auxiliary Session creation request has already finished.");
        }
        return existingRecord.promise;
      }
      const persisted = (await storage.listAuxiliarySessions(input.parentSessionId))
        .find((summary) => summary.clientRequestId === requestId);
      const recordAfterLookup = this.creationRecords.get(key);
      if (recordAfterLookup) {
        if (recordAfterLookup.status === "cancelled" || recordAfterLookup.status === "expired") {
          throw new Error("The Auxiliary Session creation request was canceled.");
        }
        if (!recordAfterLookup.input || !isDeepStrictEqual(recordAfterLookup.input, normalizedInput)) {
          throw new Error("The same Auxiliary creation request ID cannot be used with different input.");
        }
        if (recordAfterLookup.promise) return recordAfterLookup.promise;
      }
      if (persisted) {
        const existing = await storage.getAuxiliarySession(persisted.id);
        if (!existing) throw new Error("The Auxiliary Session retry target could not be found.");
        this.assertCharacterSnapshotValid(existing);
        if (!existing.creationRequest) {
          throw new Error("Auxiliary creation records before the continuity boundary are query-only and cannot be recreated.");
        }
        if (!isDeepStrictEqual(existing.creationRequest, normalizedInput)) {
          throw new Error("The same Auxiliary creation request ID cannot be used with different input.");
        }
        return existing;
      }
      if (creationContext.generationId !== this.getCreationOwnerGeneration(input.parentSessionId)) {
        throw new Error("The Auxiliary Session creation context has expired.");
      }

      const record = {} as AuxiliaryCreationRecord;
      record.request = request;
      record.input = normalizedInput;
      record.status = "preparing";
      record.cancelRequested = false;
      this.creationRecords.set(key, record);
      this.notifyCreationState(record, "preparing");
      record.promise = Promise.resolve()
        .then(() => this.runAuxiliaryCreation(input, record, normalizedInput))
        .finally(() => {
          if (record.status === "cancelled") {
            this.retireCancelledCreation(record);
          }
          if (
            (record.status === "committed" || record.status === "failed"
              || record.status === "expired")
            && this.creationRecords.get(key) === record
          ) {
            this.creationRecords.delete(key);
          }
        });
      return record.promise;
    }
    const options = this.validateAuxiliaryInput(input);
    const storage = this.deps.getStorage();
    const parent = await this.deps.getParentSession(input.parentSessionId);
    if (!parent) {
      throw new Error("The parent session could not be found.");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session creation was canceled because its storage changed during creation.");
    }
    const legacyRequestId = input.clientRequestId?.trim() ?? "";
    if (legacyRequestId) {
      const existing = (await storage.listAuxiliarySessions(input.parentSessionId))
        .find((summary) => summary.clientRequestId === legacyRequestId);
      if (existing) {
        return await this.getAuxiliarySession(existing.id) ?? (() => {
          throw new Error("The Auxiliary Session retry target could not be found.");
        })();
      }
    }
    const prepared = await this.prepareAuxiliarySession(input, parent, options, storage);
    return this.commitPreparedAuxiliarySession(input, storage, prepared);
  }

  private async runAuxiliaryCreation(
    input: CreateAuxiliarySessionInput,
    record: AuxiliaryCreationRecord,
    normalizedInput: AuxiliaryCreationRequestSnapshot,
  ): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    let prepared: Awaited<ReturnType<AuxiliarySessionService["prepareAuxiliarySession"]>>;
    try {
      const options = this.validateAuxiliaryInput(input);
      const parent = await this.deps.getParentSession(input.parentSessionId);
      if (!parent) throw new Error("The parent session could not be found.");
      if (input.creationContext && input.creationContext.parentIncarnationId !== getSessionIncarnationId(parent)) {
        throw new Error("Auxiliary Session creation was canceled because its parent session changed during creation.");
      }
      prepared = await this.prepareAuxiliarySession(input, parent, options, storage);
      if (record.cancelRequested) throw new Error("Auxiliary Session creation was canceled.");
    } catch (error) {
      if (record.status !== "expired") {
        record.status = record.cancelRequested ? "cancelled" : "failed";
        this.notifyCreationState(record, record.status);
      }
      throw error;
    }
    try {
      const result = await this.commitPreparedAuxiliarySession(input, storage, prepared, record, normalizedInput);
      record.status = "committed";
      record.auxiliarySessionId = result.id;
      this.notifyCreationState(record, "committed", result.id);
      return result;
    } catch (error) {
      const status = record.status as AuxiliaryCreationResult["status"];
      if (status === "committing") {
        record.status = "unknown";
        this.notifyCreationState(record, "unknown");
      } else if (status !== "expired") {
        record.status = record.cancelRequested ? "cancelled" : "failed";
        this.notifyCreationState(record, record.status);
      }
      throw error;
    }
  }

  private syncCreationStorage(storage: AuxiliarySessionStorageAccess): void {
    if (this.creationStorage === storage) return;
    this.creationStorage = storage;
    this.creationGenerationId = randomUUID();
    this.creationOwnerGenerations.clear();
    for (const record of this.creationRecords.values()) {
      if (record.status === "preparing" || record.status === "queued") {
        record.cancelRequested = true;
        record.status = "expired";
        this.notifyCreationState(record, "expired");
      }
      if (record.status === "unknown") {
        record.status = "expired";
        this.notifyCreationState(record, "expired");
        this.creationRecords.delete(this.creationKey(record.request));
      }
    }
  }

  private creationKey(request: AuxiliaryCreationRequest): string {
    return `${request.creationContext.generationId}:${request.parentSessionId}:${request.creationContext.parentIncarnationId}:${request.clientRequestId}`;
  }

  private retireCancelledCreation(record: AuxiliaryCreationRecord): void {
    const key = this.creationKey(record.request);
    if (this.creationRecords.get(key) !== record) return;
    const { parentSessionId, creationContext } = record.request;
    if (this.getCreationOwnerGeneration(parentSessionId) === creationContext.generationId) {
      // Fence delayed admissions before discarding their cancellation tombstone.
      // Already admitted requests keep their records and may still finish.
      this.creationOwnerGenerations.set(parentSessionId, randomUUID());
    }
    this.creationRecords.delete(key);
  }

  private getCreationOwnerGeneration(parentSessionId: string): string {
    const current = this.creationOwnerGenerations.get(parentSessionId);
    if (current) return current;
    const next = this.creationGenerationId;
    this.creationOwnerGenerations.set(parentSessionId, next);
    return next;
  }

  async updateAuxiliarySessionThreadIfMatches(input: AuxiliarySessionThreadPatchInput): Promise<AuxiliaryThreadPatchResult | null> {
    const storage = this.deps.getStorage();
    const patch = storage.updateAuxiliarySessionThreadIfMatches;
    if (!patch) {
      throw new Error("Auxiliary thread storage is unavailable for conditional updates.");
    }
    return patch.call(storage, input);
  }

  async updateAuxiliarySessionRuntimeMetadataIfMatches(
    input: AuxiliarySessionRuntimeMetadataPatchInput,
  ): Promise<AuxiliaryRuntimeMetadataPatchResult | null> {
    const storage = this.deps.getStorage();
    const patch = storage.updateAuxiliarySessionRuntimeMetadataIfMatches;
    if (!patch) {
      throw new Error("Auxiliary runtime metadata storage is unavailable for conditional updates.");
    }
    return patch.call(storage, input);
  }

  private async prepareAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    parent: Session,
    options: ReturnType<AuxiliarySessionService["validateAuxiliaryInput"]>,
    storage: AuxiliarySessionStorageAccess,
  ): Promise<{
    parentIncarnationId: string;
    parentCharacterId: string;
    launchSelection: SessionLaunchSelection;
    characterSelection: Awaited<ReturnType<AuxiliarySessionService["resolveAuxiliaryCharacter"]>>;
  }> {
    const parentIncarnationId = getSessionIncarnationId(parent);
    const parentCharacterId = resolveParentCharacterId(parent);
    const launchSelection = options.runtimeSelectionMode === "latest-session"
      ? await this.deps.resolveSessionLaunchSelection(input.provider)
      : await this.resolveExplicitLaunchSelection(
        input,
        options.approvalMode,
        options.codexSandboxMode,
        options.codexSpeed,
      );

    const characterSelection = await this.resolveAuxiliaryCharacter(parentCharacterId, storage, input.parentSessionId);
    return {
      parentIncarnationId,
      parentCharacterId,
      launchSelection,
      characterSelection,
    };
  }

  private async commitPreparedAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    storage: AuxiliarySessionStorageAccess,
    prepared: Awaited<ReturnType<AuxiliarySessionService["prepareAuxiliarySession"]>>,
    record?: AuxiliaryCreationRecord,
    normalizedInput?: AuxiliaryCreationRequestSnapshot,
  ): Promise<AuxiliarySession> {
    for (;;) {
      if (record?.cancelRequested) throw new Error("Auxiliary Session creation was canceled.");
      if (record) {
        record.status = "queued";
        this.notifyCreationState(record, "queued");
      }
      const result = await this.deps.runProviderRuntimeOperationExclusive(
        () => this.deps.runCharacterAffectTurnOwnershipExclusive
          ? this.deps.runCharacterAffectTurnOwnershipExclusive(() => this.commitAuxiliarySession(input, storage, prepared, record, normalizedInput))
          : this.commitAuxiliarySession(input, storage, prepared, record, normalizedInput),
      );
      if (result) return result;

      // A sibling took this Character before commit. Prepare again outside the
      // broad coordinators, then revalidate all commit boundaries on the next pass.
      if (record?.cancelRequested) throw new Error("Auxiliary Session creation was canceled.");
      if (record) {
        record.status = "preparing";
        this.notifyCreationState(record, "preparing");
      }
      prepared.characterSelection = await this.resolveAuxiliaryCharacter(
        prepared.parentCharacterId, storage, input.parentSessionId,
      );
    }
  }

  private async commitAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    storage: AuxiliarySessionStorageAccess,
    prepared: Awaited<ReturnType<AuxiliarySessionService["prepareAuxiliarySession"]>>,
    record?: AuxiliaryCreationRecord,
    normalizedInput?: AuxiliaryCreationRequestSnapshot,
  ): Promise<AuxiliarySession | null> {
    if (record?.cancelRequested) {
      throw new Error("Auxiliary Session creation was canceled.");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session creation was canceled because its storage changed during creation.");
    }
    const parent = await this.deps.getParentSession(input.parentSessionId);
    if (!parent) {
      throw new Error("The parent session could not be found.");
    }
    if (
      getSessionIncarnationId(parent) !== prepared.parentIncarnationId ||
      resolveParentCharacterId(parent) !== prepared.parentCharacterId
    ) {
        throw new Error("Auxiliary Session creation was canceled because its parent session changed during creation.");
    }

    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session creation was canceled because its storage changed during creation.");
    }
    const requestId = input.clientRequestId?.trim() ?? "";
    const existingAuxiliaries = await storage.listAuxiliarySessions(input.parentSessionId);
    if (requestId) {
      const existing = existingAuxiliaries.find((summary) => summary.clientRequestId === requestId);
      if (existing) {
        return await this.getAuxiliarySession(existing.id) ?? (() => {
          throw new Error("The Auxiliary Session retry target could not be found.");
        })();
      }
    }

    const runtimeSelectionMode = resolveRuntimeSelectionMode(input.runtimeSelection);
    const launchSelection = runtimeSelectionMode === "latest-session"
      ? await this.deps.resolveSessionLaunchSelection(input.provider)
      : await this.resolveExplicitLaunchSelection(
        input,
        prepared.launchSelection.approvalMode,
        prepared.launchSelection.codexSandboxMode,
        prepared.launchSelection.codexSpeed,
      );
    if (!isDeepStrictEqual(launchSelection, prepared.launchSelection)) {
      throw new Error("Auxiliary Session creation was canceled because its runtime selection changed during creation.");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session creation was canceled because its storage changed during creation.");
    }

    const activeCharacters = (await this.deps.listActiveCharacters()).filter((entry) => entry.state === "active");
    if (!activeCharacters.some((entry) => entry.id === prepared.characterSelection.characterId)) {
      throw new Error("Auxiliary Session creation was canceled because its Character became unavailable.");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session creation was canceled because its storage changed during creation.");
    }
    const usedCharacterIds = new Set(existingAuxiliaries.map((session) => session.characterId));
    if (usedCharacterIds.has(prepared.characterSelection.characterId)
      && activeCharacters.some((entry) => entry.id !== prepared.parentCharacterId && !usedCharacterIds.has(entry.id))) {
      return null;
    }
    if (record) {
      if (record.cancelRequested) {
        throw new Error("Auxiliary Session creation was canceled.");
      }
      record.status = "committing";
      this.notifyCreationState(record, "committing");
    }
    const now = currentTimestampLabel();
    return storage.upsertAuxiliarySession({
      id: `aux-${randomUUID()}`,
      parentSessionId: parent.id,
      status: "active",
      runState: "idle",
      title: "",
      provider: launchSelection.provider,
      catalogRevision: launchSelection.catalogRevision,
      model: launchSelection.model,
      reasoningEffort: launchSelection.reasoningEffort,
      approvalMode: launchSelection.approvalMode,
      codexSandboxMode: launchSelection.codexSandboxMode,
      codexSpeed: parent.codexSpeed,
      codexReviewer: parent.codexReviewer,
      customAgentName: launchSelection.customAgentName,
      allowedAdditionalDirectories: [...parent.allowedAdditionalDirectories],
      threadId: "",
      composerDraft: "",
      messages: [],
      displayAfterMessageIndex: parent.messages.length - 1,
      createdAt: now,
      updatedAt: now,
      closedAt: "",
      characterId: prepared.characterSelection.characterId,
      characterRuntimeSnapshot: prepared.characterSelection.characterRuntimeSnapshot,
      characterIconPath: prepared.characterSelection.characterRuntimeSnapshot?.iconFilePath ?? "",
      preview: "",
      clientRequestId: requestId || undefined,
      creationContext: record?.request.creationContext,
      creationRequest: normalizedInput,
    });
  }

  private notifyCreationState(
    record: AuxiliaryCreationRecord,
    status: AuxiliaryCreationResult["status"],
    auxiliarySessionId = record.auxiliarySessionId,
  ): void {
    try {
      this.deps.onCreationStateChanged?.({
        status,
        ...(auxiliarySessionId ? { auxiliarySessionId } : {}),
        clientRequestId: record.request.clientRequestId,
        parentSessionId: record.request.parentSessionId,
        generationId: record.request.creationContext.generationId,
      });
    } catch {
      // Lifecycle diagnostics must never affect creation semantics.
    }
  }

  private validateAuxiliaryInput(input: CreateAuxiliarySessionInput) {
    const runtimeSelectionMode = resolveRuntimeSelectionMode(input.runtimeSelection);
    if (runtimeSelectionMode === "latest-session") {
      assertLatestSessionRuntimeFieldsAbsent(input);
      return {
        runtimeSelectionMode,
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
        codexSpeed: DEFAULT_CODEX_SPEED,
      };
    }
    return {
      runtimeSelectionMode,
      approvalMode: resolveInitialRuntimeOption(input.approvalMode, APPROVAL_MODE_VALUES, getDefaultApprovalModeForProvider(input.provider), "approvalMode"),
      codexSandboxMode: resolveInitialRuntimeOption(input.codexSandboxMode, CODEX_SANDBOX_MODE_VALUES, DEFAULT_CODEX_SANDBOX_MODE, "codexSandboxMode"),
      codexSpeed: resolveInitialRuntimeOption(input.codexSpeed, CODEX_SPEED_VALUES, DEFAULT_CODEX_SPEED, "codexSpeed"),
    };
  }

  private async resolveAuxiliaryCharacter(
    mainCharacterId: string,
    storage: AuxiliarySessionStorageAccess,
    parentSessionId: string,
  ): Promise<{
    characterId?: string;
    characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  }> {
    const listActiveCharacters = await this.deps.listActiveCharacters();
    const existingAuxiliaries = await storage.listAuxiliarySessions(parentSessionId);
    const candidates = listActiveCharacters.filter((entry) => entry.id !== mainCharacterId);
    const selectedId = selectWeightedRandomLaunchCharacterId(
      candidates,
      [],
      existingAuxiliaries.flatMap((session) => session.characterId ? [session.characterId] : []),
      this.deps.randomCharacter ?? Math.random,
    );
    if (!selectedId) {
      throw new Error("No Character is available for this Auxiliary Session.");
    }
    const snapshot = await this.deps.createCharacterRuntimeSnapshot(selectedId);
    if (!snapshot || snapshot.characterId !== selectedId) {
      throw new Error("The Auxiliary Session Character snapshot could not be created.");
    }
    return { characterId: selectedId, characterRuntimeSnapshot: snapshot };
  }

  private async resolveExplicitLaunchSelection(
    input: CreateAuxiliarySessionInput,
    approvalMode: SessionLaunchSelection["approvalMode"],
    codexSandboxMode: SessionLaunchSelection["codexSandboxMode"],
    codexSpeed: SessionLaunchSelection["codexSpeed"],
  ): Promise<SessionLaunchSelection> {
    const snapshot = await this.deps.getModelCatalogSnapshot?.();
    const providerCatalog = getProviderCatalog(snapshot?.providers ?? [], input.provider);
    if (!snapshot || !providerCatalog || providerCatalog.id !== input.provider.trim()) {
      throw new Error("The Auxiliary Session provider is not in the model catalog.");
    }
    if (!getApprovalOptionsForProvider(providerCatalog.id).some((option) => option.value === approvalMode)) {
      throw new Error("The selected approval mode is not supported by this provider.");
    }
    const modelSelection = resolveInitialModelSelection(input, providerCatalog);
    return {
      provider: providerCatalog.id,
      catalogRevision: snapshot.revision,
      model: modelSelection.resolvedModel,
      reasoningEffort: modelSelection.resolvedReasoningEffort,
      approvalMode,
      codexSandboxMode,
      codexSpeed,
      codexReviewer: DEFAULT_CODEX_REVIEWER,
      customAgentName: input.customAgentName?.trim() ?? "",
    };
  }

  async getAuxiliaryRuntimeSession(auxiliarySessionId: string): Promise<Session | null> {
    const auxiliary = await this.getAuxiliarySession(auxiliarySessionId);
    if (!auxiliary) {
      return null;
    }

    return await this.toRuntimeSession(auxiliary);
  }

  async getAuxiliaryDraft(auxiliarySessionId: string): Promise<AuxiliaryDraftRecord | null> {
    return await this.deps.getStorage().getAuxiliaryDraft(auxiliarySessionId);
  }

  async getAuxiliarySessionStatus(auxiliarySessionId: string): Promise<AuxiliarySessionStatus | null> {
    return await this.deps.getStorage().getAuxiliarySessionStatus(auxiliarySessionId);
  }

  async saveAuxiliaryDraft(input: AuxiliaryDraftSaveInput): Promise<AuxiliaryDraftSaveResult> {
    const storage = this.deps.getStorage();
    const status = await storage.getAuxiliarySessionStatus(input.auxiliarySessionId);
    if (!status || status.parentSessionId !== input.parentSessionId || status.incarnation !== input.incarnation) {
      return { outcome: "not-found" };
    }
    return await storage.saveAuxiliaryDraft(input);
  }

  runAuxiliaryTurnWithDraft(input: {
    auxiliarySessionId: string;
    parentSessionId: string;
    incarnation: string;
    expectedDurableRevision: number;
    userMessage: string;
    displayAnchorParentMessageCount?: number;
    run: () => Promise<void>;
  }): Promise<void> {
    return this.trackPendingDraftSend(() => this.runAuxiliaryTurnWithDraftInternal(input));
  }

  runAuxiliaryInputWithDraft(input: {
    auxiliarySessionId: string;
    parentSessionId: string;
    incarnation: string;
    expectedDurableRevision: number;
    userMessage: string;
    run: () => Promise<void>;
  }): Promise<void> {
    return this.trackPendingDraftSend(() => this.runAuxiliaryTurnWithDraftInternal(input, true));
  }

  async waitForPendingDraftSends(): Promise<boolean> {
    await Promise.all([...this.pendingDraftSends]);
    for (const restore of [...this.failedDraftRestores]) {
      try {
        const storage = this.deps.getStorage();
        const current = await storage.getAuxiliaryDraft(restore.auxiliarySessionId);
        // A persisted recovery/edit or explicit deletion/recreation supersedes
        // this failed restore. Never overwrite a newer draft or resurrect it.
        if (!current
          || current.parentSessionId !== restore.parentSessionId
          || current.incarnation !== restore.incarnation
          || current.durableRevision > restore.expectedDurableRevision) {
          this.failedDraftRestores.delete(restore);
          continue;
        }
        if (current.durableRevision !== restore.expectedDurableRevision || current.text !== "") continue;
        const result = await storage.saveAuxiliaryDraft(restore);
        if (result.outcome === "saved") this.failedDraftRestores.delete(restore);
      } catch {
        // Keep the original text and retry on the next quit attempt. Settling
        // the send Promise alone must not make failed restoration safe to quit.
      }
    }
    return this.failedDraftRestores.size === 0;
  }

  trackPendingDraftSend<T>(operationFactory: () => Promise<T>): Promise<T> {
    const operation = operationFactory();
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pendingDraftSends.add(settlement);
    void settlement.then(() => this.pendingDraftSends.delete(settlement));
    return operation;
  }

  private async runAuxiliaryTurnWithDraftInternal(
    input: {
      auxiliarySessionId: string;
      parentSessionId: string;
      incarnation: string;
      expectedDurableRevision: number;
      userMessage: string;
      displayAnchorParentMessageCount?: number;
      run: () => Promise<void>;
    },
    allowRunningInput = false,
  ): Promise<void> {
    const storage = this.deps.getStorage();
    const captured = await storage.getAuxiliaryDraft(input.auxiliarySessionId);
    if (!captured
      || captured.parentSessionId !== input.parentSessionId
      || captured.incarnation !== input.incarnation
      || captured.durableRevision !== input.expectedDurableRevision
      || (allowRunningInput && captured.text !== input.userMessage)) {
      throw new Error("Sending was canceled because the Auxiliary draft changed.");
    }
    const consumed = await this.consumeAuxiliaryDraftWithStorage(storage, {
      auxiliarySessionId: input.auxiliarySessionId,
      parentSessionId: input.parentSessionId,
      incarnation: input.incarnation,
      expectedDurableRevision: input.expectedDurableRevision,
      allowRunningInput,
    });
    if (consumed.outcome !== "consumed" || !consumed.ack) {
      throw new Error("Sending was canceled because the Auxiliary draft changed.");
    }
    try {
      if (input.displayAnchorParentMessageCount !== undefined) {
        const summary = await storage.getAuxiliarySessionSummary(input.auxiliarySessionId);
        if (!summary || summary.parentSessionId !== input.parentSessionId || summary.status !== "active") {
          throw new Error("The Auxiliary Session could not be found or has changed.");
        }
        if (summary.displayAfterMessageIndex === null) {
          if (!Number.isInteger(input.displayAnchorParentMessageCount) || input.displayAnchorParentMessageCount < 0) {
            throw new Error("The Auxiliary display anchor is invalid.");
          }
          const updated = await storage.updateAuxiliaryDisplayAnchorIfMatches({
            auxiliarySessionId: summary.id,
            parentSessionId: summary.parentSessionId,
            createdAt: summary.createdAt,
            displayAfterMessageIndex: input.displayAnchorParentMessageCount - 1,
            updatedAt: currentTimestampLabel(),
          });
          if (!updated) throw new Error("Saving the Auxiliary display anchor was canceled.");
        }
      }
      await input.run();
    } catch (error) {
      const restore: AuxiliaryDraftStorageSaveInput = {
        auxiliarySessionId: input.auxiliarySessionId,
        parentSessionId: input.parentSessionId,
        incarnation: consumed.ack.incarnation,
        expectedDurableRevision: consumed.ack.durableRevision,
        text: captured.text,
        updatedAt: currentTimestampLabel(),
      };
      try {
        const restored = await storage.saveAuxiliaryDraft(restore);
        if (restored.outcome !== "saved") throw new Error(`Auxiliary draft restore ${restored.outcome}.`);
      } catch (restoreError) {
        this.failedDraftRestores.add(restore);
        throw new AggregateError([error, restoreError], "Auxiliary turn failed and draft restore failed.");
      }
      throw error;
    }
  }

  private async consumeAuxiliaryDraftWithStorage(
    storage: AuxiliarySessionStorageAccess,
    input: AuxiliaryDraftStorageConsumeInput,
  ): Promise<AuxiliaryDraftConsumeResult> {
    const status = await storage.getAuxiliarySessionStatus(input.auxiliarySessionId);
    if (!status || status.parentSessionId !== input.parentSessionId || status.incarnation !== input.incarnation) {
      return { outcome: "not-found" };
    }
    if (status.runState === "running" && (!input.allowRunningInput || this.deps.canAcceptAuxiliaryInput?.(input.auxiliarySessionId) !== true)) return { outcome: "rejected" };
    return await storage.consumeAuxiliaryDraft(input);
  }

  async persistRunningTurnStart(runtimeSession: Session, expectedMessageCount: number): Promise<Session> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(runtimeSession.id);
    if (!current) throw new Error("The Auxiliary Session could not be found.");
    this.assertCharacterSnapshotValid(current);
    const savedRuntime = await this.toRuntimeSession(current);
    const userMessage = runtimeSession.messages[expectedMessageCount];
    if (!Number.isSafeInteger(expectedMessageCount) || expectedMessageCount < 0
      || current.messages.length !== expectedMessageCount
      || runtimeSession.messages.length !== expectedMessageCount + 1
      || !userMessage || userMessage.role !== "user" || !userMessage.text.trim()
      || runtimeSession.runState !== "running" || runtimeSession.status !== "running"
      || runtimeSession.characterId !== savedRuntime.characterId
      || getSessionIncarnationId(runtimeSession) !== getSessionIncarnationId(savedRuntime)) {
      throw new Error("The Auxiliary Session changed before starting the running turn.");
    }
    assertCharacterDefinitionSnapshotUpdate(
      savedRuntime.characterRuntimeSnapshot, runtimeSession.characterRuntimeSnapshot, savedRuntime.characterId,
    );
    const next: AuxiliarySession = this.overlayExecutionOptions({
      ...current,
      status: "active",
      closedAt: "",
      runState: "running",
      characterId: runtimeSession.characterRuntimeSnapshot ? savedRuntime.characterId : current.characterId,
      characterRuntimeSnapshot: runtimeSession.characterRuntimeSnapshot ?? current.characterRuntimeSnapshot,
      messages: [...current.messages, userMessage],
      updatedAt: runtimeSession.updatedAt,
      preview: resolveAuxiliaryPreview([...current.messages, userMessage], current.preview),
    });
    const stored = await storage.updateAuxiliarySessionIfMatches({ session: next, expectedSession: current });
    if (!stored) throw new Error("Saving was canceled because the Auxiliary Session was deleted or changed.");
    return this.toRuntimeSession(this.overlayExecutionOptions(stored));
  }

  async upsertAuxiliaryRuntimeSession(
    runtimeSession: Session,
    options: { confirmedFinalAssistantText?: string | null } = {},
  ): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(runtimeSession.id);
    if (current) this.assertCharacterSnapshotValid(current);
    if (!current) {
      throw new Error("The Auxiliary Session could not be found.");
    }
    const next: AuxiliarySession = this.overlayExecutionOptions({
      ...current,
      status: "active",
      closedAt: "",
      runState:
        runtimeSession.runState === "running" || runtimeSession.runState === "error"
          ? runtimeSession.runState
          : "idle",
      title: current.title,
      provider: runtimeSession.provider,
      catalogRevision: runtimeSession.catalogRevision,
      model: runtimeSession.model,
      reasoningEffort: runtimeSession.reasoningEffort,
      approvalMode: runtimeSession.approvalMode,
      codexSandboxMode: runtimeSession.codexSandboxMode,
      codexSpeed: runtimeSession.codexSpeed,
      codexReviewer: runtimeSession.codexReviewer,
      customAgentName: runtimeSession.customAgentName,
      allowedAdditionalDirectories: [...runtimeSession.allowedAdditionalDirectories],
      threadId: runtimeSession.threadId,
      composerDraft: "",
      messages: runtimeSession.messages,
      preview: resolveAuxiliaryPreview(runtimeSession.messages, current.preview, options.confirmedFinalAssistantText),
      updatedAt: runtimeSession.updatedAt,
    });
    const updated = await storage.updateAuxiliarySessionIfMatches({
      session: next,
      expectedSession: current,
    });
    if (!updated) throw new Error("Saving was canceled because the Auxiliary Session was deleted or changed.");
    return this.overlayExecutionOptions(updated);
  }

  async updateAuxiliarySession(session: AuxiliarySession): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(session.id);
    if (current) this.assertCharacterSnapshotValid(current);
    if (!current) {
      throw new Error("The Auxiliary Session could not be found.");
    }
    if (current.runState === "running") {
      throw new Error("A running Auxiliary Session cannot be updated.");
    }

    const hasStaleRuntimeThread = session.threadId !== current.threadId && current.threadId !== "";
    if (session.createdAt !== current.createdAt || session.parentSessionId !== current.parentSessionId) {
      throw new Error("The Auxiliary Session incarnation does not match.");
    }
    const isRuntimeStalePayload =
      session.runState !== current.runState ||
      hasStaleRuntimeThread ||
      (session.messageCount === undefined && session.messages.length < current.messages.length);
    if (isRuntimeStalePayload) {
      return this.overlayExecutionOptions(current);
    }
    const next: AuxiliarySession = {
      ...current,
      status: "active",
      closedAt: "",
      title: session.title,
      provider: current.provider,
      catalogRevision: current.catalogRevision,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      approvalMode: current.approvalMode,
      codexSandboxMode: current.codexSandboxMode,
      codexSpeed: current.codexSpeed,
      codexReviewer: current.codexReviewer,
      customAgentName: current.customAgentName,
      allowedAdditionalDirectories: [...session.allowedAdditionalDirectories],
      composerDraft: current.composerDraft,
      displayAfterMessageIndex: session.displayAfterMessageIndex,
      threadId: current.threadId,
      updatedAt: currentTimestampLabel(),
    };
    const updated = await storage.updateAuxiliarySessionIfMatches({
      session: next,
      expectedSession: current,
    });
    if (!updated) throw new Error("Saving was canceled because the Auxiliary Session was deleted or changed.");
    return this.overlayExecutionOptions(updated);
  }

  async replaceAuxiliarySessions(sessions: AuxiliarySession[]): Promise<AuxiliarySession[]> {
    const storage = this.deps.getStorage();
    return Promise.all(sessions.map((session) => storage.upsertAuxiliarySession(session)));
  }

  async closeAuxiliarySession(auxiliarySessionId: string): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(auxiliarySessionId);
    if (current) this.assertCharacterSnapshotValid(current);
    if (!current) {
      throw new Error("The Auxiliary Session could not be found.");
    }
    if (current.runState === "running") {
      throw new Error("A running Auxiliary Session cannot be closed.");
    }

    const now = currentTimestampLabel();
    const next: AuxiliarySession = {
      ...current,
      status: "closed",
      runState: "idle",
      composerDraft: "",
      updatedAt: now,
      closedAt: current.closedAt || now,
    };
    const updated = await storage.updateAuxiliarySessionIfMatches({
      session: next,
      expectedSession: current,
    });
    if (!updated) throw new Error("Closing was canceled because the Auxiliary Session was deleted or changed.");
    return updated;
  }

  async recoverInterruptedSessions(): Promise<void> {
    const storage = this.deps.getStorage();
    const runningSessions = await storage.listRunningActiveAuxiliarySessions();
    if (runningSessions.length === 0) {
      return;
    }

    const now = currentTimestampLabel();
    for (const summary of runningSessions) {
      const current = await storage.getAuxiliarySession(summary.id);
      if (current) this.assertCharacterSnapshotValid(current);
      if (!current || current.status !== "active" || current.runState !== "running") {
        continue;
      }

      await storage.updateAuxiliarySessionIfMatches({
        session: {
          ...current,
          runState: "error",
          updatedAt: now,
          messages: buildInterruptedMessages(current.messages),
        },
        expectedSession: current,
      });
    }
  }

  private async toRuntimeSession(auxiliary: AuxiliarySession): Promise<Session> {
    const parent = await this.deps.getParentSession(auxiliary.parentSessionId);
    if (!parent) {
      throw new Error("The parent session could not be found.");
    }

    return {
      ...parent,
      id: auxiliary.id,
      taskTitle: parent.taskTitle,
      status: auxiliary.runState === "running" ? "running" : "idle",
      updatedAt: auxiliary.updatedAt,
      provider: auxiliary.provider,
      catalogRevision: auxiliary.catalogRevision,
      runState: auxiliary.runState,
      approvalMode: auxiliary.approvalMode,
      codexSandboxMode: auxiliary.codexSandboxMode,
      codexSpeed: auxiliary.codexSpeed,
      codexReviewer: auxiliary.codexReviewer,
      model: auxiliary.model,
      reasoningEffort: auxiliary.reasoningEffort,
      customAgentName: auxiliary.customAgentName,
      allowedAdditionalDirectories: [...auxiliary.allowedAdditionalDirectories],
      threadId: auxiliary.threadId,
      messages: auxiliary.messages,
      characterId: auxiliary.characterId ?? parent.characterId,
      character: auxiliary.characterRuntimeSnapshot?.name ?? parent.character,
      characterIconPath: auxiliary.characterRuntimeSnapshot?.iconFilePath ?? parent.characterIconPath,
      characterThemeColors: auxiliary.characterRuntimeSnapshot?.theme ?? parent.characterThemeColors,
      characterRuntimeSnapshot: auxiliary.characterRuntimeSnapshot ?? parent.characterRuntimeSnapshot,
      stream: [],
    };
  }

  private assertCharacterSnapshotValid(session: AuxiliarySession): void {
    if (session.characterRuntimeSnapshotInvalid) {
      throw new Error("The Auxiliary Session Character snapshot is invalid. Review it before continuing; the conversation was not switched to the parent Character.");
    }
  }
}
