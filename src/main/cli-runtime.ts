import { resolveApplicationDataRoot } from "./application-data-path.js";
import type { LocalRuntimeAuthorization, RuntimeApplication } from "./runtime-application.js";
import { startRuntimeHostClient } from "./runtime-host/runtime-host-bootstrap.js";

export { resolveWithMateDatabasePath } from "./application-data-path.js";

export type LocalCliAuthorization = LocalRuntimeAuthorization;

export type CliRuntimeControl = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

export type CliRuntime = RuntimeApplication;

export async function startCliRuntime(control: CliRuntimeControl = {}): Promise<CliRuntime> {
  return await startRuntimeHostClient({
    applicationDataRoot: resolveApplicationDataRoot(),
    ...control,
  });
}
