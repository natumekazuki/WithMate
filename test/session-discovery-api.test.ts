import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { parseCliArgv } from "../src/cli/parser.js";
import { ApplicationSessionService } from "../src/main/application-session-service.js";
import { createRepositoryReadOperations } from "../src/persistence-worker/repository-read-model.js";
import { createRepositoryWriteOperations } from "../src/persistence-worker/repository-write-model.js";
import { REPOSITORY_READ_OPERATIONS } from "../src/shared/repository-read-model.js";
import { REPOSITORY_WRITE_OPERATIONS } from "../src/shared/repository-write-model.js";
import { resolveWorkspaceIdentity } from "../src/shared/workspace-path.js";

const repositoryTest = Number.parseInt(process.versions.node, 10) >= 24 ? test : test.skip;
const repositoryKey = `local-repository-v1-sha256-${"a".repeat(64)}`;
const otherRepositoryKey = `local-repository-v1-sha256-${"b".repeat(64)}`;

repositoryTest("title update is idempotent and immediately participates in Session search", () => {
  withDatabase((database) => {
    let now = 100;
    const writes = createRepositoryWriteOperations(database, { clock: () => now });
    execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionCreate, createCommand("session-1", uuid(1), "Initial", "Repo"));
    execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionCreate, createCommand("session-2", uuid(3), "Other", "Repo"));
    now = 200;
    const command = { sessionId: "session-1", idempotencyKey: uuid(2), title: "Renamed Session" } as const;
    const updated = execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionUpdateTitle, command) as WriteResult;
    assert.deepEqual(updated, {
      ok: true,
      value: { sessionId: "session-1", title: "Renamed Session", updatedAt: 200 },
      replayed: false,
    });
    assert.equal(
      (execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionUpdateTitle, command) as WriteResult).replayed,
      true,
    );
    assert.equal(
      (
        execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionUpdateTitle, {
          ...command,
          title: "Different",
        }) as WriteResult
      ).ok,
      false,
    );
    assert.deepEqual(
      { ...database.prepare("SELECT title, updated_at, last_activity_at FROM sessions WHERE id = ?").get("session-1") },
      { title: "Renamed Session", updated_at: 200, last_activity_at: 100 },
    );

    const reads = createRepositoryReadOperations(database);
    const page = execute(reads, REPOSITORY_READ_OPERATIONS.sessionsPage, {
      querySearchKey: "renamed",
      localRepositoryKeys: [repositoryKey],
    }) as PageResult;
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["session-1"],
    );
    const empty = execute(reads, REPOSITORY_READ_OPERATIONS.sessionsPage, {
      querySearchKey: "renamed",
      localRepositoryKeys: [otherRepositoryKey],
    }) as PageResult;
    assert.deepEqual(empty.items, []);
    const repositoryNameMatch = execute(reads, REPOSITORY_READ_OPERATIONS.sessionsPage, {
      querySearchKey: "repo",
    }) as PageResult;
    assert.deepEqual(
      repositoryNameMatch.items.map((item) => item.id),
      ["session-2", "session-1"],
    );
    database.prepare("UPDATE sessions SET title = ? WHERE id = ?").run("Éclair", "session-2");
    const unicodeCaseMatch = execute(reads, REPOSITORY_READ_OPERATIONS.sessionsPage, {
      querySearchKey: "é",
    }) as PageResult;
    assert.deepEqual(
      unicodeCaseMatch.items.map((item) => item.id),
      ["session-2"],
    );
    const first = execute(reads, REPOSITORY_READ_OPERATIONS.sessionsPage, {
      localRepositoryKeys: [repositoryKey],
      limit: 1,
    }) as PageResult;
    assert.ok(first.nextCursor);
    assert.throws(() =>
      execute(reads, REPOSITORY_READ_OPERATIONS.sessionsPage, {
        localRepositoryKeys: [repositoryKey],
        querySearchKey: "renamed",
        cursor: first.nextCursor,
        limit: 1,
      }),
    );

    database.prepare("UPDATE sessions SET lifecycle_status = 'archived' WHERE id = ?").run("session-1");
    now = 300;
    execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionUpdateTitle, {
      sessionId: "session-1",
      idempotencyKey: uuid(5),
      title: "Archived title",
    });
    database.prepare("UPDATE sessions SET lifecycle_status = 'closed' WHERE id = ?").run("session-1");
    now = 400;
    execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionUpdateTitle, {
      sessionId: "session-1",
      idempotencyKey: uuid(6),
      title: "Closed title",
    });
    assert.deepEqual(
      {
        ...database
          .prepare("SELECT title, lifecycle_status, updated_at, last_activity_at FROM sessions WHERE id = ?")
          .get("session-1"),
      },
      { title: "Closed title", lifecycle_status: "closed", updated_at: 400, last_activity_at: 100 },
    );
  });
});

repositoryTest("local Repository listing groups names by key and excludes non-Git Sessions", () => {
  withDatabase((database) => {
    let now = 100;
    const writes = createRepositoryWriteOperations(database, { clock: () => now });
    execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionCreate, createCommand("session-1", uuid(1), "One", "Repo"));
    now = 110;
    execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionCreate, createCommand("session-2", uuid(2), "Two", "repo"));
    now = 120;
    execute(writes, REPOSITORY_WRITE_OPERATIONS.sessionCreate, createCommand("session-3", uuid(3), "Three", null));
    now = 110;
    execute(
      writes,
      REPOSITORY_WRITE_OPERATIONS.sessionCreate,
      createCommand("session-4", uuid(4), "Four", "Repo", otherRepositoryKey),
    );

    const reads = createRepositoryReadOperations(database);
    const page = execute(reads, REPOSITORY_READ_OPERATIONS.localRepositoriesPage, {}) as RepositoryPageResult;
    assert.deepEqual(page.items, [
      {
        localRepositoryKey: otherRepositoryKey,
        repositoryNames: ["Repo"],
        repositoryNameCount: 1,
        sessionCount: 1,
        lastActivityAt: 110,
      },
      {
        localRepositoryKey: repositoryKey,
        repositoryNames: ["repo", "Repo"],
        repositoryNameCount: 2,
        sessionCount: 2,
        lastActivityAt: 110,
      },
    ]);
    const first = execute(reads, REPOSITORY_READ_OPERATIONS.localRepositoriesPage, {
      limit: 1,
    }) as RepositoryPageResult;
    assert.deepEqual(first.items, [page.items[0]]);
    assert.ok(first.nextCursor);
    const second = execute(reads, REPOSITORY_READ_OPERATIONS.localRepositoriesPage, {
      cursor: first.nextCursor,
      limit: 1,
    }) as RepositoryPageResult;
    assert.deepEqual(second.items, [page.items[1]]);
    assert.equal(second.nextCursor, undefined);
  });
});

repositoryTest("local Repository names are bounded while aggregate counts remain complete", () => {
  withDatabase((database) => {
    let now = 100;
    const writes = createRepositoryWriteOperations(database, { clock: () => now });
    for (let ordinal = 0; ordinal <= 100; ordinal += 1) {
      now = 100 + ordinal;
      execute(
        writes,
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        createCommand(
          `session-${ordinal}`,
          uuid(ordinal + 1),
          `Session ${ordinal}`,
          `Repo-${String(ordinal).padStart(3, "0")}`,
        ),
      );
    }

    const reads = createRepositoryReadOperations(database);
    const page = execute(reads, REPOSITORY_READ_OPERATIONS.localRepositoriesPage, {}) as RepositoryPageResult;
    assert.equal(page.items.length, 1);
    const item = page.items[0] as Readonly<{
      repositoryNames: readonly string[];
      repositoryNameCount: number;
      sessionCount: number;
    }>;
    assert.equal(item.repositoryNames.length, 100);
    assert.equal(item.repositoryNames[0], "Repo-100");
    assert.equal(item.repositoryNames.at(-1), "Repo-001");
    assert.equal(item.repositoryNameCount, 101);
    assert.equal(item.sessionCount, 101);
  });
});

test("CLI exposes rename, typed Session filters, and Repository listing", () => {
  assert.equal(
    parseCliArgv([
      "session",
      "rename",
      "--session-id",
      "session-1",
      "--title",
      " New title ",
      "--idempotency-key",
      uuid(1),
    ]).kind,
    "command",
  );
  const list = parseCliArgv([
    "session",
    "list",
    "--repository-key",
    repositoryKey,
    "--repository-key",
    otherRepositoryKey,
    "--query",
    " repo ",
  ]);
  assert.equal(list.kind, "command");
  if (list.kind === "command" && "localRepositoryKeys" in list.command) {
    assert.deepEqual(list.command.localRepositoryKeys, [repositoryKey, otherRepositoryKey]);
    assert.equal(list.command.query, "repo");
  }
  assert.equal(parseCliArgv(["session", "repositories", "--limit", "10"]).kind, "command");
});

test("Application authorizes new operations and forwards canonical Session filters", async () => {
  const authorizationTargets: unknown[] = [];
  const readInputs: unknown[] = [];
  const writeInputs: unknown[] = [];
  const workspace = resolveWorkspaceIdentity(path.resolve("workspace"));
  assert.ok(workspace);
  const service = new ApplicationSessionService({
    reads: {
      async sessionsPage(input) {
        readInputs.push(input);
        return {
          items: [
            {
              id: "session-1",
              title: "Renamed Session",
              workspaceKey: workspace.workspaceKey,
              workspacePath: workspace.workspacePath,
              localRepositoryKey: repositoryKey,
              repositoryName: "Repo",
              defaultCharacterId: "character",
              lifecycleStatus: "active",
              createdAt: 100,
              updatedAt: 200,
              lastActivityAt: 100,
              executionState: "not_started",
              stateChangedAt: 100,
            },
          ],
        };
      },
      async localRepositoriesPage(input) {
        readInputs.push(input);
        return {
          items: [
            {
              localRepositoryKey: repositoryKey,
              repositoryNames: ["Repo"],
              repositoryNameCount: 1,
              sessionCount: 1,
              lastActivityAt: 100,
            },
          ],
        };
      },
      async sessionGet(): Promise<never> {
        throw new Error("unexpected");
      },
      async sessionDirectoriesChunk(): Promise<never> {
        throw new Error("unexpected");
      },
    },
    writes: {
      async createSession(): Promise<never> {
        throw new Error("unexpected");
      },
      async updateSessionTitle(command) {
        writeInputs.push(command);
        return {
          ok: true,
          value: { sessionId: command.sessionId, title: command.title, updatedAt: 200 },
          replayed: false,
        };
      },
      async transitionSession(): Promise<never> {
        throw new Error("unexpected");
      },
    },
    access: {
      async validateWorkspace() {
        return { allowed: true } as const;
      },
      async authorize(input) {
        authorizationTargets.push(input);
        return { allowed: true } as const;
      },
    },
    snapshotAuthorization(value) {
      return value as Readonly<{ principal: string }>;
    },
  });
  const context = { authorization: { principal: "owner" } } as const;

  const renamed = await service.updateTitle({
    context,
    sessionId: "session-1",
    title: " Renamed Session ",
    idempotencyKey: uuid(4),
  });
  assert.equal(renamed.overallStatus, "success");
  assert.deepEqual(writeInputs, [{ sessionId: "session-1", title: "Renamed Session", idempotencyKey: uuid(4) }]);

  const listed = await service.list({
    context,
    localRepositoryKeys: [repositoryKey, repositoryKey],
    query: " renamed ",
  });
  assert.equal(listed.overallStatus, "success");
  assert.deepEqual(readInputs[0], { localRepositoryKeys: [repositoryKey], querySearchKey: "renamed" });

  const repositories = await service.listLocalRepositories({ context });
  assert.equal(repositories.overallStatus, "success");
  assert.deepEqual(readInputs[1], {});
  assert.deepEqual(
    authorizationTargets.map((input) => (input as { operation: string }).operation),
    ["update_title", "list", "list_local_repositories"],
  );
});

function createCommand(
  id: string,
  idempotencyKey: string,
  title: string,
  repositoryName: string | null,
  localRepositoryKey = repositoryKey,
) {
  const workspace = resolveWorkspaceIdentity(path.resolve("workspace"));
  assert.ok(workspace);
  return {
    idempotencyKey,
    session: {
      id,
      title,
      providerId: "codex",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
      localRepositoryKey: repositoryName === null ? null : localRepositoryKey,
      repositoryName,
      allowedAdditionalDirectories: [],
      defaultCharacterId: "character",
      maxConcurrentChildRuns: 1,
    },
  } as const;
}

function execute(
  operations: ReadonlyMap<
    string,
    Readonly<{ execute(payload: Readonly<Record<string, unknown>>): { result: unknown } }>
  >,
  operation: string,
  payload: object,
): unknown {
  const handler = operations.get(operation);
  assert.ok(handler);
  return handler.execute(payload as Readonly<Record<string, unknown>>).result;
}

function withDatabase(run: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(fs.readFileSync(path.resolve("schema/sqlite/v1.sql"), "utf8"));
    run(database);
  } finally {
    database.close();
  }
}

function uuid(ordinal: number): string {
  return `018f1f4e-7f0a-7000-8000-${String(ordinal).padStart(12, "0")}`;
}

type WriteResult = Readonly<{ ok: boolean; replayed: boolean; value?: unknown }>;
type PageResult = Readonly<{ items: readonly Readonly<{ id: string }>[]; nextCursor?: string }>;
type RepositoryPageResult = Readonly<{ items: readonly unknown[]; nextCursor?: string }>;
