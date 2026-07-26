import { type RuntimeApplication } from "../../../src/main/runtime-application.js";
import { type startRuntimeHostClient } from "../../../src/main/runtime-host/runtime-host-bootstrap.js";

export type RuntimeHostClientStarter = typeof startRuntimeHostClient;
export type RuntimeApplicationContract = RuntimeApplication;
