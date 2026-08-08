#!/usr/bin/env node

import path from "node:path";

import { RuntimeHostAlreadyRunningError, startRuntimeHost } from "./runtime-host.js";

process.exitCode = await runRuntimeHostProcess(process.argv.slice(2));

async function runRuntimeHostProcess(argv: readonly string[]): Promise<number> {
  let applicationDataRoot: string | undefined;
  try {
    applicationDataRoot = parseApplicationDataRoot(argv);
  } catch {
    return 1;
  }

  try {
    const host = await startRuntimeHost({
      ...(applicationDataRoot === undefined ? {} : { applicationDataRoot }),
      timeoutMs: 10_000,
    });
    let gracefulSignal = false;
    const close = () => {
      gracefulSignal = true;
      void host.close({ timeoutMs: 10_000 }).catch(() => undefined);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    try {
      const result = await host.closed;
      return gracefulSignal && result.checkpoint === "completed" ? 0 : 1;
    } catch {
      return 1;
    } finally {
      process.removeListener("SIGINT", close);
      process.removeListener("SIGTERM", close);
    }
  } catch (error) {
    return error instanceof RuntimeHostAlreadyRunningError ? 0 : 1;
  }
}

function parseApplicationDataRoot(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== "--application-data-root") {
    throw new TypeError("Runtime host process arguments are invalid.");
  }
  const value = argv[1];
  if (value === undefined || !path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("Runtime host application data root is invalid.");
  }
  return path.normalize(value);
}
