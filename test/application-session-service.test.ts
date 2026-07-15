import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { type ApplicationAccessValidator, type ApplicationSessionOperationContext } from "../src/main/index.js";
import {
  APPLICATION_MAX_CONCURRENT_CHILD_RUNS,
  ApplicationSessionService,
} from "../src/main/application-session-service.js";
import { PersistenceClientError, PersistenceWorkerClient } from "../src/main/persistence-worker-client.js";
import { RepositoryReadClient } from "../src/main/repository-read-client.js";
import { RepositoryWriteClient } from "../src/main/repository-write-client.js";
import type {
  RepositoryCommandError,
  SessionCreateCommand,
  SessionTransitionCommand,
} from "../src/shared/repository-write-model.js";

type Authorization = Readonly<{ principalId: string }>;
type ReadPort = Pick<RepositoryReadClient, "sessionsPage" | "sessionGet">;
type WritePort = Pick<RepositoryWriteClient, "createSession" | "transitionSession">;

const context: ApplicationSessionOperationContext<Authorization> = {
  workspaceKey: "workspace-1",
  authorization: { principalId: "user-1" },
};
const workerUrl = new URL("../src/persistence-worker/worker-entry.ts", import.meta.url);
const workerOptions = { execArgv: ["--import", "tsx"] };
const workerTest = Number.parseInt(process.versions.node, 10) >= 24 ? test : test.skip;

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
        workspaceKey: "workspace-2",
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
        idempotencyKey: uuid(30),
      });
      assert.equal(otherCreated.overallStatus, "success");
      if (otherCreated.overallStatus !== "success") assert.fail("other workspace Session creation failed");
      const otherSessionId = otherCreated.value.sessionId;

      const listed = await service.list({ context });
      assert.equal(listed.overallStatus, "success");
      assert.deepEqual(listed.overallStatus === "success" && listed.value.items.map((item) => item.id), [sessionId]);
      const foreignRead = await service.read({ context, sessionId: otherSessionId });
      assert.equal(
        foreignRead.overallStatus === "failure" && foreignRead.error.kind === "domain" && foreignRead.error.code,
        "not_found",
      );
      const foreignArchive = await service.archive({
        context,
        sessionId: otherSessionId,
        idempotencyKey: uuid(31),
      });
      assert.equal(
        foreignArchive.overallStatus === "failure" &&
          foreignArchive.error.kind === "domain" &&
          foreignArchive.error.code,
        "not_found",
      );
      const foreignClose = await service.close({
        context,
        sessionId: otherSessionId,
        idempotencyKey: uuid(32),
        expectedLifecycleStatus: "active",
      });
      assert.equal(
        foreignClose.overallStatus === "failure" && foreignClose.error.kind === "domain" && foreignClose.error.code,
        "not_found",
      );
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
            providerId: "codex",
            workspaceKey: context.workspaceKey,
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
          value: {
            sessionId: command.session.id,
            workspaceKey: command.session.workspaceKey,
            lifecycleStatus: "active",
            createdAt: 100,
          },
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
      providerId: "codex",
      workspaceKey: "workspace-1",
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

test("request and access rejection happen before Repository access", async () => {
  let workspaceChecks = 0;
  let authorizationChecks = 0;
  let writes = 0;
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
          value: {
            sessionId: command.session.id,
            workspaceKey: command.session.workspaceKey,
            lifecycleStatus: "active",
            createdAt: 1,
          },
          replayed: false,
        };
      },
    },
  });
  const mutableCreate = {
    context: { workspaceKey: "workspace-1", authorization: { principalId: "user-1" } },
    idempotencyKey: uuid(70),
    providerId: "codex",
    allowedAdditionalDirectories: ["C:\\workspace-shared"],
    defaultCharacterId: "character-1",
    maxConcurrentChildRuns: 2,
  };
  const creating = createServiceUnderTest.create(mutableCreate);
  mutableCreate.context.workspaceKey = "workspace-mutated";
  mutableCreate.context.authorization.principalId = "user-mutated";
  mutableCreate.idempotencyKey = uuid(71);
  mutableCreate.providerId = "mutated-provider";
  mutableCreate.allowedAdditionalDirectories[0] = "C:\\mutated";
  createGate.resolve();
  await creating;
  assert.equal(createCommand?.session.workspaceKey, "workspace-1");
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
        await readGate.promise;
        return { allowed: true };
      },
      async authorize() {
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
    context: { workspaceKey: "workspace-1", authorization: { principalId: "user-1" } },
    lifecycleStatus: "active" as "active" | "archived" | "closed",
    cursor: "cursor-original",
    limit: 10,
  };
  const listing = readService.list(mutableList);
  mutableList.context.workspaceKey = "workspace-mutated";
  mutableList.lifecycleStatus = "archived";
  mutableList.cursor = "cursor-mutated";
  mutableList.limit = 20;
  readGate.resolve();
  await listing;
  assert.deepEqual(readInputs, [
    { workspaceKey: "workspace-1", lifecycleStatus: "active", cursor: "cursor-original", limit: 10 },
  ]);

  const detailGate = deferred<void>();
  const detailInputs: unknown[] = [];
  const detailService = createService({
    access: {
      async validateWorkspace() {
        await detailGate.promise;
        return { allowed: true };
      },
      async authorize() {
        return { allowed: true };
      },
    },
    reads: {
      async sessionGet(input) {
        detailInputs.push(input);
        return {
          session: {
            id: input.sessionId,
            providerId: "codex",
            workspaceKey: input.workspaceKey,
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
    context: { workspaceKey: "workspace-1", authorization: { principalId: "user-1" } },
    sessionId: "session-1",
  };
  const reading = detailService.read(mutableRead);
  mutableRead.context.workspaceKey = "workspace-mutated";
  mutableRead.sessionId = "session-mutated";
  detailGate.resolve();
  await reading;
  assert.deepEqual(detailInputs, [{ workspaceKey: "workspace-1", sessionId: "session-1" }]);

  const transitionGate = deferred<void>();
  const transitionService = createService({
    access: {
      async validateWorkspace() {
        await transitionGate.promise;
        return { allowed: true };
      },
      async authorize() {
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
    context: { workspaceKey: "workspace-1", authorization: { principalId: "user-1" } },
    sessionId: "session-1",
    idempotencyKey: uuid(72),
  };
  const archiving = transitionService.archive(mutableTransition);
  mutableTransition.context.workspaceKey = "workspace-mutated";
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
        await closeGate.promise;
        return { allowed: true };
      },
      async authorize() {
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
    context: { workspaceKey: "workspace-1", authorization: { principalId: "user-1" } },
    sessionId: "session-1",
    idempotencyKey: uuid(74),
    expectedLifecycleStatus: "active" as "active" | "archived",
  };
  const closing = closeService.close(mutableClose);
  mutableClose.context.workspaceKey = "workspace-mutated";
  mutableClose.sessionId = "session-mutated";
  mutableClose.idempotencyKey = uuid(75);
  mutableClose.expectedLifecycleStatus = "archived";
  closeGate.resolve();
  await closing;
  assert.deepEqual(closeCommands, [transition(uuid(74), "session-1", "active", "closed")]);
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
          value: {
            sessionId: command.session.id,
            workspaceKey: command.session.workspaceKey,
            lifecycleStatus: "active",
            createdAt: 1,
          },
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
  assert.deepEqual(receivedOptions, { timeoutMs: 1_000, signal: controller.signal });
});

test("operation timeout and cancellation settle while access validation is pending", async () => {
  let accessCalls = 0;
  let repositoryCalls = 0;
  const service = createService({
    access: {
      async validateWorkspace() {
        accessCalls += 1;
        return new Promise(() => undefined);
      },
      async authorize() {
        accessCalls += 1;
        return { allowed: true };
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
  assert.deepEqual(writeTimeout.persistence, { status: "failed", effect: "unknown" });
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

  const response = await service.list({ context: { workspaceKey: "workspace-1", authorization } });

  assert.equal(response.overallStatus, "success");
  assert.equal(received.length, 2);
  assert.notEqual(received[0], authorization);
  assert.notEqual(received[1], received[0]);
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

test("access validators receive isolated views of the decoded request snapshot", async () => {
  let authorizationInput: unknown;
  let createCommand: SessionCreateCommand | undefined;
  const service = createService({
    access: {
      async validateWorkspace(input) {
        const mutable = input as unknown as {
          operation: string;
          access: string;
          context: { workspaceKey: string; authorization: { principalId: string } };
        };
        mutable.operation = "list";
        mutable.access = "read";
        mutable.context.workspaceKey = "workspace-from-workspace-validator";
        mutable.context.authorization.principalId = "workspace-validator";
        return { allowed: true };
      },
      async authorize(input) {
        authorizationInput = structuredClone(input);
        const mutable = input as unknown as {
          operation: string;
          access: string;
          context: { workspaceKey: string; authorization: { principalId: string } };
        };
        mutable.operation = "read";
        mutable.access = "read";
        mutable.context.workspaceKey = "workspace-from-authorization-validator";
        mutable.context.authorization.principalId = "authorization-validator";
        return { allowed: true };
      },
    },
    writes: {
      async createSession(command) {
        createCommand = command;
        return {
          ok: true,
          value: {
            sessionId: command.session.id,
            workspaceKey: command.session.workspaceKey,
            lifecycleStatus: "active",
            createdAt: 1,
          },
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
    context: { workspaceKey: "workspace-1", authorization: { principalId: "user-1" } },
  });
  assert.equal(createCommand?.session.workspaceKey, "workspace-1");
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
  const invalidDirectories = [
    [123] as unknown as readonly string[],
    sparse,
    ["workspace/shared"],
    oversizedItem,
    tooManyItems,
    oversizedTotal,
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

test("workspace rejection skips authorization and Repository access", async () => {
  let authorizationChecks = 0;
  let reads = 0;
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
    reads: {
      async sessionsPage() {
        reads += 1;
        return { items: [] };
      },
    },
  });

  const response = await service.list({ context });

  assert.equal(response.overallStatus, "failure");
  assert.deepEqual(response.overallStatus === "failure" && response.error, {
    kind: "access",
    code: "workspace_unavailable",
    message: "Workspace is unavailable.",
    retryable: true,
  });
  assert.equal(authorizationChecks, 0);
  assert.equal(reads, 0);
});

test("list keeps workspace scope and represents bounded omissions as partial success", async () => {
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

  const response = await service.list({ context, lifecycleStatus: "active", limit: 10 });

  assert.equal(receivedWorkspace, "workspace-1");
  assert.equal(response.overallStatus, "partial_success");
  assert.deepEqual(response.persistence, { status: "read", effect: "none" });
  assert.deepEqual(response.overallStatus === "partial_success" && response.value, {
    items: [sessionSummary("session-1"), sessionSummary("session-2")],
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

test("read projects only known Application response fields", async () => {
  const service = createService({
    reads: {
      async sessionGet() {
        return {
          session: {
            id: "session-1",
            providerId: "codex",
            workspaceKey: "workspace-1",
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
            latestRunId: "run-latest",
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
      providerId: "codex",
      workspaceKey: "workspace-1",
      allowedAdditionalDirectoriesByteLength: 24,
      allowedAdditionalDirectoriesState: "inline",
      allowedAdditionalDirectories: ["C:\\workspace-shared"],
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
      latestRunId: "run-latest",
    },
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

test("unarchive revalidates workspace and authorization on every exact retry", async () => {
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

  assert.deepEqual(events, [
    "workspace:unarchive",
    "authorize:unarchive",
    "write",
    "workspace:unarchive",
    "authorize:unarchive",
    "write",
  ]);
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
  assert.deepEqual(response.persistence, { status: "failed", effect: "unknown" });
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

  const response = await service.list({ context });

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
  assert.deepEqual(response.persistence, { status: "failed", effect: "unknown" });
});

function createService(
  overrides: {
    access?: ApplicationAccessValidator<Authorization>;
    reads?: Partial<ReadPort>;
    writes?: Partial<WritePort>;
  } = {},
): ApplicationSessionService<Authorization> {
  const reads: ReadPort = {
    async sessionsPage() {
      return { items: [] };
    },
    async sessionGet() {
      return {
        session: {
          id: "session-1",
          providerId: "codex",
          workspaceKey: "workspace-1",
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
    ...overrides.reads,
  };
  const writes: WritePort = {
    async createSession(command) {
      return {
        ok: true,
        value: {
          sessionId: command.session.id,
          workspaceKey: command.session.workspaceKey,
          lifecycleStatus: "active",
          createdAt: 1,
        },
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
    ...overrides.writes,
  };
  return new ApplicationSessionService({
    reads,
    writes,
    access: overrides.access ?? allowingAccess(),
    snapshotAuthorization: (value: unknown) => structuredClone(value) as Authorization,
  });
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
    workspaceKey: "workspace-1",
    defaultCharacterId: "character-1",
    lifecycleStatus: "active" as const,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    executionState: "not_started" as const,
    stateChangedAt: 1,
  };
}

function transition(
  idempotencyKey: string,
  sessionId: string,
  expectedLifecycleStatus: "active" | "archived",
  targetLifecycleStatus: "active" | "archived" | "closed",
): SessionTransitionCommand {
  return { sessionId, workspaceKey: "workspace-1", idempotencyKey, expectedLifecycleStatus, targetLifecycleStatus };
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
