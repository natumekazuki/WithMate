import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { buildNewSession } from "../../src/session-state.js";
import { SessionCrudError, SessionCrudService } from "../../src-electron/session-crud-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const character: CharacterCatalogEntry = {
  id: "character-a",
  name: "Character A",
  description: "",
  iconFilePath: "",
  theme: { main: "#6f8cff", sub: "#6fb8c7" },
  state: "active",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  archivedAt: null,
};

const characterSnapshot: CharacterRuntimeSnapshot = {
  characterId: character.id,
  name: character.name,
  description: "",
  iconFilePath: "",
  theme: character.theme,
  definitionMarkdown: "# Character A",
  definitionSha256: "character-a-sha256",
  definitionByteSize: 13,
  snapshotAt: "2026-08-01T00:00:00.000Z",
};

async function removeDirectory(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

describe("SessionCrudService", () => {
  it("create replayはCharacterを再抽選せず、public projectionとGUI同期を一度だけ確定する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const sessionFilesRoot = path.join(tempDirectory, "session-files");
    const storage = new SessionStorageV6(dbPath);
    let catalogRevision = 4;
    let launchSelectionCount = 0;
    let sessionIdCount = 0;
    let snapshotCount = 0;
    const publishedSessionIds: string[] = [];
    const publicationErrors: string[] = [];

    try {
      const db = new DatabaseSync(dbPath);
      db.prepare(`
        INSERT INTO characters (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(character.id, character.name, character.createdAt, character.updatedAt);
      db.close();
      const service = new SessionCrudService({
        storage,
        resolveLaunchSelection: async () => {
          launchSelectionCount += 1;
          return {
            provider: "codex",
            catalogRevision,
            model: "gpt-test",
            reasoningEffort: "high",
            approvalMode: DEFAULT_APPROVAL_MODE,
            codexSandboxMode: "workspace-write",
            customAgentName: "",
          };
        },
        listCharacters: () => [character],
        listSessionSummaries: () => storage.listSessionSummaries(),
        listOpenSessionWindowIds: () => [],
        createCharacterRuntimeSnapshot: () => {
          snapshotCount += 1;
          return characterSnapshot;
        },
        createSessionId: () => `session-${++sessionIdCount}`,
        createSessionFilesDirectory: async (sessionId) => {
          const directoryPath = path.join(sessionFilesRoot, sessionId);
          await mkdir(directoryPath, { recursive: false });
          return directoryPath;
        },
        resolveSessionFilesDirectory: (sessionId) => path.join(sessionFilesRoot, sessionId),
        publishCreatedSession: (session) => {
          publishedSessionIds.push(session.id);
          throw new Error("broadcast failed");
        },
        publishRenamedSession: () => undefined,
        reportPublicationError: (operation) => publicationErrors.push(operation),
        now: () => new Date("2026-08-11T00:00:00.000Z"),
        random: () => 0,
      });
      await mkdir(sessionFilesRoot);

      const input = {
        title: "Created externally",
        provider: "codex" as const,
        catalogRevision: 4,
        workspace: { kind: "session_folder" as const },
        idempotencyKey: "create-key-1",
      };
      const created = await service.create(input);
      catalogRevision = 5;
      const replay = await service.create(input);

      assert.deepEqual(replay, created);
      assert.equal(created.sessionId, "session-1");
      assert.deepEqual(created.character, { id: character.id, name: character.name });
      assert.deepEqual(created.workspace, {
        kind: "session_folder",
        label: "SessionFolder",
        path: path.join(sessionFilesRoot, "session-1"),
        branch: "",
      });
      assert.deepEqual(created.sessionFolder, {
        path: path.join(sessionFilesRoot, "session-1"),
        isWorkspace: true,
      });
      assert.equal(launchSelectionCount, 1);
      assert.equal(sessionIdCount, 1);
      assert.equal(snapshotCount, 1);
      assert.deepEqual(publishedSessionIds, ["session-1"]);
      assert.deepEqual(publicationErrors, ["session.create"]);

      const listed = await service.list({ limit: 50 });
      assert.equal(listed.items.length, 1);
      assert.equal("path" in listed.items[0]!.workspace, false);
      assert.equal(JSON.stringify(listed).includes(sessionFilesRoot), false);

      const ordinarySessionFolderName = path.join(tempDirectory, "external", "SessionFolder");
      await mkdir(ordinarySessionFolderName, { recursive: true });
      catalogRevision = 4;
      const ordinaryDirectory = await service.create({
        ...input,
        workspace: { kind: "directory", path: ordinarySessionFolderName },
        idempotencyKey: "create-key-2",
      });
      assert.equal(ordinaryDirectory.workspace.kind, "directory");
      const listedOrdinaryDirectory = (await service.list({ limit: 50 })).items.find(
        (session) => session.sessionId === ordinaryDirectory.sessionId,
      );
      assert.equal(listedOrdinaryDirectory?.workspace.kind, "directory");
    } finally {
      storage.close();
      await removeDirectory(tempDirectory);
    }
  });

  it("renameは通常Sessionだけをatomicに更新し、replay時は再publishしない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    const publishedTitles: string[] = [];
    const publicationErrors: string[] = [];

    try {
      const normal = storage.insertSession(buildNewSession({
        id: "normal-session",
        taskTitle: "Before",
        workspaceLabel: "workspace",
        workspacePath: tempDirectory,
        branch: "",
        characterId: character.id,
        character: character.name,
        characterIconPath: "",
        characterThemeColors: character.theme,
        approvalMode: DEFAULT_APPROVAL_MODE,
      }));
      storage.insertSession(buildNewSession({
        id: "authoring-session",
        taskTitle: "Authoring",
        workspaceLabel: "workspace",
        workspacePath: tempDirectory,
        branch: "",
        sessionKind: "character-authoring",
        characterId: character.id,
        character: character.name,
        characterIconPath: "",
        characterThemeColors: character.theme,
        approvalMode: DEFAULT_APPROVAL_MODE,
      }));
      const service = new SessionCrudService({
        storage,
        resolveLaunchSelection: async () => { throw new Error("not used"); },
        listCharacters: () => [],
        listSessionSummaries: () => storage.listSessionSummaries(),
        listOpenSessionWindowIds: () => [],
        createCharacterRuntimeSnapshot: () => null,
        createSessionId: () => "not-used",
        createSessionFilesDirectory: async () => { throw new Error("not used"); },
        resolveSessionFilesDirectory: (sessionId) => path.join(tempDirectory, "session-files", sessionId),
        publishCreatedSession: () => undefined,
        publishRenamedSession: (session) => {
          publishedTitles.push(session.taskTitle);
          throw new Error("broadcast failed");
        },
        reportPublicationError: (operation) => publicationErrors.push(operation),
        now: () => new Date("2026-08-11T00:10:00.000Z"),
      });

      const input = { sessionId: normal.id, title: "After", idempotencyKey: "rename-key-1" };
      const renamed = await service.rename(input);
      const replay = await service.rename(input);
      assert.deepEqual(replay, renamed);
      assert.equal(storage.getSessionSummary(normal.id)?.taskTitle, "After");
      assert.deepEqual(publishedTitles, ["After"]);
      assert.deepEqual(publicationErrors, ["session.rename"]);
      await assert.rejects(
        () => service.rename({
          sessionId: "authoring-session",
          title: "Must not change",
          idempotencyKey: "rename-key-2",
        }),
        (error) => error instanceof SessionCrudError && error.code === "SESSION_KIND_UNSUPPORTED",
      );
      assert.equal(storage.getSessionSummary("authoring-session")?.taskTitle, "Authoring");
    } finally {
      storage.close();
      await removeDirectory(tempDirectory);
    }
  });

  it("ADR-005: 永続化呼出し後の失敗では作成済みSessionFolderを削除しない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-crud-"));
    const sessionFolder = path.join(tempDirectory, "session-files", "session-failed");
    try {
      const service = new SessionCrudService({
        storage: {
          resolveSessionCrudIdempotency: () => ({ kind: "miss" }),
          insertSessionIdempotently: () => { throw new Error("database failed"); },
          renameSessionIdempotently: () => { throw new Error("unused"); },
          listSessionSummaryPage: () => [],
          getSessionSummary: () => null,
        },
        resolveLaunchSelection: async () => ({
          provider: "codex",
          catalogRevision: 4,
          model: "gpt-test",
          reasoningEffort: "high",
          approvalMode: DEFAULT_APPROVAL_MODE,
          codexSandboxMode: "workspace-write",
          customAgentName: "",
        }),
        listCharacters: () => [character],
        listSessionSummaries: () => [],
        listOpenSessionWindowIds: () => [],
        createCharacterRuntimeSnapshot: () => characterSnapshot,
        createSessionId: () => "session-failed",
        createSessionFilesDirectory: async () => {
          await mkdir(sessionFolder, { recursive: true });
          return sessionFolder;
        },
        resolveSessionFilesDirectory: () => sessionFolder,
        publishCreatedSession: () => undefined,
        publishRenamedSession: () => undefined,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
        random: () => 0,
      });

      await assert.rejects(
        () => service.create({
          title: "Failed create",
          provider: "codex",
          catalogRevision: 4,
          workspace: { kind: "session_folder" },
          idempotencyKey: "failed-key",
        }),
        (error) => error instanceof SessionCrudError && error.code === "RUNTIME_UNAVAILABLE",
      );
      assert.equal((await stat(sessionFolder)).isDirectory(), true);
    } finally {
      await removeDirectory(tempDirectory);
    }
  });
});
