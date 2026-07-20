import { normalizeHostAbsolutePath, WORKSPACE_PATH_MAX_LENGTH } from "../shared/workspace-path.js";
import { isCanonicalUuid } from "../shared/persistence-runtime-protocol.js";
import {
  canonicalizeSessionQuery,
  canonicalizeSessionTitle,
  isLocalRepositoryKey,
} from "../shared/session-metadata.js";
import {
  CLI_EXIT_CODES,
  CLI_RUN_LIMITS,
  CLI_RUN_OUTPUT_CATEGORIES,
  CLI_SCHEMA_VERSION,
  CLI_SESSION_LIMITS,
  CLI_SESSION_MESSAGE_LIMITS,
  CLI_SESSION_RUN_LIMITS,
  type CliCommandIdentity,
  type CliParseResult,
  type CliRunOperation,
  type CliSessionOperation,
  type CliSessionWriteCommand,
  type CliUsageErrorCode,
  type CliUsageFailureOutput,
  type CliValidatedCommand,
} from "./contract.js";

type OptionDefinition =
  | Readonly<{ kind: "flag"; required?: boolean }>
  | Readonly<{
      kind: "value";
      required?: boolean;
      multiple?: boolean;
      maxOccurrences?: number;
      parse: (value: string) => unknown | undefined;
    }>;

type ParsedOptions = Readonly<Record<string, unknown>>;

type OptionParseResult =
  Readonly<{ ok: true; values: ParsedOptions }> | Readonly<{ ok: false; result: CliParseResult }>;

const sessionOperations = new Set<CliSessionOperation>([
  "create",
  "rename",
  "list",
  "repositories",
  "read",
  "directories-chunk",
  "messages",
  "runs",
  "message-content-chunk",
  "archive",
  "unarchive",
  "close",
  "delete",
]);
const runOperations = new Set<CliRunOperation>([
  "status",
  "events",
  "follow",
  "output-counts",
  "outputs",
  "output-preview",
  "output-chunk",
  "output-export",
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
  const namespace = snapshot[0];
  if (namespace !== "session" && namespace !== "run") {
    return usageFailure(null, "unknown_command", "Unknown command. Run 'withmate --help' for usage.");
  }
  if (
    snapshot.length === 1 ||
    (snapshot.length === 2 && (snapshot[1] === "--help" || snapshot[1] === "-h" || snapshot[1] === "help"))
  ) {
    return { kind: "help", topic: { kind: namespace } };
  }

  const operation = snapshot[1];
  if (namespace === "session") {
    if (!isSessionOperation(operation)) {
      return usageFailure(
        null,
        "unknown_command",
        "Unknown Session operation. Run 'withmate session --help' for usage.",
      );
    }
    const identity: CliCommandIdentity<CliSessionOperation> = { namespace, operation };
    const operationArgv = snapshot.slice(2);
    if (isExact(operationArgv, "--help") || isExact(operationArgv, "-h")) {
      return { kind: "help", topic: { kind: "operation", command: identity } };
    }
    return parseSessionCommand(identity, operationArgv);
  }
  if (!isRunOperation(operation)) {
    return usageFailure(null, "unknown_command", "Unknown Run operation. Run 'withmate run --help' for usage.");
  }
  const identity: CliCommandIdentity<CliRunOperation> = { namespace, operation };
  const operationArgv = snapshot.slice(2);
  if (isExact(operationArgv, "--help") || isExact(operationArgv, "-h")) {
    return { kind: "help", topic: { kind: "operation", command: identity } };
  }
  return parseRunCommand(identity, operationArgv);
}

function parseSessionCommand(
  identity: CliCommandIdentity<CliSessionOperation>,
  argv: readonly string[],
): CliParseResult {
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
    case "messages":
      return parseMessages(identity as CliCommandIdentity<"messages">, argv);
    case "runs":
      return parseRuns(identity as CliCommandIdentity<"runs">, argv);
    case "message-content-chunk":
      return parseMessageContentChunk(identity as CliCommandIdentity<"message-content-chunk">, argv);
    case "archive":
      return parseWrite(identity as CliCommandIdentity<"archive">, argv);
    case "unarchive":
      return parseWrite(identity as CliCommandIdentity<"unarchive">, argv);
    case "close":
      return parseClose(identity as CliCommandIdentity<"close">, argv);
    case "delete":
      return parseDelete(identity as CliCommandIdentity<"delete">, argv);
  }
}

function parseRunCommand(identity: CliCommandIdentity<CliRunOperation>, argv: readonly string[]): CliParseResult {
  switch (identity.operation) {
    case "status":
      return parseRunStatus(identity as CliCommandIdentity<"status">, argv);
    case "events":
      return parseRunEvents(identity as CliCommandIdentity<"events">, argv);
    case "follow":
      return parseRunFollow(identity as CliCommandIdentity<"follow">, argv);
    case "output-counts":
      return parseRunOutputCounts(identity as CliCommandIdentity<"output-counts">, argv);
    case "outputs":
      return parseRunOutputs(identity as CliCommandIdentity<"outputs">, argv);
    case "output-preview":
      return parseRunOutputPreview(identity as CliCommandIdentity<"output-preview">, argv);
    case "output-chunk":
      return parseRunOutputChunk(identity as CliCommandIdentity<"output-chunk">, argv);
    case "output-export":
      return parseRunOutputExport(identity as CliCommandIdentity<"output-export">, argv);
  }
}

function parseRunStatus(identity: CliCommandIdentity<"status">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--run-id": requiredOption(parseIdentifier),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      runId: parsed.values["--run-id"] as string,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseRunEvents(identity: CliCommandIdentity<"events">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--run-id": requiredOption(parseIdentifier),
    "--cursor": option((value) => parseBoundedString(value, CLI_SESSION_LIMITS.maxCursorLength)),
    "--limit": option((value) => parseInteger(value, 1, CLI_RUN_LIMITS.eventsMaxItems)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      runId: parsed.values["--run-id"] as string,
      ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] as string }),
      limit: (parsed.values["--limit"] as number | undefined) ?? CLI_RUN_LIMITS.eventsDefaultItems,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseRunFollow(identity: CliCommandIdentity<"follow">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--run-id": requiredOption(parseIdentifier),
    "--cursor": option((value) => parseBoundedString(value, CLI_SESSION_LIMITS.maxCursorLength)),
    "--limit": option((value) => parseInteger(value, 1, CLI_RUN_LIMITS.eventsMaxItems)),
    "--wait-ms": option((value) => parseInteger(value, 0, CLI_RUN_LIMITS.followMaxWaitMs)),
    "--poll-ms": option((value) => parseInteger(value, CLI_RUN_LIMITS.followMinPollMs, CLI_RUN_LIMITS.followMaxPollMs)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      runId: parsed.values["--run-id"] as string,
      ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] as string }),
      limit: (parsed.values["--limit"] as number | undefined) ?? CLI_RUN_LIMITS.eventsDefaultItems,
      waitMs: (parsed.values["--wait-ms"] as number | undefined) ?? CLI_RUN_LIMITS.followDefaultWaitMs,
      pollMs: (parsed.values["--poll-ms"] as number | undefined) ?? CLI_RUN_LIMITS.followDefaultPollMs,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseRunOutputCounts(identity: CliCommandIdentity<"output-counts">, argv: readonly string[]): CliParseResult {
  const parsed = parseRunOutputScope(identity, argv, {});
  if (!parsed.ok) return parsed.result;
  return runOutputCommand(identity, parsed.values);
}

function parseRunOutputs(identity: CliCommandIdentity<"outputs">, argv: readonly string[]): CliParseResult {
  const parsed = parseRunOutputScope(identity, argv, {
    "--category": option((value) => parseEnum(value, CLI_RUN_OUTPUT_CATEGORIES)),
    "--cursor": option((value) => parseBoundedString(value, CLI_SESSION_LIMITS.maxCursorLength)),
    "--limit": option((value) => parseInteger(value, 1, CLI_RUN_LIMITS.outputsMaxItems)),
  });
  if (!parsed.ok) return parsed.result;
  return runOutputCommand(identity, parsed.values, {
    ...(parsed.values["--category"] === undefined ? {} : { category: parsed.values["--category"] }),
    ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] }),
    limit: (parsed.values["--limit"] as number | undefined) ?? CLI_RUN_LIMITS.outputsDefaultItems,
  });
}

function parseRunOutputPreview(
  identity: CliCommandIdentity<"output-preview">,
  argv: readonly string[],
): CliParseResult {
  const parsed = parseRunOutputScope(identity, argv, {
    "--output-item-id": requiredOption(parseIdentifier),
    "--max-bytes": option((value) => parseInteger(value, 1, CLI_RUN_LIMITS.previewMaxBytes)),
  });
  if (!parsed.ok) return parsed.result;
  return runOutputCommand(identity, parsed.values, {
    outputItemId: parsed.values["--output-item-id"],
    maxBytes: (parsed.values["--max-bytes"] as number | undefined) ?? CLI_RUN_LIMITS.previewDefaultBytes,
  });
}

function parseRunOutputChunk(identity: CliCommandIdentity<"output-chunk">, argv: readonly string[]): CliParseResult {
  const parsed = parseRunOutputScope(identity, argv, {
    "--output-item-id": requiredOption(parseIdentifier),
    "--offset": requiredOption((value) => parseInteger(value, 0, Number.MAX_SAFE_INTEGER)),
    "--max-bytes": option((value) => parseInteger(value, 1, CLI_RUN_LIMITS.chunkMaxBytes)),
  });
  if (!parsed.ok) return parsed.result;
  return runOutputCommand(identity, parsed.values, {
    outputItemId: parsed.values["--output-item-id"],
    offset: parsed.values["--offset"],
    maxBytes: (parsed.values["--max-bytes"] as number | undefined) ?? CLI_RUN_LIMITS.chunkDefaultBytes,
  });
}

function parseRunOutputExport(identity: CliCommandIdentity<"output-export">, argv: readonly string[]): CliParseResult {
  const parsed = parseRunOutputScope(identity, argv, {
    "--output-item-id": requiredOption(parseIdentifier),
    "--destination": requiredOption(parseExportDestination),
  });
  if (!parsed.ok) return parsed.result;
  return runOutputCommand(identity, parsed.values, {
    outputItemId: parsed.values["--output-item-id"],
    destination: parsed.values["--destination"],
  });
}

function parseRunOutputScope(
  identity: CliCommandIdentity<CliRunOperation>,
  argv: readonly string[],
  options: Readonly<Record<string, OptionDefinition>>,
): OptionParseResult {
  return parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--run-id": requiredOption(parseIdentifier),
    ...options,
    ...timeoutOption,
  });
}

function runOutputCommand(
  identity: CliCommandIdentity<CliRunOperation>,
  values: ParsedOptions,
  operationValues: Readonly<Record<string, unknown>> = {},
): CliParseResult {
  return {
    kind: "command",
    command: {
      identity,
      sessionId: values["--session-id"] as string,
      runId: values["--run-id"] as string,
      ...operationValues,
      ...optionalTimeout(values),
    } as CliValidatedCommand,
  };
}

function parseDelete(identity: CliCommandIdentity<"delete">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--idempotency-key": requiredOption(parseUuid),
    "--confirm-local-only": flag({ required: true }),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      idempotencyKey: parsed.values["--idempotency-key"] as string,
      ...optionalTimeout(parsed.values),
    },
  };
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

function parseMessages(identity: CliCommandIdentity<"messages">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--cursor": option((value) => parseBoundedString(value, CLI_SESSION_LIMITS.maxCursorLength)),
    "--limit": option((value) => parseInteger(value, 1, CLI_SESSION_MESSAGE_LIMITS.messagesMaxItems)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] as string }),
      limit: (parsed.values["--limit"] as number | undefined) ?? CLI_SESSION_MESSAGE_LIMITS.messagesDefaultItems,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseRuns(identity: CliCommandIdentity<"runs">, argv: readonly string[]): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--cursor": option((value) => parseBoundedString(value, CLI_SESSION_LIMITS.maxCursorLength)),
    "--limit": option((value) => parseInteger(value, 1, CLI_SESSION_RUN_LIMITS.runsMaxItems)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] as string }),
      limit: (parsed.values["--limit"] as number | undefined) ?? CLI_SESSION_RUN_LIMITS.runsDefaultItems,
      ...optionalTimeout(parsed.values),
    },
  };
}

function parseMessageContentChunk(
  identity: CliCommandIdentity<"message-content-chunk">,
  argv: readonly string[],
): CliParseResult {
  const parsed = parseOptions(identity, argv, {
    "--session-id": requiredOption(parseIdentifier),
    "--message-id": requiredOption(parseIdentifier),
    "--offset": requiredOption((value) => parseInteger(value, 0, Number.MAX_SAFE_INTEGER)),
    "--max-bytes": requiredOption((value) => parseInteger(value, 1, CLI_SESSION_MESSAGE_LIMITS.chunkMaxBytes)),
    ...timeoutOption,
  });
  if (!parsed.ok) return parsed.result;
  return {
    kind: "command",
    command: {
      identity,
      sessionId: parsed.values["--session-id"] as string,
      messageId: parsed.values["--message-id"] as string,
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
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (name === undefined || !name.startsWith("--")) {
      return { ok: false, result: usageFailure(identity, "unexpected_argument", "Unexpected positional argument.") };
    }
    const definition = definitions[name];
    if (definition === undefined) {
      return { ok: false, result: usageFailure(identity, "unknown_option", "Unknown option.") };
    }
    const existing = collected.get(name);
    if (definition.kind === "flag") {
      if (existing !== undefined) {
        return {
          ok: false,
          result: usageFailure(identity, "duplicate_option", `Option '${name}' cannot be repeated.`),
        };
      }
      collected.set(name, [""]);
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, result: usageFailure(identity, "missing_option", `Option '${name}' requires a value.`) };
    }
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
    index += 2;
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
    if (definition.kind === "flag") {
      values[name] = true;
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
  parse: Extract<OptionDefinition, Readonly<{ kind: "value" }>>["parse"],
  settings: Readonly<{ required?: boolean; multiple?: boolean; maxOccurrences?: number }> = {},
): OptionDefinition {
  return { kind: "value", parse, ...settings };
}

function requiredOption(parse: Extract<OptionDefinition, Readonly<{ kind: "value" }>>["parse"]): OptionDefinition {
  return option(parse, { required: true });
}

function flag(settings: Readonly<{ required?: boolean }> = {}): OptionDefinition {
  return { kind: "flag", ...settings };
}

function parseUuid(value: string): string | undefined {
  return isCanonicalUuid(value) ? value : undefined;
}

function normalizeAbsolutePathValue(value: string): string | undefined {
  const normalized = normalizeHostAbsolutePath(value);
  return normalized === undefined || normalized.path.length > WORKSPACE_PATH_MAX_LENGTH ? undefined : normalized.path;
}

function parseExportDestination(value: string): string | undefined {
  const normalized = normalizeAbsolutePathValue(value);
  return normalized === undefined || normalized.length > CLI_RUN_LIMITS.maxDestinationPathLength
    ? undefined
    : normalized;
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
  return value !== undefined && sessionOperations.has(value as CliSessionOperation);
}

function isRunOperation(value: string | undefined): value is CliRunOperation {
  return value !== undefined && runOperations.has(value as CliRunOperation);
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
