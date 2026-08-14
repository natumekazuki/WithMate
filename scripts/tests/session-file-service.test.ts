import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession } from "../../src/session-state.js";
import {
  SessionFileService,
  SessionFileServiceError,
} from "../../src-electron/session-file-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

async function createFixture(options: {
  onWritePrepared?(): void | Promise<void>;
  onAfterReplaceTargetClaim?(): void;
} = {}): Promise<{
  tempDirectory: string;
  sessionFolder: string;
  storage: SessionStorageV6;
  service: SessionFileService;
}> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-file-service-"));
  const dbPath = path.join(tempDirectory, "withmate-v6.db");
  const sessionFolder = path.join(tempDirectory, "session-files", "session-a");
  const storage = new SessionStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    INSERT INTO characters (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run("character-a", "Character A", "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  db.close();
  storage.insertSession(buildNewSession({
    id: "session-a",
    provider: "codex",
    catalogRevision: 1,
    taskTitle: "Session A",
    workspaceLabel: "SessionFolder",
    workspacePath: sessionFolder,
    branch: "",
    characterId: "character-a",
    character: "Character A",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: "workspace-write",
    model: "gpt-test",
    reasoningEffort: "high",
  }));
  await mkdir(sessionFolder, { recursive: true });
  let tempIndex = 0;
  return {
    tempDirectory,
    sessionFolder,
    storage,
    service: new SessionFileService({
      storage,
      resolveSessionFilesDirectory: () => sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => `fixed-temp-${tempIndex++}`,
      ...options,
    }),
  };
}

describe("SessionFileService", () => {
  it("SF-OWN-01: missingまたはnon-default Sessionのfilesを解決しない", async () => {
    const fixture = await createFixture();
    try {
      fixture.storage.insertSession(buildNewSession({
        id: "authoring-session",
        provider: "codex",
        catalogRevision: 1,
        taskTitle: "Authoring Session",
        workspaceLabel: "SessionFolder",
        workspacePath: path.join(fixture.tempDirectory, "authoring"),
        branch: "",
        sessionKind: "character-authoring",
        characterId: "character-a",
        character: "Character A",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: "workspace-write",
        model: "gpt-test",
        reasoningEffort: "high",
      }));
      for (const sessionId of ["missing-session", "authoring-session"]) {
        await assert.rejects(
          fixture.service.list({ sessionId, limit: 50 }),
          (error) => error instanceof SessionFileServiceError && error.code === "SESSION_NOT_FOUND",
        );
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-PATH-01: relative pathだけを受理し、symlink越しのread/listを公開しない", async () => {
    const fixture = await createFixture();
    try {
      const outside = path.join(fixture.tempDirectory, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, path.join(fixture.sessionFolder, "linked"), process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        fixture.service.readText({
          sessionId: "session-a",
          relativePath: "../outside/secret.txt",
          maxBytes: 1024,
        }),
        (error) => error instanceof SessionFileServiceError && error.code === "PATH_NOT_ALLOWED",
      );
      await assert.rejects(
        fixture.service.readText({
          sessionId: "session-a",
          relativePath: "linked/secret.txt",
          maxBytes: 1024,
        }),
        (error) => error instanceof SessionFileServiceError && error.code === "PATH_CHANGED",
      );
      assert.deepEqual(await fixture.service.list({ sessionId: "session-a", limit: 50 }), { items: [] });
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-PATH-02: Session files rootのjunction差替えを経由して外部directoryへ書かない", async () => {
    const fixture = await createFixture();
    try {
      const outside = path.join(fixture.tempDirectory, "outside-root");
      const lexicalFilesRoot = path.dirname(fixture.sessionFolder);
      await mkdir(outside);
      await rm(lexicalFilesRoot, { recursive: true, force: true });
      await symlink(outside, lexicalFilesRoot, process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        fixture.service.writeText({
          sessionId: "session-a",
          relativePath: "secret.txt",
          content: "must stay contained",
          maxBytes: 1024,
          replace: false,
          idempotencyKey: "write-root-junction",
        }),
        (error) => error instanceof SessionFileServiceError && error.code === "PATH_NOT_ALLOWED",
      );
      await assert.rejects(readFile(path.join(outside, "session-a", "secret.txt"), "utf8"), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-PATH-03: identity bind後にSessionFolderを差し替えても外部directoryへpublishしない", async () => {
    const fixture = await createFixture();
    const moved = `${fixture.sessionFolder}-moved`;
    const outside = path.join(fixture.tempDirectory, "outside-after-bind");
    await mkdir(outside);
    let swapped = false;
    const service = new SessionFileService({
      storage: fixture.storage,
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "swap-temp",
      onWriteIdentityBound: () => {
        swapped = true;
        renameSync(fixture.sessionFolder, moved);
        symlinkSync(outside, fixture.sessionFolder, process.platform === "win32" ? "junction" : "dir");
      },
    });
    try {
      await assert.rejects(
        service.writeText({
          sessionId: "session-a",
          relativePath: "secret.txt",
          content: "must stay identity-bound",
          maxBytes: 1024,
          replace: false,
          idempotencyKey: "write-after-bind-swap",
        }),
        (error) => error instanceof SessionFileServiceError
          && (error.code === "PATH_CHANGED" || error.code === "RUNTIME_UNAVAILABLE")
          && (error.effect === "not_applied" || error.effect === "indeterminate"),
      );
      assert.equal(swapped, true);
      await assert.rejects(readFile(path.join(outside, "secret.txt"), "utf8"), /ENOENT/);
      await assert.rejects(readFile(path.join(outside, ".withmate-session-write-swap-temp.tmp"), "utf8"), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-PATH-04: identity bind後のnested junctionを辿って外部directoryへpublishしない", async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.tempDirectory, "outside-nested");
    await mkdir(outside);
    const service = new SessionFileService({
      storage: fixture.storage,
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "nested-swap-temp",
      onWriteIdentityBound: () => {
        symlinkSync(outside, path.join(fixture.sessionFolder, "nested"), process.platform === "win32" ? "junction" : "dir");
      },
    });
    try {
      await assert.rejects(
        service.writeText({
          sessionId: "session-a",
          relativePath: "nested/secret.txt",
          content: "must stay contained",
          maxBytes: 1024,
          replace: false,
          idempotencyKey: "write-nested-swap",
        }),
        (error) => error instanceof SessionFileServiceError
          && (error.code === "PATH_CHANGED" || error.code === "RUNTIME_UNAVAILABLE")
          && (error.effect === "not_applied" || error.effect === "indeterminate"),
      );
      await assert.rejects(readFile(path.join(outside, "secret.txt"), "utf8"), /ENOENT/);
      await assert.rejects(readFile(path.join(outside, ".withmate-session-write-nested-swap-temp.tmp"), "utf8"), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-LIMIT-02: UTF-8 textを完全読取し、invalid UTF-8と超過を明示的に拒否する", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(path.join(fixture.sessionFolder, "ok.txt"), "こんにちは", "utf8");
      await writeFile(path.join(fixture.sessionFolder, "invalid.txt"), Uint8Array.from([0xff, 0xfe]));
      const result = await fixture.service.readText({
        sessionId: "session-a",
        relativePath: "ok.txt",
        maxBytes: 1024,
      });
      assert.equal(result.content, "こんにちは");
      assert.equal(result.file.byteLength, Buffer.byteLength("こんにちは", "utf8"));

      await assert.rejects(
        fixture.service.readText({ sessionId: "session-a", relativePath: "ok.txt", maxBytes: 3 }),
        (error) => error instanceof SessionFileServiceError && error.code === "CONTENT_TOO_LARGE",
      );
      await assert.rejects(
        fixture.service.readText({ sessionId: "session-a", relativePath: "invalid.txt", maxBytes: 1024 }),
        (error) => error instanceof SessionFileServiceError && error.code === "INVALID_TEXT_ENCODING",
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-LIMIT-03: recursive listをrelative path順でcursor継続する", async () => {
    const fixture = await createFixture();
    try {
      await mkdir(path.join(fixture.sessionFolder, "notes"));
      await writeFile(path.join(fixture.sessionFolder, "a.txt"), "a", "utf8");
      await writeFile(path.join(fixture.sessionFolder, "notes", "b.txt"), "b", "utf8");
      await writeFile(path.join(fixture.sessionFolder, "notes", "c.txt"), "c", "utf8");
      const first = await fixture.service.list({ sessionId: "session-a", limit: 2 });
      assert.deepEqual(first.items.map((item) => item.relativePath), ["a.txt", "notes/b.txt"]);
      assert.ok(first.nextCursor);
      const second = await fixture.service.list({ sessionId: "session-a", limit: 2, cursor: first.nextCursor });
      assert.deepEqual(second.items.map((item) => item.relativePath), ["notes/c.txt"]);
      assert.equal(second.nextCursor, undefined);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-LIMIT-04: Unicodeとdirectory prefixでも同じbyte順でcursor継続する", async () => {
    const fixture = await createFixture();
    try {
      await mkdir(path.join(fixture.sessionFolder, "a"));
      await writeFile(path.join(fixture.sessionFolder, "a.txt"), "a", "utf8");
      await writeFile(path.join(fixture.sessionFolder, "a", "z.txt"), "nested", "utf8");
      await writeFile(path.join(fixture.sessionFolder, "z.txt"), "z", "utf8");
      await writeFile(path.join(fixture.sessionFolder, "ä.txt"), "umlaut", "utf8");
      const expected = ["a.txt", "a/z.txt", "z.txt", "ä.txt"];
      const first = await fixture.service.list({ sessionId: "session-a", limit: 2 });
      const second = await fixture.service.list({ sessionId: "session-a", limit: 2, cursor: first.nextCursor });
      assert.deepEqual([...first.items, ...second.items].map((item) => item.relativePath), expected);
      assert.equal(second.nextCursor, undefined);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-LIMIT-05: 小さいpage limitでも巨大directoryのscanを上限で拒否する", async () => {
    const fixture = await createFixture();
    try {
      await Promise.all(Array.from({ length: 257 }, (_, index) => (
        writeFile(path.join(fixture.sessionFolder, `file-${index.toString().padStart(3, "0")}.txt`), `${index}`)
      )));
      await assert.rejects(
        fixture.service.list({ sessionId: "session-a", limit: 1 }),
        (error) => error instanceof SessionFileServiceError
          && error.code === "CONTENT_TOO_LARGE"
          && error.retryable === false,
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-03: atomic writeを再生し、replaceを明示しない既存fileを上書きしない", async () => {
    const fixture = await createFixture();
    try {
      const input = {
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        content: "first",
        maxBytes: 1024,
        replace: false,
        idempotencyKey: "write-1",
      };
      const first = await fixture.service.writeText(input);
      assert.equal(await readFile(path.join(fixture.sessionFolder, "notes", "brief.md"), "utf8"), "first");
      assert.deepEqual(await fixture.service.writeText(input), first);
      await assert.rejects(
        fixture.service.writeText({ ...input, idempotencyKey: "write-same-content" }),
        (error) => error instanceof SessionFileServiceError && error.code === "FILE_ALREADY_EXISTS",
      );
      await assert.rejects(
        fixture.service.writeText({ ...input, content: "second", idempotencyKey: "write-2" }),
        (error) => error instanceof SessionFileServiceError && error.code === "FILE_ALREADY_EXISTS",
      );
      assert.equal(await readFile(path.join(fixture.sessionFolder, "notes", "brief.md"), "utf8"), "first");
      await assert.rejects(
        fixture.service.writeText({ ...input, content: "second", replace: true, idempotencyKey: "write-3" }),
        (error) => error instanceof SessionFileServiceError
          && error.code === "RUNTIME_UNAVAILABLE"
          && error.retryable === false
          && error.effect === "not_applied",
      );
      assert.equal(await readFile(path.join(fixture.sessionFolder, "notes", "brief.md"), "utf8"), "first");
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-04: publish後のSQLite応答失敗を同じkeyのretryでappliedへ収束する", async () => {
    const fixture = await createFixture();
    let failCompletion = true;
    const service = new SessionFileService({
      storage: {
        getSessionSummary: (sessionId) => fixture.storage.getSessionSummary(sessionId),
        prepareSessionFileWrite: (input) => fixture.storage.prepareSessionFileWrite(input),
        recordPreparedSessionFileWrite: (input) => fixture.storage.recordPreparedSessionFileWrite(input),
        rejectSessionFileWrite: (input) => fixture.storage.rejectSessionFileWrite(input),
        completeSessionFileWrite: (input) => {
          if (failCompletion) {
            failCompletion = false;
            throw new Error("simulated response persistence loss");
          }
          return fixture.storage.completeSessionFileWrite(input);
        },
      },
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "crash-temp",
    });
    const input = {
      sessionId: "session-a",
      relativePath: "recovered.txt",
      content: "recover me",
      maxBytes: 1024,
      replace: false,
      idempotencyKey: "write-crash",
    };
    try {
      await assert.rejects(service.writeText(input), /simulated response persistence loss/);
      assert.equal(await readFile(path.join(fixture.sessionFolder, "recovered.txt"), "utf8"), "recover me");
      const recovered = await service.writeText(input);
      assert.equal(recovered.file.relativePath, "recovered.txt");
      assert.deepEqual(await service.writeText(input), recovered);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-05: pendingのpartial tempをpath unlinkせずfail-closedにする", async () => {
    const fixture = await createFixture();
    const content = "complete content";
    const relativePath = "recovery.txt";
    const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      sessionId: "session-a",
      relativePath,
      contentSha256,
      replace: false,
    }), "utf8").digest("hex");
    const tempName = ".withmate-session-write-partial.tmp";
    try {
      fixture.storage.prepareSessionFileWrite({
        idempotencyKey: "write-partial",
        requestFingerprint,
        sessionId: "session-a",
        relativePath,
        tempName,
        createdAt: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-12T00:00:00.000Z",
      });
      await writeFile(path.join(fixture.sessionFolder, tempName), "partial", "utf8");
      await assert.rejects(
        fixture.service.writeText({
          sessionId: "session-a",
          relativePath,
          content,
          maxBytes: 1024,
          replace: false,
          idempotencyKey: "write-partial",
        }),
        (error) => error instanceof SessionFileServiceError && error.code === "PATH_CHANGED",
      );
      assert.equal(await readFile(path.join(fixture.sessionFolder, tempName), "utf8"), "partial");
      await assert.rejects(readFile(path.join(fixture.sessionFolder, relativePath), "utf8"), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-06: fresh no-overwriteの同内容競合をappliedとして扱わない", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.sessionFolder, "collision.txt");
    const service = new SessionFileService({
      storage: fixture.storage,
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "collision-temp",
      onWriteIdentityBound: () => writeFileSync(targetPath, "same", "utf8"),
    });
    try {
      await assert.rejects(
        service.writeText({
          sessionId: "session-a",
          relativePath: "collision.txt",
          content: "same",
          maxBytes: 1024,
          replace: false,
          idempotencyKey: "write-collision",
        }),
        (error) => error instanceof SessionFileServiceError
          && error.code === "FILE_ALREADY_EXISTS"
          && error.effect === "not_applied",
      );
      await assert.rejects(stat(path.join(fixture.sessionFolder, "collision-temp")), /ENOENT/);
      await unlink(targetPath);
      await assert.rejects(
        service.writeText({
          sessionId: "session-a",
          relativePath: "collision.txt",
          content: "same",
          maxBytes: 1024,
          replace: false,
          idempotencyKey: "write-collision",
        }),
        (error) => error instanceof SessionFileServiceError
          && error.code === "FILE_ALREADY_EXISTS"
          && error.effect === "not_applied",
      );
      await assert.rejects(stat(targetPath), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-07: pending replaceは別writerの同内容targetをpublish proofとして扱わず再publishする", async () => {
    const fixture = await createFixture();
    const content = "same content";
    const relativePath = "replace-recovery.txt";
    const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      sessionId: "session-a",
      relativePath,
      contentSha256,
      replace: true,
    }), "utf8").digest("hex");
    const targetPath = path.join(fixture.sessionFolder, relativePath);
    try {
      fixture.storage.prepareSessionFileWrite({
        idempotencyKey: "write-replace-recovery",
        requestFingerprint,
        sessionId: "session-a",
        relativePath,
        tempName: ".withmate-session-write-replace-recovery.tmp",
        createdAt: "2026-08-11T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      });
      await writeFile(targetPath, content, "utf8");
      const unrelatedIdentity = await stat(targetPath);

      await assert.rejects(
        fixture.service.writeText({
          sessionId: "session-a",
          relativePath,
          content,
          maxBytes: 1024,
          replace: true,
          idempotencyKey: "write-replace-recovery",
        }),
        (error) => error instanceof SessionFileServiceError
          && error.retryable === false
          && error.effect === "not_applied",
      );

      const publishedIdentity = await stat(targetPath);
      assert.equal(await readFile(targetPath, "utf8"), content);
      assert.equal(publishedIdentity.ino, unrelatedIdentity.ino);
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-08: replace publish後のcompletion failureを同一identityのcanonical resultへ収束する", async () => {
    const fixture = await createFixture();
    let failCompletion = true;
    const service = new SessionFileService({
      storage: {
        getSessionSummary: (sessionId) => fixture.storage.getSessionSummary(sessionId),
        prepareSessionFileWrite: (input) => fixture.storage.prepareSessionFileWrite(input),
        recordPreparedSessionFileWrite: (input) => fixture.storage.recordPreparedSessionFileWrite(input),
        rejectSessionFileWrite: (input) => fixture.storage.rejectSessionFileWrite(input),
        completeSessionFileWrite: (input) => {
          if (failCompletion) {
            failCompletion = false;
            throw new Error("simulated replace completion loss");
          }
          return fixture.storage.completeSessionFileWrite(input);
        },
      },
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "replace-crash-temp",
    });
    const targetPath = path.join(fixture.sessionFolder, "replace-crash.txt");
    const input = {
      sessionId: "session-a",
      relativePath: "replace-crash.txt",
      content: "canonical replacement",
      maxBytes: 1024,
      replace: true,
      idempotencyKey: "write-replace-crash",
    };
    try {
      await writeFile(targetPath, "old", "utf8");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          service.writeText(input),
          (error) => error instanceof SessionFileServiceError
            && error.retryable === false
            && error.effect === "not_applied",
        );
      }
      assert.equal(failCompletion, true);
      assert.equal(await readFile(targetPath, "utf8"), "old");
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-09: prepared proofを永続化してからreplace publishする", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.sessionFolder, "prepared-first.txt");
    const input = {
      sessionId: "session-a",
      relativePath: "prepared-first.txt",
      content: "new content",
      maxBytes: 1024,
      replace: true,
      idempotencyKey: "write-prepared-first",
    };
    let observedPrepared = false;
    const service = new SessionFileService({
      storage: fixture.storage,
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "prepared-first-temp",
      onWritePrepared: async () => {
        const replay = fixture.storage.prepareSessionFileWrite({
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: createHash("sha256").update(JSON.stringify({
            sessionId: input.sessionId,
            relativePath: input.relativePath,
            contentSha256: createHash("sha256").update(input.content, "utf8").digest("hex"),
            replace: input.replace,
          }), "utf8").digest("hex"),
          sessionId: input.sessionId,
          relativePath: input.relativePath,
          tempName: "ignored",
          createdAt: "2026-08-12T00:00:00.000Z",
          expiresAt: "2026-08-13T00:00:00.000Z",
        });
        assert.equal(replay.kind, "pending");
        assert.notEqual(replay.kind === "pending" ? replay.prepared : null, null);
        assert.equal(await readFile(targetPath, "utf8"), "old content");
        observedPrepared = true;
      },
    });
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        service.writeText(input),
        (error) => error instanceof SessionFileServiceError
          && error.retryable === false
          && error.effect === "not_applied",
      );
      assert.equal(observedPrepared, false);
      assert.equal(await readFile(targetPath, "utf8"), "old content");
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-10: 既存targetのreplaceはcontent dispatch後でも副作用前にfail-closedにする", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.sessionFolder, "timeout-recovery.txt");
    let blockPrepared = true;
    const service = new SessionFileService({
      storage: fixture.storage,
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "timeout-recovery-temp",
      writeTimeoutMs: 1_000,
      onWritePrepared: () => {
        if (!blockPrepared) return;
        blockPrepared = false;
        return new Promise<void>(() => undefined);
      },
    });
    const input = {
      sessionId: "session-a",
      relativePath: "timeout-recovery.txt",
      content: "canonical content",
      maxBytes: 1024,
      replace: true,
      idempotencyKey: "write-timeout-recovery",
    };
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        service.writeText(input),
        (error) => error instanceof SessionFileServiceError
          && error.code === "RUNTIME_UNAVAILABLE"
          && error.retryable === false
          && error.effect === "not_applied",
      );
      assert.equal(blockPrepared, true);
      await writeFile(targetPath, "third-party content", "utf8");

      await assert.rejects(
        service.writeText(input),
        (error) => error instanceof SessionFileServiceError
          && error.code === "RUNTIME_UNAVAILABLE"
          && error.retryable === false
          && error.effect === "not_applied",
      );
      assert.equal(await readFile(targetPath, "utf8"), "third-party content");
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-11: 既存targetのreplaceではproof hookへ到達しない", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.sessionFolder, "proof-before-rename.txt");
    let stopAfterProof = true;
    const service = new SessionFileService({
      storage: fixture.storage,
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
      createTempName: () => "proof-before-rename-temp",
      onAfterReplaceProof: () => {
        if (!stopAfterProof) return;
        stopAfterProof = false;
        throw new Error("simulated proof response loss");
      },
    });
    const input = {
      sessionId: "session-a",
      relativePath: "proof-before-rename.txt",
      content: "canonical content",
      maxBytes: 1024,
      replace: true,
      idempotencyKey: "write-proof-before-rename",
    };
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        service.writeText(input),
        (error) => error instanceof SessionFileServiceError
          && error.code === "RUNTIME_UNAVAILABLE"
          && error.effect === "not_applied",
      );
      assert.equal(stopAfterProof, true);
      await writeFile(targetPath, "third-party content", "utf8");
      await assert.rejects(
        service.writeText(input),
        (error) => error instanceof SessionFileServiceError
          && error.code === "RUNTIME_UNAVAILABLE"
          && error.effect === "not_applied",
      );
      assert.equal(await readFile(targetPath, "utf8"), "third-party content");
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-12: 既存targetのreplaceはprepared保存前にfail-closedにする", async () => {
    let stopAfterPrepared = true;
    const fixture = await createFixture({
      onWritePrepared: () => {
        if (!stopAfterPrepared) return;
        stopAfterPrepared = false;
        throw new Error("simulated pre-proof stop");
      },
    });
    const targetPath = path.join(fixture.sessionFolder, "pre-proof.txt");
    const input = {
      sessionId: "session-a",
      relativePath: "pre-proof.txt",
      content: "new content",
      replace: true,
      idempotencyKey: "pre-proof-retry",
    };
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        fixture.service.writeText(input),
        (error) => error instanceof SessionFileServiceError
          && error.retryable === false
          && error.effect === "not_applied",
      );
      assert.equal(stopAfterPrepared, true);
      assert.equal(await readFile(targetPath, "utf8"), "old content");
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-13: 既存targetのreplaceはtarget claim前にfail-closedにする", async () => {
    let targetPath = "";
    let targetClaimed = false;
    const fixture = await createFixture({
      onAfterReplaceTargetClaim: () => {
        targetClaimed = true;
        writeFileSync(targetPath, "third-party content", "utf8");
      },
    });
    targetPath = path.join(fixture.sessionFolder, "claim-race.txt");
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        fixture.service.writeText({
          sessionId: "session-a",
          relativePath: "claim-race.txt",
          content: "new content",
          replace: true,
          idempotencyKey: "claim-race",
        }),
        (error) => error instanceof SessionFileServiceError
          && error.retryable === false
          && error.effect === "not_applied",
      );
      assert.equal(targetClaimed, false);
      assert.equal(await readFile(targetPath, "utf8"), "old content");
    } finally {
      fixture.storage.close();
      await rm(fixture.tempDirectory, { recursive: true, force: true });
    }
  });
});
