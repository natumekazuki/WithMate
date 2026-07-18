import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";

import { CLI_EXIT_CODES } from "../src/cli/contract.js";
import { runCliLifecycle } from "../src/cli/lifecycle.js";
import { writeCliInvocationResult, type CliTextOutputStream } from "../src/cli/process-output.js";
import { CLI_VERSION } from "../src/cli/version.js";
import type { ApplicationSessionOperations } from "../src/main/index.js";
import { resolveWithMateDatabasePath } from "../src/main/cli-session-runtime.js";

type Authorization = Readonly<{ transport: "test" }>;
type Operations = ApplicationSessionOperations<Authorization>;

const authorization: Authorization = { transport: "test" };
const readArgv = ["session", "read", "--session-id", "session-1"] as const;

test("help and parse failures do not register signals or start runtime", async () => {
  let starts = 0;
  let registrations = 0;
  const dependencies = {
    version: CLI_VERSION,
    startRuntime: async () => {
      starts += 1;
      return runtime(successfulOperations());
    },
    registerInterrupt: () => {
      registrations += 1;
      return () => undefined;
    },
  };

  const help = await runCliLifecycle(["--help"], dependencies);
  const invalid = await runCliLifecycle(["session", "read"], dependencies);
  const unconfirmedDelete = await runCliLifecycle(
    ["session", "delete", "--session-id", "session-1", "--idempotency-key", "018f1f4e-7f0a-7000-8000-000000000001"],
    dependencies,
  );

  assert.equal(help.exitCode, CLI_EXIT_CODES.success);
  assert.equal(invalid.exitCode, CLI_EXIT_CODES.usageInvalid);
  assert.equal(unconfirmedDelete.exitCode, CLI_EXIT_CODES.usageInvalid);
  assert.equal(starts, 0);
  assert.equal(registrations, 0);
});

test("operation completion always performs one clean shutdown", async () => {
  let shutdowns = 0;
  let removals = 0;
  const result = await runCliLifecycle(readArgv, {
    version: CLI_VERSION,
    startRuntime: async () =>
      runtime(successfulOperations(), async () => {
        shutdowns += 1;
        return { checkpoint: "completed" };
      }),
    registerInterrupt: () => () => {
      removals += 1;
    },
  });

  assert.equal(result.exitCode, CLI_EXIT_CODES.success);
  assert.equal(oneJsonObject(result.stdout).kind, "operation");
  assert.equal(shutdowns, 1);
  assert.equal(removals, 1);
});

test("bootstrap failure is sanitized and never attempts shutdown", async () => {
  let removals = 0;
  const result = await runCliLifecycle(readArgv, {
    version: CLI_VERSION,
    startRuntime: async () => {
      throw new Error("private worker and database details");
    },
    registerInterrupt: () => () => {
      removals += 1;
    },
  });

  assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
  assert.deepEqual(oneJsonObject(result.stdout).error, {
    kind: "runtime",
    code: "bootstrap_failed",
    stage: "bootstrap",
    message: "Application runtime could not be started.",
  });
  assert.equal(result.stdout.includes("database details"), false);
  assert.equal(removals, 1);
});

test("shutdown rejection and failed checkpoint preserve the Application response", async () => {
  const shutdowns = [
    async () => {
      throw new Error("forced shutdown");
    },
    async () => ({ checkpoint: "failed" as const }),
  ];

  for (const shutdown of shutdowns) {
    const result = await runCliLifecycle(readArgv, {
      version: CLI_VERSION,
      startRuntime: async () => runtime(successfulOperations(), shutdown),
    });
    const output = oneJsonObject(result.stdout);
    assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
    assert.equal(output.kind, "lifecycle_failure");
    assert.equal((output.command as Readonly<Record<string, unknown>>).operation, "read");
    assert.equal((output.applicationResponse as Readonly<Record<string, unknown>>).overallStatus, "success");
    assert.deepEqual(output.error, {
      kind: "runtime",
      code: "shutdown_failed",
      stage: "shutdown",
      message: "Application runtime did not shut down cleanly.",
    });
  }
});

test("shutdown failure takes precedence when the operation also fails internally", async () => {
  const operations = successfulOperations(() => {
    throw new Error("operation failure");
  });
  const result = await runCliLifecycle(readArgv, {
    version: CLI_VERSION,
    startRuntime: async () =>
      runtime(operations, async () => {
        throw new Error("shutdown failure");
      }),
  });

  const output = oneJsonObject(result.stdout);
  assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
  assert.equal(output.kind, "runtime_failure");
  assert.equal((output.error as Readonly<Record<string, unknown>>).code, "shutdown_failed");
});

test("SIGINT aborts the Application operation and still shuts down", async () => {
  let interrupt: (() => void) | undefined;
  let shutdowns = 0;
  let observedAborted = false;
  const operations = successfulOperations((_request, options) => {
    observedAborted = options?.signal?.aborted === true;
    return {
      overallStatus: "failure",
      error: { kind: "operation", code: "operation_canceled", message: "canceled", retryable: false },
      persistence: { status: "not_attempted", effect: "none" },
    };
  });
  const result = await runCliLifecycle(readArgv, {
    version: CLI_VERSION,
    startRuntime: async () => {
      interrupt?.();
      return runtime(operations, async () => {
        shutdowns += 1;
        return { checkpoint: "completed" };
      });
    },
    registerInterrupt: (abort) => {
      interrupt = abort;
      return () => {
        interrupt = undefined;
      };
    },
  });

  assert.equal(result.exitCode, CLI_EXIT_CODES.canceled);
  assert.equal(observedAborted, true);
  assert.equal(shutdowns, 1);
  assert.equal(interrupt, undefined);
});

test("stdout write failure returns runtime exit code and a fixed stderr diagnostic", async () => {
  const stdout = outputStream(new Error("broken pipe"));
  const stderr = outputStream();
  const exitCode = await writeCliInvocationResult(
    { stdout: '{"kind":"operation"}\n', stderr: "", exitCode: CLI_EXIT_CODES.success },
    { stdout, stderr },
  );

  assert.equal(exitCode, CLI_EXIT_CODES.runtimeFailure);
  assert.equal(stdout.text, '{"kind":"operation"}\n');
  assert.equal(stderr.text, "withmate: output write failed\n");
});

test("stdout stream error event is contained as an output failure", async () => {
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("broken pipe"));
    },
  });
  const stderr = outputStream();
  const exitCode = await writeCliInvocationResult(
    { stdout: '{"kind":"operation"}\n', stderr: "", exitCode: CLI_EXIT_CODES.success },
    { stdout, stderr },
  );

  assert.equal(exitCode, CLI_EXIT_CODES.runtimeFailure);
  assert.equal(stderr.text, "withmate: output write failed\n");
});

test("CLI version and app-owned database location are fixed contracts", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as Readonly<{
    version: string;
  }>;
  assert.equal(CLI_VERSION, packageJson.version);

  const appDataRoot = path.resolve("isolated-app-data");
  const homeDirectory = path.resolve("isolated-home");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(process.platform === "win32" ? { APPDATA: appDataRoot } : { XDG_CONFIG_HOME: appDataRoot }),
    WITHMATE_DATABASE_PATH: path.resolve("must-not-be-used.sqlite3"),
  };
  const expectedRoot =
    process.platform === "darwin" ? path.join(homeDirectory, "Library", "Application Support") : appDataRoot;
  assert.equal(
    resolveWithMateDatabasePath(environment, process.platform, homeDirectory),
    path.join(expectedRoot, "WithMate", "withmate.sqlite3"),
  );
});

function runtime(
  operations: Operations,
  shutdown: () => Promise<Readonly<{ checkpoint: "completed" | "failed" }>> = async () => ({
    checkpoint: "completed",
  }),
) {
  return { operations, authorization, shutdown } as const;
}

function successfulOperations(
  read: (request: Parameters<Operations["read"]>[0], options: Parameters<Operations["read"]>[1]) => unknown = () =>
    readSuccess(),
): Operations {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected operation");
  };
  return {
    create: unsupported,
    updateTitle: unsupported,
    list: unsupported,
    listLocalRepositories: unsupported,
    read: async (request, options) => read(request, options) as Awaited<ReturnType<Operations["read"]>>,
    readDirectoriesChunk: unsupported,
    archive: unsupported,
    unarchive: unsupported,
    close: unsupported,
    delete: unsupported,
  };
}

function readSuccess() {
  const workspacePath = path.resolve("workspace-1");
  return {
    overallStatus: "success",
    value: {
      session: {
        id: "session-1",
        title: "Session 1",
        providerId: "codex",
        workspacePath,
        localRepositoryKey: null,
        repositoryName: null,
        allowedAdditionalDirectoriesByteLength: 2,
        allowedAdditionalDirectoriesState: "inline",
        defaultCharacterId: "character-1",
        maxConcurrentChildRuns: 2,
        lifecycleStatus: "active",
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      },
      execution: { state: "not_started" },
    },
    persistence: { status: "read", effect: "none" },
  };
}

function outputStream(error?: Error): CliTextOutputStream & { text: string } {
  const events = new EventEmitter();
  const stream = {
    text: "",
    write(text: string, callback: (writeError?: Error | null) => void) {
      stream.text += text;
      callback(error);
    },
    once(event: "error", listener: (streamError: Error) => void) {
      events.once(event, listener);
      return stream;
    },
    removeListener(event: "error", listener: (streamError: Error) => void) {
      events.removeListener(event, listener);
      return stream;
    },
  };
  return stream;
}

function oneJsonObject(stdout: string): Readonly<Record<string, unknown>> {
  assert.equal(stdout.endsWith("\n"), true);
  assert.equal(stdout.slice(0, -1).includes("\n"), false);
  const parsed: unknown = JSON.parse(stdout);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed as Readonly<Record<string, unknown>>;
}
