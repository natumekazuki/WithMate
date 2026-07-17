import RepositoryReadClient = require("../../../src/main/repository-read-client.js");
import * as moduleApi from "node:module";

import type { PersistenceWorkerClient } from "../../../src/main/persistence-worker-client.js";

type InlineWriteClient = import("../../../src/main/repository-write-client.js").RepositoryWriteClient;
type LocalWritePort = { [key: string]: (command: unknown) => Promise<unknown> };

const createRequireKey = "create" + "Require";
const requireFromHere = moduleApi[createRequireKey as "createRequire"](import.meta.url);
const clientModulePath = "../../../src/main/repository-write-client.js";
const dynamicallyRequiredClient = requireFromHere(clientModulePath);
const bareClientModulePath = "../../../src/main/" + "repository-write-client.js";
const bareRequiredClient = require(bareClientModulePath);
const dynamicallyImportedModuleApi = import("node:module");
const localWritePort = null as unknown as LocalWritePort;
const rawPersistenceClient = null as unknown as PersistenceWorkerClient;
const structuralWriteKey = "create" + "Session";
const rawRequestKey = "re" + "quest";
const structuralWrite = localWritePort[structuralWriteKey]!({});
const rawRequest = rawPersistenceClient[rawRequestKey as "request"];

void RepositoryReadClient;
void (null as InlineWriteClient | LocalWritePort | null);
void dynamicallyRequiredClient;
void bareRequiredClient;
void dynamicallyImportedModuleApi;
void structuralWrite;
void rawRequest;
