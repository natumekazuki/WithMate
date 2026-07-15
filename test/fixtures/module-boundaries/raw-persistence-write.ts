import type { PersistenceWorkerClient } from "../../../src/main/persistence-worker-client.js";
import type { PersistenceRequestClass } from "../../../src/shared/persistence-protocol.js";

declare const worker: PersistenceWorkerClient;

function send(requestClass: PersistenceRequestClass) {
  return worker["request"]("repository.session.create", requestClass, {});
}

void send("write");
