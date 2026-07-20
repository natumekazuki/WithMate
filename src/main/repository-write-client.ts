import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import {
  REPOSITORY_WRITE_OPERATIONS,
  type ChildResultCollectCommand,
  type ChildResultCollectResult,
  type ChildStartCommand,
  type ChildStartResult,
  type NormalRunAdmissionCommand,
  type NormalRunAdmissionResult,
  type ProviderBindingResolutionCommand,
  type ProviderBindingResolutionResult,
  type RepositoryCommandResult,
  type RetryRunAdmissionCommand,
  type RetryRunAdmissionResult,
  type RunDispatchBeginCommand,
  type RunDispatchBeginResult,
  type RunDispatchResolutionCommand,
  type RunDispatchResolutionResult,
  type RunInputAdmissionCommand,
  type RunInputAdmissionResult,
  type RunInputBeginCommand,
  type RunInputBeginResult,
  type RunInputResolutionCommand,
  type RunInputResolutionResult,
  type RunOutputAppendCommand,
  type RunOutputAppendResult,
  type RunOutputResolvePendingCommand,
  type RunOutputResolvePendingResult,
  type RunTerminalCommand,
  type RunTerminalResult,
  type SessionCreateCommand,
  type SessionCreateResult,
  type SessionDeleteSubtreeCommand,
  type SessionDeleteSubtreeResult,
  type SessionDeletionCleanupCompleteCommand,
  type SessionDeletionCleanupCompleteResult,
  type SessionTransitionCommand,
  type SessionTransitionResult,
  type SessionUpdateTitleCommand,
  type SessionUpdateTitleResult,
  type StartupRepairCommand,
  type StartupRepairResult,
} from "../shared/repository-write-model.js";

type RequestOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

/** Application Serviceへraw operation名を露出せず、write commandを型付きで提供する。 */
export class RepositoryWriteClient {
  readonly #worker: PersistenceWorkerClient;

  constructor(worker: PersistenceWorkerClient) {
    this.#worker = worker;
  }

  createSession(
    command: SessionCreateCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<SessionCreateResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.sessionCreate, "write", command, options);
  }

  transitionSession(
    command: SessionTransitionCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<SessionTransitionResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.sessionTransition, "write", command, options);
  }

  updateSessionTitle(
    command: SessionUpdateTitleCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<SessionUpdateTitleResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.sessionUpdateTitle, "write", command, options);
  }

  deleteSessionSubtree(
    command: SessionDeleteSubtreeCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<SessionDeleteSubtreeResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.sessionDeleteSubtree, "write", command, options);
  }

  completeSessionDeletionCleanup(
    command: SessionDeletionCleanupCompleteCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<SessionDeletionCleanupCompleteResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.sessionDeletionCleanupComplete, "write", command, options);
  }

  repairStartupState(
    command: StartupRepairCommand = {},
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<StartupRepairResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.startupRepair, "write", command, options);
  }

  admitNormalRun(
    command: NormalRunAdmissionCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<NormalRunAdmissionResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runAdmit, "write", command, options);
  }

  admitRetryRun(
    command: RetryRunAdmissionCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RetryRunAdmissionResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runRetry, "write", command, options);
  }

  startChild(command: ChildStartCommand, options?: RequestOptions): Promise<RepositoryCommandResult<ChildStartResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.childStart, "write", command, options);
  }

  resolveProviderBinding(
    command: ProviderBindingResolutionCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<ProviderBindingResolutionResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.bindingResolve, "write", command, options);
  }

  beginRunDispatch(
    command: RunDispatchBeginCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunDispatchBeginResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, "write", command, options);
  }

  resolveRunDispatch(
    command: RunDispatchResolutionCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunDispatchResolutionResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.dispatchResolve, "write", command, options);
  }

  admitRunInput(
    command: RunInputAdmissionCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunInputAdmissionResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runInputAdmit, "write", command, options);
  }

  beginRunInput(
    command: RunInputBeginCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunInputBeginResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runInputBegin, "write", command, options);
  }

  resolveRunInput(
    command: RunInputResolutionCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunInputResolutionResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runInputResolve, "write", command, options);
  }

  appendRunOutput(
    command: RunOutputAppendCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunOutputAppendResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runOutputAppend, "write", command, options);
  }

  resolvePendingRunOutput(
    command: RunOutputResolvePendingCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunOutputResolvePendingResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runOutputResolvePending, "write", command, options);
  }

  completeRun(
    command: RunTerminalCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<RunTerminalResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.runTerminal, "write", command, options);
  }

  collectChildResult(
    command: ChildResultCollectCommand,
    options?: RequestOptions,
  ): Promise<RepositoryCommandResult<ChildResultCollectResult>> {
    return this.#worker.request(REPOSITORY_WRITE_OPERATIONS.childResultCollect, "write", command, options);
  }
}
