import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession } from "../../src/session-state.js";
import {
  SessionFileWriteIdempotencyConflictError,
  SessionStorageV6,
} from "../../src-electron/session-storage-v6.js";

describe("Session file write idempotency storage", () => {
  it("SF-WRITE-01: pendingとappliedとrejectedを再生し、異なるfingerprintを拒否する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-file-write-storage-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    try {
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
        workspacePath: path.join(tempDirectory, "session-files", "session-a"),
        branch: "",
        characterId: "character-a",
        character: "Character A",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: "workspace-write",
        model: "gpt-test",
        reasoningEffort: "high",
      }));

      const prepared = storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        createdAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      });
      assert.deepEqual(prepared, {
        kind: "pending",
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        resumed: false,
      });
      assert.deepEqual(storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "ignored-by-replay.md",
        tempName: "ignored-by-replay.tmp",
        createdAt: "2026-08-12T00:01:00.000Z",
        expiresAt: "2026-08-13T00:01:00.000Z",
      }), {
        ...prepared,
        resumed: true,
      });

      const result = { file: { sessionId: "session-a", relativePath: "notes/brief.md", byteLength: 5 } };
      assert.deepEqual(storage.completeSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        result,
        completedAt: "2026-08-12T00:02:00.000Z",
        expiresAt: "2026-08-13T00:02:00.000Z",
      }), result);
      assert.deepEqual(storage.prepareSessionFileWrite({
        idempotencyKey: "write-1",
        requestFingerprint: "fingerprint-1",
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        createdAt: "2026-08-12T00:02:00.000Z",
        expiresAt: "2026-08-13T00:02:00.000Z",
      }), {
        kind: "replay",
        sessionId: "session-a",
        relativePath: "notes/brief.md",
        tempName: ".withmate-write-temp-1",
        result,
      });
      assert.throws(
        () => storage.prepareSessionFileWrite({
          idempotencyKey: "write-1",
          requestFingerprint: "different",
          sessionId: "session-a",
          relativePath: "notes/other.md",
          tempName: ".withmate-write-temp-2",
          createdAt: "2026-08-12T00:03:00.000Z",
          expiresAt: "2026-08-13T00:03:00.000Z",
        }),
        SessionFileWriteIdempotencyConflictError,
      );

      storage.prepareSessionFileWrite({
        idempotencyKey: "write-rejected",
        requestFingerprint: "fingerprint-rejected",
        sessionId: "session-a",
        relativePath: "existing.md",
        tempName: ".withmate-write-rejected",
        createdAt: "2026-08-12T00:03:00.000Z",
        expiresAt: "2026-08-13T00:03:00.000Z",
      });
      const canonicalError = {
        code: "FILE_ALREADY_EXISTS",
        message: "The Session file already exists and replace was not enabled.",
        retryable: false,
        details: { relativePath: "existing.md" },
        effect: "not_applied",
      };
      assert.deepEqual(storage.rejectSessionFileWrite({
        idempotencyKey: "write-rejected",
        requestFingerprint: "fingerprint-rejected",
        error: canonicalError,
        completedAt: "2026-08-12T00:04:00.000Z",
        expiresAt: "2026-08-13T00:04:00.000Z",
      }), canonicalError);
      assert.deepEqual(storage.prepareSessionFileWrite({
        idempotencyKey: "write-rejected",
        requestFingerprint: "fingerprint-rejected",
        sessionId: "session-a",
        relativePath: "ignored.md",
        tempName: "ignored.tmp",
        createdAt: "2026-08-12T00:05:00.000Z",
        expiresAt: "2026-08-13T00:05:00.000Z",
      }), {
        kind: "rejected",
        sessionId: "session-a",
        relativePath: "existing.md",
        tempName: ".withmate-write-rejected",
        error: canonicalError,
      });
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("SF-WRITE-02: cleanupはterminal resultだけを期限切れにし、pendingはretry可能に保つ", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-file-write-cleanup-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    const storage = new SessionStorageV6(dbPath);
    try {
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
        workspacePath: tempDirectory,
        branch: "",
        characterId: "character-a",
        character: "Character A",
        approvalMode: DEFAULT_APPROVAL_MODE,
        codexSandboxMode: "workspace-write",
        model: "gpt-test",
        reasoningEffort: "high",
      }));
      for (const key of ["pending", "applied", "rejected"] as const) {
        storage.prepareSessionFileWrite({
          idempotencyKey: key,
          requestFingerprint: key,
          sessionId: "session-a",
          relativePath: `${key}.md`,
          tempName: `.${key}.tmp`,
          createdAt: "2026-08-10T00:00:00.000Z",
          expiresAt: "2026-08-11T00:00:00.000Z",
        });
      }
      storage.completeSessionFileWrite({
        idempotencyKey: "applied",
        requestFingerprint: "applied",
        result: { ok: true },
        completedAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      });
      storage.rejectSessionFileWrite({
        idempotencyKey: "rejected",
        requestFingerprint: "rejected",
        error: { code: "FILE_ALREADY_EXISTS" },
        completedAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      });

      assert.equal(storage.cleanupAppliedSessionFileWriteIdempotency("2026-08-12T00:00:00.000Z"), 0);
      assert.equal(storage.cleanupAppliedSessionFileWriteIdempotency("2026-08-13T00:00:00.000Z"), 2);
      assert.equal(storage.prepareSessionFileWrite({
        idempotencyKey: "pending",
        requestFingerprint: "pending",
        sessionId: "session-a",
        relativePath: "pending.md",
        tempName: ".pending.tmp",
        createdAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-13T00:00:00.000Z",
      }).kind, "pending");
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
