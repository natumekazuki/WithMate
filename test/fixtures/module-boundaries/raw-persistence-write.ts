import type { PersistenceWorkerClient } from "../../../src/main/persistence-worker-client.js";

declare const worker: PersistenceWorkerClient;
const requestClass = "write" as const;

void worker["request"]("repository.session.create", requestClass, {});
