import type { PersistenceWorkerClient } from "./persistence-worker-client.js";
import {
  REPOSITORY_WRITE_OPERATIONS,
  type NormalRunAdmissionCommand,
  type NormalRunAdmissionResult,
  type RepositoryCommandResult,
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
}
