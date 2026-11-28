import { randomUUID } from "node:crypto";
import {
  validateSessionMetadataPatch,
  type SessionMetadataPatch,
} from "../../src-shared/session/session-metadata.js";
import { isDeepStrictEqual } from "node:util";
import { resolveCodexReviewerUpdate } from "../../src-shared/settings/codex-reviewer.js";

import { currentTimestampLabel } from "../../src-shared/time-state.js";
import {
  APPROVAL_MODE_VALUES,
  DEFAULT_APPROVAL_MODE,
} from "../../src-shared/settings/approval-mode.js";
import {
  getApprovalOptionsForProvider,
  getApprovalReviewerOptionsForProvider,
  getDefaultApprovalModeForProvider,
  resolveExecutionOptionsReviewerUpdate,
} from "../../src-shared/settings/provider-runtime-options.js";
import { supportsWithMateAutoReview } from "../../src-shared/settings/withmate-auto-review.js";
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
import {
  CODEX_SPEED_VALUES,
  DEFAULT_CODEX_SPEED,
} from "../../src-shared/settings/codex-speed.js";
import { DEFAULT_CODEX_REVIEWER } from "../../src-shared/settings/codex-reviewer.js";
import {
  resolveModelSelection,
  getProviderCatalog,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import {
  getSessionIncarnationId,
  type Session,
  type TurnInputDeliveryState,
} from "../../src-shared/session/session-state.js";
import type { ComposerAttachment } from "../../src-shared/session/runtime-state.js";
import {
  validateSessionExecutionOptions,
  type SessionExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import type {
  SetExecutionOptionsResult,
  SetAuxiliaryExecutionOptionsRequest,
  SetAuxiliaryTitleRequest,
  SetAuxiliaryMessageBookmarkRequest,
} from "../../src-shared/session/session-mutation-contract.js";
import type {
  CharacterCatalogEntry,
  CharacterRuntimeSnapshot,
} from "../../src-shared/character/character-catalog.js";
import { selectWeightedRandomLaunchCharacterId } from "../../src-shared/character/launch-character-selection.js";
import type {
  Awaitable,
  AuxiliarySessionStorageAccess,
} from "../storage/persistent-store-lifecycle-service.js";
import type { SessionLaunchSelection } from "../session/session-launch-selection-service.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";
import type {
  AuxiliarySessionThreadPatchInput,
  AuxiliaryThreadPatchResult,
  AuxiliaryRuntimeMetadataPatchResult,
} from "./auxiliary-session-storage.js";
import type { AuxiliarySessionRuntimeMetadataPatchInput } from "./auxiliary-session-storage.js";
import type {
  AuxiliaryDraftStorageSaveInput,
  AuxiliaryDraftStorageConsumeInput,
} from "./auxiliary-session-storage.js";
import { assertCharacterDefinitionSnapshotUpdate } from "../session/session-running-turn-start.js";
import type { SessionTurnTerminalCommit } from "../session/session-turn-terminal-commit.js";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";
import type {
  AuxiliaryDraftConsumeResult,
  AuxiliaryDraftRecord,
  AuxiliaryDraftSaveInput,
  AuxiliaryDraftSaveResult,
  AuxiliarySessionStatus,
} from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

/** Auxiliary の作成・更新に使う永続化、親セッション、Provider と実行中状態への依存。 */
type AuxiliarySessionServiceDeps = {
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  /** 指定した Provider と Workspace に対し、直近セッションを基に起動時の実行設定を決める。 */
  resolveSessionLaunchSelection(
    providerId?: string | null,
    workspacePath?: string,
  ): Promise<SessionLaunchSelection>;
  /** 親の世代、アクセス状態、実行設定を参照する元の親セッションを取得する。 */
  getParentSession(parentSessionId: string): Awaitable<Session | null>;
  /** 現在の Auxiliary の保存先を返す。待機をまたぐ処理では返された保存先の同一性も確認する。 */
  getStorage(): AuxiliarySessionStorageAccess;
  /** 明示指定のモデルや実行設定を検証するカタログを、指定の Workspace・Provider を基に取得する。 */
  getModelCatalogSnapshot?(
    workspacePath?: string,
    providerId?: string,
  ): Awaitable<ModelCatalogSnapshot | null>;
  /** Auxiliary 作成時の Character 選択および確定直前の再確認に使う一覧を取得する。 */
  listActiveCharacters(): Awaitable<readonly CharacterCatalogEntry[]>;
  /** 選んだ Character の定義と表示情報を作成時点のスナップショットに固定する。 */
  createCharacterRuntimeSnapshot(
    characterId: string,
  ): Awaitable<CharacterRuntimeSnapshot | null>;
  randomCharacter?: () => number;
  /** 作成要求の状態遷移を要求 ID と世代にひも付けて通知する。 */
  onCreationStateChanged?(result: AuxiliaryCreationStateChange): void;
  /** 実行メッセージの永続化が完了した親セッションを通知する。 */
  onRuntimeMessagesCommitted?(parentSessionId: string): void;
  /** 読み取りや更新の開始時点で現在の保存先を識別する値を取得する。 */
  captureStorageIdentity?(): unknown;
  /** 待機をまたいで保存先が切り替わっていないか、開始時点の値と照合する。 */
  isStorageIdentityCurrent?(identity: unknown): boolean;
  /** 保存上の実行状態にまだ反映されていないものも含め、実行が進行中かを確認する。 */
  isAuxiliaryRunInFlight?(auxiliarySessionId: string): boolean;
  /** 実行中の Auxiliary が追加入力を受け付けられるかを判定する。 */
  canAcceptAuxiliaryInput?(auxiliarySessionId: string): boolean;
  /** 保存の完了とは独立に、受理した実行設定を現在の選択として記録する。 */
  rememberExecutionOptions?(
    session: AuxiliarySessionSummary,
    options: SessionExecutionOptions,
  ): void;
  /** 取得した Auxiliary の記録に、保存待ちまたは保存失敗時も保持される現在の実行設定を反映する。 */
  overlayCurrentExecutionOptions?<T extends AuxiliarySessionSummary>(
    session: T,
  ): T;
};

/** 一つの作成要求について、正規化済みの入力、取消要求、進行状態と処理結果を追跡する。 */
type AuxiliaryCreationRecord = {
  request: AuxiliaryCreationRequest;
  input?: AuxiliaryCreationRequestSnapshot;
  status: AuxiliaryCreationResult["status"];
  cancelRequested: boolean;
  promise?: Promise<AuxiliarySession>;
  auxiliarySessionId?: string;
};

/** 再送時に同じ作成入力か判定できるよう、指定された項目を維持したまま文字列の前後の空白を除く。 */
function normalizeCreationInput(
  input: CreateAuxiliarySessionInput,
): AuxiliaryCreationRequestSnapshot {
  const normalized: AuxiliaryCreationRequestSnapshot = {
    parentSessionId: input.parentSessionId.trim(),
    provider: input.provider.trim(),
    clientRequestId: input.clientRequestId?.trim() ?? "",
  };
  if (input.runtimeSelection !== undefined)
    normalized.runtimeSelection = input.runtimeSelection;
  if (input.model !== undefined) normalized.model = input.model.trim();
  if (input.reasoningEffort !== undefined)
    normalized.reasoningEffort = input.reasoningEffort;
  if (input.approvalMode !== undefined)
    normalized.approvalMode = input.approvalMode;
  if (input.codexSandboxMode !== undefined)
    normalized.codexSandboxMode = input.codexSandboxMode;
  if (input.codexSpeed !== undefined) normalized.codexSpeed = input.codexSpeed;
  if (input.customAgentName !== undefined)
    normalized.customAgentName = input.customAgentName.trim();
  return normalized;
}

/** 作成世代と親の世代を表す両方のフィールドが文字列かを調べる。 */
function isCreationContext(value: unknown): value is AuxiliaryCreationContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AuxiliaryCreationContext).generationId === "string" &&
    typeof (value as AuxiliaryCreationContext).parentIncarnationId === "string"
  );
}

/** 指定値またはカタログ既定値でモデルと推論強度を解決する。モデル候補がなければ作成を拒否する。 */
function resolveInitialModelSelection(
  input: CreateAuxiliarySessionInput,
  providerCatalog: ModelCatalogProvider,
) {
  if (!(input.model ?? providerCatalog.defaultModelId).trim()) {
    throw new Error(
      `Provider ${providerCatalog.id} has no available model. Complete model discovery before creating an Auxiliary Session.`,
    );
  }
  return resolveModelSelection(
    providerCatalog,
    input.model ?? providerCatalog.defaultModelId,
    input.reasoningEffort ?? providerCatalog.defaultReasoningEffort,
  );
}

/** 設定が省略されたときだけ既定値を返し、指定された値は許可一覧に含まれることを確認する。 */
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

/** 省略時は明示指定として扱い、既知の実行設定選択方式だけを受理する。 */
function resolveRuntimeSelectionMode(
  value: unknown,
): AuxiliaryRuntimeSelectionMode {
  if (value === undefined || value === "explicit") {
    return "explicit";
  }
  if (value === "latest-session") {
    return value;
  }
  throw new Error("Could not parse the Auxiliary Session runtime selection.");
}

/** 直近セッションから設定を引き継ぐ要求に、個別の実行設定が混在していないことを確認する。 */
function assertLatestSessionRuntimeFieldsAbsent(
  input: CreateAuxiliarySessionInput,
): void {
  if (
    input.model !== undefined ||
    input.reasoningEffort !== undefined ||
    input.approvalMode !== undefined ||
    input.codexSandboxMode !== undefined ||
    input.codexSpeed !== undefined ||
    input.customAgentName !== undefined
  ) {
    throw new Error(
      "Runtime options cannot be specified when using latest-session selection.",
    );
  }
}

/** 親の Character をスナップショットの ID、保存済み ID の順で特定する。 */
function resolveParentCharacterId(parent: Session): string {
  return (
    parent.characterRuntimeSnapshot?.characterId || parent.characterId || ""
  );
}

/** Auxiliary の作成要求を世代単位で調停し、保存済みの会話、実行状態と下書きの更新を仲介する。 */
export class AuxiliarySessionService {
  private readonly creationRecords = new Map<string, AuxiliaryCreationRecord>();
  private readonly creationOwnerGenerations = new Map<string, string>();
  private readonly pendingDraftSends = new Set<Promise<void>>();
  private readonly failedDraftRestores =
    new Set<AuxiliaryDraftStorageSaveInput>();
  private creationStorage: AuxiliarySessionStorageAccess | null = null;
  private creationGenerationId = randomUUID();
  private readonly selectionCheckpoints = new Map<string, Promise<void>>();
  private readonly selectionRequestRevisions = new Map<string, number>();

  /** 現在の親と保存先を取得する依存、および実行設定の解決や状態通知に使う依存を保持する。 */
  constructor(private readonly deps: AuxiliarySessionServiceDeps) {}

  /** 現在の実行設定を反映する依存がなければ、取得した保存記録をそのまま返す。 */
  private overlayExecutionOptions<T extends AuxiliarySessionSummary>(
    session: T,
  ): T {
    return this.deps.overlayCurrentExecutionOptions?.(session) ?? session;
  }

  /** 保存先の参照か識別値が開始時点から変わっていれば、古い保存先を前提とした処理を中断する。 */
  private assertStorageIdentity(
    storage: AuxiliarySessionStorageAccess,
    identity: unknown,
  ): void {
    if (
      this.deps.getStorage() !== storage ||
      (this.deps.isStorageIdentityCurrent &&
        !this.deps.isStorageIdentityCurrent(identity))
    ) {
      throw new Error("The Auxiliary Session storage changed.");
    }
  }

  /** 作成要求に添える親の世代と、現在の作成受付を識別する世代を取得する。 */
  async getAuxiliaryCreationContext(
    parentSessionId: string,
  ): Promise<AuxiliaryCreationContext> {
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

  /** 進行中の作成記録と保存済み要求 ID を突き合わせ、作成の確定、取消、未検出や世代失効を区別する。 */
  async getAuxiliaryCreation(
    request: AuxiliaryCreationRequest,
  ): Promise<AuxiliaryCreationResult> {
    const storage = this.deps.getStorage();
    this.syncCreationStorage(storage);
    const key = this.creationKey(request);
    const record = this.creationRecords.get(key);
    if (record && record.status !== "unknown") {
      return {
        status: record.status,
        auxiliarySessionId: record.auxiliarySessionId,
      };
    }
    const existing = (
      await storage.listAuxiliarySessions(request.parentSessionId)
    ).find((summary) => summary.clientRequestId === request.clientRequestId);
    if (
      record?.cancelRequested &&
      !record.promise &&
      (this.deps.getStorage() !== storage || record.status === "expired")
    ) {
      this.syncCreationStorage(this.deps.getStorage());
      this.creationRecords.delete(key);
      return { status: "expired" };
    }
    if (record && record.status !== "unknown") {
      return {
        status: record.status,
        auxiliarySessionId: record.auxiliarySessionId,
      };
    }
    if (existing) {
      if (record) {
        record.status = "committed";
        record.auxiliarySessionId = existing.id;
        if (
          record.cancelRequested &&
          !record.promise &&
          this.creationRecords.get(key) === record
        ) {
          this.creationRecords.delete(key);
        }
        this.notifyCreationState(record, "committed", existing.id);
      }
      return { status: "committed", auxiliarySessionId: existing.id };
    }
    if (
      record?.status === "unknown" &&
      record.cancelRequested &&
      !record.promise
    ) {
      record.status = "cancelled";
      this.retireCancelledCreation(record);
      this.notifyCreationState(record, "cancelled");
      return { status: "cancelled" };
    }
    if (record?.status === "unknown") {
      return { status: "unknown" };
    }
    return request.creationContext.generationId ===
      this.getCreationOwnerGeneration(request.parentSessionId)
      ? { status: "not-found" }
      : { status: "expired" };
  }

  /** 保存確定に入る前の作成を取り消す。未登録の要求は取消記録を先に確保し、保存の有無を確認する。 */
  async cancelAuxiliaryCreation(
    request: AuxiliaryCreationRequest,
  ): Promise<AuxiliaryCreationResult> {
    const storage = this.deps.getStorage();
    this.syncCreationStorage(storage);
    const key = this.creationKey(request);
    const record = this.creationRecords.get(key);
    if (!record) {
      if (
        request.creationContext.generationId !==
        this.getCreationOwnerGeneration(request.parentSessionId)
      ) {
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
        existing = (
          await storage.listAuxiliarySessions(request.parentSessionId)
        ).find(
          (summary) => summary.clientRequestId === request.clientRequestId,
        );
      } catch {
        lookupFailed = true;
      }
      if (
        this.deps.getStorage() !== storage ||
        tombstone.status === "expired"
      ) {
        this.syncCreationStorage(this.deps.getStorage());
        this.creationRecords.delete(key);
        return { status: "expired" };
      }
      if (tombstone.status !== "unknown") {
        if (
          tombstone.status === "committed" &&
          this.creationRecords.get(key) === tombstone
        ) {
          this.creationRecords.delete(key);
        }
        return {
          status: tombstone.status,
          auxiliarySessionId: tombstone.auxiliarySessionId,
        };
      }
      if (this.creationRecords.get(key) !== tombstone)
        return { status: "expired" };
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
    return {
      status: record.status,
      auxiliarySessionId: record.auxiliarySessionId,
    };
  }

  /** 親の作成受付を更新し、その親について準備中・待機中の要求や未確定の先行取消を失効させる。 */
  releaseAuxiliaryCreationOwner(parentSessionId: string): void {
    for (const record of this.creationRecords.values()) {
      if (
        record.request.parentSessionId === parentSessionId &&
        (record.status === "preparing" ||
          record.status === "queued" ||
          (record.status === "unknown" &&
            record.cancelRequested &&
            !record.promise))
      ) {
        record.cancelRequested = true;
        record.status = "expired";
        this.notifyCreationState(record, "expired");
      }
      if (
        record.request.parentSessionId === parentSessionId &&
        record.status === "expired" &&
        !record.promise
      ) {
        this.creationRecords.delete(this.creationKey(record.request));
      }
    }
    this.creationOwnerGenerations.set(parentSessionId, randomUUID());
  }

  /** 一つの親に属する Auxiliary の要約に、現在の実行設定を反映して返す。 */
  async listAuxiliarySessions(
    parentSessionId: string,
  ): Promise<AuxiliarySessionSummary[]> {
    return (
      await this.deps.getStorage().listAuxiliarySessions(parentSessionId)
    ).map((session) => this.overlayExecutionOptions(session));
  }

  /** 複数の親に属する Auxiliary の要約をまとめて読み、現在の実行設定を反映する。 */
  async listAuxiliarySessionSummaries(
    parentSessionIds: readonly string[],
  ): Promise<AuxiliarySessionSummary[]> {
    return (
      await this.deps
        .getStorage()
        .listAuxiliarySessionSummaries(parentSessionIds)
    ).map((session) => this.overlayExecutionOptions(session));
  }

  /** 親を限定せずに保存済み Auxiliary を列挙し、現在の実行設定を反映する。 */
  async listAllAuxiliarySessions(): Promise<AuxiliarySession[]> {
    return (await this.deps.getStorage().listAllAuxiliarySessions()).map(
      (session) => this.overlayExecutionOptions(session),
    );
  }

  /** 指定した親の最新の Auxiliary を保存先から取得する。該当がなければ null を返す。 */
  async getLatestAuxiliarySession(
    parentSessionId: string,
  ): Promise<AuxiliarySession | null> {
    const session = await this.deps
      .getStorage()
      .getLatestAuxiliarySession(parentSessionId);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  /** 指定 ID の Auxiliary を履歴込みで取得し、Character スナップショットの破損を拒否する。 */
  async getAuxiliarySession(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySession | null> {
    const session = await this.deps
      .getStorage()
      .getAuxiliarySession(auxiliarySessionId);
    if (session) this.assertCharacterSnapshotValid(session);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  /** 指定 ID の Auxiliary の実行用メタデータを読み、Character スナップショットの破損を拒否する。 */
  async getAuxiliarySessionMetadata(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySession | null> {
    const session = await this.deps
      .getStorage()
      .getAuxiliarySessionMetadata(auxiliarySessionId);
    if (session) this.assertCharacterSnapshotValid(session);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  /** 保存先が用意する指定 ID の表示用データに、現在の実行設定を反映して返す。 */
  async getAuxiliarySessionView(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySession | null> {
    const session = await this.deps
      .getStorage()
      .getAuxiliarySessionView(auxiliarySessionId);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  /** 親の最新 Auxiliary の表示用データを取得し、待機中に保存先が切り替わっていないことを確認する。 */
  async getLatestAuxiliarySessionView(
    parentSessionId: string,
  ): Promise<AuxiliarySession | null> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const session =
      await storage.getLatestAuxiliarySessionView(parentSessionId);
    this.assertStorageIdentity(storage, identity);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  /** 指定 ID の要約に現在の実行設定を反映する。該当がなければ null を返す。 */
  async getAuxiliarySessionSummary(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySessionSummary | null> {
    const session = await this.deps
      .getStorage()
      .getAuxiliarySessionSummary(auxiliarySessionId);
    return session ? this.overlayExecutionOptions(session) : null;
  }

  /** 更新対象の要約を読み、保存先・親 ID・作成日時が要求時の対象と一致することを確認する。 */
  private async getMutationTarget(request: {
    auxiliarySessionId: string;
    parentSessionId: string;
    createdAt: string;
  }): Promise<{
    storage: AuxiliarySessionStorageAccess;
    identity: unknown;
    session: AuxiliarySessionSummary;
  }> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const session = await storage.getAuxiliarySessionSummary(
      request.auxiliarySessionId,
    );
    this.assertStorageIdentity(storage, identity);
    if (
      !session ||
      session.parentSessionId !== request.parentSessionId ||
      session.createdAt !== request.createdAt
    ) {
      throw new Error(
        "The Auxiliary Session could not be found or has changed.",
      );
    }
    return {
      storage,
      identity,
      session: this.overlayExecutionOptions(session),
    };
  }

  /** 実行中でない Auxiliary に、空白だけではないタイトルを対象の同一性を条件として保存する。 */
  async setAuxiliaryTitle(request: SetAuxiliaryTitleRequest): Promise<void> {
    const { storage, session } = await this.getMutationTarget(request);
    if (session.runState === "running")
      throw new Error("A running Auxiliary Session cannot be updated.");
    if (typeof request.title !== "string" || !request.title.trim()) {
      throw new Error("The Auxiliary Session title cannot be empty.");
    }
    const updated = await storage.updateAuxiliaryTitleIfMatches({
      ...request,
      updatedAt: currentTimestampLabel(),
    });
    if (!updated)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
  }

  /** メタデータパッチを検証し、呼び出し元の再確認後に保存して更新後の要約を返す。 */
  async patchAuxiliarySessionMetadata(
    request: {
      auxiliarySessionId: string;
      parentSessionId: string;
      createdAt: string;
      patch: SessionMetadataPatch;
    },
    assertCurrent?: () => void,
  ): Promise<AuxiliarySessionSummary> {
    const patch = validateSessionMetadataPatch(request.patch);
    const { storage, identity } = await this.getMutationTarget(request);
    assertCurrent?.();
    const result = await storage.patchAuxiliarySessionMetadata({
      ...request,
      patch,
      updatedAt: currentTimestampLabel(),
    });
    this.assertStorageIdentity(storage, identity);
    return result;
  }

  /** 非負のメッセージ番号と真偽値の指定を検証し、対象が変わっていなければブックマークを保存する。 */
  async setAuxiliaryMessageBookmark(
    request: SetAuxiliaryMessageBookmarkRequest,
  ): Promise<void> {
    const { storage } = await this.getMutationTarget(request);
    if (
      !Number.isInteger(request.messageIndex) ||
      request.messageIndex < 0 ||
      typeof request.isBookmarked !== "boolean"
    ) {
      throw new Error("The Auxiliary message bookmark is invalid.");
    }
    const updated = await storage.updateAuxiliaryMessageBookmarkIfMatches({
      ...request,
      updatedAt: currentTimestampLabel(),
    });
    if (!updated)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
  }

  /** 最新の有効な選択だけを受理し、現在の値を反映したうえで Auxiliary ごとに順に保存する。受理と保存の成否は別に返す。 */
  async setAuxiliaryExecutionOptions(
    request: SetAuxiliaryExecutionOptionsRequest,
  ): Promise<SetExecutionOptionsResult> {
    const selectionKey = `${request.auxiliarySessionId}:${request.createdAt}`;
    const revision =
      (this.selectionRequestRevisions.get(selectionKey) ?? 0) + 1;
    this.selectionRequestRevisions.set(selectionKey, revision);
    const { storage, identity, session } =
      await this.getMutationTarget(request);
    const snapshot = await this.deps.getModelCatalogSnapshot?.();
    if (this.selectionRequestRevisions.get(selectionKey) !== revision)
      return { status: "superseded" };
    const current = await storage.getAuxiliarySessionSummary(
      request.auxiliarySessionId,
    );
    this.assertStorageIdentity(storage, identity);
    if (
      !current ||
      current.parentSessionId !== request.parentSessionId ||
      current.createdAt !== request.createdAt
    ) {
      throw new Error(
        "The Auxiliary Session could not be found or has changed.",
      );
    }
    if (this.selectionRequestRevisions.get(selectionKey) !== revision)
      return { status: "superseded" };
    const fresh = this.overlayExecutionOptions(current);
    const parent = await this.deps.getParentSession(fresh.parentSessionId);
    this.assertStorageIdentity(storage, identity);
    if (!parent || parent.accessMode !== "active")
      throw new Error("The parent Session is unavailable or read-only.");
    if (this.selectionRequestRevisions.get(selectionKey) !== revision)
      return { status: "superseded" };
    const provider = getProviderCatalog(
      snapshot?.providers ?? [],
      fresh.provider,
    );
    if (!snapshot || !provider || provider.id !== session.provider) {
      throw new Error(
        "The Auxiliary Session provider is not in the model catalog.",
      );
    }
    const { withMateReviewerExplicit: _explicit, ...requested } =
      validateSessionExecutionOptions(request.executionOptions, provider);
    const options = {
      ...requested,
      ...resolveExecutionOptionsReviewerUpdate(
        fresh,
        requested,
        request.confirmedReviewerChange,
        request.approvalChoice,
      ),
    };
    if (options.codexReviewer !== request.executionOptions.codexReviewer)
      validateSessionExecutionOptions(options, provider);
    this.assertStorageIdentity(storage, identity);
    if (this.selectionRequestRevisions.get(selectionKey) !== revision)
      return { status: "superseded" };
    this.deps.rememberExecutionOptions?.(fresh, options);
    const previous =
      this.selectionCheckpoints.get(session.id) ?? Promise.resolve();
    const checkpoint = previous
      .catch(() => {})
      .then(async () => {
        this.assertStorageIdentity(storage, identity);
        const updated = await storage.updateAuxiliaryExecutionOptionsIfMatches({
          ...request,
          options: { provider: session.provider, ...options },
          updatedAt: currentTimestampLabel(),
        });
        if (!updated)
          throw new Error(
            "Saving was canceled because the Auxiliary Session was deleted or changed.",
          );
      });
    this.selectionCheckpoints.set(session.id, checkpoint);
    try {
      await checkpoint;
      return { status: "accepted", checkpointSaved: true };
    } catch {
      return { status: "accepted", checkpointSaved: false };
    } finally {
      if (this.selectionCheckpoints.get(session.id) === checkpoint)
        this.selectionCheckpoints.delete(session.id);
    }
  }

  /** 親履歴の件数を末尾のインデックスに換算し、表示アンカーが未設定のときだけ保存する。 */
  async setAuxiliaryDisplayAnchor(
    auxiliarySessionId: string,
    parentMessageCount: number,
  ): Promise<void> {
    if (!Number.isInteger(parentMessageCount) || parentMessageCount < 0) {
      throw new Error("The Auxiliary display anchor is invalid.");
    }
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const session =
      await storage.getAuxiliarySessionSummary(auxiliarySessionId);
    this.assertStorageIdentity(storage, identity);
    if (!session) throw new Error("The Auxiliary Session could not be found.");
    if (session.displayAfterMessageIndex !== null) return;
    const updated = await storage.updateAuxiliaryDisplayAnchorIfMatches({
      auxiliarySessionId: session.id,
      parentSessionId: session.parentSessionId,
      createdAt: session.createdAt,
      displayAfterMessageIndex: parentMessageCount - 1,
      updatedAt: currentTimestampLabel(),
    });
    if (!updated)
      throw new Error("Saving the Auxiliary display anchor was canceled.");
  }

  /** 保存先で実行中とされる Auxiliary の要約に、現在の実行設定を反映する。 */
  async listRunningAuxiliarySessions(): Promise<AuxiliarySessionSummary[]> {
    return (await this.deps.getStorage().listRunningAuxiliarySessions()).map(
      (session) => this.overlayExecutionOptions(session),
    );
  }

  /** 準備と確定を経て Auxiliary を作る。作成コンテキスト付きの同一要求は、入力が一致する場合だけ進行中の処理や保存結果を共有する。 */
  async createAuxiliarySession(
    input: CreateAuxiliarySessionInput,
  ): Promise<AuxiliarySession> {
    const requestId = input.clientRequestId?.trim() ?? "";
    const creationContext = input.creationContext;
    if (
      requestId &&
      creationContext !== undefined &&
      !isCreationContext(creationContext)
    ) {
      throw new Error(
        "Could not parse the Auxiliary Session creation context.",
      );
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
        if (
          existingRecord.status === "cancelled" ||
          existingRecord.status === "expired"
        ) {
          throw new Error(
            "The Auxiliary Session creation request was canceled.",
          );
        }
        if (existingRecord.status === "unknown" && !existingRecord.promise) {
          throw new Error(
            "The Auxiliary Session creation cancellation is still being confirmed.",
          );
        }
        if (
          !existingRecord.input ||
          !isDeepStrictEqual(existingRecord.input, normalizedInput)
        ) {
          throw new Error(
            "The same Auxiliary creation request ID cannot be used with different input.",
          );
        }
        if (!existingRecord.promise) {
          throw new Error(
            "The Auxiliary Session creation request has already finished.",
          );
        }
        return existingRecord.promise;
      }
      const persisted = (
        await storage.listAuxiliarySessions(input.parentSessionId)
      ).find((summary) => summary.clientRequestId === requestId);
      const recordAfterLookup = this.creationRecords.get(key);
      if (recordAfterLookup) {
        if (
          recordAfterLookup.status === "cancelled" ||
          recordAfterLookup.status === "expired"
        ) {
          throw new Error(
            "The Auxiliary Session creation request was canceled.",
          );
        }
        if (
          !recordAfterLookup.input ||
          !isDeepStrictEqual(recordAfterLookup.input, normalizedInput)
        ) {
          throw new Error(
            "The same Auxiliary creation request ID cannot be used with different input.",
          );
        }
        if (recordAfterLookup.promise) return recordAfterLookup.promise;
      }
      if (persisted) {
        const existing = await storage.getAuxiliarySession(persisted.id);
        if (!existing)
          throw new Error(
            "The Auxiliary Session retry target could not be found.",
          );
        this.assertCharacterSnapshotValid(existing);
        if (!existing.creationRequest) {
          throw new Error(
            "Auxiliary creation records before the continuity boundary are query-only and cannot be recreated.",
          );
        }
        if (!isDeepStrictEqual(existing.creationRequest, normalizedInput)) {
          throw new Error(
            "The same Auxiliary creation request ID cannot be used with different input.",
          );
        }
        return existing;
      }
      if (
        creationContext.generationId !==
        this.getCreationOwnerGeneration(input.parentSessionId)
      ) {
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
            (record.status === "committed" ||
              record.status === "failed" ||
              record.status === "expired") &&
            this.creationRecords.get(key) === record
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
      throw new Error(
        "Auxiliary Session creation was canceled because its storage changed during creation.",
      );
    }
    const legacyRequestId = input.clientRequestId?.trim() ?? "";
    if (legacyRequestId) {
      const existing = (
        await storage.listAuxiliarySessions(input.parentSessionId)
      ).find((summary) => summary.clientRequestId === legacyRequestId);
      if (existing) {
        return (
          (await this.getAuxiliarySession(existing.id)) ??
          (() => {
            throw new Error(
              "The Auxiliary Session retry target could not be found.",
            );
          })()
        );
      }
    }
    const prepared = await this.prepareAuxiliarySession(
      input,
      parent,
      options,
      storage,
    );
    return this.commitPreparedAuxiliarySession(input, storage, prepared);
  }

  /** 要求の世代と取消を確認して作成を進め、確定中の例外では保存結果不明、それ以前の例外では取消か失敗を通知する。 */
  private async runAuxiliaryCreation(
    input: CreateAuxiliarySessionInput,
    record: AuxiliaryCreationRecord,
    normalizedInput: AuxiliaryCreationRequestSnapshot,
  ): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    let prepared: Awaited<
      ReturnType<AuxiliarySessionService["prepareAuxiliarySession"]>
    >;
    try {
      const options = this.validateAuxiliaryInput(input);
      const parent = await this.deps.getParentSession(input.parentSessionId);
      if (!parent) throw new Error("The parent session could not be found.");
      if (
        input.creationContext &&
        input.creationContext.parentIncarnationId !==
          getSessionIncarnationId(parent)
      ) {
        throw new Error(
          "Auxiliary Session creation was canceled because its parent session changed during creation.",
        );
      }
      prepared = await this.prepareAuxiliarySession(
        input,
        parent,
        options,
        storage,
      );
      if (record.cancelRequested)
        throw new Error("Auxiliary Session creation was canceled.");
    } catch (error) {
      if (record.status !== "expired") {
        record.status = record.cancelRequested ? "cancelled" : "failed";
        this.notifyCreationState(record, record.status);
      }
      throw error;
    }
    try {
      const result = await this.commitPreparedAuxiliarySession(
        input,
        storage,
        prepared,
        record,
        normalizedInput,
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

  /** 保存先が切り替わったときに受付世代を更新し、旧保存先の準備・待機中または結果不明の要求を失効させる。 */
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

  /** 作成受付世代、親 ID とその世代、クライアントの要求 ID を組み合わせて追跡キーを作る。 */
  private creationKey(request: AuxiliaryCreationRequest): string {
    return `${request.creationContext.generationId}:${request.parentSessionId}:${request.creationContext.parentIncarnationId}:${request.clientRequestId}`;
  }

  /** 取消記録を破棄する前に、その要求の受付世代がまだ現行なら更新し、遅延要求を受理しないようにする。 */
  private retireCancelledCreation(record: AuxiliaryCreationRecord): void {
    const key = this.creationKey(record.request);
    if (this.creationRecords.get(key) !== record) return;
    const { parentSessionId, creationContext } = record.request;
    if (
      this.getCreationOwnerGeneration(parentSessionId) ===
      creationContext.generationId
    ) {
      // キャンセルの記録を破棄する前に、遅れて到着した要求が受理されないようにする。
      // 受理済みの要求は記録を維持し、そのまま完了できる場合がある。
      this.creationOwnerGenerations.set(parentSessionId, randomUUID());
    }
    this.creationRecords.delete(key);
  }

  /** 親に固有の受付世代がなければ、現在の保存先の既定世代を割り当てる。 */
  private getCreationOwnerGeneration(parentSessionId: string): string {
    const current = this.creationOwnerGenerations.get(parentSessionId);
    if (current) return current;
    const next = this.creationGenerationId;
    this.creationOwnerGenerations.set(parentSessionId, next);
    return next;
  }

  /** 保存先が対応している場合に、Auxiliary のスレッドを条件付きで更新する。 */
  async updateAuxiliarySessionThreadIfMatches(
    input: AuxiliarySessionThreadPatchInput,
  ): Promise<AuxiliaryThreadPatchResult | null> {
    const storage = this.deps.getStorage();
    const patch = storage.updateAuxiliarySessionThreadIfMatches;
    if (!patch) {
      throw new Error(
        "Auxiliary thread storage is unavailable for conditional updates.",
      );
    }
    return patch.call(storage, input);
  }

  /** 保存先が対応している場合に、Auxiliary の実行メタデータを条件付きで更新する。 */
  async updateAuxiliarySessionRuntimeMetadataIfMatches(
    input: AuxiliarySessionRuntimeMetadataPatchInput,
  ): Promise<AuxiliaryRuntimeMetadataPatchResult | null> {
    const storage = this.deps.getStorage();
    const patch = storage.updateAuxiliarySessionRuntimeMetadataIfMatches;
    if (!patch) {
      throw new Error(
        "Auxiliary runtime metadata storage is unavailable for conditional updates.",
      );
    }
    return patch.call(storage, input);
  }

  /** 親の世代と Character を控え、排他区間へ入る前に起動設定と Auxiliary の Character 候補を解決する。 */
  private async prepareAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    parent: Session,
    options: ReturnType<AuxiliarySessionService["validateAuxiliaryInput"]>,
    storage: AuxiliarySessionStorageAccess,
  ): Promise<{
    parentIncarnationId: string;
    parentCharacterId: string;
    launchSelection: SessionLaunchSelection;
    characterSelection: Awaited<
      ReturnType<AuxiliarySessionService["resolveAuxiliaryCharacter"]>
    >;
  }> {
    const parentIncarnationId = getSessionIncarnationId(parent);
    const parentCharacterId = resolveParentCharacterId(parent);
    const launchSelection =
      options.runtimeSelectionMode === "latest-session"
        ? await this.deps.resolveSessionLaunchSelection(
            input.provider,
            parent.workspacePath,
          )
        : await this.resolveExplicitLaunchSelection(
            input,
            options.approvalMode,
            options.codexSandboxMode,
            options.codexSpeed,
            parent.workspacePath,
          );

    const characterSelection = await this.resolveAuxiliaryCharacter(
      parentCharacterId,
      storage,
      input.parentSessionId,
    );
    return {
      parentIncarnationId,
      parentCharacterId,
      launchSelection,
      characterSelection,
    };
  }

  /** Provider 操作との排他内で作成を試み、Character が競合した場合は排他を解放して候補を選び直す。 */
  private async commitPreparedAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    storage: AuxiliarySessionStorageAccess,
    prepared: Awaited<
      ReturnType<AuxiliarySessionService["prepareAuxiliarySession"]>
    >,
    record?: AuxiliaryCreationRecord,
    normalizedInput?: AuxiliaryCreationRequestSnapshot,
  ): Promise<AuxiliarySession> {
    for (;;) {
      if (record?.cancelRequested)
        throw new Error("Auxiliary Session creation was canceled.");
      if (record) {
        record.status = "queued";
        this.notifyCreationState(record, "queued");
      }
      const result = await this.deps.runProviderRuntimeOperationExclusive(() =>
        this.commitAuxiliarySession(
          input,
          storage,
          prepared,
          record,
          normalizedInput,
        ),
      );
      if (result) return result;

      // 確定前に兄弟 Session がこの Character を確保した。広い範囲を調整する coordinator の外で準備し直し、
      // 次の試行で確定時のすべての条件を再検証する。
      if (record?.cancelRequested)
        throw new Error("Auxiliary Session creation was canceled.");
      if (record) {
        record.status = "preparing";
        this.notifyCreationState(record, "preparing");
      }
      prepared.characterSelection = await this.resolveAuxiliaryCharacter(
        prepared.parentCharacterId,
        storage,
        input.parentSessionId,
      );
    }
  }

  /** 排他内で親・保存先・要求 ID・Character を再確認して保存する。未使用 Character を選び直せる競合では null を返す。 */
  private async commitAuxiliarySession(
    input: CreateAuxiliarySessionInput,
    storage: AuxiliarySessionStorageAccess,
    prepared: Awaited<
      ReturnType<AuxiliarySessionService["prepareAuxiliarySession"]>
    >,
    record?: AuxiliaryCreationRecord,
    normalizedInput?: AuxiliaryCreationRequestSnapshot,
  ): Promise<AuxiliarySession | null> {
    if (record?.cancelRequested) {
      throw new Error("Auxiliary Session creation was canceled.");
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error(
        "Auxiliary Session creation was canceled because its storage changed during creation.",
      );
    }
    const parent = await this.deps.getParentSession(input.parentSessionId);
    if (!parent) {
      throw new Error("The parent session could not be found.");
    }
    if (
      getSessionIncarnationId(parent) !== prepared.parentIncarnationId ||
      resolveParentCharacterId(parent) !== prepared.parentCharacterId
    ) {
      throw new Error(
        "Auxiliary Session creation was canceled because its parent session changed during creation.",
      );
    }

    if (this.deps.getStorage() !== storage) {
      throw new Error(
        "Auxiliary Session creation was canceled because its storage changed during creation.",
      );
    }
    const requestId = input.clientRequestId?.trim() ?? "";
    const existingAuxiliaries = await storage.listAuxiliarySessions(
      input.parentSessionId,
    );
    if (requestId) {
      const existing = existingAuxiliaries.find(
        (summary) => summary.clientRequestId === requestId,
      );
      if (existing) {
        return (
          (await this.getAuxiliarySession(existing.id)) ??
          (() => {
            throw new Error(
              "The Auxiliary Session retry target could not be found.",
            );
          })()
        );
      }
    }

    const launchSelection = prepared.launchSelection;
    if (this.deps.getStorage() !== storage) {
      throw new Error(
        "Auxiliary Session creation was canceled because its storage changed during creation.",
      );
    }

    const activeCharacters = (await this.deps.listActiveCharacters()).filter(
      (entry) => entry.state === "active",
    );
    if (
      !activeCharacters.some(
        (entry) => entry.id === prepared.characterSelection.characterId,
      )
    ) {
      throw new Error(
        "Auxiliary Session creation was canceled because its Character became unavailable.",
      );
    }
    if (this.deps.getStorage() !== storage) {
      throw new Error(
        "Auxiliary Session creation was canceled because its storage changed during creation.",
      );
    }
    const usedCharacterIds = new Set(
      existingAuxiliaries.map((session) => session.characterId),
    );
    if (
      usedCharacterIds.has(prepared.characterSelection.characterId) &&
      activeCharacters.some(
        (entry) =>
          entry.id !== prepared.parentCharacterId &&
          !usedCharacterIds.has(entry.id),
      )
    ) {
      return null;
    }
    if (
      getApprovalReviewerOptionsForProvider(
        launchSelection.provider,
        launchSelection.approvalMode,
      ).some(
        (option) => option.value === parent.codexReviewer && option.disabled,
      )
    ) {
      throw new Error(
        "The selected reviewer is not supported with this approval mode.",
      );
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
      runState: "idle",
      title: "",
      provider: launchSelection.provider,
      catalogRevision: 0,
      model: launchSelection.model,
      reasoningEffort: launchSelection.reasoningEffort,
      approvalMode: launchSelection.approvalMode,
      codexSandboxMode: launchSelection.codexSandboxMode,
      codexSpeed: parent.codexSpeed,
      codexReviewer: parent.codexReviewer,
      withMateReviewerExplicit:
        supportsWithMateAutoReview(launchSelection.provider) &&
        (parent.withMateReviewerExplicit ||
          parent.provider === "codex" ||
          parent.provider === "claude")
          ? true
          : undefined,
      customAgentName: launchSelection.customAgentName,
      threadId: "",
      composerDraft: "",
      messages: [],
      displayAfterMessageIndex:
        (parent.messageCount ?? parent.messages.length) - 1,
      createdAt: now,
      updatedAt: now,
      characterId: prepared.characterSelection.characterId,
      characterRuntimeSnapshot:
        prepared.characterSelection.characterRuntimeSnapshot,
      characterIconPath:
        prepared.characterSelection.characterRuntimeSnapshot?.iconFilePath ??
        "",
      preview: "",
      clientRequestId: requestId || undefined,
      creationContext: record?.request.creationContext,
      creationRequest: normalizedInput,
    });
  }

  /** 作成の状態、要求 ID と受付世代を通知する。通知先の例外は作成結果に影響させない。 */
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
      // ライフサイクルの診断が作成処理の挙動を変えてはならない。
    }
  }

  /** 実行設定の選択方式を検証し、明示指定では許可値と省略時の既定値を解決する。 */
  private validateAuxiliaryInput(input: CreateAuxiliarySessionInput) {
    const runtimeSelectionMode = resolveRuntimeSelectionMode(
      input.runtimeSelection,
    );
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
      approvalMode: resolveInitialRuntimeOption(
        input.approvalMode,
        APPROVAL_MODE_VALUES,
        getDefaultApprovalModeForProvider(input.provider),
        "approvalMode",
      ),
      codexSandboxMode: resolveInitialRuntimeOption(
        input.codexSandboxMode,
        CODEX_SANDBOX_MODE_VALUES,
        DEFAULT_CODEX_SANDBOX_MODE,
        "codexSandboxMode",
      ),
      codexSpeed: resolveInitialRuntimeOption(
        input.codexSpeed,
        CODEX_SPEED_VALUES,
        DEFAULT_CODEX_SPEED,
        "codexSpeed",
      ),
    };
  }

  /** 親以外から、兄弟に未割当の候補を優先して Character を選び、一致するスナップショットを確保する。 */
  private async resolveAuxiliaryCharacter(
    mainCharacterId: string,
    storage: AuxiliarySessionStorageAccess,
    parentSessionId: string,
  ): Promise<{
    characterId?: string;
    characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  }> {
    const listActiveCharacters = await this.deps.listActiveCharacters();
    const existingAuxiliaries =
      await storage.listAuxiliarySessions(parentSessionId);
    const candidates = listActiveCharacters.filter(
      (entry) => entry.id !== mainCharacterId,
    );
    const selectedId = selectWeightedRandomLaunchCharacterId(
      candidates,
      [],
      existingAuxiliaries.flatMap((session) =>
        session.characterId ? [session.characterId] : [],
      ),
      this.deps.randomCharacter ?? Math.random,
    );
    if (!selectedId) {
      throw new Error("No Character is available for this Auxiliary Session.");
    }
    const snapshot = await this.deps.createCharacterRuntimeSnapshot(selectedId);
    if (!snapshot || snapshot.characterId !== selectedId) {
      throw new Error(
        "The Auxiliary Session Character snapshot could not be created.",
      );
    }
    return { characterId: selectedId, characterRuntimeSnapshot: snapshot };
  }

  /** 親の Workspace で明示指定の Provider・モデルと承認設定をカタログで検証し、起動選択に変換する。 */
  private async resolveExplicitLaunchSelection(
    input: CreateAuxiliarySessionInput,
    approvalMode: SessionLaunchSelection["approvalMode"],
    codexSandboxMode: SessionLaunchSelection["codexSandboxMode"],
    codexSpeed: SessionLaunchSelection["codexSpeed"],
    workspacePath: string,
  ): Promise<SessionLaunchSelection> {
    const snapshot = await this.deps.getModelCatalogSnapshot?.(
      workspacePath,
      input.model ? undefined : input.provider,
    );
    const providerCatalog = getProviderCatalog(
      snapshot?.providers ?? [],
      input.provider,
    );
    if (
      !snapshot ||
      !providerCatalog ||
      providerCatalog.id !== input.provider.trim()
    ) {
      throw new Error(
        "The Auxiliary Session provider is not in the model catalog.",
      );
    }
    if (
      !getApprovalOptionsForProvider(providerCatalog.id).some(
        (option) => option.value === approvalMode,
      )
    ) {
      throw new Error(
        "The selected approval mode is not supported by this provider.",
      );
    }
    const modelSelection = resolveInitialModelSelection(input, providerCatalog);
    return {
      provider: providerCatalog.id,
      model: modelSelection.resolvedModel,
      reasoningEffort: modelSelection.resolvedReasoningEffort,
      approvalMode,
      codexSandboxMode,
      codexSpeed,
      codexReviewer: DEFAULT_CODEX_REVIEWER,
      customAgentName: input.customAgentName?.trim() ?? "",
    };
  }

  /** 履歴本文を読み込まずに Auxiliary のメタデータを読み、親の実行環境と合わせて実行用 Session に変換する。 */
  async getAuxiliaryRuntimeSession(
    auxiliarySessionId: string,
  ): Promise<Session | null> {
    const auxiliary =
      await this.getAuxiliarySessionMetadata(auxiliarySessionId);
    if (!auxiliary) {
      return null;
    }

    return await this.toRuntimeSession(auxiliary);
  }

  /** 指定した Auxiliary の永続化済み下書きがあれば返す。 */
  async getAuxiliaryDraft(
    auxiliarySessionId: string,
  ): Promise<AuxiliaryDraftRecord | null> {
    return await this.deps.getStorage().getAuxiliaryDraft(auxiliarySessionId);
  }

  /** 下書きの保存や消費で参照する Auxiliary の識別情報と実行状態を取得する。 */
  async getAuxiliarySessionStatus(
    auxiliarySessionId: string,
  ): Promise<AuxiliarySessionStatus | null> {
    return await this.deps
      .getStorage()
      .getAuxiliarySessionStatus(auxiliarySessionId);
  }

  /** Auxiliary の親と世代が一致する場合だけ、既定のリビジョン条件で下書きの保存を試みる。 */
  async saveAuxiliaryDraft(
    input: AuxiliaryDraftSaveInput,
  ): Promise<AuxiliaryDraftSaveResult> {
    const storage = this.deps.getStorage();
    const status = await storage.getAuxiliarySessionStatus(
      input.auxiliarySessionId,
    );
    if (
      !status ||
      status.parentSessionId !== input.parentSessionId ||
      status.incarnation !== input.incarnation
    ) {
      return { outcome: "not-found" };
    }
    return await storage.saveAuxiliaryDraft(input);
  }

  /** 新規ターン送信の前に下書きを消費し、送信の確定または失敗まで終了待ちの対象にする。 */
  runAuxiliaryTurnWithDraft(input: {
    auxiliarySessionId: string;
    parentSessionId: string;
    incarnation: string;
    expectedDurableRevision: number;
    userMessage: string;
    displayAnchorParentMessageCount?: number;
    run: () => Promise<void>;
  }): Promise<void> {
    return this.trackPendingDraftSend(() =>
      this.runAuxiliaryTurnWithDraftInternal(input),
    );
  }

  /** 実行中の追加入力として下書きを消費し、対象の本文と受付可否を確認したうえで送信を実行する。 */
  runAuxiliaryInputWithDraft(input: {
    auxiliarySessionId: string;
    parentSessionId: string;
    incarnation: string;
    expectedDurableRevision: number;
    userMessage: string;
    run: () => Promise<void>;
  }): Promise<void> {
    return this.trackPendingDraftSend(() =>
      this.runAuxiliaryTurnWithDraftInternal(input, true),
    );
  }

  /** 進行中の下書き送信を待ち、失敗した復元を再試行する。復元を保留したままなら false を返す。 */
  async waitForPendingDraftSends(): Promise<boolean> {
    await Promise.all([...this.pendingDraftSends]);
    for (const restore of [...this.failedDraftRestores]) {
      try {
        const storage = this.deps.getStorage();
        const current = await storage.getAuxiliaryDraft(
          restore.auxiliarySessionId,
        );
        // 保存済みの復旧・編集や明示的な削除・再作成を、この復元失敗より優先する。
        // 新しい下書きを上書きしたり、削除された下書きを復活させたりしない。
        if (
          !current ||
          current.parentSessionId !== restore.parentSessionId ||
          current.incarnation !== restore.incarnation ||
          current.durableRevision > restore.expectedDurableRevision
        ) {
          this.failedDraftRestores.delete(restore);
          continue;
        }
        if (
          current.durableRevision !== restore.expectedDurableRevision ||
          current.text !== ""
        )
          continue;
        const result = await storage.saveAuxiliaryDraft(restore);
        if (result.outcome === "saved")
          this.failedDraftRestores.delete(restore);
      } catch {
        // 元のテキストを保持し、次の終了試行で復元を再試行する。
        // 復元に失敗したまま送信の Promise が決着しただけでは、安全に終了できない。
      }
    }
    return this.failedDraftRestores.size === 0;
  }

  /** 元の操作結果はそのまま返し、成否にかかわらず終了待ちの監視対象から外す。 */
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

  /** 一致する下書きを消費後、必要なら表示アンカーを固定して送信する。失敗時は元の本文を同じリビジョン条件で復元する。 */
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
    if (
      !captured ||
      captured.parentSessionId !== input.parentSessionId ||
      captured.incarnation !== input.incarnation ||
      captured.durableRevision !== input.expectedDurableRevision ||
      (allowRunningInput && captured.text !== input.userMessage)
    ) {
      throw new Error(
        "Sending was canceled because the Auxiliary draft changed.",
      );
    }
    const consumed = await this.consumeAuxiliaryDraftWithStorage(storage, {
      auxiliarySessionId: input.auxiliarySessionId,
      parentSessionId: input.parentSessionId,
      incarnation: input.incarnation,
      expectedDurableRevision: input.expectedDurableRevision,
      allowRunningInput,
    });
    if (consumed.outcome !== "consumed" || !consumed.ack) {
      throw new Error(
        "Sending was canceled because the Auxiliary draft changed.",
      );
    }
    try {
      if (input.displayAnchorParentMessageCount !== undefined) {
        const summary = await storage.getAuxiliarySessionSummary(
          input.auxiliarySessionId,
        );
        if (!summary || summary.parentSessionId !== input.parentSessionId) {
          throw new Error(
            "The Auxiliary Session could not be found or has changed.",
          );
        }
        if (summary.displayAfterMessageIndex === null) {
          if (
            !Number.isInteger(input.displayAnchorParentMessageCount) ||
            input.displayAnchorParentMessageCount < 0
          ) {
            throw new Error("The Auxiliary display anchor is invalid.");
          }
          const updated = await storage.updateAuxiliaryDisplayAnchorIfMatches({
            auxiliarySessionId: summary.id,
            parentSessionId: summary.parentSessionId,
            createdAt: summary.createdAt,
            displayAfterMessageIndex: input.displayAnchorParentMessageCount - 1,
            updatedAt: currentTimestampLabel(),
          });
          if (!updated)
            throw new Error(
              "Saving the Auxiliary display anchor was canceled.",
            );
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
        if (restored.outcome !== "saved")
          throw new Error(`Auxiliary draft restore ${restored.outcome}.`);
      } catch (restoreError) {
        this.failedDraftRestores.add(restore);
        throw new AggregateError(
          [error, restoreError],
          "Auxiliary turn failed and draft restore failed.",
        );
      }
      throw error;
    }
  }

  /** 下書きの親と世代を照合し、実行中は追加入力の許可条件を満たした場合だけ消費する。 */
  private async consumeAuxiliaryDraftWithStorage(
    storage: AuxiliarySessionStorageAccess,
    input: AuxiliaryDraftStorageConsumeInput,
  ): Promise<AuxiliaryDraftConsumeResult> {
    const status = await storage.getAuxiliarySessionStatus(
      input.auxiliarySessionId,
    );
    if (
      !status ||
      status.parentSessionId !== input.parentSessionId ||
      status.incarnation !== input.incarnation
    ) {
      return { outcome: "not-found" };
    }
    if (
      status.runState === "running" &&
      (!input.allowRunningInput ||
        this.deps.canAcceptAuxiliaryInput?.(input.auxiliarySessionId) !== true)
    )
      return { outcome: "rejected" };
    return await storage.consumeAuxiliaryDraft(input);
  }

  /** キューを経由しないターンの開始を保存し、更新後の実行用 Session を返す。 */
  async persistRunningTurnStart(
    runtimeSession: Session,
    expectedMessageCount: number,
  ): Promise<Session> {
    return (await this.persistTurnStart(runtimeSession, expectedMessageCount))
      .session;
  }

  /** 開始メッセージとキュー起点のターン識別情報を保存し、双方を返す。 */
  async persistQueuedTurnStart(
    runtimeSession: Session,
    expectedMessageCount: number,
    queueId: string,
    turn: SessionTurnInput,
  ): Promise<{ session: Session; turn: SessionTurnRecord }> {
    const result = await this.persistTurnStart(
      runtimeSession,
      expectedMessageCount,
      { queueId, turn },
    );
    if (!result.turn)
      throw new Error("The queued Auxiliary turn identity was not persisted.");
    return { session: result.session, turn: result.turn };
  }

  /** 実行開始時の履歴件数・世代・Character を照合し、先頭のユーザーメッセージと必要なターン情報を追記する。 */
  private async persistTurnStart(
    runtimeSession: Session,
    expectedMessageCount: number,
    queuedTurn?: { queueId: string; turn: SessionTurnInput },
  ): Promise<{ session: Session; turn?: SessionTurnRecord }> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const current = await storage.getAuxiliarySessionMetadata(
      runtimeSession.id,
    );
    if (!current) throw new Error("The Auxiliary Session could not be found.");
    this.assertCharacterSnapshotValid(current);
    const savedRuntime = await this.toRuntimeSession(current);
    const userMessage = runtimeSession.messages.at(-1);
    if (
      !Number.isSafeInteger(expectedMessageCount) ||
      expectedMessageCount < 0 ||
      current.messageCount !== expectedMessageCount ||
      runtimeSession.messages.length !== 1 ||
      !userMessage ||
      userMessage.role !== "user" ||
      !userMessage.text.trim() ||
      runtimeSession.runState !== "running" ||
      runtimeSession.status !== "running" ||
      runtimeSession.characterId !== savedRuntime.characterId ||
      getSessionIncarnationId(runtimeSession) !==
        getSessionIncarnationId(savedRuntime)
    ) {
      throw new Error(
        "The Auxiliary Session changed before starting the running turn.",
      );
    }
    assertCharacterDefinitionSnapshotUpdate(
      savedRuntime.characterRuntimeSnapshot,
      runtimeSession.characterRuntimeSnapshot,
      savedRuntime.characterId,
    );
    this.assertStorageIdentity(storage, identity);
    const stored = await storage.appendAuxiliaryRunningTurnStart({
      auxiliarySessionId: current.id,
      parentSessionId: current.parentSessionId,
      createdAt: current.createdAt,
      expectedMessageCount,
      userMessage,
      updatedAt: runtimeSession.updatedAt,
      characterRuntimeSnapshot:
        runtimeSession.characterRuntimeSnapshot ??
        current.characterRuntimeSnapshot,
      queuedTurn,
    });
    if (!stored)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
    this.notifyRuntimeMessagesCommitted(stored.parentSessionId);
    return {
      session: {
        ...(await this.toRuntimeSession(this.overlayExecutionOptions(stored))),
        messages: runtimeSession.messages,
      },
      turn: stored.queuedTurn,
    };
  }

  /** 実行中の追加ユーザーメッセージを履歴件数と世代を条件に追記し、必要ならキュー上の入力にも結び付ける。 */
  async appendRunningInput(
    runtimeSession: Session,
    text: string,
    turnId: number,
    queuedInput?: { queueId: string; inputTurnId: string },
    replyTo?: import("../../src-shared/session/session-reply.js").SessionReply,
  ): Promise<Session> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const current = await storage.getAuxiliarySessionMetadata(
      runtimeSession.id,
    );
    if (current) this.assertCharacterSnapshotValid(current);
    this.assertStorageIdentity(storage, identity);
    if (
      !current ||
      current.createdAt !== getSessionIncarnationId(runtimeSession)
    ) {
      throw new Error("The Auxiliary Session incarnation does not match.");
    }
    const userMessage = {
      role: "user" as const,
      text,
      ...(replyTo ? { replyTo } : {}),
    };
    const stored = await storage.appendAuxiliarySteer({
      auxiliarySessionId: current.id,
      parentSessionId: current.parentSessionId,
      createdAt: current.createdAt,
      expectedMessageCount:
        runtimeSession.messageCount ?? runtimeSession.messages.length,
      userMessage,
      turnId,
      updatedAt: currentTimestampLabel(),
      queuedInput,
    });
    if (!stored)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
    this.notifyRuntimeMessagesCommitted(stored.parentSessionId);
    return {
      ...(await this.toRuntimeSession(this.overlayExecutionOptions(stored))),
      messages: [...runtimeSession.messages, userMessage],
    };
  }

  /** 実行先ターン ID、添付と質問への対応を使い、配信結果が未確定の追加入力を先に保存する。 */
  async beginRunningInput(
    runtimeSession: Session,
    text: string,
    turnId: number,
    nativeTurnId: string,
    attachments: ComposerAttachment[],
    _origin?: import("../../src-shared/session/session-turn-queue.js").SessionSteerOrigin,
    questionRequestId?: string,
    replyTo?: import("../../src-shared/session/session-reply.js").SessionReply,
  ): Promise<Session> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const current = await storage.getAuxiliarySessionMetadata(
      runtimeSession.id,
    );
    if (current) this.assertCharacterSnapshotValid(current);
    this.assertStorageIdentity(storage, identity);
    if (
      !current ||
      current.createdAt !== getSessionIncarnationId(runtimeSession)
    )
      throw new Error("The Auxiliary Session incarnation does not match.");
    const userMessage = {
      role: "user" as const,
      text,
      ...(replyTo ? { replyTo } : {}),
      turnInput: {
        turnId: String(turnId),
        nativeTurnId,
        attachments,
        state: "pending" as const,
        ...(questionRequestId ? { questionRequestId } : {}),
      },
    };
    const stored = await storage.beginAuxiliarySteer({
      auxiliarySessionId: current.id,
      parentSessionId: current.parentSessionId,
      createdAt: current.createdAt,
      expectedMessageCount:
        runtimeSession.messageCount ?? runtimeSession.messages.length,
      userMessage,
      turnId,
      nativeTurnId,
      attachments,
      updatedAt: currentTimestampLabel(),
    });
    if (!stored)
      throw new Error("The Auxiliary Steer input could not be saved.");
    this.notifyRuntimeMessagesCommitted(stored.parentSessionId);
    return {
      ...(await this.toRuntimeSession(this.overlayExecutionOptions(stored))),
      messages: [...runtimeSession.messages, userMessage],
    };
  }

  /** 追加入力の配信結果を履歴上の絶対位置とターンで特定して保存し、実行中のメッセージにも反映する。 */
  async settleRunningInput(
    runtimeSession: Session,
    messageSeq: number,
    turnId: number,
    state: Exclude<TurnInputDeliveryState, "pending">,
  ): Promise<Session> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const current = await storage.getAuxiliarySessionMetadata(
      runtimeSession.id,
    );
    if (current) this.assertCharacterSnapshotValid(current);
    this.assertStorageIdentity(storage, identity);
    if (
      !current ||
      current.createdAt !== getSessionIncarnationId(runtimeSession)
    )
      throw new Error("The Auxiliary Session incarnation does not match.");
    const count = runtimeSession.messageCount ?? runtimeSession.messages.length;
    const stored = await storage.settleAuxiliarySteer({
      auxiliarySessionId: current.id,
      parentSessionId: current.parentSessionId,
      createdAt: current.createdAt,
      expectedMessageCount: count,
      turnId,
      messageSeq,
      state,
      updatedAt: currentTimestampLabel(),
    });
    if (!stored)
      throw new Error("The Auxiliary Steer input outcome could not be saved.");
    this.notifyRuntimeMessagesCommitted(stored.parentSessionId);
    return {
      ...(await this.toRuntimeSession(this.overlayExecutionOptions(stored))),
      messages: runtimeSession.messages.map((message, index) =>
        (message.historyIndex ??
          count - runtimeSession.messages.length + index) === messageSeq &&
        message.turnInput
          ? { ...message, turnInput: { ...message.turnInput, state } }
          : message,
      ),
    };
  }

  /** 最後のアシスタント発言と終端結果を、履歴件数・世代を条件に追記し、プレビューと実行状態を更新する。 */
  async appendTerminalSession(
    runtimeSession: Session,
    terminalCommit: SessionTurnTerminalCommit,
    options: { confirmedFinalAssistantText?: string | null } = {},
  ): Promise<Session> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const current = await storage.getAuxiliarySessionMetadata(
      runtimeSession.id,
    );
    if (current) this.assertCharacterSnapshotValid(current);
    this.assertStorageIdentity(storage, identity);
    const assistantMessage = runtimeSession.messages.at(-1);
    if (
      !current ||
      current.createdAt !== getSessionIncarnationId(runtimeSession) ||
      !assistantMessage ||
      assistantMessage.role !== "assistant"
    ) {
      throw new Error(
        "The Auxiliary Session terminal identity does not match.",
      );
    }
    const stored = await storage.appendAuxiliaryTerminal({
      auxiliarySessionId: current.id,
      parentSessionId: current.parentSessionId,
      createdAt: current.createdAt,
      expectedMessageCount: terminalCommit.assistantMessageSeq,
      assistantMessage,
      runState: runtimeSession.runState === "error" ? "error" : "idle",
      threadId: runtimeSession.threadId,
      preview: resolveAuxiliaryPreview(
        [assistantMessage],
        current.preview,
        options.confirmedFinalAssistantText,
      ),
      updatedAt: runtimeSession.updatedAt,
      terminalCommit,
    });
    if (!stored)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
    this.notifyRuntimeMessagesCommitted(stored.parentSessionId);
    return {
      ...(await this.toRuntimeSession(this.overlayExecutionOptions(stored))),
      messages: runtimeSession.messages,
    };
  }

  /** 永続化完了後に通知し、通知の失敗はログに残して保存結果には影響させない。 */
  private notifyRuntimeMessagesCommitted(parentSessionId: string): void {
    try {
      this.deps.onRuntimeMessagesCommitted?.(parentSessionId);
    } catch (error) {
      console.warn(
        "Committed Auxiliary runtime Session broadcast failed",
        error,
      );
    }
  }

  /** 履歴件数、元のスレッドと実行状態が一致する場合にだけ、履歴本文を置き換えず実行メタデータを保存する。 */
  async checkpointRuntimeMetadata(
    runtimeSession: Session,
    expected: Session,
  ): Promise<Session> {
    const storage = this.deps.getStorage();
    const identity = this.deps.captureStorageIdentity?.();
    const current = await storage.getAuxiliarySessionMetadata(
      runtimeSession.id,
    );
    if (current) this.assertCharacterSnapshotValid(current);
    this.assertStorageIdentity(storage, identity);
    if (
      !current ||
      current.createdAt !== getSessionIncarnationId(runtimeSession)
    )
      throw new Error("The Auxiliary Session incarnation does not match.");
    const stored = await storage.checkpointAuxiliaryRuntimeMetadata({
      auxiliarySessionId: current.id,
      parentSessionId: current.parentSessionId,
      createdAt: current.createdAt,
      expectedMessageCount: expected.messageCount ?? expected.messages.length,
      expectedThreadId: expected.threadId,
      expectedRunState:
        expected.runState === "running" || expected.runState === "error"
          ? expected.runState
          : "idle",
      runState:
        runtimeSession.runState === "running" ||
        runtimeSession.runState === "error"
          ? runtimeSession.runState
          : "idle",
      provider: runtimeSession.provider,
      threadId: runtimeSession.threadId,
      updatedAt: runtimeSession.updatedAt,
    });
    if (!stored)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
    return {
      ...(await this.toRuntimeSession(this.overlayExecutionOptions(stored))),
      messages: runtimeSession.messages,
    };
  }

  /** 実行用 Session を Auxiliary の保存形式へ反映し、更新結果を Auxiliary として返す。 */
  async upsertAuxiliaryRuntimeSession(
    runtimeSession: Session,
    options: { confirmedFinalAssistantText?: string | null } = {},
  ): Promise<AuxiliarySession> {
    return this.storeAuxiliaryRuntimeSession(runtimeSession, options);
  }

  /** 終端情報と実行結果を合わせて保存し、更新結果を実行用 Session へ戻す。 */
  async upsertTerminalAuxiliaryRuntimeSession(
    runtimeSession: Session,
    terminalCommit: SessionTurnTerminalCommit,
    options: { confirmedFinalAssistantText?: string | null } = {},
  ): Promise<Session> {
    return this.toRuntimeSession(
      await this.storeAuxiliaryRuntimeSession(
        runtimeSession,
        options,
        terminalCommit,
      ),
    );
  }

  /** 保存上のタイトルを維持しながら実行結果と履歴を写し、読み出した保存版との一致を条件に通常または終端更新を選ぶ。 */
  private async storeAuxiliaryRuntimeSession(
    runtimeSession: Session,
    options: { confirmedFinalAssistantText?: string | null },
    terminalCommit?: SessionTurnTerminalCommit,
  ): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(runtimeSession.id);
    if (current) this.assertCharacterSnapshotValid(current);
    if (!current) {
      throw new Error("The Auxiliary Session could not be found.");
    }
    const next: AuxiliarySession = this.overlayExecutionOptions({
      ...current,
      runState:
        runtimeSession.runState === "running" ||
        runtimeSession.runState === "error"
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
      withMateReviewerExplicit: runtimeSession.withMateReviewerExplicit,
      customAgentName: runtimeSession.customAgentName,
      threadId: runtimeSession.threadId,
      composerDraft: "",
      messages: runtimeSession.messages,
      preview: resolveAuxiliaryPreview(
        runtimeSession.messages,
        current.preview,
        options.confirmedFinalAssistantText,
      ),
      updatedAt: runtimeSession.updatedAt,
    });
    const input = {
      session: next,
      expectedSession: current,
    };
    const updated = terminalCommit
      ? await storage.updateTerminalAuxiliarySessionIfMatches(
          input,
          terminalCommit,
        )
      : await storage.updateAuxiliarySessionIfMatches(input);
    if (!updated)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
    return this.overlayExecutionOptions(updated);
  }

  /** 実行中の設定変更を拒み、古い履歴を送り返されたときは現行版を保護する。受理時も保存上の実行設定を維持する。 */
  async updateAuxiliarySession(
    session: AuxiliarySession,
  ): Promise<AuxiliarySession> {
    const storage = this.deps.getStorage();
    const current = await storage.getAuxiliarySession(session.id);
    if (current) this.assertCharacterSnapshotValid(current);
    if (!current) {
      throw new Error("The Auxiliary Session could not be found.");
    }
    const hasStaleRuntimeThread =
      session.threadId !== current.threadId && current.threadId !== "";
    if (
      session.createdAt !== current.createdAt ||
      session.parentSessionId !== current.parentSessionId
    ) {
      throw new Error("The Auxiliary Session incarnation does not match.");
    }
    if (
      current.runState === "running" ||
      this.deps.isAuxiliaryRunInFlight?.(current.id)
    ) {
      const parent = await this.deps.getParentSession(current.parentSessionId);
      if (!parent || parent.accessMode !== "active")
        throw new Error("The parent Session is unavailable or read-only.");
      if (
        session.title !== current.title ||
        session.provider !== current.provider ||
        session.runState !== current.runState ||
        session.threadId !== current.threadId
      ) {
        throw new Error("A running Auxiliary Session cannot be updated.");
      }
      const updated = await storage.updateAuxiliarySessionIfMatches({
        session: { ...current, updatedAt: currentTimestampLabel() },
        expectedSession: current,
      });
      if (!updated)
        throw new Error(
          "Saving was canceled because the Auxiliary Session was deleted or changed.",
        );
      return this.overlayExecutionOptions(updated);
    }
    const isRuntimeStalePayload =
      session.runState !== current.runState ||
      hasStaleRuntimeThread ||
      (session.messageCount === undefined &&
        session.messages.length < current.messages.length);
    if (isRuntimeStalePayload) {
      return this.overlayExecutionOptions(current);
    }
    const next: AuxiliarySession = {
      ...current,
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
      composerDraft: current.composerDraft,
      displayAfterMessageIndex: session.displayAfterMessageIndex,
      threadId: current.threadId,
      updatedAt: currentTimestampLabel(),
    };
    const updated = await storage.updateAuxiliarySessionIfMatches({
      session: next,
      expectedSession: current,
    });
    if (!updated)
      throw new Error(
        "Saving was canceled because the Auxiliary Session was deleted or changed.",
      );
    return this.overlayExecutionOptions(updated);
  }

  /** 渡された Auxiliary をそれぞれ保存し、入力と同順の更新結果を返す。 */
  async replaceAuxiliarySessions(
    sessions: AuxiliarySession[],
  ): Promise<AuxiliarySession[]> {
    const storage = this.deps.getStorage();
    return Promise.all(
      sessions.map((session) => storage.upsertAuxiliarySession(session)),
    );
  }

  /** 親の Workspace と許可ディレクトリを引き継ぎ、会話・実行設定・Character を Auxiliary 側の値で組み直す。 */
  private async toRuntimeSession(
    auxiliary: AuxiliarySession,
  ): Promise<Session> {
    const parent = await this.deps.getParentSession(auxiliary.parentSessionId);
    if (!parent) {
      throw new Error("The parent session could not be found.");
    }

    return {
      ...parent,
      id: auxiliary.id,
      incarnationId: auxiliary.createdAt,
      taskTitle: auxiliary.title,
      description: auxiliary.description ?? "",
      status: auxiliary.runState === "running" ? "running" : "idle",
      updatedAt: auxiliary.updatedAt,
      provider: auxiliary.provider,
      catalogRevision: auxiliary.catalogRevision,
      runState: auxiliary.runState,
      approvalMode: auxiliary.approvalMode,
      codexSandboxMode: auxiliary.codexSandboxMode,
      codexSpeed: auxiliary.codexSpeed,
      codexReviewer: auxiliary.codexReviewer,
      withMateReviewerExplicit: auxiliary.withMateReviewerExplicit,
      model: auxiliary.model,
      reasoningEffort: auxiliary.reasoningEffort,
      customAgentName: auxiliary.customAgentName,
      allowedAdditionalDirectories: [...parent.allowedAdditionalDirectories],
      threadId: auxiliary.threadId,
      messages: auxiliary.messages,
      messageCount: auxiliary.messageCount,
      characterId: auxiliary.characterId ?? parent.characterId,
      character: auxiliary.characterRuntimeSnapshot?.name ?? parent.character,
      characterIconPath:
        auxiliary.characterRuntimeSnapshot?.iconFilePath ??
        parent.characterIconPath,
      characterThemeColors:
        auxiliary.characterRuntimeSnapshot?.theme ??
        parent.characterThemeColors,
      characterRuntimeSnapshot:
        auxiliary.characterRuntimeSnapshot ?? parent.characterRuntimeSnapshot,
      stream: [],
    };
  }

  /** 保存済みの Character スナップショットが不正なら、親の Character に切り替えず処理を拒否する。 */
  private assertCharacterSnapshotValid(session: AuxiliarySession): void {
    if (session.characterRuntimeSnapshotInvalid) {
      throw new Error(
        "The Auxiliary Session Character snapshot is invalid. Review it before continuing; the conversation was not switched to the parent Character.",
      );
    }
  }
}
