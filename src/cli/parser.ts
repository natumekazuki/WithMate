import { normalizeHostAbsolutePath, WORKSPACE_PATH_MAX_LENGTH } from "../shared/workspace-path.js";
import { isCanonicalUuid } from "../shared/persistence-runtime-protocol.js";
import {
  canonicalizeSessionQuery,
  canonicalizeSessionTitle,
  isLocalRepositoryKey,
} from "../shared/session-metadata.js";
import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  CLI_SESSION_LIMITS,
  type CliCommandIdentity,
  type CliParseResult,
  type CliSessionOperation,
  type CliSessionWriteCommand,
  type CliUsageErrorCode,
  type CliUsageFailureOutput,
  type CliValidatedCommand,
} from "./contract.js";

type OptionDefinition = Readonly<{
  required?: boolean;
  multiple?: boolean;
  maxOccurrences?: number;
  parse: (value: string) => unknown | undefined;
}>;

type ParsedOptions = Readonly<Record<string, unknown>>;

type OptionParseResult =
  Readonly<{ ok: true; values: ParsedOptions }> | Readonly<{ ok: false; result: CliParseResult }>;

const operations = new Set<CliSessionOperation>([
  "create",
  "rename",
  "list",
  "repositories",
  "read",
  "directories-chunk",
  "archive",
  "unarchive",
  "close",
]);

const timeoutOption = {
  "--timeout-ms": option((value) => parseInteger(value, 1, CLI_SESSION_LIMITS.maxTimeoutMs)),
} as const;

export function parseCliArgv(argv: readonly string[]): CliParseResult {
  const snapshot = [...argv];
  if (snapshot.length === 0 || isExact(snapshot, "--help") || isExact(snapshot, "-h") || isExact(snapshot, "help")) {
    return { kind: "help", topic: { kind: "root" } };
  }
  if (isExact(snapshot, "--version") || isExact(snapshot, "-V")) return { kind: "version" };
  if (snapshot[0] !== "session") {
    return usageFailure(null, "unknown_command", "Unknown command. Run 'withmate --help' for usage.");
  }
  if (
    snapshot.length === 1 ||
    (snapshot.length === 2 && (snapshot[1] === "--help" || snapshot[1] === "-h" || snapshot[1] === "help"))
  ) {
    return { kind: "help", topic: { kind: "session" } };
  }

  const operation = snapshot[1];
  if (!isSessionOperation(operation)) {
    return usageFailure(null, "unknown_command", "Unknown Session operation. Run 'withmate session --help' for usage.");
  }
  const identity: CliCommandIdentity = { namespace: "session", operation };
  const operationArgv = snapshot.slice(2);
  if (isExact(operationArgv, "--help") || isExact(operationArgv, "-h")) {
    return { kind: "help", topic: { kind: "operation", command: identity } };
  }

  return parseSessionCommand(identity, operationArgv);
}

function parseSessionCommand(identity: CliCommandIdentity, argv: readonly string[]): CliParseResult {
  switch (identity.operation) {
    case "create":
      return parseCreate(identity as CliCommandIdentity<"create">, argv);
    case "rename":
      return parseRename(identity as CliCommandIdentity<"rename">, argv);
    case "list":
      return parseList(identity as CliCommandIdentity<"list">, argv);
    case "repositories":
      return parseRepositories(identity as CliCommandIdentity<"repositories">, argv);
    case "read":
      return parseRead(identity as CliCommandIdentity<"read">, argv);
    case "directories-chunk":
      return parseDirectoriesChunk(identity as CliCommandIdentity<"directories-chunk">, argv);
    case "archive":
      return parseWrite(identity as CliCommandIdentity<"archive">, argv);
    case "unarchive":
      return parseWrite(identity as CliCommandIdentity<"unarchive">, argv);
    case "close":
      return parseClose(identity as CliCommandIdentity<"close">, argv);
  }
}

function parseRename(identity: CliCommandIdentity<"rename">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--title": requiredOption(canonicalizeSessionTitle),
    "--idempotency-key": requiredOption(parseUuid),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      title: parsed.values["--title"] as string,
      idempotencyKey: parsed.values["--idempotency-key"] as string,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseCreate(identity: CliCommandIdentity<"create">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--title": requiredOption((value) => canonicalizeSessionTitle(value)),
    "--workspace": requiredOption(normalizeAbsolutePathValue),
    "--idempotency-key": requiredOption(parseUuid),
    "--provider": requiredOption(parseIdentifier),
    "--additional-directory": option(normalizeAbsolutePathValue, {
      multiple: true,
      maxOccurrences: CLI_SESSION_LIMITS.maxAdditionalDirectories,
    }),
    "--default-character": requiredOption(parseIdentifier),
    "--max-concurrent-child-runs": requiredOption((value) =>
      parseInteger(value, 0, CLI_SESSION_LIMITS.maxConcurrentChildRuns),
    ),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  const command: CliValidatedCommand = {
    identity,
    title: parsed.values["--title"] as string,
    workspacePath: parsed.values["--workspace"] as string,
    idempotencyKey: parsed.values["--idempotency-key"] as string,
    providerId: parsed.values["--provider"] as string,
    allowedAdditionalDirectories: (parsed.values["--additional-directory"] as readonly string[] | undefined) ?? [],
    defaultCharacterId: parsed.values["--default-character"] as string,
    maxConcurrentChildRuns: parsed.values["--max-concurrent-child-runs"] as number,
    ...optionalTimeout(parsed.values),
  };
  return { kind: "command", command };
}

function parseList(identity: CliCommandIdentity<"list">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--workspace": option(normalizeAbsolutePathValue),
    "--lifecycle-status": option((value) => parseEnum(value, ["active", "archived", "closed"] as const)),
    "--repository-key": option((value) => (isLocalRepositoryKey(value) ? value : undefined), {
      multiple: true,
      maxOccurrences: CLI_SESSION_LIMITS.maxRepositoryFilters,
    }),
    "--query": option(canonicalizeSessionQuery),
    "--cursor": option((value) => parseBoundedString(value, CLI_SESSION_LIMITS.maxCursorLength)),
    "--limit": option((value) => parseInteger(value, 1, CLI_SESSION_LIMITS.listMaxItems)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      ...(parsed.values["--workspace"] === undefined ? {} : { workspacePath: parsed.values["--workspace"] as string }),
      ...(parsed.values["--lifecycle-status"] === undefined
        ? {}
        : { lifecycleStatus: parsed.values["--lifecycle-status"] as "active" | "archived" | "closed" }),
      ...(parsed.values["--repository-key"] === undefined
        ? {}
        : { localRepositoryKeys: [...new Set(parsed.values["--repository-key"] as string[])].sort() }),
      ...(parsed.values["--query"] === undefined ? {} : { query: parsed.values["--query"] as string }),
      ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] as string }),
      limit: (parsed.values["--limit"] as number | undefined) ?? CLI_SESSION_LIMITS.listDefaultItems,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseRepositories(identity: CliCommandIdentity<"repositories">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--cursor": option((value) => parseBoundedString(value, CLI_SESSION_LIMITS.maxCursorLength)),
    "--limit": option((value) => parseInteger(value, 1, CLI_SESSION_LIMITS.listMaxItems)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] as string }),
      limit: (parsed.values["--limit"] as number | undefined) ?? CLI_SESSION_LIMITS.listDefaultItems,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseRead(identity: CliCommandIdentity<"read">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseDirectoriesChunk(
  identity: CliCommandIdentity<"directories-chunk">,
  argv: readonly string[],
): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--offset": requiredOption((value) => parseInteger(value, 0, Number.MAX_SAFE_INTEGER)),
    "--max-bytes": requiredOption((value) => parseInteger(value, 1, CLI_SESSION_LIMITS.directoriesChunkMaxBytes)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      offset: parsed.values["--offset"] as number,
      maxBytes: parsed.values["--max-bytes"] as number,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseWrite<TOperation extends "archive" | "unarchive">(
  identity: CliCommandIdentity<TOperation>,
  argv: readonly string[],
): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--idempotency-key": requiredOption(parseUuid),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  const common = {
    sessionId: parsed.values["--session-id"] as string,
    idempotencyKey: parsed.values["--idempotency-key"] as string,
    ...optionalTimeout(parsed.values),
  };
  const command: CliSessionWriteCommand<TOperation> = { identity, ...common };
  return { kind: "command", command: command as CliValidatedCommand };
}

function parseClose(identity: CliCommandIdentity<"close">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--idempotency-key": requiredOption(parseUuid),
    "--expected-lifecycle-status": requiredOption((value) => parseEnum(value, ["active", "archived"] as const)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      idempotencyKey: parsed.values["--idempotency-key"] as string,
      expectedLifecycleStatus: parsed.values["--expected-lifecycle-status"] as "active" | "archived",
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseOptions(
  identity: CliCommandIdentity,
  argv: readonly string[],
  definitions: Readonly<Record<string, OptionDefinition>>,
): OptionParseResult {
  const collected = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (name === undefined || !name.startsWith("--")) {
      return { ok: false, result: usageFailure(identity, "unexpected_argument", "Unexpected positional argument.") };
    }
    const definition = definitions[name];
    if (definition === undefined) {
      return { ok: false, result: usageFailure(identity, "unknown_option", "Unknown option.") };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, result: usageFailure(identity, "missing_option", `Option '${name}' requires a value.`) };
    }
    const existing = collected.get(name);
    if (existing !== undefined && !definition.multiple) {
      return { ok: false, result: usageFailure(identity, "duplicate_option", `Option '${name}' cannot be repeated.`) };
    }
    if (definition.maxOccurrences !== undefined && (existing?.length ?? 0) >= definition.maxOccurrences) {
      return {
        ok: false,
        result: usageFailure(
          identity,
          "invalid_option_value",
          `Option '${name}' exceeds its maximum occurrence count.`,
        ),
      };
    }
    if (existing === undefined) collected.set(name, [value]);
    else existing.push(value);
  }

  const values: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const rawValues = collected.get(name);
    if (rawValues === undefined) {
      if (definition.required) {
        return { ok: false, result: usageFailure(identity, "missing_option", `Required option '${name}' is missing.`) };
      }
      continue;
    }
    const parsedValues: unknown[] = [];
    for (const rawValue of rawValues) {
      const parsedValue = definition.parse(rawValue);
      if (parsedValue === undefined) {
        return {
          ok: false,
          result: usageFailure(identity, "invalid_option_value", `Option '${name}' has an invalid value.`),
        };
      }
      parsedValues.push(parsedValue);
    }
    values[name] = definition.multiple ? parsedValues : parsedValues[0];
  }
  return { ok: true, values };
}

function option(
  parse: OptionDefinition["parse"],
  settings: Readonly<{ required?: boolean; multiple?: boolean; maxOccurrences?: number }> = {},
): OptionDefinition {
  return { parse, ...settings };
}

function requiredOption(parse: OptionDefinition["parse"]): OptionDefinition {
  return option(parse, { required: true });
}

function parseUuid(value: string): string | undefined {
  return isCanonicalUuid(value) ? value : undefined;
}

function normalizeAbsolutePathValue(value: string): string | undefined {
  const normalized = normalizeHostAbsolutePath(value);
  return normalized === undefined || normalized.path.length > WORKSPACE_PATH_MAX_LENGTH ? undefined : normalized.path;
}

function parseIdentifier(value: string): string | undefined {
  return parseBoundedString(value, CLI_SESSION_LIMITS.maxIdentifierLength);
}

function parseBoundedString(value: string, maxLength: number): string | undefined {
  return value.length > 0 && value.length <= maxLength && !value.includes("\0") ? value : undefined;
}

function parseInteger(value: string, minimum: number, maximum: number): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function parseEnum<TValue extends string>(value: string, allowed: readonly TValue[]): TValue | undefined {
  return allowed.includes(value as TValue) ? (value as TValue) : undefined;
}

function optionalTimeout(values: ParsedOptions): Readonly<{ timeoutMs?: number }> {
  return values["--timeout-ms"] === undefined ? {} : { timeoutMs: values["--timeout-ms"] as number };
}

function isExact(values: readonly string[], expected: string): boolean {
  return values.length === 1 && values[0] === expected;
}

function isSessionOperation(value: string | undefined): value is CliSessionOperation {
  return value !== undefined && operations.has(value as CliSessionOperation);
}

function usageFailure(
  command: CliCommandIdentity | null,
  code: CliUsageErrorCode,
  message: string,
): Extract<CliParseResult, Readonly<{ kind: "usage_failure" }>> {
  const output: CliUsageFailureOutput = {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "usage_failure",
    command,
    error: { kind: "usage", code, message },
  };
  return { kind: "usage_failure", output, exitCode: CLI_EXIT_CODES.usageInvalid };
}
