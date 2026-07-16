import type { PersistenceWorkerClient } from "../../../src/main/persistence-worker-client.js";
import type { PersistenceRequestClass } from "../../../src/shared/persistence-protocol.js";

declare const worker: PersistenceWorkerClient;

function send(requestClass: PersistenceRequestClass) {
  return worker["request"]("repository.session.create", requestClass, {});
}

void send("write");

const boundRequest = worker.request.bind(worker);
void boundRequest("repository.session.create", "write", {});

const requestMethodName = "request" as const;
const computedRequest = worker[requestMethodName].bind(worker);
void computedRequest("repository.session.create", "write", {});

void worker.request.call(worker, "repository.session.create", "write", {});
void Reflect.apply(worker.request, worker, ["repository.session.create", "write", {}]);

const { request: escapedRequest } = worker;
void escapedRequest("repository.session.create", "write", {});

const computedDestructureName = "request" as const;
const { [computedDestructureName]: escapedComputedRequest } = worker;
void escapedComputedRequest("repository.session.create", "write", {});

function escapeGenericRequest<K extends "request">(key: K) {
  return worker[key];
}

void escapeGenericRequest("request")("repository.session.create", "write", {});
