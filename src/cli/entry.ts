#!/usr/bin/env node

import { startCliRuntime } from "../main/cli-runtime.js";
import { registerProcessSigint, runCliLifecycle } from "./lifecycle.js";
import { writeCliInvocationResult, type CliTextOutputStream } from "./process-output.js";
import { CLI_VERSION } from "./version.js";

const result = await runCliLifecycle(process.argv.slice(2), {
  version: CLI_VERSION,
  startRuntime: startCliRuntime,
  registerInterrupt: registerProcessSigint,
});
process.exitCode = await writeCliInvocationResult(result, {
  stdout: process.stdout as CliTextOutputStream,
  stderr: process.stderr as CliTextOutputStream,
});
