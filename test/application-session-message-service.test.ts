import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationSessionMessageService,
  type ApplicationSessionMessageServiceOptions,
} from "../src/main/application-session-message-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import {
  APPLICATION_SESSION_MESSAGE_LIMITS,
  type ApplicationSessionMessageAccessValidator,
} from "../src/shared/application-session-message-model.js";

type Authorization = Readonly<{ principal: string }>;
type Reads = ApplicationSessionMessageServiceOptions<Authorization>["reads"];
type MessagePageProjection = Awaited<ReturnType<Reads["messagesPage"]>>;

const authorization: Authorization = { principal: "owner" };

test("invalid Message requests fail before authorization and Repository access", async () => {
  let authorizationCalls = 0;
  let repositoryCalls = 0;
  const service = createService({
    access: {
      async authorize() {
        authorizationCalls += 1;
        return { allowed: true };
      },
    },
    reads: reads({
      sessionGet: async () => {
        repositoryCalls += 1;
        return sessionProjection();
      },
      messagesPage: async () => {
        repositoryCalls += 1;
        return pageProjection();
      },
      messageContentChunk: async () => {
        repositoryCalls += 1;
        return chunkProjection();
      },
    }),
  });
  const invalidMessages = [
    { ...messagesRequest(), sessionId: "" },
    { ...messagesRequest(), cursor: "x".repeat(APPLICATION_SESSION_MESSAGE_LIMITS.maxCursorLength + 1) },
    { ...messagesRequest(), limit: 0 },
    { ...messagesRequest(), limit: APPLICATION_SESSION_MESSAGE_LIMITS.messagesMaxItems + 1 },
    { ...messagesRequest(), unexpected: true },
  ];
  const invalidChunks = [
    { ...chunkRequest(), messageId: "" },
    { ...chunkRequest(), offset: -1 },
    { ...chunkRequest(), maxBytes: 0 },
    { ...chunkRequest(), maxBytes: APPLICATION_SESSION_MESSAGE_LIMITS.chunkMaxBytes + 1 },
    { ...chunkRequest(), unexpected: true },
  ];

  for (const request of invalidMessages) {
    const response = await service.messages(request as never);
    assertFailure(response, "request", "request_invalid", "not_attempted");
  }
  for (const request of invalidChunks) {
    const response = await service.messageContentChunk(request as never);
    assertFailure(response, "request", "request_invalid", "not_attempted");
  }
  assert.equal(authorizationCalls, 0);
  assert.equal(repositoryCalls, 0);
});

test("authorization targets distinguish the Message page from content and rejection performs no Repository read", async () => {
  const targets: unknown[] = [];
  let repositoryCalls = 0;
  const service = createService({
    access: {
      async authorize(input) {
        targets.push(input);
        return {
          allowed: false,
          error: { code: "forbidden", message: "secret Message body C:\\private", retryable: false },
        };
      },
    },
    reads: reads({
      sessionGet: async () => {
        repositoryCalls += 1;
        return sessionProjection();
      },
    }),
  });

  const messages = await service.messages(messagesRequest());
  const chunk = await service.messageContentChunk(chunkRequest());

  assertFailure(messages, "access", "forbidden", "not_attempted");
  assertFailure(chunk, "access", "forbidden", "not_attempted");
  assert.equal(JSON.stringify([messages, chunk]).includes("secret Message body"), false);
  assert.equal(repositoryCalls, 0);
  assert.deepEqual(targets, [
    {
      operation: "messages",
      access: "read",
      context: { authorization },
      target: { kind: "session_messages", sessionId: "session-1" },
    },
    {
      operation: "message_content_chunk",
      access: "read",
      context: { authorization },
      target: {
        kind: "session_message_content",
        sessionId: "session-1",
        messageId: "message-1",
        offset: 0,
        maxBytes: 4,
      },
    },
  ]);
});

test("Message page resolves internal workspace scope, preserves ordinal gaps, and projects inline and chunked states", async () => {
  const calls: unknown[] = [];
  const blocks = [{ type: "text", text: "hello" }] as const;
  const service = createService({
    reads: reads({
      sessionGet: async (input, options) => {
        calls.push({ operation: "sessionGet", input, signal: options?.signal instanceof AbortSignal });
        return sessionProjection("session-1", "workspace-1", "archived");
      },
      messagesPage: async (input, options) => {
        calls.push({ operation: "messagesPage", input, signal: options?.signal instanceof AbortSignal });
        return pageProjection(
          [
            messageProjection({ id: "message-1", ordinal: 2, blocks }),
            messageProjection({
              id: "message-2",
              ordinal: 5,
              contentState: "chunked",
              contentByteLength: APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes + 1,
            }),
          ],
          "cursor-2",
        );
      },
    }),
  });

  const response = await service.messages({ ...messagesRequest(), cursor: "cursor-1", limit: 2 });

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.deepEqual(response.value, {
      sessionId: "session-1",
      items: [
        {
          id: "message-1",
          ordinal: 2,
          role: "user",
          contentByteLength: jsonByteLength(blocks),
          createdAt: 10,
          content: { state: "inline", blocks },
        },
        {
          id: "message-2",
          ordinal: 5,
          role: "user",
          contentByteLength: APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes + 1,
          createdAt: 10,
          content: { state: "chunked" },
        },
      ],
      nextCursor: "cursor-2",
    });
    assert.equal(Object.hasOwn(response.value, "workspaceKey"), false);
    assert.equal(Object.hasOwn(response.value.items[1]!, "contentBlocks"), false);
  }
  assert.deepEqual(calls, [
    { operation: "sessionGet", input: { sessionId: "session-1" }, signal: true },
    {
      operation: "messagesPage",
      input: { sessionId: "session-1", workspaceKey: "workspace-1", cursor: "cursor-1", limit: 2 },
      signal: true,
    },
  ]);
});

test("Message page uses the Repository default limit and snapshots inline blocks", async () => {
  const source = [{ type: "text", text: "before" }] as { type: "text"; text: string }[];
  const service = createService({
    reads: reads({
      messagesPage: async (input) => {
        assert.equal(input.limit, APPLICATION_SESSION_MESSAGE_LIMITS.messagesDefaultItems);
        return pageProjection([messageProjection({ blocks: source })]);
      },
    }),
  });

  const response = await service.messages(messagesRequest());
  source[0]!.text = "after";
  source.push({ type: "text", text: "mutated" });

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.deepEqual(response.value.items[0]!.content, {
      state: "inline",
      blocks: [{ type: "text", text: "before" }],
    });
    assert.equal(
      Object.isFrozen(
        response.value.items[0]!.content.state === "inline" ? response.value.items[0]!.content.blocks : [],
      ),
      true,
    );
  }
});

test("Repository Message omission becomes bounded partial success and is not projected as an item", async () => {
  const service = createService({
    reads: reads({
      messagesPage: async () =>
        pageProjection(
          [
            messageProjection({ id: "message-1", ordinal: 1 }),
            { omitted: true, reason: "response_size_limit", ordinal: 2 },
            messageProjection({ id: "message-3", ordinal: 3 }),
          ],
          "cursor-3",
        ),
    }),
  });

  const response = await service.messages(messagesRequest());

  assert.equal(response.overallStatus, "partial_success");
  if (response.overallStatus === "partial_success") {
    assert.deepEqual(
      response.value.items.map((item) => item.id),
      ["message-1", "message-3"],
    );
    assert.deepEqual(response.issues, [
      {
        kind: "omission",
        code: "response_size_limit",
        message: "Message was omitted because the response size limit was reached.",
        ordinal: 2,
      },
    ]);
    assert.equal(response.value.nextCursor, "cursor-3");
  }
});

test("Message page rejects malformed scope, ordering, content tuples, and content blocks as internal failures", async () => {
  const inlineBlocks = [{ type: "text", text: "hello" }] as const;
  const invalidPages: unknown[] = [
    pageProjection([messageProjection({ sessionId: "session-other" })]),
    { ...pageProjection(), workspaceKey: "workspace-other" },
    pageProjection([messageProjection({ ordinal: 0 })]),
    pageProjection([messageProjection({ ordinal: 2 }), messageProjection({ id: "message-2", ordinal: 1 })]),
    pageProjection([{ ...messageProjection(), role: "system" }]),
    pageProjection([{ ...messageProjection(), contentByteLength: 1 }]),
    pageProjection([
      { ...messageProjection({ blocks: inlineBlocks }), contentByteLength: jsonByteLength(inlineBlocks) + 1 },
    ]),
    pageProjection([{ ...messageProjection(), contentState: "inline", contentBlocks: undefined }]),
    pageProjection([
      {
        ...messageProjection(),
        contentState: "inline",
        contentByteLength: APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes + 1,
      },
    ]),
    pageProjection([
      {
        ...messageProjection(),
        contentState: "chunked",
        contentByteLength: APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes,
      },
    ]),
    pageProjection([
      {
        ...messageProjection(),
        contentState: "chunked",
        contentByteLength: APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes + 1,
        contentBlocks: inlineBlocks,
      },
    ]),
    pageProjection([{ ...messageProjection(), contentBlocks: [{ type: "tool", text: "private" }] }]),
    pageProjection([], "cursor-same"),
  ];

  for (const page of invalidPages) {
    const service = createService({ reads: reads({ messagesPage: async () => page as never }) });
    const response = await service.messages({ ...messagesRequest(), cursor: "cursor-same" });
    assertFailure(response, "application", "internal_error", "failed");
    assert.equal(JSON.stringify(response).includes("private"), false);
  }
});

test("Repository not-found is uniformly bounded for missing Session, workspace, and Message", async () => {
  for (const operation of ["session", "page", "chunk"] as const) {
    const secret = "C:\\private\\message.json raw Message content";
    const error = new PersistenceClientError({ code: "not_found", message: secret, retryable: false, effect: "none" });
    const service = createService({
      reads: reads({
        sessionGet: async () => {
          if (operation === "session") throw error;
          return sessionProjection();
        },
        messagesPage: async () => {
          if (operation === "page") throw error;
          return pageProjection();
        },
        messageContentChunk: async () => {
          if (operation === "chunk") throw error;
          return chunkProjection();
        },
      }),
    });
    const response =
      operation === "chunk"
        ? await service.messageContentChunk(chunkRequest())
        : await service.messages(messagesRequest());
    assertFailure(response, "domain", "not_found", "rejected");
    assert.equal(JSON.stringify(response).includes(secret), false);
  }
});

test("invalid persisted Message content remains a bounded internal chunk failure", async () => {
  const secret = "private legacy Message content";
  const error = new PersistenceClientError({
    code: "operation_failed",
    message: secret,
    retryable: false,
    effect: "none",
  });
  const service = createService({
    reads: reads({
      messageContentChunk: async () => {
        throw error;
      },
    }),
  });

  const response = await service.messageContentChunk(chunkRequest());

  assertFailure(response, "persistence", "persistence_operation_failed", "failed");
  assert.equal(JSON.stringify(response).includes(secret), false);
});

test("Message content chunk uses actual bytes for byteLength, nextOffset, EOF, and buffer ownership", async () => {
  const source = Uint8Array.from([1, 2, 3]).buffer;
  const requests: unknown[] = [];
  const service = createService({
    reads: reads({
      messageContentChunk: async (input, options) => {
        requests.push({ input, signal: options?.signal instanceof AbortSignal });
        return chunkProjection({ offset: 4, bytes: source, totalBytes: 10, eof: false });
      },
    }),
  });

  const response = await service.messageContentChunk({ ...chunkRequest(), offset: 4, maxBytes: 8 });
  new Uint8Array(source)[0] = 99;

  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.deepEqual(
      { ...response.value, bytes: [...new Uint8Array(response.value.bytes)] },
      {
        sessionId: "session-1",
        messageId: "message-1",
        offset: 4,
        totalBytes: 10,
        byteLength: 3,
        bytes: [1, 2, 3],
        eof: false,
        nextOffset: 7,
      },
    );
    assert.notEqual(response.value.bytes, source);
  }
  assert.deepEqual(requests, [
    {
      input: {
        sessionId: "session-1",
        workspaceKey: "workspace-1",
        messageId: "message-1",
        offset: 4,
        maxBytes: 8,
      },
      signal: true,
    },
  ]);
});

test("Message content chunk ownership cannot be bypassed by an own ArrayBuffer slice method", async () => {
  const source = Uint8Array.from([1, 2]).buffer;
  Object.defineProperty(source, "slice", { value: () => source });
  const service = createService({
    reads: reads({
      messageContentChunk: async () => chunkProjection({ bytes: source, totalBytes: 2, eof: true }),
    }),
  });

  const response = await service.messageContentChunk(chunkRequest());
  assert.equal(response.overallStatus, "success");
  if (response.overallStatus === "success") {
    assert.notEqual(response.value.bytes, source);
    new Uint8Array(source)[0] = 99;
    assert.deepEqual([...new Uint8Array(response.value.bytes)], [1, 2]);
  }
});

test("Message content chunk accepts exact-end and beyond-end empty EOF results", async () => {
  for (const offset of [4, 8]) {
    const service = createService({
      reads: reads({
        messageContentChunk: async () =>
          chunkProjection({ offset, totalBytes: 4, bytes: new ArrayBuffer(0), eof: true }),
      }),
    });
    const response = await service.messageContentChunk({ ...chunkRequest(), offset });
    assert.equal(response.overallStatus, "success");
    if (response.overallStatus === "success") {
      assert.equal(response.value.byteLength, 0);
      assert.equal(response.value.eof, true);
      assert.equal(Object.hasOwn(response.value, "nextOffset"), false);
    }
  }
});

test("Message content chunk rejects inconsistent scope, clamp, progress, range, and EOF metadata", async () => {
  const invalidChunks = [
    chunkProjection({ sessionId: "session-other" }),
    chunkProjection({ messageId: "message-other" }),
    chunkProjection({ offset: 1 }),
    chunkProjection({ bytes: new ArrayBuffer(5), totalBytes: 10, eof: false }),
    chunkProjection({ bytes: new ArrayBuffer(0), totalBytes: 10, eof: false }),
    chunkProjection({ bytes: new ArrayBuffer(2), totalBytes: 10, eof: true }),
    chunkProjection({ bytes: new ArrayBuffer(5), totalBytes: 4, eof: true }),
  ];
  for (const chunk of invalidChunks) {
    const service = createService({ reads: reads({ messageContentChunk: async () => chunk }) });
    const response = await service.messageContentChunk(chunkRequest());
    assertFailure(response, "application", "internal_error", "failed");
  }
});

test("Message content chunk validates 1 and 256 KiB boundaries and supports inline-sized content", async () => {
  for (const maxBytes of [1, APPLICATION_SESSION_MESSAGE_LIMITS.chunkMaxBytes]) {
    let observedMaxBytes = 0;
    const service = createService({
      reads: reads({
        messageContentChunk: async (input) => {
          observedMaxBytes = input.maxBytes;
          return chunkProjection({ bytes: Uint8Array.from([91]).buffer, totalBytes: 2, eof: false });
        },
      }),
    });
    const response = await service.messageContentChunk({ ...chunkRequest(), maxBytes });
    assert.equal(response.overallStatus, "success");
    assert.equal(observedMaxBytes, maxBytes);
  }
});

test("timeout and AbortSignal cancellation abort a started Repository Message read and never become success", async () => {
  let timeoutAborted = false;
  const timeoutService = createService({
    reads: reads({
      messagesPage: async (_input, options) =>
        pendingUntilAbort(options?.signal, () => {
          timeoutAborted = true;
        }),
    }),
  });
  const timeout = await timeoutService.messages(messagesRequest(), { timeoutMs: 5 });
  assertFailure(timeout, "persistence", "persistence_timeout", "failed");
  assert.equal(timeoutAborted, true);

  let cancelAborted = false;
  let markChunkReadStarted!: () => void;
  const chunkReadStarted = new Promise<void>((resolve) => {
    markChunkReadStarted = resolve;
  });
  const cancelService = createService({
    reads: reads({
      messageContentChunk: async (_input, options) => {
        markChunkReadStarted();
        return pendingUntilAbort(options?.signal, () => {
          cancelAborted = true;
        });
      },
    }),
  });
  const controller = new AbortController();
  const pending = cancelService.messageContentChunk(chunkRequest(), { signal: controller.signal });
  await chunkReadStarted;
  controller.abort();
  const canceled = await pending;
  assertFailure(canceled, "persistence", "persistence_canceled", "failed");
  assert.equal(cancelAborted, true);
});

function createService(
  overrides: Partial<ApplicationSessionMessageServiceOptions<Authorization>> = {},
): ApplicationSessionMessageService<Authorization> {
  return new ApplicationSessionMessageService({
    reads: overrides.reads ?? reads(),
    access: overrides.access ?? allowAccess(),
    snapshotAuthorization(value) {
      if (typeof value !== "object" || value === null || (value as Authorization).principal !== "owner") {
        throw new TypeError("invalid authorization");
      }
      return { principal: "owner" };
    },
  });
}

function allowAccess(): ApplicationSessionMessageAccessValidator<Authorization> {
  return {
    async authorize() {
      return { allowed: true };
    },
  };
}

function reads(overrides: Partial<Reads> = {}): Reads {
  return {
    sessionGet: overrides.sessionGet ?? (async () => sessionProjection()),
    messagesPage: overrides.messagesPage ?? (async () => pageProjection()),
    messageContentChunk: overrides.messageContentChunk ?? (async () => chunkProjection()),
  };
}

function messagesRequest() {
  return { context: { authorization }, sessionId: "session-1" } as const;
}

function chunkRequest() {
  return { ...messagesRequest(), messageId: "message-1", offset: 0, maxBytes: 4 } as const;
}

function sessionProjection(
  id = "session-1",
  workspaceKey = "workspace-1",
  lifecycleStatus: "active" | "archived" | "closed" = "active",
) {
  return {
    session: {
      id,
      title: "Session",
      providerId: "provider",
      workspaceKey,
      workspacePath: "C:\\workspace",
      localRepositoryKey: null,
      repositoryName: null,
      allowedAdditionalDirectoriesByteLength: 2,
      allowedAdditionalDirectoriesState: "inline" as const,
      allowedAdditionalDirectories: [],
      defaultCharacterId: "character",
      maxConcurrentChildRuns: 2,
      lifecycleStatus,
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    },
    execution: { state: "not_started" as const },
  };
}

function pageProjection(items: readonly unknown[] = [messageProjection()], nextCursor?: string): MessagePageProjection {
  return {
    sessionId: "session-1",
    workspaceKey: "workspace-1",
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  } as unknown as MessagePageProjection;
}

function messageProjection(
  overrides: Readonly<{
    id?: string;
    sessionId?: string;
    ordinal?: number;
    blocks?: unknown;
    contentState?: "inline" | "chunked";
    contentByteLength?: number;
  }> = {},
) {
  const blocks = overrides.blocks ?? [{ type: "text", text: "hello" }];
  const contentState = overrides.contentState ?? "inline";
  return {
    id: overrides.id ?? "message-1",
    sessionId: overrides.sessionId ?? "session-1",
    ordinal: overrides.ordinal ?? 1,
    role: "user" as const,
    contentByteLength: overrides.contentByteLength ?? jsonByteLength(blocks),
    contentState,
    ...(contentState === "inline" ? { contentBlocks: blocks } : {}),
    createdAt: 10,
  };
}

function chunkProjection(
  overrides: Readonly<{
    sessionId?: string;
    messageId?: string;
    offset?: number;
    totalBytes?: number;
    eof?: boolean;
    bytes?: ArrayBuffer;
  }> = {},
) {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    messageId: overrides.messageId ?? "message-1",
    offset: overrides.offset ?? 0,
    totalBytes: overrides.totalBytes ?? 4,
    eof: overrides.eof ?? true,
    bytes: overrides.bytes ?? new ArrayBuffer(4),
  };
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertFailure(
  response: Readonly<{
    overallStatus: string;
    error?: Readonly<{ kind: string; code: string }>;
    persistence: Readonly<{ status: string }>;
  }>,
  kind: string,
  code: string,
  persistenceStatus: string,
): void {
  assert.equal(response.overallStatus, "failure");
  assert.equal(response.error?.kind, kind);
  assert.equal(response.error?.code, code);
  assert.equal(response.persistence.status, persistenceStatus);
}

function pendingUntilAbort<TValue>(signal: AbortSignal | undefined, onAbort: () => void): Promise<TValue> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        onAbort();
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
