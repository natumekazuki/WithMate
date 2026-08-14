import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import {
  SessionTranscriptService,
  SessionTranscriptServiceError,
} from "../../src-electron/session-transcript-service.js";
import { SessionTranscriptStorageV6 } from "../../src-electron/session-transcript-storage-v6.js";
import {
  PUBLIC_TRANSCRIPT_SCHEMA_VERSION,
  SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES,
  SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES,
} from "../../src/session-transcript.js";

const CREATED_AT = "2026-08-13T00:00:00.000Z";
const EARLIER_AT = "2026-08-12T00:00:00.000Z";

async function createFixture(options: {
  onBeforePublish?(): void;
  onAfterReplaceProof?(): void;
  onAfterReplaceTargetClaim?(): void;
  onAfterReplaceRename?(): void;
  onAfterPublish?(): void;
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-transcript-"));
  const sessionFolder = path.join(directory, "session-files", "session-1");
  await mkdir(sessionFolder, { recursive: true });
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, session_kind, provider_id, catalog_revision, model_id,
        reasoning_effort, approval_mode, workspace_path, created_at, updated_at, last_active_at
      ) VALUES (?, ?, 'active', 'default', 'codex', 7, 'gpt-public', 'high', 'on-request', ?, ?, ?, ?)
    `).run("session-1", "Public session", sessionFolder, CREATED_AT, CREATED_AT, CREATED_AT);
    db.prepare(`
      INSERT INTO session_messages_v6 (session_id, seq, role, body, created_at)
      VALUES (?, 0, 'user', ?, ?), (?, 1, 'assistant', ?, ?)
    `).run(
      "session-1",
      JSON.stringify({ role: "user", text: "Hello" }),
      CREATED_AT,
      "session-1",
      JSON.stringify({ role: "assistant", text: "World" }),
      CREATED_AT,
    );
    db.prepare(`
      INSERT INTO session_turns_v6 (
        session_id, phase, provider_id, model_id, reasoning_effort, approval_mode,
        sandbox_mode, thread_id, started_at, completed_at, updated_at
      ) VALUES (?, 'completed', 'codex', 'legacy-model', 'medium', 'never',
        'workspace-write', 'private-thread-id', ?, ?, ?)
    `).run("session-1", CREATED_AT, CREATED_AT, CREATED_AT);
    db.prepare(`
      INSERT INTO session_turns_v6 (
        session_id, phase, provider_id, model_id, reasoning_effort, approval_mode,
        sandbox_mode, thread_id, started_at, completed_at, updated_at
      ) VALUES (?, 'completed', 'codex', 'do-not-infer', 'low', 'never',
        'danger-full-access', 'legacy-private-thread', ?, ?, ?)
    `).run("session-1", EARLIER_AT, CREATED_AT, CREATED_AT);
    db.prepare(`
      INSERT INTO session_turn_provider_outputs_v6 (
        turn_id, seq, provider_id, kind, summary, payload_json, created_at
      ) VALUES (1, 0, 'codex', 'raw_items', 'raw private summary', ?, ?)
    `).run(JSON.stringify({ requestId: "provider-request-secret", stack: "private-stack" }), CREATED_AT);
    db.prepare(`
      INSERT INTO session_executions_v6 (
        id, session_id, operation, state, request_json, result_json,
        created_at, admitted_at, completed_at, updated_at
      ) VALUES (?, ?, 'turn.run', 'completed', ?, ?, ?, ?, ?, ?)
    `).run(
      "execution-1",
      "session-1",
      JSON.stringify({
        catalogRevision: 7,
        turn: {
          provider: "codex",
          userMessage: "not duplicated in turn context",
          model: "gpt-public",
          reasoningEffort: "high",
          approvalMode: "on-request",
          codexSandboxMode: "workspace-write",
          attachments: [{ kind: "file", relativePath: "brief.md", absolutePath: "C:/private/brief.md" }],
          requestId: "private-request-id",
          token: "private-token",
        },
      }),
      JSON.stringify({ assistantText: "terminal text", providerRaw: "private-provider-raw" }),
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    );
    db.prepare(`
      INSERT INTO session_execution_public_progress_v6 (
        execution_id, assistant_text, truncated, updated_at
      ) VALUES (?, ?, 0, ?)
    `).run("execution-1", "public partial", CREATED_AT);
    db.prepare(`
      INSERT INTO session_interactions_v6 (
        id, execution_id, kind, state, public_payload_json, response_action,
        response_submitted_fields_json, response_fingerprint, created_at, resolved_at, updated_at
      ) VALUES (?, ?, 'elicitation', 'answered', ?, 'accept', ?, ?, ?, ?, ?)
    `).run(
      "interaction-1",
      "execution-1",
      JSON.stringify({
        prompt: "Choose a value",
        fields: [{ name: "token", title: "Token", type: "text", required: true, value: "secret-value" }],
        requestId: "interaction-private-request",
        absolutePath: "C:/private",
      }),
      JSON.stringify(["token"]),
      "private-response-fingerprint",
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    );
  } finally {
    db.close();
  }
  const storage = new SessionTranscriptStorageV6(dbPath);
  storage.upsertPublicTurnContext({
    turnId: 1,
    sessionId: "session-1",
    executionId: "execution-1",
    effectiveOptions: {
      provider: "codex",
      model: "gpt-public",
      reasoningEffort: "high",
      approvalMode: "on-request",
      sandboxMode: "workspace-write",
      customAgentName: null,
    },
    attachments: [{ kind: "file", relativePath: "brief.md" }],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const service = new SessionTranscriptService({
    storage,
    resolveSessionFilesDirectory: () => sessionFolder,
    now: () => new Date(CREATED_AT),
    createTempName: () => "test-temp",
    ...options,
  });
  return { directory, dbPath, sessionFolder, storage, service };
}

function inlineInput(format: "json" | "markdown", maxBytes = 1024 * 1024) {
  return {
    sessionId: "session-1",
    format,
    maxBytes,
    destination: { kind: "inline" as const },
  };
}

function folderInput(overrides: Partial<{
  relativePath: string;
  replace: boolean;
  idempotencyKey: string;
  maxBytes: number;
}> = {}) {
  return {
    sessionId: "session-1",
    format: "json" as const,
    maxBytes: overrides.maxBytes ?? 64 * 1024 * 1024,
    destination: {
      kind: "session_folder" as const,
      relativePath: overrides.relativePath ?? "exports/transcript.json",
      replace: overrides.replace ?? false,
      idempotencyKey: overrides.idempotencyKey ?? "export-1",
    },
  };
}

async function assertNoTranscriptTemp(directory: string): Promise<void> {
  try {
    assert.equal((await readdir(directory)).some((name) => name.includes("test-temp")), false);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  }
}

describe("SessionTranscriptService", () => {
  it("EXT-TRANSCRIPT-13: canonical JSONを固定順・UTF-8末尾LFで作りprivate値を投影しない", async () => {
    const fixture = await createFixture();
    try {
      const result = await fixture.service.export(inlineInput("json"));
      assert.equal(result.destination, "inline");
      if (result.destination !== "inline") return;
      assert.equal(result.content.charCodeAt(0) === 0xfeff, false);
      assert.equal(result.content.endsWith("\n"), true);
      assert.equal(Buffer.byteLength(result.content, "utf8"), result.byteLength);
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), ["schemaVersion", "completeness", "session", "messages", "turns", "interactions"]);
      assert.equal(parsed.interactions[0]?.fields[0]?.label, "Token");
      assert.equal(parsed.schemaVersion, PUBLIC_TRANSCRIPT_SCHEMA_VERSION);
      assert.equal(parsed.completeness, "legacy_partial");
      const turns = parsed.turns as Array<Record<string, unknown>>;
      assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2]);
      assert.equal(turns.some((turn) => turn.projectionCompleteness === "complete"
        && turn.executionId === "execution-1"), true);
      assert.equal(turns.some((turn) => turn.projectionCompleteness === "legacy_partial"
        && turn.executionId === null
        && turn.effectiveOptions === null), true);
      const serialized = JSON.stringify(parsed);
      for (const privateValue of [
        "private-thread-id",
        "provider-request-secret",
        "private-stack",
        "private-request-id",
        "private-token",
        "private-provider-raw",
        "interaction-private-request",
        "C:/private",
        "secret-value",
        "private-response-fingerprint",
      ]) {
        assert.equal(serialized.includes(privateValue), false, privateValue);
      }
      assert.equal(serialized.includes("brief.md"), true);
      assert.equal(serialized.includes("public partial"), true);
      assert.equal(serialized.includes("Choose a value"), true);
      assert.equal(serialized.includes('"submittedFields":["token"]'), true);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-TRANSCRIPT-13: Markdownをcanonical public JSON projectionだけから派生する", async () => {
    const fixture = await createFixture();
    try {
      const jsonResult = await fixture.service.export(inlineInput("json"));
      const markdownResult = await fixture.service.export(inlineInput("markdown"));
      assert.equal(jsonResult.destination, "inline");
      assert.equal(markdownResult.destination, "inline");
      if (jsonResult.destination !== "inline" || markdownResult.destination !== "inline") return;
      const match = markdownResult.content.match(/<pre><code class="language-json">([\s\S]+)<\/code><\/pre>\n$/);
      assert.ok(match);
      const embeddedJson = match[1]
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&");
      assert.deepEqual(JSON.parse(embeddedJson), JSON.parse(jsonResult.content));
      assert.equal(markdownResult.content.endsWith("\n"), true);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: inlineはexact UTF-8 limitを許可し超過時は切り詰めず拒否する", async () => {
    const fixture = await createFixture();
    try {
      const baseline = await fixture.service.export(inlineInput("json"));
      assert.equal(baseline.destination, "inline");
      if (baseline.destination !== "inline") return;
      const exact = await fixture.service.export(inlineInput("json", baseline.byteLength));
      assert.deepEqual(exact, baseline);
      await assert.rejects(
        fixture.service.export(inlineInput("json", baseline.byteLength - 1)),
        (error) => error instanceof SessionTranscriptServiceError && error.code === "CONTENT_TOO_LARGE",
      );
      assert.throws(
        () => fixture.service.export(inlineInput("json", SESSION_TRANSCRIPT_INLINE_HARD_MAX_BYTES + 1)),
        (error) => error instanceof SessionTranscriptServiceError && error.code === "LIMIT_EXCEEDED",
      );
      assert.throws(
        () => fixture.service.export(folderInput({ maxBytes: SESSION_TRANSCRIPT_FOLDER_HARD_MAX_BYTES + 1 })),
        (error) => error instanceof SessionTranscriptServiceError && error.code === "LIMIT_EXCEEDED",
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: SessionFolderへsame-directory atomic publishしreplayとconflictを収束する", async () => {
    const fixture = await createFixture();
    try {
      const input = folderInput();
      const first = await fixture.service.export(input);
      const replay = await fixture.service.export(input);
      assert.deepEqual(replay, first);
      assert.equal(first.destination, "session_folder");
      if (first.destination !== "session_folder") return;
      const bytes = await readFile(path.join(fixture.sessionFolder, first.file.relativePath));
      const inline = await fixture.service.export(inlineInput("json"));
      assert.equal(inline.destination, "inline");
      if (inline.destination !== "inline") return;
      assert.equal(bytes.toString("utf8"), inline.content);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), first.file.sha256);
      assert.equal(bytes.byteLength, first.file.byteLength);
      assert.equal((await readdir(path.join(fixture.sessionFolder, "exports"))).some((name) => name.includes("test-temp")), true);
      await assert.rejects(
        fixture.service.export(folderInput({ relativePath: "other.json" })),
        (error) => error instanceof SessionTranscriptServiceError && error.code === "IDEMPOTENCY_CONFLICT",
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: SessionFolder exportはfull projectionをhydrateせずrow iteratorからstreamする", async () => {
    const fixture = await createFixture();
    const service = new SessionTranscriptService({
      storage: {
        readBaseProjection: () => {
          throw new Error("full projection must not be hydrated");
        },
        readBaseProjectionStream: (sessionId) => fixture.storage.readBaseProjectionStream(sessionId),
        prepareExport: (input) => fixture.storage.prepareExport(input),
        recordPreparedOutput: (input) => fixture.storage.recordPreparedOutput(input),
        completeExport: (input) => fixture.storage.completeExport(input),
        rejectExport: (input) => fixture.storage.rejectExport(input),
      },
      resolveSessionFilesDirectory: () => fixture.sessionFolder,
      now: () => new Date(CREATED_AT),
      createTempName: () => "stream-temp",
    });
    try {
      const result = await service.export(folderInput({ idempotencyKey: "streaming" }));
      assert.equal(result.destination, "session_folder");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: SessionFolder limit超過はdestinationを作らずtemp proofを保持してterminal rejectionへ収束する", async () => {
    const fixture = await createFixture();
    const input = folderInput({ idempotencyKey: "too-large", maxBytes: 1 });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          fixture.service.export(input),
          (error) => error instanceof SessionTranscriptServiceError
            && error.code === "CONTENT_TOO_LARGE"
            && error.effect === "not_applied",
        );
      }
      const exportDirectory = path.join(fixture.sessionFolder, "exports");
      assert.deepEqual(await readdir(exportDirectory), [".withmate-transcript-export-test-temp.tmp"]);
      await assert.rejects(readFile(path.join(exportDirectory, "transcript.json")), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: operation-owned temp名のcollisionは既存fileを保持してfail-closedにする", async () => {
    const fixture = await createFixture();
    const exportDirectory = path.join(fixture.sessionFolder, "exports");
    const tempPath = path.join(exportDirectory, ".withmate-transcript-export-test-temp.tmp");
    try {
      await mkdir(exportDirectory, { recursive: true });
      await writeFile(tempPath, "third-party content", "utf8");
      await assert.rejects(
        fixture.service.export(folderInput({ idempotencyKey: "temp-collision" })),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "PATH_OUTSIDE_SESSION_FOLDER"
          && error.effect === "not_applied",
      );
      assert.equal(await readFile(tempPath, "utf8"), "third-party content");
      await assert.rejects(readFile(path.join(exportDirectory, "transcript.json")), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: publish後のresponse lossをhard-link proofから同一fileへ回復する", async () => {
    let failAfterPublish = true;
    const fixture = await createFixture({
      onAfterPublish: () => {
        if (failAfterPublish) {
          failAfterPublish = false;
          throw new Error("simulated response loss");
        }
      },
    });
    const input = folderInput({ idempotencyKey: "response-loss" });
    try {
      await assert.rejects(fixture.service.export(input), /simulated response loss/);
      const targetPath = path.join(fixture.sessionFolder, "exports", "transcript.json");
      const firstIdentity = await stat(targetPath);
      const recovered = await fixture.service.export(input);
      const recoveredIdentity = await stat(targetPath);
      assert.equal(recovered.destination, "session_folder");
      assert.equal(recoveredIdentity.ino, firstIdentity.ino);
      assert.equal((await readdir(path.dirname(targetPath))).some((name) => name.includes("test-temp")), true);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: 既存targetのreplaceはrename前にfail-closedにする", async () => {
    let failAfterRename = true;
    const fixture = await createFixture({
      onAfterReplaceRename: () => {
        if (failAfterRename) {
          failAfterRename = false;
          throw new Error("simulated rename response loss");
        }
      },
    });
    const targetPath = path.join(fixture.sessionFolder, "existing.json");
    const input = folderInput({
      relativePath: "existing.json",
      replace: true,
      idempotencyKey: "replace-response-loss",
    });
    try {
      await writeFile(targetPath, "old content", "utf8");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          fixture.service.export(input),
          (error) => error instanceof SessionTranscriptServiceError
            && error.code === "EXPORT_FAILED"
            && error.retryable === false
            && error.effect === "not_applied",
        );
      }
      assert.equal(failAfterRename, true);
      assert.equal(await readFile(targetPath, "utf8"), "old content");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: 既存targetのreplace拒否後も第三者変更を上書きしない", async () => {
    let failAfterRename = true;
    const fixture = await createFixture({
      onAfterReplaceRename: () => {
        if (failAfterRename) {
          failAfterRename = false;
          throw new Error("simulated rename response loss");
        }
      },
    });
    const targetPath = path.join(fixture.sessionFolder, "changed-after-publish.json");
    const input = folderInput({
      relativePath: "changed-after-publish.json",
      replace: true,
      idempotencyKey: "replace-target-changed",
    });
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        fixture.service.export(input),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "EXPORT_FAILED"
          && error.effect === "not_applied",
      );
      assert.equal(failAfterRename, true);
      await writeFile(targetPath, "third-party content", "utf8");
      await assert.rejects(
        fixture.service.export(input),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "EXPORT_FAILED"
          && error.effect === "not_applied",
      );
      assert.equal(await readFile(targetPath, "utf8"), "third-party content");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: 既存targetのreplaceはproof作成前にfail-closedにする", async () => {
    let stopAfterProof = true;
    const fixture = await createFixture({
      onAfterReplaceProof: () => {
        if (!stopAfterProof) return;
        stopAfterProof = false;
        throw new Error("simulated proof response loss");
      },
    });
    const targetPath = path.join(fixture.sessionFolder, "proof-before-rename.json");
    const input = folderInput({
      relativePath: "proof-before-rename.json",
      replace: true,
      idempotencyKey: "replace-proof-before-rename",
    });
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        fixture.service.export(input),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "EXPORT_FAILED"
          && error.effect === "not_applied",
      );
      assert.equal(stopAfterProof, true);
      await writeFile(targetPath, "third-party content", "utf8");
      await assert.rejects(
        fixture.service.export(input),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "EXPORT_FAILED"
          && error.effect === "not_applied",
      );
      assert.equal(await readFile(targetPath, "utf8"), "third-party content");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: 既存targetのreplaceはprepared保存前にfail-closedにする", async () => {
    let stopAfterPrepared = true;
    const fixture = await createFixture({
      onBeforePublish: () => {
        if (!stopAfterPrepared) return;
        stopAfterPrepared = false;
        throw new Error("simulated pre-proof stop");
      },
    });
    const targetPath = path.join(fixture.sessionFolder, "pre-proof.json");
    const input = folderInput({ relativePath: "pre-proof.json", replace: true, idempotencyKey: "pre-proof-retry" });
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        fixture.service.export(input),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "EXPORT_FAILED"
          && error.effect === "not_applied",
      );
      assert.equal(stopAfterPrepared, true);
      assert.equal(await readFile(targetPath, "utf8"), "old content");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: 既存targetのreplaceはtarget claim前にfail-closedにする", async () => {
    let targetPath = "";
    let targetClaimed = false;
    const fixture = await createFixture({
      onAfterReplaceTargetClaim: () => {
        targetClaimed = true;
        writeFileSync(targetPath, "third-party content", "utf8");
      },
    });
    targetPath = path.join(fixture.sessionFolder, "claim-race.json");
    const input = folderInput({ relativePath: "claim-race.json", replace: true, idempotencyKey: "claim-race" });
    try {
      await writeFile(targetPath, "old content", "utf8");
      await assert.rejects(
        fixture.service.export(input),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "EXPORT_FAILED"
          && error.effect === "not_applied",
      );
      assert.equal(targetClaimed, false);
      assert.equal(await readFile(targetPath, "utf8"), "old content");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-TRANSCRIPT-13: parent identity failureではpath unlinkせずoperation proofを保持する", async () => {
    let originalParent = "";
    let movedParent = "";
    const fixture = await createFixture({
      onAfterReplaceRename: () => {
        renameSync(originalParent, movedParent);
        mkdirSync(originalParent);
      },
    });
    const input = folderInput({
      relativePath: "exports/transcript.json",
      replace: true,
      idempotencyKey: "replace-parent-identity-failure",
    });
    originalParent = path.join(fixture.sessionFolder, "exports");
    movedParent = path.join(fixture.sessionFolder, "exports-moved");
    try {
      await assert.rejects(
        fixture.service.export(input),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "PATH_OUTSIDE_SESSION_FOLDER"
          && error.retryable,
      );
      const retainedInOriginal = (await readdir(originalParent)).some((name) => name.includes("test-temp"));
      assert.equal(retainedInOriginal, true);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: replace=falseは既存fileを変更せずterminal rejectionを再生する", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.sessionFolder, "existing.json");
    try {
      await writeFile(targetPath, "original", "utf8");
      const input = folderInput({ relativePath: "existing.json", idempotencyKey: "existing" });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          fixture.service.export(input),
          (error) => error instanceof SessionTranscriptServiceError
            && error.code === "FILE_ALREADY_EXISTS"
            && error.effect === "not_applied",
        );
      }
      assert.equal(await readFile(targetPath, "utf8"), "original");
      assert.equal((await readdir(fixture.sessionFolder)).some((name) => name.includes("test-temp")), false);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-EXPORT-14: byte limit後のroot identity差し替えをpublish前に拒否する", async () => {
    let originalFolder = "";
    let movedFolder = "";
    const fixture = await createFixture({
      onBeforePublish: () => {
        renameSync(originalFolder, movedFolder);
        mkdirSync(originalFolder);
      },
    });
    originalFolder = path.join(fixture.sessionFolder, "exports");
    movedFolder = path.join(fixture.sessionFolder, "exports-moved");
    try {
      await assert.rejects(
        fixture.service.export(folderInput({ idempotencyKey: "identity-change" })),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "PATH_OUTSIDE_SESSION_FOLDER",
      );
      await assert.rejects(readFile(path.join(originalFolder, "transcript.json")), /ENOENT/);
      await assert.rejects(readFile(path.join(movedFolder, "transcript.json")), /ENOENT/);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-TRANSCRIPT-13: identity bound後かつpublish直前の外部symlink差し替えへpublishしない", async () => {
    let originalParent = "";
    let movedParent = "";
    let attackerParent = "";
    const fixture = await createFixture({
      onBeforePublish: () => {
        mkdirSync(attackerParent);
        renameSync(originalParent, movedParent);
        symlinkSync(attackerParent, originalParent, process.platform === "win32" ? "junction" : "dir");
      },
    });
    originalParent = path.join(fixture.sessionFolder, "exports");
    movedParent = path.join(fixture.sessionFolder, "exports-bound-moved");
    attackerParent = path.join(fixture.directory, "attacker-directory");
    try {
      await assert.rejects(
        fixture.service.export(folderInput({ idempotencyKey: "parent-symlink-same-inode" })),
        (error) => error instanceof SessionTranscriptServiceError
          && error.code === "PATH_OUTSIDE_SESSION_FOLDER"
          && error.retryable,
      );
      await assert.rejects(readFile(path.join(attackerParent, "transcript.json")), /ENOENT/);
      await assertNoTranscriptTemp(attackerParent);
      await assert.rejects(readFile(path.join(movedParent, "transcript.json")), /ENOENT/);
      await assertNoTranscriptTemp(movedParent);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
