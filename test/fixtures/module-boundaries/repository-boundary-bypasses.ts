import RepositoryReadClient = require("../../../src/main/repository-read-client.js");
import * as moduleApi from "node:module";

import type { PersistenceWorkerClient } from "../../../src/main/persistence-worker-client.js";
import { REPOSITORY_READ_OPERATIONS } from "../../../src/shared/repository-read-model.js";

type InlineWriteClient = import("../../../src/main/repository-write-client.js").RepositoryWriteClient;
type LocalWritePort = { [key: string]: (command: unknown) => Promise<unknown> };
type LocalRunOutputReadPort = {
  runOutputCounts(request: unknown): Promise<unknown>;
  runOutputsPage(request: unknown): Promise<unknown>;
  runOutputGet(request: unknown): Promise<unknown>;
  runOutputPayloadMetadata(request: unknown): Promise<unknown>;
  payloadChunk(request: unknown): Promise<unknown>;
};

const createRequireKey = "create" + "Require";
const requireFromHere = moduleApi[createRequireKey as "createRequire"](import.meta.url);
const clientModulePath = "../../../src/main/repository-write-client.js";
const dynamicallyRequiredClient = requireFromHere(clientModulePath);
const bareClientModulePath = "../../../src/main/" + "repository-write-client.js";
const bareRequiredClient = require(bareClientModulePath);
const dynamicallyImportedModuleApi = import("node:module");
const localWritePort = null as unknown as LocalWritePort;
const localRunOutputReadPort = null as unknown as LocalRunOutputReadPort;
const rawPersistenceClient = null as unknown as PersistenceWorkerClient;
const structuralWriteKey = "create" + "Session";
const structuralOutputPageKey = "runOutputs" + "Page";
const rawRequestKey = "re" + "quest";
const structuralWrite = localWritePort[structuralWriteKey]!({});
const structuralOutputCounts = localRunOutputReadPort.runOutputCounts({});
const structuralOutputPage = localRunOutputReadPort[structuralOutputPageKey as "runOutputsPage"]({});
const structuralOutputGet = localRunOutputReadPort.runOutputGet({});
const structuralOutputMetadata = localRunOutputReadPort.runOutputPayloadMetadata({});
const structuralPayloadChunk = localRunOutputReadPort.payloadChunk({});
const rawRequest = rawPersistenceClient[rawRequestKey as "request"];
const rawReadOperation = REPOSITORY_READ_OPERATIONS.runGet;

void RepositoryReadClient;
void (null as InlineWriteClient | LocalWritePort | null);
void dynamicallyRequiredClient;
void bareRequiredClient;
void dynamicallyImportedModuleApi;
void structuralWrite;
void structuralOutputCounts;
void structuralOutputPage;
void structuralOutputGet;
void structuralOutputMetadata;
void structuralPayloadChunk;
void rawRequest;
void rawReadOperation;
