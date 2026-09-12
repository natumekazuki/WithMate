import { SessionAuthorityError } from "../src/session-authority.js";
import { ResourceBudgetError } from "./resource-budget-storage.js";
import { SessionResourceRevisionConflictError } from "./resource-history-schema.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import { resolveCodexReviewerUpdate } from "../src/codex-reviewer.js";
import { buildNewSession, type CreateSessionInput, type Session } from "../src/session-state.js";
import { SESSION_AUTHORITY_MAPPING_REVISION } from "../src/session-authority.js";
import type { DeleteSessionsLastActiveBeforeCutoff, DeleteSessionsResult } from "../src/withmate-window-types.js";
import { buildChildSessionRoleBinding, buildRootSessionRoleBinding, requireSessionRoleBinding } from "../src/session-role-binding.js";
import type {
  SessionRuntimeArchiveInput, SessionRuntimeCloneInput, SessionRuntimeConfigureInput,
  SessionRuntimeCreateInput, SessionRuntimeDeleteInput, SessionRuntimeDeleteManifestResult,
  SessionRuntimeMoveInput, SessionRuntimeProviderTuple, SessionRuntimeRestoreInput,
  SessionRuntimeSessionDetail, SessionRuntimeSessionMoveManifestResult, SessionRuntimeSessionPlacement,
} from "../src/session-external-runtime-contract.js";
import { SessionCrudError, projectSessionDetail } from "./session-crud-service.js";
import type { SessionLifecycleOperation, SessionLifecycleOperationRecord } from "./session-lifecycle-storage.js";
import { SessionLifecycleResolver } from "./session-lifecycle-resolver.js";

export type SessionLifecycleInput = SessionRuntimeCreateInput | SessionRuntimeConfigureInput | SessionRuntimeMoveInput
  | SessionRuntimeCloneInput | SessionRuntimeRestoreInput | SessionRuntimeArchiveInput | SessionRuntimeDeleteInput;

export type SessionLifecycleServiceStorage = {
  getLifecycleSession(sessionId: string, includeArchived?: boolean): Session | null;
  getSessionResourceRevision(sessionId: string, includeDeleted?: boolean): number | null;
  getLifecycleOperationByKey(operation: SessionLifecycleOperation, proof: MutationAuthorityProof, key: string, fingerprint: string): SessionLifecycleOperationRecord | null;
  prepareLifecycleMutation(input: {
    operation: SessionLifecycleOperation; input: SessionLifecycleInput; proof: MutationAuthorityProof;
    nextSession?: Session; destinationProof?: MutationAuthorityProof; now: string; requestFingerprint: string;
  }): SessionLifecycleOperationRecord;
  commitLifecycleMutation(input: {
    operationId: string; expectedOperationRevision: number; proof: MutationAuthorityProof;
    now: string; projectResult(session: Session): SessionRuntimeSessionDetail;
  }): SessionLifecycleOperationRecord;
  recordLifecycleStep(input: {
    operationId: string; expectedRevision: number; step: string; effect: "none" | "committed" | "unknown";
    payload?: Record<string, unknown>; occurredAt: string;
  }): SessionLifecycleOperationRecord;
  completeLifecycleMutation(operationId: string, expectedRevision: number, now: string): SessionLifecycleOperationRecord;
  rejectLifecycleMutation(operationId: string, expectedRevision: number, error: unknown, now: string): void;
  markRecoveryRequiredLifecycleMutation(operationId: string, expectedRevision: number, error: unknown, now: string): void;
  listPendingLifecycleOperations(): SessionLifecycleOperationRecord[];
  getLifecycleManifest(sessionId: string, destinationRootSessionId?: string): SessionRuntimeDeleteManifestResult | SessionRuntimeSessionMoveManifestResult;
  listSessionIdsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff): string[];
};

export class SessionLifecycleRecoveryError extends Error {
  readonly code = "SESSION_LIFECYCLE_RECOVERY_REQUIRED";
  readonly retryable = true;
  constructor(readonly operationId: string, readonly sessionId: string | null, readonly effect: "not_applied" | "applied" | "indeterminate", cause?: unknown) {
    super("The Session lifecycle operation requires recovery with the same request.", { cause });
  }
}

export class SessionLifecycleService {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly deps: {
    storage: SessionLifecycleServiceStorage;
    resolver: SessionLifecycleResolver;
    createSessionFilesDirectory(sessionId: string): Promise<string>;
    cleanupSessionFilesDirectory(sessionId: string): Promise<void>;
    resolveSessionFilesDirectory(sessionId: string): string;
    publishSession(session: Session): void;
    publishRemovedSession(sessionId: string): Promise<void>;
    isDeletionRunInFlight?(sessionId: string): boolean;
    authorizeTransferDestination?(actorSessionId: string, destinationRootSessionId: string, operation: "session.move" | "session.move.manifest", input: { sessionId: string; destinationRootSessionId: string }): MutationAuthorityProof;
    authorizeConstruction?(actorSessionId: string, input: SessionRuntimeCreateInput | SessionRuntimeCloneInput): MutationAuthorityProof;
    now?(): Date;
    createSessionId?(): string;
  }) {}

  create(input: SessionRuntimeCreateInput, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    return this.mutate("session.create", input, proof);
  }
  configure(input: SessionRuntimeConfigureInput, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    return this.mutate("session.configure", input, proof);
  }
  move(input: SessionRuntimeMoveInput, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    return this.mutate("session.move", input, proof);
  }
  clone(input: SessionRuntimeCloneInput, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    return this.mutate("session.clone", input, proof);
  }
  restore(input: SessionRuntimeRestoreInput, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    return this.mutate("session.restore", input, proof);
  }
  archive(input: SessionRuntimeArchiveInput, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    return this.mutate("session.archive", input, proof);
  }
  delete(input: SessionRuntimeDeleteInput, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    return this.mutate("session.delete", input, proof);
  }
  deleteManifest(sessionId: string): SessionRuntimeDeleteManifestResult {
    return this.deps.storage.getLifecycleManifest(sessionId) as SessionRuntimeDeleteManifestResult;
  }
  moveManifest(sessionId: string, destinationRootSessionId: string, proof?: MutationAuthorityProof): SessionRuntimeSessionMoveManifestResult {
    if (proof) this.destinationProof("session.move.manifest", { sessionId, destinationRootSessionId }, proof);
    return this.deps.storage.getLifecycleManifest(sessionId, destinationRootSessionId) as SessionRuntimeSessionMoveManifestResult;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const session = buildNewSession(input);
    const provider = this.providerTuple(session, "reset");
    this.deps.resolver.provider(provider);
    const request: SessionRuntimeCreateInput = {
      expectedContainerRevision: 0,
      placement: { kind: "root", rootKind: session.roleBinding?.sessionRole === "overall-coordinator" ? "overall-coordinator" : "standalone" },
      title: session.taskTitle, character: { characterId: session.characterId, expectedDefinitionSha256: session.characterRuntimeSnapshot?.definitionSha256 ?? "" },
      provider, workspace: session.workspacePath === this.deps.resolveSessionFilesDirectory(session.id)
        ? { kind: "session_folder" } : { kind: "directory", path: session.workspacePath },
      initialGrant: { kind: "inherit" }, budget: { kind: "inherit" }, idempotencyKey: randomUUID(),
    };
    await this.mutate("session.create", request, this.userProof(session, "session.create"), session);
    return this.requireSession(session.id);
  }

  async updateSession(request: Session): Promise<Session> {
    const current = this.requireSession(request.id);
    if (isTitleOnlySessionUpdate(current, request)) {
      await this.mutate("session.configure", {
        sessionId: current.id,
        expectedRevision: this.deps.storage.getSessionResourceRevision(current.id)!,
        kind: "title",
        title: request.taskTitle,
        idempotencyKey: randomUUID(),
      }, this.userProof(current, "session.configure"));
      return this.requireSession(current.id);
    }
    const provider = this.providerTuple(request, current.provider === request.provider && current.threadId === request.threadId ? "continue" : "reset");
    const resolvedProvider = this.deps.resolver.provider(provider, current);
    const workspace = await this.deps.resolver.workspace(current.id,
      request.workspacePath === this.deps.resolveSessionFilesDirectory(current.id)
        ? { kind: "session_folder" } : { kind: "directory", path: request.workspacePath });
    const character = request.characterId === current.characterId ? {
      characterId: current.characterId, character: current.character, characterIconPath: current.characterIconPath,
      characterThemeColors: current.characterThemeColors, characterRuntimeSnapshot: current.characterRuntimeSnapshot,
    } : this.deps.resolver.character(request.characterId, request.characterRuntimeSnapshot?.definitionSha256);
    const next = { ...current, ...resolvedProvider, ...workspace, ...character,
      ...this.executionSettings(provider, workspace.workspacePath), taskTitle: request.taskTitle,
      codexSpeed: request.codexSpeed,
      codexReviewer: resolveCodexReviewerUpdate(current, request.codexReviewer),
      threadId: current.characterId !== request.characterId || current.workspacePath !== workspace.workspacePath ? "" : resolvedProvider.threadId };
    const input: SessionRuntimeConfigureInput = { sessionId: current.id, expectedRevision: this.deps.storage.getSessionResourceRevision(current.id)!,
      kind: "runtime", provider, idempotencyKey: randomUUID() };
    await this.mutate("session.configure", input, this.userProof(current, "session.configure"), next);
    return this.requireSession(current.id);
  }

  async deleteSession(sessionId: string, _mode: "tombstone"): Promise<DeleteSessionsResult> {
    const session = this.requireSession(sessionId, true);
    const manifest = this.deleteManifest(sessionId);
    await this.delete({ sessionId, expectedRevision: this.deps.storage.getSessionResourceRevision(sessionId)!, manifestRevision: manifest.manifestRevision,
      idempotencyKey: randomUUID() }, this.userProof(session, "session.delete"));
    return { deletedSessionIds: [sessionId], skippedRunningSessionIds: [] };
  }

  async deleteSessionsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff, mode: "tombstone"): Promise<DeleteSessionsResult> {
    const result: DeleteSessionsResult = { cutoffDate: cutoff.cutoffDate, cutoffTimestampMs: cutoff.cutoffTimestampMs, deletedSessionIds: [], skippedRunningSessionIds: [] };
    for (const id of this.deps.storage.listSessionIdsLastActiveBefore(cutoff)) {
      if (this.deps.storage.getLifecycleSession(id, true)?.sessionKind !== "default") continue;
      if (this.deps.isDeletionRunInFlight?.(id)) {
        result.skippedRunningSessionIds.push(id);
        continue;
      }
      const manifest = this.deleteManifest(id);
      if (!manifest.deletable) {
        if (manifest.executions.running > 0 || manifest.executions.queued > 0) result.skippedRunningSessionIds.push(id);
        continue;
      }
      await this.deleteSession(id, mode);
      result.deletedSessionIds.push(id);
    }
    return result;
  }

  async recoverPending(): Promise<void> {
    while (true) {
      const pending = this.deps.storage.listPendingLifecycleOperations();
      if (pending.length === 0) return;
      for (const record of pending) {
        await this.exclusive(async () => {
          const proof = record.manifest.proof as MutationAuthorityProof | undefined;
          if (!proof) throw new SessionLifecycleRecoveryError(record.operationId, record.targetSessionId, "indeterminate");
          try {
            await this.resume(record, proof);
          } catch (error) {
            if (!isLifecycleRejection(error)) throw error;
          }
        });
      }
    }
  }

  private mutate(operation: SessionLifecycleOperation, input: SessionLifecycleInput, proof: MutationAuthorityProof, resolved?: Session): Promise<SessionRuntimeSessionDetail> {
    return this.exclusive(async () => {
      const fingerprint = createHash("sha256").update(JSON.stringify({ input, ...(resolved ? { resolved } : {}) })).digest("hex");
      const replay = this.deps.storage.getLifecycleOperationByKey(operation, proof, input.idempotencyKey, fingerprint);
      if (replay) return this.resume(replay, proof);
      const destinationProof = operation === "session.clone"
        ? this.constructionProof(input as SessionRuntimeCloneInput, proof)
        : operation === "session.move" && (input as SessionRuntimeMoveInput).kind === "cross_root"
        ? this.destinationProof("session.move", input as { sessionId: string; destinationRootSessionId: string }, proof) : undefined;
      const nextSession = resolved ?? await this.resolveNextSession(operation, input);
      const record = this.deps.storage.prepareLifecycleMutation({ operation, input, proof, nextSession, destinationProof, requestFingerprint: fingerprint, now: this.now() });
      return this.resume(record, proof);
    });
  }

  private constructionProof(input: SessionRuntimeCloneInput, sourceProof: MutationAuthorityProof): MutationAuthorityProof {
    if (sourceProof.principal.kind !== "agent" || !this.deps.authorizeConstruction) {
      if (sourceProof.principal.kind === "user" || sourceProof.principal.kind === "system") return sourceProof;
      throw new SessionCrudError("SESSION_STATE_CONFLICT", "The destination construction authority is unavailable.");
    }
    if (input.placement.kind === "child" && input.placement.parentSessionId !== sourceProof.principal.actorSessionId) {
      throw new SessionCrudError("AUTHORITY_FORBIDDEN", "Clone destination parent authority must belong to the source actor.");
    }
    const constructionProof = this.deps.authorizeConstruction(sourceProof.principal.actorSessionId, input);
    if (constructionProof.principal.kind !== "agent"
      || constructionProof.principal.actorSessionId !== sourceProof.principal.actorSessionId) {
      throw new SessionCrudError("AUTHORITY_FORBIDDEN", "The destination construction authority must belong to the source actor.");
    }
    return constructionProof;
  }

  private destinationProof(operation: "session.move" | "session.move.manifest", input: { sessionId: string; destinationRootSessionId: string }, proof: MutationAuthorityProof): MutationAuthorityProof {
    if (proof.principal.kind !== "agent" || !this.deps.authorizeTransferDestination) {
      throw new SessionCrudError("SESSION_STATE_CONFLICT", "The destination transfer authority is unavailable.");
    }
    return this.deps.authorizeTransferDestination(proof.principal.actorSessionId, input.destinationRootSessionId, operation, input);
  }

  private async resume(initial: SessionLifecycleOperationRecord, proof: MutationAuthorityProof): Promise<SessionRuntimeSessionDetail> {
    let record = initial;
    if (record.state === "committed") return record.result as SessionRuntimeSessionDetail;
    if (record.state === "rejected") throw new SessionCrudError("SESSION_STATE_CONFLICT", "The lifecycle operation was rejected.");
    if (this.requiresFolderCompensation(record) && record.error && isCleanupRequired(record.error)) {
      try {
        await this.deps.cleanupSessionFilesDirectory(record.targetSessionId!);
        this.deps.storage.rejectLifecycleMutation(record.operationId, record.revision, {
          code: "SESSION_FOLDER_CLEANUP_COMPLETED", message: "The SessionFolder was cleaned after the lifecycle database rejection.",
        }, this.now());
        throw new SessionCrudError("SESSION_STATE_CONFLICT", "The lifecycle operation was rejected after SessionFolder cleanup.");
      } catch (error) {
        if (error instanceof SessionCrudError && error.code === "SESSION_STATE_CONFLICT") throw error;
        throw new SessionLifecycleRecoveryError(record.operationId, record.targetSessionId, "not_applied", error);
      }
    }
    let folderCreated = false;
    try {
      if (record.effects.database !== "committed") {
        if (record.operation === "session.delete" && record.targetSessionId && this.deps.isDeletionRunInFlight?.(record.targetSessionId)) {
          throw new SessionCrudError("SESSION_STATE_CONFLICT", "An active runtime prevents Session deletion.");
        }
        if (this.requiresFolderCompensation(record) && record.effects.filesystem !== "committed") {
          await this.deps.createSessionFilesDirectory(record.targetSessionId!);
          folderCreated = true;
          record = this.deps.storage.recordLifecycleStep({
            operationId: record.operationId,
            expectedRevision: record.revision,
            step: "filesystem",
            effect: "committed",
            payload: { sessionFolder: record.targetSessionId },
            occurredAt: this.now(),
          });
        }
        record = this.deps.storage.commitLifecycleMutation({
          operationId: record.operationId, expectedOperationRevision: record.revision, proof, now: this.now(),
          projectResult: (session) => this.project(session),
        });
      }
      if (record.operation === "session.delete" && record.targetSessionId) {
        await this.deps.publishRemovedSession(record.targetSessionId);
        if (!(record.result as SessionRuntimeSessionDetail).sessionFolder.isWorkspace) {
          await this.deps.cleanupSessionFilesDirectory(record.targetSessionId);
        }
      } else if (record.targetSessionId) {
        if (record.operation === "session.archive") {
          const request = record.manifest.input as SessionRuntimeArchiveInput;
          const ids = [record.targetSessionId, ...(request.descendantPolicy === "archive_descendants"
            ? this.deps.storage.getLifecycleManifest(record.targetSessionId).descendants.map((entry) => entry.sessionId) : [])];
          for (const id of ids) await this.deps.publishRemovedSession(id);
        } else {
          const session = this.deps.storage.getLifecycleSession(record.targetSessionId, true);
          if (!session) throw new Error("The committed lifecycle Session is missing.");
          this.deps.publishSession(session);
        }
      }
      record = this.deps.storage.completeLifecycleMutation(record.operationId, record.revision, this.now());
      return record.result as SessionRuntimeSessionDetail;
    } catch (error) {
      if (isLifecycleRejection(error) && record.effects.database !== "committed") {
        if ((folderCreated || record.effects.filesystem === "committed") && this.requiresFolderCompensation(record)) {
          try {
            await this.deps.cleanupSessionFilesDirectory(record.targetSessionId!);
            this.deps.storage.rejectLifecycleMutation(record.operationId, record.revision, { code: error.code, message: error.message }, this.now());
          } catch (cleanupError) {
            this.deps.storage.markRecoveryRequiredLifecycleMutation(record.operationId, record.revision, {
              code: "SESSION_FOLDER_CLEANUP_REQUIRED", message: "The SessionFolder could not be cleaned after a rejected lifecycle mutation.",
              cleanupRequired: true, originalError: { code: error.code, message: error.message },
            }, this.now());
            throw new SessionLifecycleRecoveryError(record.operationId, record.targetSessionId, "not_applied", cleanupError);
          }
        } else {
          this.deps.storage.rejectLifecycleMutation(record.operationId, record.revision, { code: error.code, message: error.message }, this.now());
        }
        throw error;
      }
      throw new SessionLifecycleRecoveryError(record.operationId, record.targetSessionId,
        record.effects.database === "committed" ? "applied" : "indeterminate", error);
    }
  }

  private async resolveNextSession(operation: SessionLifecycleOperation, input: SessionLifecycleInput): Promise<Session | undefined> {
    if (operation === "session.create") {
      const request = input as SessionRuntimeCreateInput;
      const id = this.deps.createSessionId?.() ?? `launch-${randomUUID()}`;
      const workspace = await this.deps.resolver.workspace(id, request.workspace);
      const provider = this.deps.resolver.provider(request.provider);
      const character = this.deps.resolver.character(request.character.characterId, request.character.expectedDefinitionSha256);
      const session = buildNewSession({
        id, taskTitle: request.title, ...workspace, ...character, ...provider,
        ...this.executionSettings(request.provider, workspace.workspacePath), roleBinding: this.placement(id, request.placement),
      });
      return session;
    }
    if (operation === "session.clone") {
      const request = input as SessionRuntimeCloneInput;
      const source = this.requireSession(request.sourceSessionId);
      this.assertRevision(source.id, request.expectedSourceRevision);
      const id = this.deps.createSessionId?.() ?? `launch-${randomUUID()}`;
      const workspace = source.workspacePath === this.deps.resolveSessionFilesDirectory(source.id)
        ? await this.deps.resolver.workspace(id, { kind: "session_folder" })
        : await this.deps.resolver.workspace(id, { kind: "directory", path: source.workspacePath });
      const character = this.deps.resolver.character(source.characterId, source.characterRuntimeSnapshot?.definitionSha256);
      const provider = this.deps.resolver.provider(this.providerTuple(source, "reset"));
      return buildNewSession({
        ...source, ...provider, ...workspace, ...character, id, taskTitle: request.title,
        ...this.executionSettings(this.providerTuple(source, "reset"), workspace.workspacePath),
        roleBinding: this.placement(id, request.placement),
      });
    }
    if (operation !== "session.configure" && operation !== "session.restore") return undefined;
    const request = input as SessionRuntimeConfigureInput | SessionRuntimeRestoreInput;
    const current = this.requireSession(request.sessionId, operation === "session.restore");
    this.assertRevision(current.id, request.expectedRevision);
    if (operation === "session.restore") {
      const restore = request as SessionRuntimeRestoreInput;
      const provider = this.deps.resolver.provider(restore.provider, current);
      const character = this.deps.resolver.character(current.characterId, current.characterRuntimeSnapshot?.definitionSha256);
      const workspace = current.workspacePath === this.deps.resolveSessionFilesDirectory(current.id)
        ? await this.deps.resolver.workspace(current.id, { kind: "session_folder" })
        : await this.deps.resolver.workspace(current.id, { kind: "directory", path: current.workspacePath });
      return { ...current, ...provider, ...character, ...workspace, taskTitle: restore.purpose,
        ...this.executionSettings(restore.provider, workspace.workspacePath) };
    }
    const configure = request as SessionRuntimeConfigureInput;
    switch (configure.kind) {
      case "title": return { ...current, taskTitle: configure.title };
      case "runtime": return { ...current, ...this.deps.resolver.provider(configure.provider, current),
        ...this.executionSettings(configure.provider, current.workspacePath) };
      case "character": return { ...current, ...this.deps.resolver.character(configure.character.characterId, configure.character.expectedDefinitionSha256), threadId: configure.threadContinuity === "continue" ? current.threadId : "" };
      case "workspace": {
        const workspace = await this.deps.resolver.workspace(current.id, configure.workspace);
        return { ...current, ...workspace, allowedAdditionalDirectories: [], threadId: configure.threadContinuity === "continue" ? current.threadId : "" };
      }
      case "role": return { ...current, roleBinding: requireSessionRoleBinding(current.id, { ...current.roleBinding, sessionRole: configure.sessionRole }) };
    }
  }

  private executionSettings(provider: SessionRuntimeProviderTuple, workspacePath: string): Pick<Session, "approvalMode" | "codexSandboxMode" | "customAgentName" | "allowedAdditionalDirectories"> {
    return { approvalMode: provider.approvalMode,
      codexSandboxMode: provider.id === "codex" ? provider.codexSandboxMode : "workspace-write",
      customAgentName: provider.id === "copilot" ? provider.customAgentName : "",
      allowedAdditionalDirectories: provider.id === "codex"
        ? this.deps.resolver.additionalDirectories(workspacePath, provider.allowedAdditionalDirectories)
        : [],
    };
  }
  private providerTuple(session: Session, threadContinuity: "continue" | "reset"): SessionRuntimeProviderTuple {
    const tuple = { catalogRevision: session.catalogRevision, model: session.model, reasoningEffort: session.reasoningEffort, threadContinuity, approvalMode: session.approvalMode };
    if (session.provider === "codex") return { ...tuple, id: "codex", codexSandboxMode: session.codexSandboxMode, allowedAdditionalDirectories: session.allowedAdditionalDirectories };
    if (session.provider === "copilot") return { ...tuple, id: "copilot", customAgentName: session.customAgentName };
    throw new SessionCrudError("RUNTIME_UNAVAILABLE", "The selected Provider is unsupported.");
  }
  private userProof(session: Session, operation: SessionLifecycleOperation): MutationAuthorityProof {
    return { principal: { kind: "user", receiptId: randomUUID() }, operation, action: operation,
      mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION, effectClass: "local_mutation", grantId: null, grantRevision: null,
      evaluatedAt: this.now(), resolvedScope: { resourceKind: operation === "session.create" ? "session_namespace" : "session",
        resourceId: session.id, rootSessionId: session.roleBinding?.rootSessionId ?? session.id, ownerKind: "session", ownerId: session.id, relation: "self" } };
  }
  private placement(id: string, placement: SessionRuntimeSessionPlacement) {
    if (placement.kind === "root") return buildRootSessionRoleBinding(id, placement.rootKind);
    const parent = this.requireSession(placement.parentSessionId);
    return buildChildSessionRoleBinding(id, parent.id, requireSessionRoleBinding(parent.id, parent.roleBinding), placement.sessionRole);
  }
  private requireSession(id: string, archived = false): Session {
    const session = this.deps.storage.getLifecycleSession(id, archived);
    if (!session || session.sessionKind !== "default") throw new SessionCrudError("SESSION_NOT_FOUND", "The Session was not found.");
    return session;
  }
  private assertRevision(id: string, expected: number): void {
    const revision = this.deps.storage.getSessionResourceRevision(id);
    if (revision !== expected) throw new SessionCrudError("SESSION_REVISION_CONFLICT", "The Session revision has changed.", true, { sessionId: id, expectedRevision: expected, currentRevision: revision ?? 0 });
  }
  private project(session: Session): SessionRuntimeSessionDetail {
    const revision = this.deps.storage.getSessionResourceRevision(session.id, true);
    if (revision === null) throw new Error("The Session resource revision is missing.");
    return projectSessionDetail(session, this.deps.resolveSessionFilesDirectory(session.id), revision);
  }
  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }
  private requiresFolderCompensation(record: SessionLifecycleOperationRecord): boolean {
    return (record.operation === "session.create" || record.operation === "session.clone") && !!record.targetSessionId
      && (record.manifest.nextSession as Session | undefined)?.workspacePath === this.deps.resolveSessionFilesDirectory(record.targetSessionId);
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function isLifecycleRejection(error: unknown): error is SessionCrudError | SessionAuthorityError | ResourceBudgetError | SessionResourceRevisionConflictError {
  return error instanceof SessionCrudError || error instanceof SessionAuthorityError
    || error instanceof ResourceBudgetError || error instanceof SessionResourceRevisionConflictError;
}

function isCleanupRequired(error: unknown): error is { cleanupRequired: true } {
  return !!error && typeof error === "object" && (error as { cleanupRequired?: unknown }).cleanupRequired === true;
}

function isTitleOnlySessionUpdate(current: Session, request: Session): boolean {
  const comparableFields = [
    "provider", "catalogRevision", "workspacePath", "roleBinding", "characterId",
    "characterRuntimeSnapshot", "approvalMode", "codexSandboxMode", "codexSpeed",
    "codexReviewer", "model", "reasoningEffort", "customAgentName",
    "allowedAdditionalDirectories", "threadId",
  ] as const;
  return current.taskTitle !== request.taskTitle
    && comparableFields.every((field) => isDeepStrictEqual(current[field], request[field]));
}
