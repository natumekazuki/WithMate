import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { currentTimestampLabel } from "../../src-shared/time-state.js";
import { APPROVAL_MODE_VALUES, DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
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
import { DEFAULT_CODEX_REVIEWER, resolveCodexReviewerUpdate } from "../../src-shared/settings/codex-reviewer.js";
import {
  coerceModelSelection,
  getModelCatalogItem,
  getProviderCatalog,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { selectWeightedRandomLaunchCharacterId } from "../../src-shared/character/launch-character-selection.js";
import type { Awaitable, AuxiliarySessionStorageAccess } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionLaunchSelection } from "../session/session-launch-selection-service.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";
import type { RunCharacterAffectTurnOwnershipExclusive } from "../character/character-affect-turn-ownership-coordinator.js";
import type { AuxiliarySessionThreadPatchInput } from "./auxiliary-session-storage.js";
import type { AuxiliarySessionRuntimeMetadataPatchInput } from "./auxiliary-session-storage.js";
import type {
  AuxiliaryDraftConsumeInput,
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
  const interruptedMessage = "前回の Auxiliary 実行はアプリ終了で中断された可能性があります。必要ならもう一度送信してください。";
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

async function isRuntimeMetadataInCatalog(
  session: AuxiliarySession,
  snapshot: ModelCatalogSnapshot | null | undefined,
): Promise<boolean> {
  if (!snapshot || session.catalogRevision !== snapshot.revision) {
    return false;
  }

  const providerCatalog = getProviderCatalog(snapshot.providers, session.provider);
  if (!providerCatalog || providerCatalog.id !== session.provider) {
    return false;
  }

  const model = getModelCatalogItem(providerCatalog, session.model);
  return model?.reasoningEfforts.includes(session.reasoningEffort) ?? false;
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

  throw new Error(`Auxiliary Session の ${fieldName} を解釈できないよ。`);
}

function resolveRuntimeSelectionMode(value: unknown): AuxiliaryRuntimeSelectionMode {
  if (value === undefined || value === "explicit") {
    return "explicit";
  }
  if (value === "latest-session") {
    return value;
  }
  throw new Error("Auxiliary Session の runtimeSelection を解釈できないよ。");
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
    throw new Error("latest-session 選択では runtime option を直接指定できないよ。");
  }
}

function resolveParentCharacterId(parent: Session): string {
  return parent.characterRuntimeSnapshot?.characterId || parent.characterId || "";
}

export class AuxiliarySessionService {
  private readonly creationRecords = new Map<string, AuxiliaryCreationRecord>();
  private readonly creationOwnerGenerations = new Map<string, string>();
  private readonly pendingDraftSends = new Set<Promise<void>>();
  private readonly failedDraftRestores = new Set<AuxiliaryDraftSaveInput>();
  private creationStorage: AuxiliarySessionStorageAccess | null = null;
  private creationGenerationId = randomUUID();

  constructor(private readonly deps: AuxiliarySessionServiceDeps) {}

  async getAuxiliaryCreationContext(parentSessionId: string): Promise<AuxiliaryCreationContext> {
    const storage = this.deps.getStorage();
    this.syncCreationStorage(storage);
    const parent = await this.deps.getParentSession(parentSessionId);
    if (!parent) {
      throw new Error("親セッションが見つからないよ。");
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
    return this.deps.getStorage().listAuxiliarySessions(parentSessionId);
  }

  async listAuxiliarySessionSummaries(parentSessionIds: readonly string[]): Promise<AuxiliarySessionSummary[]> {
    return this.deps.getStorage().listAuxiliarySessionSummaries(parentSessionIds);
  }

  async listAllAuxiliarySessions(): Promise<AuxiliarySession[]> {
    return this.deps.getStorage().listAllAuxiliarySessions();
  }

  async listActiveAuxiliarySessionSummaries(parentSessionIds: readonly string[]): Promise<AuxiliarySessionSummary[]> {
    return this.deps.getStorage().listActiveAuxiliarySessionSummaries(parentSessionIds);
  }

  async getActiveAuxiliarySession(parentSessionId: string): Promise<AuxiliarySession | null> {
    return this.deps.getStorage().getActiveAuxiliarySession(parentSessionId);
  }

  async getAuxiliarySession(auxiliarySessionId: string): Promise<AuxiliarySession | null> {
    const session = await this.deps.getStorage().getAuxiliarySession(auxiliarySessionId);
    if (session) this.assertCharacterSnapshotValid(session);
    return session;
  }

  async listRunningActiveAuxiliarySessions(): Promise<AuxiliarySessionSummary[]> {
    return this.deps.getStorage().listRunningActiveAuxiliarySessions();
  }

  async createAuxiliarySession(input: CreateAuxiliarySessionInput): Promise<AuxiliarySession> {
    const requestId = input.clientRequestId?.trim() ?? "";
    const creationContext = input.creationContext;
    if (requestId && creationContext !== undefined && !isCreationContext(creationContext)) {
      throw new Error("Auxiliary Session の creation context を解釈できないよ。");
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
          throw new Error("Auxiliary Session の作成要求は取り消し済みだよ。");
        }
        if (existingRecord.status === "unknown" && !existingRecord.promise) {
          throw new Error("Auxiliary Session の作成要求の取消結果を確認中だよ。");
        }
        if (!existingRecord.input || !isDeepStrictEqual(existingRecord.input, normalizedInput)) {
          throw new Error("同じ Auxiliary creation request ID に異なる入力は使えないよ。");
        }
        if (!existingRecord.promise) {
          throw new Error("Auxiliary Session の作成要求はすでに終了しているよ。");
        }
        return existingRecord.promise;
      }
      const persisted = (await storage.listAuxiliarySessions(input.parentSessionId))
        .find((summary) => summary.clientRequestId === requestId);
      const recordAfterLookup = this.creationRecords.get(key);
      if (recordAfterLookup) {
        if (recordAfterLookup.status === "cancelled" || recordAfterLookup.status === "expired") {
          throw new Error("Auxiliary Session の作成要求は取り消し済みだよ。");
        }
        if (!recordAfterLookup.input || !isDeepStrictEqual(recordAfterLookup.input, normalizedInput)) {
          throw new Error("同じ Auxiliary creation request ID に異なる入力は使えないよ。");
        }
        if (recordAfterLookup.promise) return recordAfterLookup.promise;
      }
      if (persisted) {
        const existing = await storage.getAuxiliarySession(persisted.id);
        if (!existing) throw new Error("Auxiliary Session の再送対象が見つからないよ。");
        this.assertCharacterSnapshotValid(existing);
        if (!existing.creationRequest) {
          throw new Error("継続境界以前のAuxiliary作成行はquery専用で、再作成には利用できないよ。");
        }
        if (!isDeepStrictEqual(existing.creationRequest, normalizedInput)) {
          throw new Error("同じ Auxiliary creation request ID に異なる入力は使えないよ。");
        }
        return existing;
      }
      if (creationContext.generationId !== this.getCreationOwnerGeneration(input.parentSessionId)) {
        throw new Error("Auxiliary Session の creation context が期限切れだよ。");
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
      throw new Error("親セッションが見つからないよ。");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session の保存先が作成中に切り替わったため、作成を中止したよ。");
    }
    const legacyRequestId = input.clientRequestId?.trim() ?? "";
    if (legacyRequestId) {
      const existing = (await storage.listAuxiliarySessions(input.parentSessionId))
        .find((summary) => summary.clientRequestId === legacyRequestId);
      if (existing) {
        return await this.getAuxiliarySession(existing.id) ?? (() => {
          throw new Error("Auxiliary Session の再送対象が見つからないよ。");
        })();
      }
    }
    const prepared = await this.prepareAuxiliarySession(input, parent, options);
    return this.deps.runProviderRuntimeOperationExclusive(
      () => this.deps.runCharacterAffectTurnOwnershipExclusive
        ? this.deps.runCharacterAffectTurnOwnershipExclusive(() => this.commitAuxiliarySession(input, storage, prepared))
        : this.commitAuxiliarySession(input, storage, prepared),
    );
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
      if (!parent) throw new Error("親セッションが見つからないよ。");
      if (input.creationContext && input.creationContext.parentIncarnationId !== getSessionIncarnationId(parent)) {
        throw new Error("Auxiliary Session の親セッションが置き換わったため、作成を中止したよ。");
      }
      prepared = await this.prepareAuxiliarySession(input, parent, options);
      if (record.cancelRequested) throw new Error("Auxiliary Session の作成を取り消したよ。");
    } catch (error) {
      if (record.status !== "expired") {
        record.status = record.cancelRequested ? "cancelled" : "failed";
        this.notifyCreationState(record, record.status);
      }
      throw error;
    }
    record.status = "queued";
    this.notifyCreationState(record, "queued");
    try {
      const result = await this.deps.runProviderRuntimeOperationExclusive(
        () => this.deps.runCharacterAffectTurnOwnershipExclusive
          ? this.deps.runCharacterAffectTurnOwnershipExclusive(() => this.commitAuxiliarySession(input, storage, prepared, record, normalizedInput))
          : this.commitAuxiliarySession(input, storage, prepared, record, normalizedInput),
      );
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

  async updateAuxiliarySessionThreadIfMatches(input: AuxiliarySessionThreadPatchInput): Promise<AuxiliarySession | null> {
    const storage = this.deps.getStorage();
    const patch = storage.updateAuxiliarySessionThreadIfMatches;
    if (!patch) {
      throw new Error("Auxiliary thread の条件付き更新storageが利用できないよ。");
    }
    return patch.call(storage, input);
  }

  async updateAuxiliarySessionRuntimeMetadataIfMatches(
    input: AuxiliarySessionRuntimeMetadataPatchInput,
  ): Promise<AuxiliarySession | null> {
    const storage = this.deps.getStorage();
    const patch = storage.updateAuxiliarySessionRuntimeMetadataIfMatches;
    if (!patch) {
      throw new Error("Auxiliary runtime metadata の条件付き更新storageが利用できないよ。");
    }
    return patch.call(storage, input);
  }

  private async prepareAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    parent: Session,
    options: ReturnType<AuxiliarySessionService["validateAuxiliaryInput"]>,
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

    const characterSelection = await this.resolveAuxiliaryCharacter(parent);
    return {
      parentIncarnationId,
      parentCharacterId,
      launchSelection,
      characterSelection,
    };
  }

  private async commitAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    storage: AuxiliarySessionStorageAccess,
    prepared: {
      parentIncarnationId: string;
      parentCharacterId: string;
      launchSelection: SessionLaunchSelection;
    characterSelection: Awaited<ReturnType<AuxiliarySessionService["resolveAuxiliaryCharacter"]>>;
    },
    record?: AuxiliaryCreationRecord,
    normalizedInput?: AuxiliaryCreationRequestSnapshot,
  ): Promise<AuxiliarySession> {
    if (record?.cancelRequested) {
      throw new Error("Auxiliary Session の作成を取り消したよ。");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session の保存先が作成中に切り替わったため、作成を中止したよ。");
    }
    const parent = await this.deps.getParentSession(input.parentSessionId);
    if (!parent) {
      throw new Error("親セッションが見つからないよ。");
    }
    if (
      getSessionIncarnationId(parent) !== prepared.parentIncarnationId ||
      resolveParentCharacterId(parent) !== prepared.parentCharacterId
    ) {
      throw new Error("Auxiliary Session の親セッションが作成中に置き換わったため、作成を中止したよ。");
    }

    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session の保存先が作成中に切り替わったため、作成を中止したよ。");
    }
    const requestId = input.clientRequestId?.trim() ?? "";
    if (requestId) {
      const existing = (await storage.listAuxiliarySessions(input.parentSessionId))
        .find((summary) => summary.clientRequestId === requestId);
      if (existing) {
        return await this.getAuxiliarySession(existing.id) ?? (() => {
          throw new Error("Auxiliary Session の再送対象が見つからないよ。");
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
      throw new Error("Auxiliary Session の runtime 選択が作成中に変わったため、作成を中止したよ。");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error("Auxiliary Session の保存先が作成中に切り替わったため、作成を中止したよ。");
    }

    if (!(await this.deps.listActiveCharacters()).some((entry) =>
      entry.id === prepared.characterSelection.characterId && entry.state === "active"
    )) {
      throw new Error("Auxiliary Session の Character が作成中に利用できなくなったため、作成を中止したよ。");
    }
    if (record) {
      if (record.cancelRequested) {
        throw new Error("Auxiliary Session の作成を取り消したよ。");
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
      approvalMode: resolveInitialRuntimeOption(input.approvalMode, APPROVAL_MODE_VALUES, DEFAULT_APPROVAL_MODE, "approvalMode"),
      codexSandboxMode: resolveInitialRuntimeOption(input.codexSandboxMode, CODEX_SANDBOX_MODE_VALUES, DEFAULT_CODEX_SANDBOX_MODE, "codexSandboxMode"),
      codexSpeed: resolveInitialRuntimeOption(input.codexSpeed, CODEX_SPEED_VALUES, DEFAULT_CODEX_SPEED, "codexSpeed"),
    };
  }

  private async resolveAuxiliaryCharacter(parent: Session): Promise<{
    characterId?: string;
    characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  }> {
    const listActiveCharacters = await this.deps.listActiveCharacters();
    const mainCharacterId = parent.characterRuntimeSnapshot?.characterId || parent.characterId;
    const candidates = listActiveCharacters.filter((entry) => entry.id !== mainCharacterId);
    const selectedId = selectWeightedRandomLaunchCharacterId(
      candidates,
      [],
      [],
      this.deps.randomCharacter ?? Math.random,
    );
    if (!selectedId) {
      throw new Error("Auxiliary Session に割り当て可能な Character がないよ。");
    }
    const snapshot = await this.deps.createCharacterRuntimeSnapshot(selectedId);
    if (!snapshot || snapshot.characterId !== selectedId) {
      throw new Error("Auxiliary Session の Character snapshot を作成できないよ。");
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
      throw new Error("Auxiliary Session の Provider が model catalog に存在しないよ。");
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
    if (status.runState === "running") return { outcome: "rejected" };
    return await storage.saveAuxiliaryDraft(input);
  }

  runAuxiliaryTurnWithDraft(input: {
    auxiliarySessionId: string;
    parentSessionId: string;
    incarnation: string;
    expectedDurableRevision: number;
    userMessage: string;
    run: () => Promise<void>;
  }): Promise<void> {
    return this.trackPendingDraftSend(() => this.runAuxiliaryTurnWithDraftInternal(input));
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
      run: () => Promise<void>;
    },
  ): Promise<void> {
    const storage = this.deps.getStorage();
    const captured = await storage.getAuxiliaryDraft(input.auxiliarySessionId);
    if (!captured
      || captured.parentSessionId !== input.parentSessionId
      || captured.incarnation !== input.incarnation
      || captured.durableRevision !== input.expectedDurableRevision) {
      throw new Error("Auxiliary の送信対象draftが更新されたため、送信を中止したよ。");
    }
    const consumed = await this.consumeAuxiliaryDraftWithStorage(storage, input);
    if (consumed.outcome !== "consumed" || !consumed.ack) {
      throw new Error("Auxiliary の送信対象draftが更新されたため、送信を中止したよ。");
    }
    try {
      await input.run();
    } catch (error) {
      const restore: AuxiliaryDraftSaveInput = {
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
    input: AuxiliaryDraftConsumeInput,
  ): Promise<AuxiliaryDraftConsumeResult> {
    const status = await storage.getAuxiliarySessionStatus(input.auxiliarySessionId);
    if (!status || status.parentSessionId !== input.parentSessionId || status.incarnation !== input.incarnation) {
      return { outcome: "not-found" };
    }
    if (status.runState === "running") return { outcome: "rejected" };
    return await storage.consumeAuxiliaryDraft(input);
  }

  async upsertAuxiliaryRuntimeSession(
    runtimeSession: Session,
    options: { confirmedFinalAssistantText?: string | null } = {},
  ): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(runtimeSession.id);
    if (current) this.assertCharacterSnapshotValid(current);
    if (!current) {
      throw new Error("Auxiliary Session が見つからないよ。");
    }
    const next: AuxiliarySession = {
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
    };
    const updated = await storage.updateAuxiliarySessionIfMatches({
      session: next,
      expectedSession: current,
    });
    if (!updated) throw new Error("Auxiliary Session の保存対象が削除または更新されたため、保存を中止したよ。");
    return updated;
  }

  async updateAuxiliarySession(session: AuxiliarySession): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(session.id);
    if (current) this.assertCharacterSnapshotValid(current);
    if (!current) {
      throw new Error("Auxiliary Session が見つからないよ。");
    }
    if (current.runState === "running") {
      throw new Error("実行中の Auxiliary Session は更新できないよ。");
    }

    const hasStaleRuntimeThread = session.threadId !== current.threadId && current.threadId !== "";
    const isRuntimeStalePayload =
      session.runState !== current.runState ||
      hasStaleRuntimeThread ||
      session.messages.length < current.messages.length;
    if (isRuntimeStalePayload) {
      return current;
    }
    const hasRuntimeMetadataChange =
      session.provider !== current.provider ||
      session.catalogRevision !== current.catalogRevision ||
      session.model !== current.model ||
      session.reasoningEffort !== current.reasoningEffort;
    const isExplicitRuntimeMetadataUpdate =
      hasRuntimeMetadataChange &&
      await isRuntimeMetadataInCatalog(session, await this.deps.getModelCatalogSnapshot?.());
    const shouldPreserveRuntimeMetadata =
      hasRuntimeMetadataChange &&
      !isExplicitRuntimeMetadataUpdate;
    const shouldResetRuntimeThread = hasRuntimeMetadataChange && !shouldPreserveRuntimeMetadata;

    const next: AuxiliarySession = {
      ...current,
      status: "active",
      closedAt: "",
      title: session.title,
      provider: shouldPreserveRuntimeMetadata ? current.provider : session.provider,
      catalogRevision: shouldPreserveRuntimeMetadata ? current.catalogRevision : session.catalogRevision,
      model: shouldPreserveRuntimeMetadata ? current.model : session.model,
      reasoningEffort: shouldPreserveRuntimeMetadata ? current.reasoningEffort : session.reasoningEffort,
      approvalMode: session.approvalMode,
      codexSandboxMode: session.codexSandboxMode,
      codexSpeed: session.codexSpeed,
      codexReviewer: resolveCodexReviewerUpdate(current, session.codexReviewer),
      customAgentName: session.customAgentName,
      allowedAdditionalDirectories: [...session.allowedAdditionalDirectories],
      composerDraft: current.composerDraft,
      displayAfterMessageIndex: session.displayAfterMessageIndex,
      threadId: shouldResetRuntimeThread ? "" : current.threadId,
      updatedAt: currentTimestampLabel(),
    };
    const updated = await storage.updateAuxiliarySessionIfMatches({
      session: next,
      expectedSession: current,
    });
    if (!updated) throw new Error("Auxiliary Session の保存対象が削除または更新されたため、保存を中止したよ。");
    return updated;
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
      throw new Error("Auxiliary Session が見つからないよ。");
    }
    if (current.runState === "running") {
      throw new Error("実行中の Auxiliary Session は終了できないよ。");
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
    if (!updated) throw new Error("Auxiliary Session の保存対象が削除または更新されたため、終了を中止したよ。");
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
      throw new Error("親セッションが見つからないよ。");
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
      throw new Error("Auxiliary Session の Character snapshot が不正だよ。会話を親 Characterへ差し替えず、再確認が必要です。");
    }
  }
}
