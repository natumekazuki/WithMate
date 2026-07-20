import assert from "node:assert/strict";
import test from "node:test";

import { CLI_EXIT_CODES, CLI_SESSION_MESSAGE_LIMITS, type CliValidatedSessionCommand } from "../src/cli/contract.js";
import { helpText } from "../src/cli/help.js";
import { parseCliArgv } from "../src/cli/parser.js";
import { dispatchCliSessionCommand } from "../src/cli/session-dispatch.js";
import type { ApplicationSessionMessageOperations, ApplicationSessionOperations } from "../src/main/index.js";

type Authorization = Readonly<{ principal: "local-user" }>;
type MessageOperations = ApplicationSessionMessageOperations<Authorization>;

const authorization: Authorization = { principal: "local-user" };

test("Session Message parser accepts the complete grammar and Repository-aligned defaults", () => {
  assert.deepEqual(
    parseCliArgv([
      "session",
      "messages",
      "--session-id",
      "session-1",
      "--cursor",
      "opaque-1",
      "--limit",
      "100",
      "--timeout-ms",
      "5000",
    ]),
    {
      kind: "command",
      command: {
        identity: { namespace: "session", operation: "messages" },
        sessionId: "session-1",
        cursor: "opaque-1",
        limit: 100,
        timeoutMs: 5000,
      },
    },
  );
  assert.deepEqual(parseCliArgv(["session", "messages", "--session-id", "session-1"]), {
    kind: "command",
    command: {
      identity: { namespace: "session", operation: "messages" },
      sessionId: "session-1",
      limit: CLI_SESSION_MESSAGE_LIMITS.messagesDefaultItems,
    },
  });
  assert.deepEqual(
    parseCliArgv([
      "session",
      "message-content-chunk",
      "--session-id",
      "session-1",
      "--message-id",
      "message-1",
      "--offset",
      "0",
      "--max-bytes",
      "262144",
      "--timeout-ms",
      "5000",
    ]),
    {
      kind: "command",
      command: {
        identity: { namespace: "session", operation: "message-content-chunk" },
        sessionId: "session-1",
        messageId: "message-1",
        offset: 0,
        maxBytes: 262_144,
        timeoutMs: 5000,
      },
    },
  );
});

test("Session Message parser rejects missing, duplicate, unknown, and out-of-range options", () => {
  const overlong = "x".repeat(2_049);
  const invalidArgv = [
    ["session", "messages"],
    ["session", "messages", "--session-id", "session-1", "--session-id", "session-2"],
    ["session", "messages", "--session-id", "session-1", "--unknown", "x"],
    ["session", "messages", "--session-id", "session-1", "--cursor", overlong],
    ["session", "messages", "--session-id", "session-1", "--limit", "0"],
    ["session", "messages", "--session-id", "session-1", "--limit", "101"],
    ["session", "message-content-chunk", "--session-id", "session-1", "--message-id", "message-1"],
    [
      "session",
      "message-content-chunk",
      "--session-id",
      "session-1",
      "--message-id",
      "message-1",
      "--offset",
      "-1",
      "--max-bytes",
      "1",
    ],
    [
      "session",
      "message-content-chunk",
      "--session-id",
      "session-1",
      "--message-id",
      "message-1",
      "--offset",
      "0",
      "--max-bytes",
      "0",
    ],
    [
      "session",
      "message-content-chunk",
      "--session-id",
      "session-1",
      "--message-id",
      "message-1",
      "--offset",
      "0",
      "--max-bytes",
      "262145",
    ],
  ];

  for (const argv of invalidArgv) {
    const result = parseCliArgv(argv);
    assert.equal(result.kind, "usage_failure", argv.join(" "));
    if (result.kind === "usage_failure") assert.equal(result.exitCode, CLI_EXIT_CODES.usageInvalid);
  }
});

test("Session Message help publishes the accepted command grammar", () => {
  const sessionHelp = helpText({ kind: "session" });
  const messagesHelp = helpText({
    kind: "operation",
    command: { namespace: "session", operation: "messages" },
  });
  const chunkHelp = helpText({
    kind: "operation",
    command: { namespace: "session", operation: "message-content-chunk" },
  });

  assert.match(sessionHelp, /messages/u);
  assert.match(sessionHelp, /message-content-chunk/u);
  assert.match(messagesHelp, /--limit <1\.\.100>\s+Default: 50/u);
  assert.match(messagesHelp, /--cursor <opaque-cursor>/u);
  assert.match(chunkHelp, /--message-id <message-id>/u);
  assert.match(chunkHelp, /--offset <non-negative-integer>/u);
  assert.match(chunkHelp, /--max-bytes <1\.\.262144>/u);
});

test("Message page dispatch propagates authorization and strictly projects inline, chunked, and omission results", async () => {
  const calls: unknown[] = [];
  const blocks = [{ type: "text", text: "hello" }] as const;
  const command = parsedCommand([
    "session",
    "messages",
    "--session-id",
    "session-1",
    "--cursor",
    "cursor-1",
    "--limit",
    "3",
    "--timeout-ms",
    "5000",
  ]);
  const messageOperations = messageOperationsFixture({
    messages: async (request, options) => {
      calls.push({ request, options });
      return {
        overallStatus: "partial_success",
        value: {
          sessionId: "session-1",
          items: [
            {
              id: "message-1",
              ordinal: 1,
              role: "user",
              contentByteLength: jsonByteLength(blocks),
              createdAt: 1,
              content: { state: "inline", blocks },
            },
            {
              id: "message-3",
              ordinal: 3,
              role: "assistant",
              contentByteLength: 65_537,
              createdAt: 3,
              content: { state: "chunked" },
            },
          ],
          nextCursor: "cursor-3",
        },
        issues: [
          {
            kind: "omission",
            code: "response_size_limit",
            message: "Message was omitted because the response size limit was reached.",
            ordinal: 2,
          },
        ],
        persistence: { status: "read", effect: "none" },
      };
    },
  });

  const result = await dispatchCliSessionCommand(command, dependencies(messageOperations));

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, CLI_EXIT_CODES.partialSuccess);
  assert.deepEqual(calls, [
    {
      request: {
        context: { authorization },
        sessionId: "session-1",
        cursor: "cursor-1",
        limit: 3,
      },
      options: { timeoutMs: 5000 },
    },
  ]);
  assert.equal(result.output.kind, "operation");
  if (result.output.kind === "operation") {
    assert.deepEqual(result.output.applicationResponse, {
      overallStatus: "partial_success",
      value: {
        sessionId: "session-1",
        items: [
          {
            id: "message-1",
            ordinal: 1,
            role: "user",
            contentByteLength: jsonByteLength(blocks),
            createdAt: 1,
            content: { state: "inline", blocks },
          },
          {
            id: "message-3",
            ordinal: 3,
            role: "assistant",
            contentByteLength: 65_537,
            createdAt: 3,
            content: { state: "chunked" },
          },
        ],
        nextCursor: "cursor-3",
      },
      issues: [
        {
          kind: "omission",
          code: "response_size_limit",
          message: "Message was omitted because the response size limit was reached.",
          ordinal: 2,
        },
      ],
      persistence: { status: "read", effect: "none" },
    });
    assert.equal(JSON.stringify(result.output).includes("workspaceKey"), false);
  }
});

test("Message content chunk dispatch emits base64 for actual bytes and preserves EOF coupling", async () => {
  const calls: unknown[] = [];
  const command = parsedCommand([
    "session",
    "message-content-chunk",
    "--session-id",
    "session-1",
    "--message-id",
    "message-1",
    "--offset",
    "4",
    "--max-bytes",
    "8",
  ]);
  const messageOperations = messageOperationsFixture({
    messageContentChunk: async (request, options) => {
      calls.push({ request, options });
      return {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          messageId: "message-1",
          offset: 4,
          totalBytes: 10,
          byteLength: 3,
          bytes: Uint8Array.from([1, 2, 3]).buffer,
          eof: false,
          nextOffset: 7,
        },
        persistence: { status: "read", effect: "none" },
      };
    },
  });

  const result = await dispatchCliSessionCommand(command, dependencies(messageOperations));

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, CLI_EXIT_CODES.success);
  assert.deepEqual(calls, [
    {
      request: {
        context: { authorization },
        sessionId: "session-1",
        messageId: "message-1",
        offset: 4,
        maxBytes: 8,
      },
      options: {},
    },
  ]);
  assert.equal(result.output.kind, "operation");
  if (result.output.kind === "operation" && result.output.applicationResponse.overallStatus === "success") {
    assert.deepEqual(result.output.applicationResponse.value, {
      sessionId: "session-1",
      messageId: "message-1",
      offset: 4,
      totalBytes: 10,
      chunk: { encoding: "base64", byteLength: 3, data: "AQID" },
      eof: false,
      nextOffset: 7,
    });
    assert.equal(Buffer.from(result.output.applicationResponse.value.chunk.data, "base64").byteLength, 3);
    assert.equal(Object.hasOwn(result.output.applicationResponse.value, "bytes"), false);
  }
});

test("CLI projector rejects malformed Message tuples, raw fields, and inconsistent chunk metadata", async () => {
  const blocks = [{ type: "text", text: "hello" }] as const;
  const pageCommand = parsedCommand(["session", "messages", "--session-id", "session-1"]);
  const invalidPageValues = [
    {
      sessionId: "session-1",
      items: [
        {
          id: "message-1",
          ordinal: 1,
          role: "user",
          contentByteLength: jsonByteLength(blocks),
          createdAt: 1,
          content: { state: "chunked", blocks },
        },
      ],
    },
    {
      sessionId: "session-1",
      items: [
        {
          id: "message-1",
          ordinal: 1,
          role: "user",
          contentByteLength: jsonByteLength(blocks),
          createdAt: 1,
          content: { state: "inline", blocks },
          providerPayload: "private",
        },
      ],
    },
  ];
  for (const value of invalidPageValues) {
    const result = await dispatchCliSessionCommand(
      pageCommand,
      dependencies(messageOperationsFixture({ messages: async () => success(value) as never })),
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
    assert.equal(JSON.stringify(result.output).includes("private"), false);
  }
  const zeroOrdinalOmission = await dispatchCliSessionCommand(
    pageCommand,
    dependencies(
      messageOperationsFixture({
        messages: async () =>
          ({
            overallStatus: "partial_success",
            value: { sessionId: "session-1", items: [] },
            issues: [{ kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 0 }],
            persistence: { status: "read", effect: "none" },
          }) as never,
      }),
    ),
  );
  assert.equal(zeroOrdinalOmission.ok, false);
  assert.equal(zeroOrdinalOmission.exitCode, CLI_EXIT_CODES.runtimeFailure);

  const invalidOmissionOrdinals = [
    {
      value: {
        sessionId: "session-1",
        items: [
          {
            id: "message-1",
            ordinal: 1,
            role: "user",
            contentByteLength: jsonByteLength(blocks),
            createdAt: 1,
            content: { state: "inline", blocks },
          },
        ],
      },
      issues: [{ kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 1 }],
    },
    {
      value: { sessionId: "session-1", items: [] },
      issues: [
        { kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 2 },
        { kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 1 },
      ],
    },
  ];
  for (const response of invalidOmissionOrdinals) {
    const result = await dispatchCliSessionCommand(
      pageCommand,
      dependencies(
        messageOperationsFixture({
          messages: async () =>
            ({
              overallStatus: "partial_success",
              ...response,
              persistence: { status: "read", effect: "none" },
            }) as never,
        }),
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
  }

  const chunkCommand = parsedCommand([
    "session",
    "message-content-chunk",
    "--session-id",
    "session-1",
    "--message-id",
    "message-1",
    "--offset",
    "0",
    "--max-bytes",
    "4",
  ]);
  const invalidChunks = [
    { byteLength: 3, bytes: new ArrayBuffer(2), eof: true },
    { byteLength: 2, bytes: new ArrayBuffer(2), eof: false, nextOffset: 4 },
    { byteLength: 2, bytes: new ArrayBuffer(2), eof: true, nextOffset: 2 },
  ];
  for (const invalid of invalidChunks) {
    const value = {
      sessionId: "session-1",
      messageId: "message-1",
      offset: 0,
      totalBytes: 2,
      ...invalid,
    };
    const result = await dispatchCliSessionCommand(
      chunkCommand,
      dependencies(messageOperationsFixture({ messageContentChunk: async () => success(value) as never })),
    );
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, CLI_EXIT_CODES.runtimeFailure);
  }

  const accessorChunk = {
    sessionId: "session-1",
    messageId: "message-1",
    offset: 0,
    totalBytes: 2,
    byteLength: 2,
    bytes: new ArrayBuffer(2),
  } as Record<string, unknown>;
  Object.defineProperty(accessorChunk, "eof", { enumerable: true, get: () => true });
  const accessorResult = await dispatchCliSessionCommand(
    chunkCommand,
    dependencies(messageOperationsFixture({ messageContentChunk: async () => success(accessorChunk) as never })),
  );
  assert.equal(accessorResult.ok, false);
  assert.equal(accessorResult.exitCode, CLI_EXIT_CODES.runtimeFailure);

  const partialChunk = await dispatchCliSessionCommand(
    chunkCommand,
    dependencies(
      messageOperationsFixture({
        messageContentChunk: async () =>
          ({
            overallStatus: "partial_success",
            value: {
              sessionId: "session-1",
              messageId: "message-1",
              offset: 0,
              totalBytes: 2,
              byteLength: 2,
              bytes: new ArrayBuffer(2),
              eof: true,
            },
            issues: [{ kind: "omission", code: "response_size_limit", message: "omitted", ordinal: 1 }],
            persistence: { status: "read", effect: "none" },
          }) as never,
      }),
    ),
  );
  assert.equal(partialChunk.ok, false);
  assert.equal(partialChunk.exitCode, CLI_EXIT_CODES.runtimeFailure);
});

function parsedCommand(argv: readonly string[]): CliValidatedSessionCommand {
  const parsed = parseCliArgv(argv);
  assert.equal(parsed.kind, "command");
  if (parsed.kind !== "command" || parsed.command.identity.namespace !== "session") assert.fail("expected command");
  return parsed.command as CliValidatedSessionCommand;
}

function dependencies(messageOperations: MessageOperations) {
  return { operations: unsupportedSessionOperations(), messageOperations, authorization } as const;
}

function messageOperationsFixture(overrides: Partial<MessageOperations>): MessageOperations {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected Message operation");
  };
  return {
    messages: overrides.messages ?? unsupported,
    messageContentChunk: overrides.messageContentChunk ?? unsupported,
  };
}

function unsupportedSessionOperations(): ApplicationSessionOperations<Authorization> {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected Session operation");
  };
  return {
    create: unsupported,
    updateTitle: unsupported,
    list: unsupported,
    listLocalRepositories: unsupported,
    read: unsupported,
    readDirectoriesChunk: unsupported,
    archive: unsupported,
    unarchive: unsupported,
    close: unsupported,
    delete: unsupported,
  };
}

function success(value: unknown) {
  return { overallStatus: "success", value, persistence: { status: "read", effect: "none" } } as const;
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
