import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ApplicationAccessValidationInput,
  ApplicationAccessValidator,
  ApplicationSessionOperationContext,
} from "../src/shared/application-service-model.js";
import {
  APPLICATION_MAX_CONCURRENT_CHILD_RUNS,
  APPLICATION_MAX_READ_CHUNK_BYTES,
  ApplicationSessionService,
} from "../src/main/application-session-service.js";
import type { LocalRepositoryMetadataResolver } from "../src/main/local-repository-metadata.js";
import { PersistenceClientError, PersistenceWorkerClient } from "../src/main/persistence-worker-client.js";
import { RepositoryReadClient } from "../src/main/repository-read-client.js";
import { RepositoryWriteClient } from "../src/main/repository-write-client.js";
import type {
  RepositoryCommandError,
  SessionCreateCommand,
  SessionCreateResult,
  SessionTransitionCommand,
} from "../src/shared/repository-write-model.js";
import { resolveWorkspaceIdentity } from "../src/shared/workspace-path.js";

type Authorization = Readonly<{ principalId: string }>;
type ReadPort = Pick<RepositoryReadClient, "sessionsPage" | "sessionGet" | "sessionDirectoriesChunk">;
type WritePort = Pick<RepositoryWriteClient, "createSession" | "transitionSession">;

const workspace = resolveWorkspaceIdentity(path.resolve("workspace-1"))!;
const otherWorkspace = resolveWorkspaceIdentity(path.resolve("workspace-2"))!;
const context: ApplicationSessionOperationContext<Authorization> = {
  authorization: { principalId: "user-1" },
};
const workerUrl = new URL("../src/persistence-worker/worker-entry.ts", import.meta.url);
const workerOptions = { execArgv: ["--import", "tsx"] };
const workerTest = Number.parseInt(process.versions.node, 10) >= 24 ? test : test.skip;
const localRepositoryKey = `local-repository-v1-sha256-${"a".repeat(64)}`;

workerTest("Session operations run end-to-end through the Application Service and production Repository", async () => {
  await withTempDirectory(async (directory) => {
    const client = new PersistenceWorkerClient({
      workerUrl,
      databasePath: path.join(directory, "application-session.sqlite3"),
      legacyDatabasePaths: [],
      workerOptions,
    });
    await client.start();
    try {
      const service = new ApplicationSessionService({
        reads: new RepositoryReadClient(client),
        writes: new RepositoryWriteClient(client),
        access: allowingAccess(),
        snapshotAuthorization: structuredClone,
      });
      const created = await service.create(createRequest());
      assert.equal(created.overallStatus, "success");
      if (created.overallStatus !== "success") assert.fail("Session creation failed");
      const sessionId = created.value.sessionId;

      const replay = await service.create(createRequest());
      assert.equal(replay.overallStatus, "success");
      assert.deepEqual(replay.persistence, { status: "committed", effect: "none", replayed: true });
      const conflict = await service.create({ ...createRequest(), providerId: "other-provider" });
      assert.equal(conflict.overallStatus, "failure");
      assert.equal(
        conflict.overallStatus === "failure" && conflict.error.kind === "domain" && conflict.error.code,
        "idempotency_conflict",
      );

      const otherContext: ApplicationSessionOperationContext<Authorization> = {
        authorization: { principalId: "user-2" },
      };
      const otherService = new ApplicationSessionService({
        reads: new RepositoryReadClient(client),
        writes: new RepositoryWriteClient(client),
        access: allowingAccess(),
        snapshotAuthorization: structuredClone,
      });
      const otherCreated = await otherService.create({
        ...createRequest(),
        context: otherContext,
        workspacePath: otherWorkspace.workspacePath,
        idempotencyKey: uuid(30),
      });
      assert.equal(otherCreated.overallStatus, "success");
      if (otherCreated.overallStatus !== "success") assert.fail("other workspace Session creation failed");
      const otherSessionId = otherCreated.value.sessionId;

      const listed = await service.list({ context, workspacePath: workspace.workspacePath });
      assert.equal(listed.overallStatus, "success");
      assert.deepEqual(listed.overallStatus === "success" && listed.value.items.map((item) => item.id), [sessionId]);
      const globallyListed = await service.list({ context });
      assert.equal(globallyListed.overallStatus, "success");
      assert.deepEqual(
        globallyListed.overallStatus === "success" && globallyListed.value.items.map((item) => item.id).sort(),
        [otherSessionId, sessionId].sort(),
      );
      const foreignRead = await service.read({ context, sessionId: otherSessionId });
      assert.equal(foreignRead.overallStatus, "success");
      const foreignDirectories = await service.readDirectoriesChunk({
        context,
        sessionId: otherSessionId,
        offset: 0,
        maxBytes: 1_024,
      });
      assert.equal(foreignDirectories.overallStatus, "success");
      const foreignArchive = await service.archive({
        context,
        sessionId: otherSessionId,
        idempotencyKey: uuid(31),
      });
      assert.equal(foreignArchive.overallStatus, "success");
      const foreignClose = await service.close({
        context,
        sessionId: otherSessionId,
        idempotencyKey: uuid(32),
        expectedLifecycleStatus: "archived",
      });
      assert.equal(foreignClose.overallStatus, "success");
      const detail = await service.read({ context, sessionId });
      assert.equal(detail.overallStatus, "success");
      assert.equal(detail.overallStatus === "success" && detail.value.execution.state, "not_started");

      const archived = await service.archive({ context, sessionId, idempotencyKey: uuid(20) });
      assert.equal(archived.overallStatus === "success" && archived.value.lifecycleStatus, "archived");
      const restored = await service.unarchive({ context, sessionId, idempotencyKey: uuid(21) });
      assert.equal(restored.overallStatus === "success" && restored.value.lifecycleStatus, "active");
      const closed = await service.close({
        context,
        sessionId,
        idempotencyKey: uuid(22),
        expectedLifecycleStatus: "active",
      });
      assert.equal(closed.overallStatus === "success" && closed.value.lifecycleStatus, "closed");
      const reopen = await service.unarchive({ context, sessionId, idempotencyKey: uuid(23) });
      assert.equal(reopen.overallStatus, "failure");
      assert.equal(
        reopen.overallStatus === "failure" && reopen.error.kind === "domain" && reopen.error.code,
        "lifecycle_conflict",
      );
    } finally {
      await client.shutdown();
    }
  });
});

workerTest("Application list accepts a Repository cursor containing a maximum-length Session ID", async () => {
  await withTempDirectory(async (directory) => {
    const client = new PersistenceWorkerClient({
      workerUrl,
      databasePath: path.join(directory, "application-session-cursor.sqlite3"),
      legacyDatabasePaths: [],
      workerOptions,
    });
    await client.start();
    try {
      const writes = new RepositoryWriteClient(client);
      for (const [id, idempotencyKey] of [
        ["z".repeat(1_024), uuid(60)],
        ["a".repeat(1_024), uuid(61)],
      ] as const) {
        const result = await writes.createSession({
          idempotencyKey,
          session: {
            id,
            title: "Cursor boundary Session",
            providerId: "codex",
            workspaceKey: workspace.workspaceKey,
            workspacePath: workspace.workspacePath,
            localRepositoryKey: null,
            repositoryName: null,
            allowedAdditionalDirectories: [],
            defaultCharacterId: "character-1",
            maxConcurrentChildRuns: 2,
          },
        });
        assert.equal(result.ok, true);
      }
      const service = new ApplicationSessionService({
        reads: new RepositoryReadClient(client),
        writes,
        access: allowingAccess(),
        snapshotAuthorization: structuredClone,
      });

      const first = await service.list({ context, limit: 1 });
      assert.equal(first.overallStatus, "success");
      if (first.overallStatus !== "success") assert.fail("first Session page failed");
      assert.ok(first.value.nextCursor !== undefined);
      assert.ok(first.value.nextCursor.length > 1_024);
      assert.ok(first.value.nextCursor.length <= 2_048);

      const second = await service.list({ context, limit: 1, cursor: first.value.nextCursor });
      assert.equal(second.overallStatus, "success");
      if (second.overallStatus !== "success") assert.fail("second Session page failed");
      assert.equal(second.value.items.length, 1);
      assert.notEqual(second.value.items[0]?.id, first.value.items[0]?.id);
    } finally {
      await client.shutdown();
    }
  });
});

workerTest("Application reads chunked Session directory configuration through the scoped Repository port", async () => {
  await withTempDirectory(async (directory) => {
    const client = new PersistenceWorkerClient({
      workerUrl,
      databasePath: path.join(directory, "application-session-directories.sqlite3"),
      legacyDatabasePaths: [],
      workerOptions,
    });
    await client.start();
    try {
      const service = new ApplicationSessionService({
        reads: new RepositoryReadClient(client),
        writes: new RepositoryWriteClient(client),
        access: allowingAccess(),
        snapshotAuthorization: structuredClone,
      });
      const allowedAdditionalDirectories = [
        `C:\\${"a".repeat(24_000)}`,
        `D:\\${"b".repeat(24_000)}`,
        `E:\\${"c".repeat(24_000)}`,
      ];
      const created = await service.create({ ...createRequest(), allowedAdditionalDirectories });
      assert.equal(created.overallStatus, "success");
      if (created.overallStatus !== "success") assert.fail("chunked Session creation failed");

      const detail = await service.read({ context, sessionId: created.value.sessionId });
      assert.equal(detail.overallStatus, "success");
      if (detail.overallStatus !== "success") assert.fail("chunked Session detail failed");
      assert.equal(detail.value.session.allowedAdditionalDirectoriesState, "chunked");
      assert.equal("allowedAdditionalDirectories" in detail.value.session, false);

      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (true) {
        const chunk = await service.readDirectoriesChunk({
          context,
          sessionId: created.value.sessionId,
          offset,
          maxBytes: 32 * 1024,
        });
        assert.equal(chunk.overallStatus, "success");
        if (chunk.overallStatus !== "success") assert.fail("Session directory chunk failed");
        const bytes = new Uint8Array(chunk.value.bytes);
        chunks.push(bytes);
        offset += bytes.byteLength;
        if (chunk.value.eof) break;
      }
      const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      assert.deepEqual(decoded, allowedAdditionalDirectories);

      const beyondEof = await service.readDirectoriesChunk({
        context,
        sessionId: created.value.sessionId,
        offset: detail.value.session.allowedAdditionalDirectoriesByteLength + 10,
        maxBytes: 32 * 1_024,
      });
      assert.equal(beyondEof.overallStatus, "success");
      if (beyondEof.overallStatus !== "success") assert.fail("post-EOF Session directory chunk failed");
      assert.equal(beyondEof.value.bytes.byteLength, 0);
      assert.equal(beyondEof.value.eof, true);
    } finally {
      await client.shutdown();
    }
  });
});

test("create validates workspace and authorization before issuing a stable Session ID", async () => {
  const events: string[] = [];
  const commands: SessionCreateCommand[] = [];
  const service = createService({
    access: allowingAccess(events),
    writes: {
      async createSession(command) {
        events.push("write");
        commands.push(command);
        return {
          ok: true,
          value: sessionCreateResult(command, 100),
          replayed: commands.length > 1,
        };
      },
    },
  });
  const request = createRequest();

  const first = await service.create(request);
  const replay = await service.create(request);

  assert.deepEqual(events, [
    "workspace:create",
    "authorize:create",
    "write",
    "workspace:create",
    "authorize:create",
    "write",
  ]);
  assert.equal(first.overallStatus, "success");
  assert.equal(replay.overallStatus, "success");
  assert.equal(commands[0]?.session.id, commands[1]?.session.id);
  assert.match(commands[0]?.session.id ?? "", /^session_[0-9a-f]{64}$/);
  assert.deepEqual(commands[0], {
    idempotencyKey: request.idempotencyKey,
    session: {
      id: commands[0]?.session.id,
      title: request.title,
      providerId: "codex",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
      localRepositoryKey: null,
      repositoryName: null,
      allowedAdditionalDirectories: ["C:\\workspace-shared"],
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 2,
    },
  });
  assert.deepEqual(first.persistence, { status: "committed", effect: "none", replayed: false });
  assert.deepEqual(replay.persistence, { status: "committed", effect: "none", replayed: true });
  assert.deepEqual(
    replay.overallStatus === "success" && replay.value,
    first.overallStatus === "success" && first.value,
  );
});

test("create resolves and persists local Repository metadata after authorization", async () => {
  const events: string[] = [];
  let persisted: SessionCreateCommand | undefined;
  const service = createService({
    access: allowingAccess(events),
    async resolveLocalRepositoryMetadata(workspacePath, signal) {
      events.push("resolve-repository");
      assert.equal(workspacePath, workspace.workspacePath);
      assert.equal(signal.aborted, false);
      return {
        status: "found",
        metadata: { localRepositoryKey, repositoryName: "WithMate" },
      };
    },
    writes: {
      async createSession(command) {
        events.push("write");
        persisted = command;
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });

  const response = await service.create(createRequest());

  assert.equal(response.overallStatus, "success");
  assert.deepEqual(events, ["workspace:create", "authorize:create", "resolve-repository", "write"]);
  assert.equal(persisted?.session.localRepositoryKey, localRepositoryKey);
  assert.equal(persisted?.session.repositoryName, "WithMate");
  assert.equal(response.overallStatus === "success" && response.value.localRepositoryKey, localRepositoryKey);
  assert.equal(response.overallStatus === "success" && response.value.repositoryName, "WithMate");
});

test("exact create retry returns the persisted Repository snapshot when Git detection changes", async () => {
  let resolutionCount = 0;
  let stored: SessionCreateResult | undefined;
  const service = createService({
    async resolveLocalRepositoryMetadata() {
      resolutionCount += 1;
      return resolutionCount === 1
        ? { status: "found", metadata: { localRepositoryKey, repositoryName: "WithMate" } }
        : { status: "unavailable" };
    },
    writes: {
      async createSession(command) {
        stored ??= sessionCreateResult(command, 1);
        return { ok: true, value: stored, replayed: resolutionCount > 1 };
      },
    },
  });

  const first = await service.create(createRequest());
  const replay = await service.create(createRequest());

  assert.equal(first.overallStatus, "success");
  assert.equal(replay.overallStatus, "success");
  assert.equal(replay.overallStatus === "success" && replay.value.localRepositoryKey, localRepositoryKey);
  assert.equal(replay.overallStatus === "success" && replay.value.repositoryName, "WithMate");
  assert.deepEqual(replay.persistence, { status: "committed", effect: "none", replayed: true });
});

test("malformed Repository metadata resolution fails before persistence", async () => {
  let writes = 0;
  const service = createService({
    resolveLocalRepositoryMetadata: async () =>
      ({ status: "found", metadata: { localRepositoryKey: null, repositoryName: null } }) as never,
    writes: {
      async createSession() {
        writes += 1;
        throw new Error("unreachable");
      },
    },
  });

  const response = await service.create(createRequest());

  assert.equal(response.overallStatus, "failure");
  assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
  assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  assert.equal(writes, 0);
});

test("Repository metadata resolution observes the Application deadline before persistence", async () => {
  let resolverAborted = false;
  let writes = 0;
  const service = createService({
    resolveLocalRepositoryMetadata: async (_workspacePath, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            resolverAborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
    writes: {
      async createSession() {
        writes += 1;
        throw new Error("unreachable");
      },
    },
  });

  const response = await service.create(createRequest(), { timeoutMs: 10 });

  assert.equal(response.overallStatus, "failure");
  assert.equal(response.overallStatus === "failure" && response.error.code, "operation_timeout");
  assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  assert.equal(resolverAborted, true);
  assert.equal(writes, 0);
});

test("create validates every canonical directory candidate before compacting the Repository value", async () => {
  let workspaceValidationDirectories: readonly string[] | undefined;
  let authorizationDirectories: readonly string[] | undefined;
  let commandDirectories: readonly string[] | undefined;
  const rawDirectories =
    process.platform === "win32"
      ? ["C:\\allowed\\..\\secret\\child", "c:/SECRET/", "D:/workspace/shared"]
      : ["/allowed/../secret/child", "/secret/", "/workspace/shared"];
  const expectedDirectories =
    process.platform === "win32" ? ["c:\\SECRET", "D:\\workspace\\shared"] : ["/secret", "/workspace/shared"];
  const expectedValidationDirectories =
    process.platform === "win32"
      ? ["C:\\secret\\child", "c:\\SECRET", "D:\\workspace\\shared"]
      : ["/secret/child", "/secret", "/workspace/shared"];
  const service = createService({
    access: {
      async validateWorkspace(input) {
        workspaceValidationDirectories = input.target.allowedAdditionalDirectories;
        return { allowed: true };
      },
      async authorize(input) {
        if (input.operation === "create") authorizationDirectories = input.target.allowedAdditionalDirectories;
        return { allowed: true };
      },
    },
    writes: {
      async createSession(command) {
        commandDirectories = command.session.allowedAdditionalDirectories;
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });

  const response = await service.create({ ...createRequest(), allowedAdditionalDirectories: rawDirectories });

  assert.equal(response.overallStatus, "success");
  assert.deepEqual(workspaceValidationDirectories, expectedValidationDirectories);
  assert.deepEqual(authorizationDirectories, expectedValidationDirectories);
  assert.deepEqual(commandDirectories, expectedDirectories);
});

test("authorization receives isolated operation-specific Session targets and create configuration", async () => {
  const authorized: ApplicationAccessValidationInput<Authorization>[] = [];
  const service = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize(input) {
        authorized.push(input);
        if (input.operation === "create") {
          (input.target.allowedAdditionalDirectories as string[])[0] = "C:\\mutated";
        }
        return { allowed: true };
      },
    },
  });

  await service.create(createRequest());
  await service.list({ context, lifecycleStatus: "active" });
  await service.read({ context, sessionId: "session-1" });
  await service.archive({ context, sessionId: "session-2", idempotencyKey: uuid(62) });
  await service.readDirectoriesChunk({ context, sessionId: "session-3", offset: 5, maxBytes: 1024 });

  assert.deepEqual(
    authorized.map(({ operation, target }) => ({ operation, target })),
    [
      {
        operation: "create",
        target: {
          kind: "session_create",
          title: "Session title",
          workspacePath: workspace.workspacePath,
          providerId: "codex",
          allowedAdditionalDirectories: ["C:\\mutated"],
          defaultCharacterId: "character-1",
          maxConcurrentChildRuns: 2,
        },
      },
      {
        operation: "list",
        target: { kind: "session_collection", scope: "all_sessions", lifecycleStatus: "active" },
      },
      { operation: "read", target: { kind: "session", sessionId: "session-1" } },
      { operation: "archive", target: { kind: "session", sessionId: "session-2" } },
      {
        operation: "read_directories_chunk",
        target: { kind: "session_directories", sessionId: "session-3", offset: 5, maxBytes: 1024 },
      },
    ],
  );
  assert.deepEqual(createRequest().allowedAdditionalDirectories, ["C:\\workspace-shared"]);
});

test("request and access rejection happen before Repository access", async () => {
  let workspaceChecks = 0;
  let authorizationChecks = 0;
  let writes = 0;
  let repositoryResolutions = 0;
  const access: ApplicationAccessValidator<Authorization> = {
    async validateWorkspace() {
      workspaceChecks += 1;
      return { allowed: true };
    },
    async authorize() {
      authorizationChecks += 1;
      return {
        allowed: false,
        error: { code: "forbidden", message: "Operation is not permitted.", retryable: false },
      };
    },
  };
  const service = createService({
    access,
    async resolveLocalRepositoryMetadata() {
      repositoryResolutions += 1;
      return { status: "not_git" };
    },
    writes: {
      async createSession() {
        writes += 1;
        throw new Error("unreachable");
      },
    },
  });

  const malformed = await service.create({ ...createRequest(), idempotencyKey: "not-a-uuid" });
  const forbidden = await service.create(createRequest());

  assert.equal(malformed.overallStatus, "failure");
  assert.equal(malformed.overallStatus === "failure" && malformed.error.kind, "request");
  assert.deepEqual(malformed.persistence, { status: "not_attempted", effect: "none" });
  assert.equal(forbidden.overallStatus, "failure");
  assert.equal(forbidden.overallStatus === "failure" && forbidden.error.kind, "access");
  assert.deepEqual(forbidden.persistence, { status: "not_attempted", effect: "none" });
  assert.equal(workspaceChecks, 1);
  assert.equal(authorizationChecks, 1);
  assert.equal(repositoryResolutions, 0);
  assert.equal(writes, 0);
});

test("access rejection projects only known public fields", async () => {
  const accessError = {
    code: "forbidden",
    message: "Operation is not permitted.",
    retryable: false,
    kind: "persistence",
    internalSecret: "authorization-only",
  } as const;
  const service = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize() {
        return { allowed: false, error: accessError };
      },
    },
  });

  const response = await service.list({ context });

  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "access",
    code: "forbidden",
    message: "Operation is not permitted.",
    retryable: false,
  });
  assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
});

test("every operation returns a request envelope for malformed transport input before calling ports", async () => {
  let accessCalls = 0;
  let readCalls = 0;
  let writeCalls = 0;
  const service = createService({
    access: {
      async validateWorkspace() {
        accessCalls += 1;
        return { allowed: true };
      },
      async authorize() {
        accessCalls += 1;
        return { allowed: true };
      },
    },
    reads: {
      async sessionsPage() {
        readCalls += 1;
        throw new Error("unreachable");
      },
      async sessionGet() {
        readCalls += 1;
        throw new Error("unreachable");
      },
      async sessionDirectoriesChunk() {
        readCalls += 1;
        throw new Error("unreachable");
      },
    },
    writes: {
      async createSession() {
        writeCalls += 1;
        throw new Error("unreachable");
      },
      async transitionSession() {
        writeCalls += 1;
        throw new Error("unreachable");
      },
    },
  });
  const malformedOperations: readonly (() => Promise<unknown>)[] = [
    () => service.create(null as never),
    () => service.list([] as never),
    () => service.list({ context, lifecycleStatus: "deleted" } as never),
    () => service.read({} as never),
    () => service.readDirectoriesChunk({ context, sessionId: "session-1", offset: -1, maxBytes: 1024 }),
    () =>
      service.readDirectoriesChunk({
        context,
        sessionId: "session-1",
        offset: 0,
        maxBytes: APPLICATION_MAX_READ_CHUNK_BYTES + 1,
      }),
    () => service.archive({ context: null } as never),
    () => service.unarchive(null as never),
    () => service.close(null as never),
    () =>
      service.close({
        context,
        sessionId: "session-1",
        idempotencyKey: uuid(50),
        expectedLifecycleStatus: "closed",
      } as never),
  ];

  for (const operation of malformedOperations) {
    const response = (await operation()) as Awaited<ReturnType<typeof service.create>>;
    assert.equal(response.overallStatus, "failure");
    assert.equal(response.overallStatus === "failure" && response.error.kind, "request");
    assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  }
  assert.equal(accessCalls, 0);
  assert.equal(readCalls, 0);
  assert.equal(writeCalls, 0);
});

test("validated request snapshots cannot be changed while access validation is pending", async () => {
  const createGate = deferred<void>();
  let createCommand: SessionCreateCommand | undefined;
  const authorizedPrincipals: string[] = [];
  const createServiceUnderTest = createService({
    access: {
      async validateWorkspace() {
        await createGate.promise;
        return { allowed: true };
      },
      async authorize(input) {
        authorizedPrincipals.push(input.context.authorization.principalId);
        return { allowed: true };
      },
    },
    writes: {
      async createSession(command) {
        createCommand = command;
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });
  const mutableCreate = {
    context: { authorization: { principalId: "user-1" } },
    title: "Snapshot title",
    workspacePath: workspace.workspacePath,
    idempotencyKey: uuid(70),
    providerId: "codex",
    allowedAdditionalDirectories: ["C:\\workspace-shared"],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 2,
  };
  const creating = createServiceUnderTest.create(mutableCreate);
  mutableCreate.workspacePath = otherWorkspace.workspacePath;
  mutableCreate.context.authorization.principalId = "user-mutated";
  mutableCreate.idempotencyKey = uuid(71);
  mutableCreate.providerId = "mutated-provider";
  mutableCreate.allowedAdditionalDirectories[0] = "C:\\mutated";
  createGate.resolve();
  await creating;
  assert.equal(createCommand?.session.workspaceKey, workspace.workspaceKey);
  assert.equal(createCommand?.session.workspacePath, workspace.workspacePath);
  assert.equal(createCommand?.idempotencyKey, uuid(70));
  assert.equal(createCommand?.session.providerId, "codex");
  assert.deepEqual(createCommand?.session.allowedAdditionalDirectories, ["C:\\workspace-shared"]);
  assert.deepEqual(authorizedPrincipals, ["user-1"]);

  const readGate = deferred<void>();
  const readInputs: unknown[] = [];
  const transitionCommands: SessionTransitionCommand[] = [];
  const readService = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize() {
        await readGate.promise;
        return { allowed: true };
      },
    },
    reads: {
      async sessionsPage(input) {
        readInputs.push(input);
        return { items: [] };
      },
    },
  });
  const mutableList = {
    context: { authorization: { principalId: "user-1" } },
    workspacePath: workspace.workspacePath,
    lifecycleStatus: "active" as "active" | "archived" | "closed",
    cursor: "cursor-original",
    limit: 10,
  };
  const listing = readService.list(mutableList);
  mutableList.workspacePath = otherWorkspace.workspacePath;
  mutableList.lifecycleStatus = "archived";
  mutableList.cursor = "cursor-mutated";
  mutableList.limit = 20;
  readGate.resolve();
  await listing;
  assert.deepEqual(readInputs, [
    { workspaceKey: workspace.workspaceKey, lifecycleStatus: "active", cursor: "cursor-original", limit: 10 },
  ]);

  const detailGate = deferred<void>();
  const detailInputs: unknown[] = [];
  const detailService = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize() {
        await detailGate.promise;
        return { allowed: true };
      },
    },
    reads: {
      async sessionGet(input) {
        detailInputs.push(input);
        return {
          session: {
            id: input.sessionId,
            title: `Session ${input.sessionId}`,
            providerId: "codex",
            workspaceKey: workspace.workspaceKey,
            workspacePath: workspace.workspacePath,
            localRepositoryKey: null,
            repositoryName: null,
            allowedAdditionalDirectoriesByteLength: 2,
            allowedAdditionalDirectoriesState: "inline",
            allowedAdditionalDirectories: [],
            defaultCharacterId: "character-1",
            maxConcurrentChildRuns: 2,
            lifecycleStatus: "active",
            createdAt: 1,
            updatedAt: 1,
            lastActivityAt: 1,
          },
          execution: { state: "not_started" },
        };
      },
    },
  });
  const mutableRead = {
    context: { authorization: { principalId: "user-1" } },
    sessionId: "session-1",
  };
  const reading = detailService.read(mutableRead);
  mutableRead.sessionId = "session-mutated";
  detailGate.resolve();
  await reading;
  assert.deepEqual(detailInputs, [{ sessionId: "session-1" }]);

  const transitionGate = deferred<void>();
  const transitionService = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize() {
        await transitionGate.promise;
        return { allowed: true };
      },
    },
    writes: {
      async transitionSession(command) {
        transitionCommands.push(command);
        return {
          ok: true,
          value: { sessionId: command.sessionId, lifecycleStatus: command.targetLifecycleStatus, updatedAt: 1 },
          replayed: false,
        };
      },
    },
  });
  const mutableTransition = {
    context: { authorization: { principalId: "user-1" } },
    sessionId: "session-1",
    idempotencyKey: uuid(72),
  };
  const archiving = transitionService.archive(mutableTransition);
  mutableTransition.sessionId = "session-mutated";
  mutableTransition.idempotencyKey = uuid(73);
  transitionGate.resolve();
  await archiving;
  assert.deepEqual(transitionCommands, [transition(uuid(72), "session-1", "active", "archived")]);

  const closeGate = deferred<void>();
  const closeCommands: SessionTransitionCommand[] = [];
  const closeService = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize() {
        await closeGate.promise;
        return { allowed: true };
      },
    },
    writes: {
      async transitionSession(command) {
        closeCommands.push(command);
        return {
          ok: true,
          value: { sessionId: command.sessionId, lifecycleStatus: command.targetLifecycleStatus, updatedAt: 1 },
          replayed: false,
        };
      },
    },
  });
  const mutableClose = {
    context: { authorization: { principalId: "user-1" } },
    sessionId: "session-1",
    idempotencyKey: uuid(74),
    expectedLifecycleStatus: "active" as "active" | "archived",
  };
  const closing = closeService.close(mutableClose);
  mutableClose.sessionId = "session-mutated";
  mutableClose.idempotencyKey = uuid(75);
  mutableClose.expectedLifecycleStatus = "archived";
  closeGate.resolve();
  await closing;
  assert.deepEqual(closeCommands, [transition(uuid(74), "session-1", "active", "closed")]);
});

test("request fields are read once into the validated snapshot", async () => {
  let reads = 0;
  let authorizedLimit: number | undefined;
  let persistedLimit: number | undefined;
  const service = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize(input) {
        if (input.operation === "create") authorizedLimit = input.target.maxConcurrentChildRuns;
        return { allowed: true };
      },
    },
    writes: {
      async createSession(command) {
        persistedLimit = command.session.maxConcurrentChildRuns;
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });
  const request = { ...createRequest() } as Record<string, unknown>;
  Object.defineProperty(request, "maxConcurrentChildRuns", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 2 : APPLICATION_MAX_CONCURRENT_CHILD_RUNS + 1;
    },
  });

  const response = await service.create(request as never);

  assert.equal(response.overallStatus, "success");
  assert.equal(reads, 1);
  assert.equal(authorizedLimit, 2);
  assert.equal(persistedLimit, 2);
});

test("request and option traps stay inside a request failure envelope", async () => {
  const service = createService();
  const throwingRequest = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("request trap");
      },
    },
  );
  const throwingOptions = Object.defineProperty({}, "timeoutMs", {
    enumerable: true,
    get() {
      throw new Error("options getter");
    },
  });
  const throwingDirectories = ["C:\\workspace-shared"];
  Object.defineProperty(throwingDirectories, "toJSON", {
    enumerable: true,
    get() {
      throw new Error("toJSON getter");
    },
  });

  const operations = [
    () => service.create(throwingRequest as never),
    () => service.list(throwingRequest as never),
    () => service.read(throwingRequest as never),
    () => service.readDirectoriesChunk(throwingRequest as never),
    () => service.archive(throwingRequest as never),
    () => service.unarchive(throwingRequest as never),
    () => service.close(throwingRequest as never),
    () => service.list({ context }, throwingOptions as never),
    () => service.create({ ...createRequest(), allowedAdditionalDirectories: throwingDirectories }),
  ];

  for (const operation of operations) {
    const response = await operation();
    assert.equal(response.overallStatus === "failure" && response.error.kind, "request");
    assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  }
});

test("operation options are validated and snapshotted before access validation", async () => {
  let accessCalls = 0;
  let readCalls = 0;
  let writeCalls = 0;
  const invalidService = createService({
    access: {
      async validateWorkspace() {
        accessCalls += 1;
        return { allowed: true };
      },
      async authorize() {
        accessCalls += 1;
        return { allowed: true };
      },
    },
    reads: {
      async sessionsPage() {
        readCalls += 1;
        throw new Error("unreachable");
      },
      async sessionGet() {
        readCalls += 1;
        throw new Error("unreachable");
      },
    },
    writes: {
      async createSession() {
        writeCalls += 1;
        throw new Error("unreachable");
      },
      async transitionSession() {
        writeCalls += 1;
        throw new Error("unreachable");
      },
    },
  });
  const invalidOptions = [
    null,
    [],
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: 2_147_483_648 },
    { signal: {} },
    { timeoutMs: 1_000, internal: true },
  ];

  for (const options of invalidOptions) {
    const response = await invalidService.create(createRequest(), options as never);
    assert.equal(response.overallStatus, "failure");
    assert.equal(response.overallStatus === "failure" && response.error.kind, "request");
    assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  }
  const invalidOptionOperations = [
    () => invalidService.create(createRequest(), { timeoutMs: -1 }),
    () => invalidService.list({ context }, { timeoutMs: -1 }),
    () => invalidService.read({ context, sessionId: "session-1" }, { timeoutMs: -1 }),
    () =>
      invalidService.readDirectoriesChunk(
        { context, sessionId: "session-1", offset: 0, maxBytes: 1024 },
        { timeoutMs: -1 },
      ),
    () => invalidService.archive({ context, sessionId: "session-1", idempotencyKey: uuid(76) }, { timeoutMs: -1 }),
    () => invalidService.unarchive({ context, sessionId: "session-1", idempotencyKey: uuid(77) }, { timeoutMs: -1 }),
    () =>
      invalidService.close(
        {
          context,
          sessionId: "session-1",
          idempotencyKey: uuid(78),
          expectedLifecycleStatus: "active",
        },
        { timeoutMs: -1 },
      ),
  ];
  for (const operation of invalidOptionOperations) {
    const response = await operation();
    assert.equal(response.overallStatus, "failure");
    assert.equal(response.overallStatus === "failure" && response.error.kind, "request");
    assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  }
  assert.equal(accessCalls, 0);
  assert.equal(readCalls, 0);
  assert.equal(writeCalls, 0);

  const accessGate = deferred<void>();
  let receivedOptions: unknown;
  const controller = new AbortController();
  const service = createService({
    access: {
      async validateWorkspace() {
        await accessGate.promise;
        return { allowed: true };
      },
      async authorize() {
        return { allowed: true };
      },
    },
    writes: {
      async createSession(command, options) {
        receivedOptions = options;
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });
  const mutableOptions = { timeoutMs: 1_000, signal: controller.signal };
  const creating = service.create(createRequest(), mutableOptions);
  mutableOptions.timeoutMs = -1;
  mutableOptions.signal = new AbortController().signal;
  accessGate.resolve();

  assert.equal((await creating).overallStatus, "success");
  assert.ok(
    typeof receivedOptions === "object" &&
      receivedOptions !== null &&
      "signal" in receivedOptions &&
      receivedOptions.signal instanceof AbortSignal,
  );
  assert.notEqual(receivedOptions.signal, controller.signal);
  assert.equal(receivedOptions.signal.aborted, false);
});

test("operation timeout and cancellation settle while access validation is pending", async () => {
  let accessCalls = 0;
  let repositoryCalls = 0;
  const service = createService({
    access: {
      async validateWorkspace() {
        accessCalls += 1;
        return { allowed: true };
      },
      async authorize() {
        accessCalls += 1;
        return new Promise(() => undefined);
      },
    },
    reads: {
      async sessionsPage() {
        repositoryCalls += 1;
        return { items: [] };
      },
    },
  });

  const timedOut = await Promise.race([
    service.list({ context }, { timeoutMs: 5 }),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 50)),
  ]);
  assert.notEqual(timedOut, "unsettled");
  if (timedOut === "unsettled") assert.fail("operation timeout did not settle");
  assert.equal(timedOut.overallStatus, "failure");
  assert.deepEqual(timedOut.overallStatus === "failure" && timedOut.error, {
    kind: "operation",
    code: "operation_timeout",
    message: "Application operation timed out.",
    retryable: true,
  });
  assert.deepEqual(timedOut.persistence, { status: "not_attempted", effect: "none" });

  const controller = new AbortController();
  controller.abort();
  const canceled = await Promise.race([
    service.list({ context }, { signal: controller.signal }),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 50)),
  ]);
  assert.notEqual(canceled, "unsettled");
  if (canceled === "unsettled") assert.fail("operation cancellation did not settle");
  assert.deepEqual(canceled.overallStatus === "failure" && canceled.error, {
    kind: "operation",
    code: "operation_canceled",
    message: "Application operation was canceled.",
    retryable: false,
  });
  assert.deepEqual(canceled.persistence, { status: "not_attempted", effect: "none" });
  assert.equal(accessCalls, 1);
  assert.equal(repositoryCalls, 0);
});

test("operation deadline preserves persistence effect after Repository access starts", async () => {
  const readService = createService({
    reads: {
      async sessionsPage() {
        return new Promise(() => undefined);
      },
    },
  });
  const readTimeout = await Promise.race([
    readService.list({ context }, { timeoutMs: 5 }),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 50)),
  ]);
  assert.notEqual(readTimeout, "unsettled");
  if (readTimeout === "unsettled") assert.fail("read deadline did not settle");
  assert.deepEqual(readTimeout.overallStatus === "failure" && readTimeout.error, {
    kind: "persistence",
    code: "persistence_timeout",
    message: "Application operation timed out.",
    retryable: true,
    effect: "none",
  });
  assert.deepEqual(readTimeout.persistence, { status: "failed", effect: "none" });

  const writeService = createService({
    writes: {
      async createSession() {
        return new Promise(() => undefined);
      },
    },
  });
  const writeTimeout = await Promise.race([
    writeService.create(createRequest(), { timeoutMs: 5 }),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 50)),
  ]);
  assert.notEqual(writeTimeout, "unsettled");
  if (writeTimeout === "unsettled") assert.fail("write deadline did not settle");
  assert.deepEqual(writeTimeout.overallStatus === "failure" && writeTimeout.error, {
    kind: "persistence",
    code: "persistence_timeout",
    message: "Application operation timed out.",
    retryable: true,
    effect: "unknown",
  });
  assert.deepEqual(writeTimeout.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });
});

test("Repository fulfillment after the absolute deadline cannot become success", async () => {
  const blockPastDeadline = () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20) {
      // Simulate synchronous adapter work that delays the event loop beyond the operation deadline.
    }
  };
  const readService = createService({
    reads: {
      async sessionsPage() {
        blockPastDeadline();
        return { items: [] };
      },
    },
  });
  const writeService = createService({
    writes: {
      async createSession(command) {
        blockPastDeadline();
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });

  const read = await readService.list({ context }, { timeoutMs: 5 });
  const write = await writeService.create(createRequest(), { timeoutMs: 5 });

  assert.equal(read.overallStatus === "failure" && read.error.code, "persistence_timeout");
  assert.deepEqual(read.persistence, { status: "failed", effect: "none" });
  assert.equal(write.overallStatus === "failure" && write.error.code, "persistence_timeout");
  assert.deepEqual(write.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });
});

test("Repository and access response projection remain inside the operation deadline", async () => {
  const blockPastDeadline = () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20) {
      // Projection is synchronous, so the caller-visible deadline must be checked after it completes.
    }
  };
  const repositoryPage = Object.defineProperty({}, "items", {
    enumerable: true,
    get() {
      blockPastDeadline();
      return [];
    },
  });
  const repositoryService = createService({
    reads: {
      async sessionsPage() {
        return repositoryPage as never;
      },
    },
  });
  const accessDecision = Object.defineProperty({}, "allowed", {
    enumerable: true,
    get() {
      blockPastDeadline();
      return true;
    },
  });
  const accessService = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize() {
        return accessDecision as never;
      },
    },
  });

  const repositoryResponse = await repositoryService.list({ context }, { timeoutMs: 5 });
  const accessResponse = await accessService.list({ context }, { timeoutMs: 5 });

  assert.equal(repositoryResponse.overallStatus === "failure" && repositoryResponse.error.code, "persistence_timeout");
  assert.deepEqual(repositoryResponse.persistence, { status: "failed", effect: "none" });
  assert.equal(accessResponse.overallStatus === "failure" && accessResponse.error.code, "operation_timeout");
  assert.deepEqual(accessResponse.persistence, { status: "not_attempted", effect: "none" });
});

test("abort during Repository start observes a later rejection without unhandledRejection", async () => {
  const controller = new AbortController();
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const service = createService({
      reads: {
        async sessionsPage() {
          controller.abort();
          throw new Error("repository rejection after abort");
        },
      },
    });

    const response = await service.list({ context }, { signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(response.overallStatus === "failure" && response.error.code, "persistence_canceled");
    assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
    assert.deepEqual(unhandled, []);

    const synchronousController = new AbortController();
    const synchronousService = createService({
      reads: {
        sessionsPage() {
          synchronousController.abort();
          throw new Error("synchronous repository rejection after abort");
        },
      },
    });
    const synchronousResponse = await synchronousService.list({ context }, { signal: synchronousController.signal });
    assert.equal(
      synchronousResponse.overallStatus === "failure" && synchronousResponse.error.code,
      "persistence_canceled",
    );
    assert.deepEqual(synchronousResponse.persistence, { status: "failed", effect: "none" });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("Application owns the deadline and does not pass a competing timeout to Repository ports", async () => {
  let receivedOptions: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> | undefined;
  const service = createService({
    writes: {
      async createSession(_command, options) {
        receivedOptions = options;
        if (options?.timeoutMs !== undefined) {
          throw persistenceError("request_timeout", "Repository timeout won the race.", false, "unknown");
        }
        return new Promise(() => undefined);
      },
    },
  });

  const response = await service.create(createRequest(), { timeoutMs: 5 });

  assert.equal(receivedOptions?.timeoutMs, undefined);
  assert.ok(receivedOptions?.signal instanceof AbortSignal);
  assert.equal(receivedOptions.signal.aborted, true);
  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "persistence",
    code: "persistence_timeout",
    message: "Application operation timed out.",
    retryable: true,
    effect: "unknown",
  });
  assert.deepEqual(response.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });
});

test("operation deadline starts before request authorization snapshot", async () => {
  let snapshots = 0;
  const service = new ApplicationSessionService<Authorization>({
    reads: createServiceReads(),
    writes: createServiceWrites(),
    access: allowingAccess(),
    snapshotAuthorization(value: unknown) {
      snapshots += 1;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 30) {
        // The injected decoder is synchronous; the operation must check its deadline immediately afterwards.
      }
      return structuredClone(value) as Authorization;
    },
  });

  const timedOut = await service.list({ context }, { timeoutMs: 5 });
  assert.deepEqual(timedOut.overallStatus === "failure" && timedOut.error, {
    kind: "operation",
    code: "operation_timeout",
    message: "Application operation timed out.",
    retryable: true,
  });
  assert.deepEqual(timedOut.persistence, { status: "not_attempted", effect: "none" });

  const controller = new AbortController();
  controller.abort();
  const canceled = await service.list({ context }, { signal: controller.signal });
  assert.deepEqual(canceled.overallStatus === "failure" && canceled.error, {
    kind: "operation",
    code: "operation_canceled",
    message: "Application operation was canceled.",
    retryable: false,
  });
  assert.equal(snapshots, 1);
});

test("operation deadline is rechecked after each access validation snapshot", async () => {
  let snapshots = 0;
  let workspaceCalls = 0;
  const service = new ApplicationSessionService<Authorization>({
    reads: createServiceReads(),
    writes: createServiceWrites(),
    access: {
      async validateWorkspace() {
        workspaceCalls += 1;
        return { allowed: true };
      },
      async authorize() {
        return { allowed: true };
      },
    },
    snapshotAuthorization(value: unknown) {
      snapshots += 1;
      if (snapshots === 2) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 30) {
          // The access view must not invoke its validator after consuming the deadline.
        }
      }
      return structuredClone(value) as Authorization;
    },
  });

  const response = await service.list({ context }, { timeoutMs: 5 });

  assert.equal(response.overallStatus === "failure" && response.error.code, "operation_timeout");
  assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  assert.equal(workspaceCalls, 0);
});

test("Session directory chunks use Session-scoped authorization and project known response fields", async () => {
  const bytes = new TextEncoder().encode('["C:\\\\shared"]');
  let repositoryInput: Readonly<{ sessionId: string; offset: number; maxBytes: number }> | undefined;
  const service = createService({
    reads: {
      async sessionDirectoriesChunk(input) {
        repositoryInput = input;
        return {
          sessionId: input.sessionId,
          offset: input.offset,
          totalBytes: bytes.byteLength,
          eof: true,
          bytes: bytes.buffer,
          internalSecret: "repository-only",
        };
      },
    },
  });

  const response = await service.readDirectoriesChunk({
    context,
    sessionId: "session-1",
    offset: 0,
    maxBytes: 64 * 1024,
  });

  assert.deepEqual(repositoryInput, {
    sessionId: "session-1",
    offset: 0,
    maxBytes: 64 * 1024,
  });
  assert.deepEqual(response, {
    overallStatus: "success",
    value: {
      sessionId: "session-1",
      offset: 0,
      totalBytes: bytes.byteLength,
      eof: true,
      bytes: bytes.buffer,
    },
    persistence: { status: "read", effect: "none" },
  });
});

test("authorization snapshot policy supports non-structured-clone authorization values", async () => {
  type FunctionAuthorization = Readonly<{ principalId: string; canAccess: () => boolean }>;
  const authorization: FunctionAuthorization = { principalId: "user-1", canAccess: () => true };
  const received: FunctionAuthorization[] = [];
  const service = new ApplicationSessionService<FunctionAuthorization>({
    reads: {
      async sessionsPage() {
        return { items: [] };
      },
      async sessionGet() {
        throw new Error("unreachable");
      },
      async sessionDirectoriesChunk() {
        throw new Error("unreachable");
      },
    },
    writes: {
      async createSession() {
        throw new Error("unreachable");
      },
      async transitionSession() {
        throw new Error("unreachable");
      },
    },
    access: {
      async validateWorkspace(input) {
        received.push(input.context.authorization);
        return { allowed: true };
      },
      async authorize(input) {
        received.push(input.context.authorization);
        return { allowed: true };
      },
    },
    snapshotAuthorization(value: unknown) {
      const candidate = value as FunctionAuthorization;
      return { principalId: candidate.principalId, canAccess: candidate.canAccess };
    },
  });

  const response = await service.list({ context: { authorization } });

  assert.equal(response.overallStatus, "success");
  assert.equal(received.length, 1);
  assert.notEqual(received[0], authorization);
  assert.equal(received[0]?.canAccess(), true);
});

test("create rejects child Run limits above the Application safety cap before ports", async () => {
  let accessCalls = 0;
  let writeCalls = 0;
  const service = createService({
    access: {
      async validateWorkspace() {
        accessCalls += 1;
        return { allowed: true };
      },
      async authorize() {
        accessCalls += 1;
        return { allowed: true };
      },
    },
    writes: {
      async createSession() {
        writeCalls += 1;
        throw new Error("unreachable");
      },
    },
  });

  const response = await service.create({
    ...createRequest(),
    maxConcurrentChildRuns: APPLICATION_MAX_CONCURRENT_CHILD_RUNS + 1,
  });

  assert.equal(response.overallStatus, "failure");
  assert.equal(response.overallStatus === "failure" && response.error.kind, "request");
  assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  assert.equal(accessCalls, 0);
  assert.equal(writeCalls, 0);
});

test("create accepts the exact Application child Run safety cap", async () => {
  let persistedLimit: number | undefined;
  const service = createService({
    writes: {
      async createSession(command) {
        persistedLimit = command.session.maxConcurrentChildRuns;
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });

  const response = await service.create({
    ...createRequest(),
    maxConcurrentChildRuns: APPLICATION_MAX_CONCURRENT_CHILD_RUNS,
  });

  assert.equal(response.overallStatus, "success");
  assert.equal(persistedLimit, APPLICATION_MAX_CONCURRENT_CHILD_RUNS);
});

test("access validators receive isolated views of the decoded request snapshot", async () => {
  let authorizationInput: unknown;
  let createCommand: SessionCreateCommand | undefined;
  const service = createService({
    access: {
      async validateWorkspace(input) {
        const mutable = input as unknown as {
          operation: string;
          access: string;
          context: { authorization: { principalId: string } };
          target: { workspacePath: string; allowedAdditionalDirectories: string[] };
        };
        mutable.operation = "list";
        mutable.access = "read";
        mutable.context.authorization.principalId = "workspace-validator";
        mutable.target.workspacePath = otherWorkspace.workspacePath;
        mutable.target.allowedAdditionalDirectories[0] = "C:\\workspace-validator";
        return { allowed: true };
      },
      async authorize(input) {
        authorizationInput = structuredClone(input);
        const mutable = input as unknown as {
          operation: string;
          access: string;
          context: { authorization: { principalId: string } };
          target: { workspacePath: string; allowedAdditionalDirectories: string[] };
        };
        mutable.operation = "read";
        mutable.access = "read";
        mutable.context.authorization.principalId = "authorization-validator";
        mutable.target.workspacePath = otherWorkspace.workspacePath;
        mutable.target.allowedAdditionalDirectories[0] = "C:\\authorization-validator";
        return { allowed: true };
      },
    },
    writes: {
      async createSession(command) {
        createCommand = command;
        return {
          ok: true,
          value: sessionCreateResult(command, 1),
          replayed: false,
        };
      },
    },
  });

  const response = await service.create(createRequest());

  assert.equal(response.overallStatus, "success");
  assert.deepEqual(authorizationInput, {
    operation: "create",
    access: "write",
    context: { authorization: { principalId: "user-1" } },
    target: {
      kind: "session_create",
      title: "Session title",
      workspacePath: workspace.workspacePath,
      providerId: "codex",
      allowedAdditionalDirectories: ["C:\\workspace-shared"],
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 2,
    },
  });
  assert.equal(createCommand?.session.workspaceKey, workspace.workspaceKey);
  assert.equal(createCommand?.session.workspacePath, workspace.workspacePath);
  assert.deepEqual(createCommand?.session.allowedAdditionalDirectories, ["C:\\workspace-shared"]);
});

test("create rejects malformed additional directories before access validation and Repository writes", async () => {
  let workspaceChecks = 0;
  let authorizationChecks = 0;
  let writes = 0;
  const service = createService({
    access: {
      async validateWorkspace() {
        workspaceChecks += 1;
        return { allowed: true };
      },
      async authorize() {
        authorizationChecks += 1;
        return { allowed: true };
      },
    },
    writes: {
      async createSession() {
        writes += 1;
        throw new Error("unreachable");
      },
    },
  });
  const sparse = new Array<string>(1);
  const oversizedItem = [`C:\\${"a".repeat(32_768)}`];
  const tooManyItems = Array.from({ length: 1_025 }, (_, index) => `C:\\directory-${index}`);
  const oversizedTotal = Array.from({ length: 129 }, (_, index) => `C:\\directory-${index}\\${"a".repeat(32_740)}`);
  const normalizedOversizedTotal = Array.from(
    { length: 127 },
    (_, index) => `C:/directory-${index}/${"a/".repeat(16_360)}z`,
  );
  const invalidDirectories = [
    [123] as unknown as readonly string[],
    sparse,
    ["workspace/shared"],
    ...(process.platform === "win32" ? [["/home/user"], ["\\secret"]] : [["C:\\workspace\\shared"]]),
    oversizedItem,
    tooManyItems,
    oversizedTotal,
    ...(process.platform === "win32" ? [normalizedOversizedTotal] : []),
  ];

  for (const allowedAdditionalDirectories of invalidDirectories) {
    const response = await service.create({ ...createRequest(), allowedAdditionalDirectories });
    assert.equal(response.overallStatus, "failure");
    assert.equal(response.overallStatus === "failure" && response.error.kind, "request");
    assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
  }
  assert.equal(workspaceChecks, 0);
  assert.equal(authorizationChecks, 0);
  assert.equal(writes, 0);
});

test("create canonicalizes a bounded title and rejects invalid titles before access", async () => {
  let canonicalTitle: string | undefined;
  let accessChecks = 0;
  const service = createService({
    access: {
      async validateWorkspace() {
        accessChecks += 1;
        return { allowed: true };
      },
      async authorize() {
        accessChecks += 1;
        return { allowed: true };
      },
    },
    writes: {
      async createSession(command) {
        canonicalTitle = command.session.title;
        return createServiceWrites().createSession(command);
      },
    },
  });

  const accepted = await service.create({ ...createRequest(), title: "  Canonical title  " });
  assert.equal(accepted.overallStatus, "success");
  assert.equal(canonicalTitle, "Canonical title");
  assert.equal(accessChecks, 2);

  for (const title of ["   ", "x".repeat(513), "invalid\0title", 123] as readonly unknown[]) {
    const rejected = await service.create({ ...createRequest(), title } as never);
    assert.equal(rejected.overallStatus, "failure");
    assert.equal(rejected.overallStatus === "failure" && rejected.error.kind, "request");
  }
  assert.equal(accessChecks, 2);
});

test("create workspace rejection skips authorization and Repository access", async () => {
  let authorizationChecks = 0;
  let writes = 0;
  const service = createService({
    access: {
      async validateWorkspace() {
        return {
          allowed: false,
          error: { code: "workspace_unavailable", message: "Workspace is unavailable.", retryable: true },
        };
      },
      async authorize() {
        authorizationChecks += 1;
        return { allowed: true };
      },
    },
    writes: {
      async createSession() {
        writes += 1;
        throw new Error("unreachable");
      },
    },
  });

  const response = await service.create(createRequest());

  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "access",
    code: "workspace_unavailable",
    message: "Workspace is unavailable.",
    retryable: true,
  });
  assert.equal(authorizationChecks, 0);
  assert.equal(writes, 0);
});

test("list applies an optional workspace filter and represents bounded omissions as partial success", async () => {
  let receivedWorkspace: string | undefined;
  const service = createService({
    reads: {
      async sessionsPage(input) {
        receivedWorkspace = input.workspaceKey;
        return {
          items: [
            { ...sessionSummary("session-1"), internalSecret: "repository-only" },
            { omitted: true, reason: "response_size_limit" },
            { ...sessionSummary("session-2"), internalSecret: "repository-only" },
          ],
          nextCursor: "cursor-2",
        };
      },
    },
  });

  const response = await service.list({
    context,
    workspacePath: workspace.workspacePath,
    lifecycleStatus: "active",
    limit: 10,
  });

  assert.equal(receivedWorkspace, workspace.workspaceKey);
  assert.equal(response.overallStatus, "partial_success");
  assert.deepEqual(response.persistence, { status: "read", effect: "none" });
  assert.deepEqual(response.overallStatus === "partial_success" && response.value, {
    items: [publicSessionSummary("session-1"), publicSessionSummary("session-2")],
    nextCursor: "cursor-2",
  });
  assert.deepEqual(response.overallStatus === "partial_success" && response.issues, [
    {
      kind: "omission",
      code: "response_size_limit",
      message: "A Session list item was omitted because the response size limit was reached.",
    },
  ]);
});

test(
  "Windows Workspace filters use path identity instead of display-path casing",
  { skip: process.platform !== "win32" },
  async () => {
    const service = createService({
      reads: {
        async sessionsPage() {
          return { items: [sessionSummary("session-1")] };
        },
      },
    });
    const alternateCasePath = workspace.workspacePath.replace(/[A-Za-z]/u, (character) =>
      character === character.toUpperCase() ? character.toLowerCase() : character.toUpperCase(),
    );

    const response = await service.list({ context, workspacePath: alternateCasePath });

    assert.equal(response.overallStatus, "success");
    assert.deepEqual(response.overallStatus === "success" && response.value.items, [publicSessionSummary("session-1")]);
  },
);

test("list rejects Repository pages that exceed the requested aggregate limit", async () => {
  const service = createService({
    reads: {
      async sessionsPage() {
        return { items: [sessionSummary("session-1"), sessionSummary("session-2")] };
      },
    },
  });

  const response = await service.list({ context, limit: 1 });

  assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
  assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
});

test("Repository page fields are read once before aggregate validation and projection", async () => {
  let itemReads = 0;
  const page = Object.defineProperty({}, "items", {
    enumerable: true,
    get() {
      itemReads += 1;
      return itemReads === 1
        ? [sessionSummary("session-1")]
        : [sessionSummary("session-1"), sessionSummary("session-2")];
    },
  });
  const service = createService({
    reads: {
      async sessionsPage() {
        return page as never;
      },
    },
  });

  const response = await service.list({ context, limit: 1 });

  assert.equal(response.overallStatus, "success");
  assert.deepEqual(response.overallStatus === "success" && response.value.items, [publicSessionSummary("session-1")]);
  assert.equal(itemReads, 1);
});

test("list and detail reject impossible execution state and Run ID combinations", async () => {
  const invalidItems = [
    { ...sessionSummary("session-1"), activeRunId: "run-active" },
    { ...sessionSummary("session-1"), executionState: "running" as const },
    { ...sessionSummary("session-1"), executionState: "completed" as const },
    {
      ...sessionSummary("session-1"),
      lifecycleStatus: "archived" as const,
      executionState: "running" as const,
      activeRunId: "run-active",
      latestRunId: "run-active",
    },
    {
      ...sessionSummary("session-1"),
      executionState: "running" as const,
      activeRunId: "run-active",
      latestRunId: "run-latest",
    },
  ];
  for (const item of invalidItems) {
    const service = createService({
      reads: {
        async sessionsPage() {
          return { items: [item] };
        },
      },
    });
    const response = await service.list({ context });
    assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
  }

  const invalidExecutions = [
    { state: "not_started" as const, activeRunId: "run-active" },
    { state: "running" as const, latestRunId: "run-latest" },
    { state: "running" as const, activeRunId: "run-active", latestRunId: "run-latest" },
    { state: "completed" as const },
  ];
  for (const execution of invalidExecutions) {
    const service = createService({
      reads: {
        async sessionGet() {
          return { session: sessionDetail("session-1"), execution };
        },
      },
    });
    const response = await service.read({ context, sessionId: "session-1" });
    assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
  }

  for (const lifecycleStatus of ["archived", "closed"] as const) {
    const service = createService({
      reads: {
        async sessionGet() {
          return {
            session: { ...sessionDetail("session-1"), lifecycleStatus },
            execution: { state: "running" as const, activeRunId: "run-active", latestRunId: "run-active" },
          };
        },
      },
    });
    const response = await service.read({ context, sessionId: "session-1" });
    assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
  }
});

test("read projects only known Application response fields", async () => {
  const service = createService({
    reads: {
      async sessionGet() {
        return {
          session: {
            id: "session-1",
            title: "Session 1",
            providerId: "codex",
            workspaceKey: workspace.workspaceKey,
            workspacePath: workspace.workspacePath,
            localRepositoryKey: null,
            repositoryName: null,
            allowedAdditionalDirectoriesByteLength: 24,
            allowedAdditionalDirectoriesState: "inline",
            allowedAdditionalDirectories: ["C:\\workspace-shared"],
            defaultCharacterId: "character-1",
            maxConcurrentChildRuns: 2,
            lifecycleStatus: "active",
            createdAt: 1,
            updatedAt: 2,
            lastActivityAt: 3,
            internalSecret: "repository-only",
          },
          execution: {
            state: "running",
            activeRunId: "run-active",
            latestRunId: "run-active",
            internalSecret: "repository-only",
          },
          internalSecret: "repository-only",
        };
      },
    },
  });

  const response = await service.read({ context, sessionId: "session-1" });

  assert.deepEqual(response.overallStatus === "success" && response.value, {
    session: {
      id: "session-1",
      title: "Session 1",
      providerId: "codex",
      workspacePath: workspace.workspacePath,
      localRepositoryKey: null,
      repositoryName: null,
      allowedAdditionalDirectoriesByteLength: 24,
      allowedAdditionalDirectoriesState: "inline",
      defaultCharacterId: "character-1",
      maxConcurrentChildRuns: 2,
      lifecycleStatus: "active",
      createdAt: 1,
      updatedAt: 2,
      lastActivityAt: 3,
    },
    execution: {
      state: "running",
      activeRunId: "run-active",
      latestRunId: "run-active",
    },
  });
});

test("read never exposes inline directories without the dedicated directory authorization", async () => {
  const service = createService({
    access: {
      async validateWorkspace() {
        return { allowed: true };
      },
      async authorize(input) {
        return input.operation === "read_directories_chunk"
          ? {
              allowed: false,
              error: { code: "forbidden", message: "Directory access is forbidden.", retryable: false },
            }
          : { allowed: true };
      },
    },
  });

  const detail = await service.read({ context, sessionId: "session-1" });
  const directories = await service.readDirectoriesChunk({
    context,
    sessionId: "session-1",
    offset: 0,
    maxBytes: 1_024,
  });

  assert.equal(detail.overallStatus, "success");
  if (detail.overallStatus !== "success") assert.fail("Session detail failed");
  assert.equal("allowedAdditionalDirectories" in detail.value.session, false);
  assert.deepEqual(directories.overallStatus === "failure" && directories.error, {
    kind: "access",
    code: "forbidden",
    message: "Directory access is forbidden.",
    retryable: false,
  });
});

test("read maps scoped not_found to a domain rejection without exposing persistence transport semantics", async () => {
  const service = createService({
    reads: {
      async sessionGet() {
        throw persistenceError("not_found", "Session was not found.", false, "none");
      },
    },
  });

  const response = await service.read({ context, sessionId: "session-other-workspace" });

  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "domain",
    code: "not_found",
    message: "Session was not found.",
    retryable: false,
  });
  assert.deepEqual(response.persistence, { status: "rejected", effect: "none" });
});

test("archive, unarchive, and close assemble only the allowed lifecycle commands", async () => {
  const commands: SessionTransitionCommand[] = [];
  const service = createService({
    writes: {
      async transitionSession(command) {
        commands.push(command);
        return {
          ok: true,
          value: { sessionId: command.sessionId, lifecycleStatus: command.targetLifecycleStatus, updatedAt: 200 },
          replayed: false,
        };
      },
    },
  });

  const archive = await service.archive({ context, sessionId: "session-1", idempotencyKey: uuid(2) });
  const unarchive = await service.unarchive({ context, sessionId: "session-1", idempotencyKey: uuid(3) });
  const closeActive = await service.close({
    context,
    sessionId: "session-1",
    idempotencyKey: uuid(4),
    expectedLifecycleStatus: "active",
  });
  const closeArchived = await service.close({
    context,
    sessionId: "session-2",
    idempotencyKey: uuid(5),
    expectedLifecycleStatus: "archived",
  });

  assert.deepEqual(commands, [
    transition(uuid(2), "session-1", "active", "archived"),
    transition(uuid(3), "session-1", "archived", "active"),
    transition(uuid(4), "session-1", "active", "closed"),
    transition(uuid(5), "session-2", "archived", "closed"),
  ]);
  for (const response of [archive, unarchive, closeActive, closeArchived]) {
    assert.equal(response.overallStatus, "success");
    assert.deepEqual(response.persistence, { status: "committed", effect: "none", replayed: false });
  }
});

test("unarchive reauthorizes the Session on every exact retry without Workspace validation", async () => {
  const events: string[] = [];
  let calls = 0;
  const service = createService({
    access: allowingAccess(events),
    writes: {
      async transitionSession(command) {
        events.push("write");
        calls += 1;
        return {
          ok: true,
          value: { sessionId: command.sessionId, lifecycleStatus: "active", updatedAt: 200 },
          replayed: calls > 1,
        };
      },
    },
  });
  const request = { context, sessionId: "session-1", idempotencyKey: uuid(6) } as const;

  await service.unarchive(request);
  const replay = await service.unarchive(request);

  assert.deepEqual(events, ["authorize:unarchive", "write", "authorize:unarchive", "write"]);
  assert.deepEqual(replay.persistence, { status: "committed", effect: "none", replayed: true });
});

test("Repository domain rejection stays separate from persistence failure", async () => {
  const service = createService({
    writes: {
      async transitionSession() {
        return {
          ok: false,
          error: { code: "session_busy", message: "Session has an active Run.", retryable: true },
          replayed: false,
        };
      },
    },
  });

  const response = await service.archive({ context, sessionId: "session-1", idempotencyKey: uuid(7) });

  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "domain",
    code: "session_busy",
    message: "Session has an active Run.",
    retryable: true,
  });
  assert.deepEqual(response.persistence, { status: "rejected", effect: "none" });
});

test("Repository domain rejection projects only known public fields", async () => {
  const repositoryError = {
    code: "session_busy",
    message: "Session has an active Run.",
    retryable: true,
    kind: "persistence",
    internalSecret: "repository-only",
  } as unknown as RepositoryCommandError;
  const service = createService({
    writes: {
      async transitionSession() {
        return { ok: false, error: repositoryError, replayed: false };
      },
    },
  });

  const response = await service.archive({ context, sessionId: "session-1", idempotencyKey: uuid(51) });

  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "domain",
    code: "session_busy",
    message: "Session has an active Run.",
    retryable: true,
  });
  assert.deepEqual(response.persistence, { status: "rejected", effect: "none" });

  const capacityError = {
    code: "capacity_exceeded",
    message: "Provider capacity was reached.",
    retryable: true,
    details: {
      scope: "provider",
      providerId: "codex",
      current: 4,
      limit: 4,
      internalSecret: "repository-only",
    },
    internalSecret: "repository-only",
  } as unknown as RepositoryCommandError;
  const capacityService = createService({
    writes: {
      async transitionSession() {
        return { ok: false, error: capacityError, replayed: false };
      },
    },
  });

  const capacityResponse = await capacityService.archive({
    context,
    sessionId: "session-1",
    idempotencyKey: uuid(52),
  });

  assert.deepEqual(capacityResponse.overallStatus === "failure" && capacityResponse.error, {
    kind: "domain",
    code: "capacity_exceeded",
    message: "Provider capacity was reached.",
    retryable: true,
    details: { scope: "provider", providerId: "codex", current: 4, limit: 4 },
  });
});

test("write transport failure preserves unknown effect and is never reported as success", async () => {
  const service = createService({
    writes: {
      async createSession() {
        throw persistenceError("request_timeout", "Persistence request timed out.", false, "unknown");
      },
    },
  });

  const response = await service.create(createRequest());

  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "persistence",
    code: "persistence_timeout",
    message: "Persistence request timed out.",
    retryable: false,
    effect: "unknown",
  });
  assert.deepEqual(response.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });
});

test("write failures with unknown effect always identify exact-request reconciliation", async () => {
  const service = createService({
    writes: {
      async createSession() {
        throw persistenceError("worker_crashed", "Persistence Worker crashed.", false, "unknown");
      },
    },
  });

  const response = await service.create(createRequest());

  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "persistence",
    code: "persistence_unavailable",
    message: "Persistence Worker crashed.",
    retryable: false,
    effect: "unknown",
  });
  assert.deepEqual(response.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });
});

test("read transport failures never claim an unknown write effect", async () => {
  const service = createService({
    reads: {
      async sessionsPage() {
        throw persistenceError("worker_crashed", "Persistence Worker crashed.", false, "unknown");
      },
    },
  });

  const response = await service.list({ context });

  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "persistence",
    code: "persistence_unavailable",
    message: "Persistence Worker crashed.",
    retryable: false,
    effect: "none",
  });
  assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
});

test("malformed fulfilled access decisions become pre-persistence application failures", async () => {
  const malformedDecisions = [
    () => undefined,
    () => ({ allowed: false }),
    () =>
      Object.defineProperty({}, "allowed", {
        get: () => {
          throw new Error("getter failure");
        },
      }),
    () =>
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("proxy failure");
          },
        },
      ),
  ];
  for (const malformedPort of ["workspace", "authorization"] as const) {
    for (const malformedDecision of malformedDecisions) {
      let repositoryCalls = 0;
      const service = createService({
        access: {
          async validateWorkspace() {
            return malformedPort === "workspace" ? (malformedDecision() as never) : { allowed: true };
          },
          async authorize() {
            return malformedPort === "authorization" ? (malformedDecision() as never) : { allowed: true };
          },
        },
        reads: {
          async sessionsPage() {
            repositoryCalls += 1;
            return { items: [] };
          },
        },
      });

      const response =
        malformedPort === "workspace" ? await service.create(createRequest()) : await service.list({ context });

      assert.deepEqual(response.overallStatus === "failure" && response.error, {
        kind: "application",
        code: "internal_error",
        message: "Application Service could not complete the operation.",
        retryable: false,
      });
      assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
      assert.equal(repositoryCalls, 0);
    }
  }
});

test("shape-valid Repository results must match the requested workspace, Session, filter, and lifecycle target", async () => {
  const listWrongWorkspace = createService({
    reads: {
      async sessionsPage() {
        return { items: [{ ...sessionSummary("session-1"), workspaceKey: "workspace-2" }] };
      },
    },
  });
  const listWrongLifecycle = createService({
    reads: {
      async sessionsPage() {
        return { items: [{ ...sessionSummary("session-1"), lifecycleStatus: "archived" as const }] };
      },
    },
  });
  const readWrongTarget = createService({
    reads: {
      async sessionGet() {
        return { session: sessionDetail("session-2", otherWorkspace), execution: { state: "not_started" as const } };
      },
    },
  });
  const createWrongTarget = createService({
    writes: {
      async createSession() {
        return {
          ok: true as const,
          value: {
            sessionId: "session-other",
            title: "Session title",
            workspaceKey: otherWorkspace.workspaceKey,
            workspacePath: otherWorkspace.workspacePath,
            localRepositoryKey: null,
            repositoryName: null,
            lifecycleStatus: "active" as const,
            createdAt: 1,
          },
          replayed: false,
        };
      },
    },
  });
  const transitionWrongTarget = createService({
    writes: {
      async transitionSession() {
        return {
          ok: true as const,
          value: { sessionId: "session-other", lifecycleStatus: "active" as const, updatedAt: 1 },
          replayed: false,
        };
      },
    },
  });

  const readResponses = [
    await listWrongWorkspace.list({ context }),
    await listWrongLifecycle.list({ context, lifecycleStatus: "active" }),
    await readWrongTarget.read({ context, sessionId: "session-1" }),
  ];
  const writeResponses = [
    await createWrongTarget.create(createRequest()),
    await transitionWrongTarget.archive({ context, sessionId: "session-1", idempotencyKey: uuid(71) }),
  ];

  for (const response of readResponses) {
    assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
    assert.deepEqual(response.persistence, { status: "failed", effect: "none" });
  }
  for (const response of writeResponses) {
    assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
    assert.deepEqual(response.persistence, {
      status: "failed",
      effect: "unknown",
      reconciliation: "exact_request_required",
    });
  }
});

test("malformed fulfilled Repository results stay inside the response envelope", async () => {
  const listService = createService({
    reads: {
      async sessionsPage() {
        return { items: [{}] } as never;
      },
    },
  });
  const detailService = createService({
    reads: {
      async sessionGet() {
        return { session: undefined, execution: undefined } as never;
      },
    },
  });
  const chunkService = createService({
    reads: {
      async sessionDirectoriesChunk() {
        return { sessionId: "wrong-session", offset: 0 } as never;
      },
    },
  });
  const oversizedChunkService = createService({
    reads: {
      async sessionDirectoriesChunk() {
        return { sessionId: "session-1", offset: 0, totalBytes: 5, eof: true, bytes: new ArrayBuffer(5) };
      },
    },
  });
  const stalledChunkService = createService({
    reads: {
      async sessionDirectoriesChunk() {
        return { sessionId: "session-1", offset: 0, totalBytes: 2, eof: false, bytes: new ArrayBuffer(0) };
      },
    },
  });
  const createServiceWithMalformedResult = createService({
    writes: {
      async createSession() {
        return { ok: true, value: undefined, replayed: false } as never;
      },
    },
  });
  const transitionService = createService({
    writes: {
      async transitionSession() {
        return { ok: true, value: { lifecycleStatus: "active" }, replayed: false } as never;
      },
    },
  });

  const readResponses = [
    await listService.list({ context }),
    await detailService.read({ context, sessionId: "session-1" }),
    await chunkService.readDirectoriesChunk({ context, sessionId: "session-1", offset: 0, maxBytes: 1_024 }),
    await oversizedChunkService.readDirectoriesChunk({ context, sessionId: "session-1", offset: 0, maxBytes: 4 }),
    await stalledChunkService.readDirectoriesChunk({ context, sessionId: "session-1", offset: 0, maxBytes: 4 }),
  ];
  const writeResponses = [
    await createServiceWithMalformedResult.create(createRequest()),
    await transitionService.archive({ context, sessionId: "session-1", idempotencyKey: uuid(70) }),
  ];

  for (const read of readResponses) {
    assert.deepEqual(read.overallStatus === "failure" && read.error, {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    });
    assert.deepEqual(read.persistence, { status: "failed", effect: "none" });
  }
  for (const write of writeResponses) {
    assert.deepEqual(write.overallStatus === "failure" && write.error, {
      kind: "application",
      code: "internal_error",
      message: "Application Service could not complete the operation.",
      retryable: false,
    });
    assert.deepEqual(write.persistence, {
      status: "failed",
      effect: "unknown",
      reconciliation: "exact_request_required",
    });
  }
});

test("unexpected validator failures stay application failures and do not claim persistence effects", async () => {
  const service = createService({
    access: {
      async validateWorkspace() {
        throw new Error("validator unavailable");
      },
      async authorize() {
        return { allowed: true };
      },
    },
  });

  const response = await service.create(createRequest());

  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "application",
    code: "internal_error",
    message: "Application Service could not complete the operation.",
    retryable: false,
  });
  assert.deepEqual(response.persistence, { status: "not_attempted", effect: "none" });
});

test("unexpected write failures preserve unknown commit effect", async () => {
  const service = createService({
    writes: {
      async transitionSession() {
        throw new Error("unexpected adapter failure");
      },
    },
  });

  const response = await service.archive({ context, sessionId: "session-1", idempotencyKey: uuid(8) });

  assert.equal(response.overallStatus, "failure");
  assert.equal(response.overallStatus === "failure" && response.error.kind, "application");
  assert.deepEqual(response.persistence, {
    status: "failed",
    effect: "unknown",
    reconciliation: "exact_request_required",
  });
});

function createService(
  overrides: {
    access?: ApplicationAccessValidator<Authorization>;
    reads?: Partial<ReadPort>;
    writes?: Partial<WritePort>;
    resolveLocalRepositoryMetadata?: LocalRepositoryMetadataResolver;
  } = {},
): ApplicationSessionService<Authorization> {
  const reads: ReadPort = {
    ...createServiceReads(),
    ...overrides.reads,
  };
  const writes: WritePort = {
    ...createServiceWrites(),
    ...overrides.writes,
  };
  return new ApplicationSessionService({
    reads,
    writes,
    access: overrides.access ?? allowingAccess(),
    ...(overrides.resolveLocalRepositoryMetadata === undefined
      ? {}
      : { resolveLocalRepositoryMetadata: overrides.resolveLocalRepositoryMetadata }),
    snapshotAuthorization: (value: unknown) => structuredClone(value) as Authorization,
  });
}

function createServiceReads(): ReadPort {
  return {
    async sessionsPage() {
      return { items: [] };
    },
    async sessionGet() {
      return {
        session: {
          id: "session-1",
          title: "Session 1",
          providerId: "codex",
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
          localRepositoryKey: null,
          repositoryName: null,
          allowedAdditionalDirectoriesByteLength: 2,
          allowedAdditionalDirectoriesState: "inline",
          allowedAdditionalDirectories: [],
          defaultCharacterId: "character-1",
          maxConcurrentChildRuns: 2,
          lifecycleStatus: "active",
          createdAt: 1,
          updatedAt: 1,
          lastActivityAt: 1,
        },
        execution: { state: "not_started" },
      };
    },
    async sessionDirectoriesChunk(input) {
      return { sessionId: input.sessionId, offset: input.offset, totalBytes: 2, eof: true, bytes: new ArrayBuffer(2) };
    },
  };
}

function createServiceWrites(): WritePort {
  return {
    async createSession(command) {
      return {
        ok: true,
        value: sessionCreateResult(command, 1),
        replayed: false,
      };
    },
    async transitionSession(command) {
      return {
        ok: true,
        value: { sessionId: command.sessionId, lifecycleStatus: command.targetLifecycleStatus, updatedAt: 1 },
        replayed: false,
      };
    },
  };
}

function sessionCreateResult(command: SessionCreateCommand, createdAt: number): SessionCreateResult {
  const repositoryMetadata =
    command.session.localRepositoryKey === null
      ? ({ localRepositoryKey: null, repositoryName: null } as const)
      : ({
          localRepositoryKey: command.session.localRepositoryKey,
          repositoryName: command.session.repositoryName,
        } as const);
  return {
    sessionId: command.session.id,
    title: command.session.title,
    workspaceKey: command.session.workspaceKey,
    workspacePath: command.session.workspacePath,
    lifecycleStatus: "active",
    createdAt,
    ...repositoryMetadata,
  };
}

function allowingAccess(events: string[] = []): ApplicationAccessValidator<Authorization> {
  return {
    async validateWorkspace(input) {
      events.push(`workspace:${input.operation}`);
      return { allowed: true };
    },
    async authorize(input) {
      events.push(`authorize:${input.operation}`);
      return { allowed: true };
    },
  };
}

function createRequest() {
  return {
    context,
    title: "Session title",
    workspacePath: workspace.workspacePath,
    idempotencyKey: uuid(1),
    providerId: "codex",
    allowedAdditionalDirectories: ["C:\\workspace-shared"],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 2,
  } as const;
}

function sessionSummary(id: string) {
  return {
    id,
    title: `Session ${id}`,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
    localRepositoryKey: null,
    repositoryName: null,
    defaultCharacterId: "character-1",
    lifecycleStatus: "active" as const,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    executionState: "not_started" as const,
    stateChangedAt: 1,
  };
}

function publicSessionSummary(id: string) {
  const { workspaceKey: _workspaceKey, ...summary } = sessionSummary(id);
  return summary;
}

function sessionDetail(
  id: string,
  sessionWorkspace: Readonly<{ workspaceKey: string; workspacePath: string }> = workspace,
) {
  return {
    id,
    title: `Session ${id}`,
    providerId: "codex",
    workspaceKey: sessionWorkspace.workspaceKey,
    workspacePath: sessionWorkspace.workspacePath,
    localRepositoryKey: null,
    repositoryName: null,
    allowedAdditionalDirectoriesByteLength: 2,
    allowedAdditionalDirectoriesState: "inline" as const,
    allowedAdditionalDirectories: [],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 2,
    lifecycleStatus: "active" as const,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  };
}

function transition(
  idempotencyKey: string,
  sessionId: string,
  expectedLifecycleStatus: "active" | "archived",
  targetLifecycleStatus: "active" | "archived" | "closed",
): SessionTransitionCommand {
  return { sessionId, idempotencyKey, expectedLifecycleStatus, targetLifecycleStatus };
}

function persistenceError(
  code: ConstructorParameters<typeof PersistenceClientError>[0]["code"],
  message: string,
  retryable: boolean,
  effect: ConstructorParameters<typeof PersistenceClientError>[0]["effect"],
): PersistenceClientError {
  return new PersistenceClientError({ code, message, retryable, effect });
}

function uuid(value: number): string {
  return `018f1f4e-7f0a-7000-8000-${value.toString().padStart(12, "0")}`;
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-application-session-"));
  try {
    await run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
