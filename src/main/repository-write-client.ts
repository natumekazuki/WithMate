import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import {
  REPOSITORY_WRITE_OPERATIONS,
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
  type SessionCreateCommand,
  type SessionCreateResult,
  type SessionTransitionCommand,
  type SessionTransitionResult,
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
}
