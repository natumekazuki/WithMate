import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { UNKNOWN_CHARACTER_OWNER_ID } from "../../src/character/character-owner.js";
import { buildNewSession, type MessageArtifact } from "../../src/session-state.js";
import { resolveCharacterAuthoringRuntimeSessionForTurn } from "../../src-electron/character-authoring-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

async function removeDirectoryWithRetry(targetPath: string, attempts = 5): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const isBusyError = typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY";
      if (!isBusyError || index === attempts - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50 * (index + 1)));
    }
  }
}

function createArtifact(): MessageArtifact {
  return {
    title: "Run result",
    activitySummary: ["edited file"],
    operationTimeline: [
      {
        type: "tool",
        summary: "apply patch",
        details: "large operation details",
      },
    ],
    changedFiles: [
      {
        kind: "edit",
        path: "src/example.ts",
        summary: "updated example",
        diffRows: [
          {
            kind: "add",
            rightNumber: 1,
            rightText: "const value = true;",
          },
        ],
      },
    ],
    runChecks: [{ label: "npm test", value: "pass" }],
  };
}

function createCharacterRuntimeSnapshot(
  characterId: string,
  name: string,
): CharacterRuntimeSnapshot {
  return {
    characterId,
    name,
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    definitionMarkdown: `# Character\n${name}`,
    definitionSha256: `${characterId}-sha256`,
    definitionByteSize: name.length,
    snapshotAt: "2026-08-01T00:00:00.000Z",
  };
}

function insertCharacterRows(dbPath: string, characterIds: readonly string[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const characterId of characterIds) {
      insert.run(
        characterId,
        characterId,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
    }
  } finally {
    db.close();
  }
}

function insertAuxiliarySessionRows(dbPath: string, rows: Array<{ id: string; parentSessionId: string }>): void {
  const db = new DatabaseSync(dbPath);
  try {
    const statement = db.prepare(`
      INSERT INTO auxiliary_sessions (
        id,
        parent_session_id,
        status,
        created_at,
        updated_at,
        payload_json
      ) VALUES (?, ?, 'active', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '{}')
    `);
    for (const row of rows) {
      statement.run(row.id, row.parentSessionId);
    }
  } finally {
    db.close();
  }
}

function insertCompanionSessionRows(dbPath: string, rows: Array<{ id: string; status: string }>): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS companion_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      )
    `);
    const statement = db.prepare("INSERT INTO companion_sessions (id, status) VALUES (?, ?)");
    for (const row of rows) {
      statement.run(row.id, row.status);
    }
  } finally {
    db.close();
  }
}

function listAuxiliarySessionParentIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT parent_session_id AS parentSessionId
      FROM auxiliary_sessions
      ORDER BY parent_session_id ASC
    `).all() as Array<{ parentSessionId: string }>;
    return rows.map((row) => row.parentSessionId);
  } finally {
    db.close();
  }
}

function insertSessionTurnRows(
  dbPath: string,
  rows: Array<{
    sessionId?: string | null;
    auxiliarySessionId?: string | null;
    summary: string;
  }>,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    const statement = db.prepare(`
      INSERT INTO session_turns_v6 (
        session_id,
        auxiliary_session_id,
        provider_id,
        phase,
        summary,
        started_at,
        updated_at
      ) VALUES (?, ?, 'codex', 'completed', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
    `);
    for (const row of rows) {
      statement.run(
        row.sessionId ?? null,
        row.auxiliarySessionId ?? null,
        row.summary,
      );
    }
  } finally {
    db.close();
  }
}

function listSessionTurnSummaries(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT summary
      FROM session_turns_v6
      ORDER BY summary ASC
    `).all() as Array<{ summary: string }>;
    return rows.map((row) => row.summary);
  } finally {
    db.close();
  }
}

describe("SessionStorageV6", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "Main SessionのReviewerは新規作成でUserになり、V6 runtime policyでroundtripし未知値はUserへ正規化される"
  // oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-2" }
  // failure_mode = "Auto-review選択が再起動で消える、新規値がUser以外になる、または未知値がAuto-reviewへ昇格する"
  // scope = "session-storage-v6"
  // lifecycle = "permanent"
  // @end-test-value
  it("ReviewerをV6 runtime policyでroundtripし新規・未知値をUserとして読む", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-speed-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const fastSession = storage.insertSession(buildNewSession({
        id: "fast-session",
        taskTitle: "Fast session",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        codexSpeed: "fast",
        codexReviewer: "auto-review",
      }));
      const legacySession = storage.insertSession(buildNewSession({
        id: "legacy-session",
        taskTitle: "Legacy session",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      }));
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions_v6 SET runtime_policy_json = json_set(runtime_policy_json, '$.codexReviewer', 'unexpected') WHERE id = ?").run(legacySession.id);
      db.close();

      storage = new SessionStorageV6(dbPath);
      assert.equal(storage.getSession(fastSession.id)?.codexSpeed, "fast");
      assert.equal(storage.getSession(legacySession.id)?.codexSpeed, "standard");
      assert.equal(storage.getSession(fastSession.id)?.codexReviewer, "auto-review");
      assert.equal(storage.getSession(legacySession.id)?.codexReviewer, "user");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("pin stateだけを更新し、updatedAtと本文を維持して再読込できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = storage.insertSession({
        ...buildNewSession({
          id: "pin-session",
          taskTitle: "Pin session",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        updatedAt: "2026-08-09T04:38:00.000Z",
        messages: [{ role: "user", text: "keep me" }],
      });

      const pinned = storage.setSessionPinned(session.id, true);
      assert.equal(pinned.isPinned, true);
      assert.equal(pinned.updatedAt, session.updatedAt);
      assert.equal(storage.getSession(session.id)?.messages[0]?.text, "keep me");
      storage.upsertSession({ ...session, taskTitle: "Updated title", isPinned: false });
      assert.equal(storage.getSession(session.id)?.isPinned, true);

      storage.close();
      storage = new SessionStorageV6(dbPath);
      assert.equal(storage.getSession(session.id)?.isPinned, true);
      assert.equal(storage.setSessionPinned(session.id, false).isPinned, false);
      assert.throws(() => storage?.setSessionPinned("missing", true), /見つからない/);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("summary page は keyset境界、検索、pinned/open projection、Character usageをboundedに扱う", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "Workspace Label",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const insert = (
        id: string,
        taskTitle: string,
        updatedAt: string,
        characterId = "char-a",
        sessionKind: "default" | "character-authoring" = "default",
      ) => storage?.insertSession({
        ...buildNewSession({ ...baseInput, id, taskTitle, characterId, sessionKind }),
        updatedAt,
      });

      insert("same-a", "100% literal", "2026-08-10T00:00:00.000Z");
      insert("same-b", "underscore_value", "2026-08-10T00:00:00.000Z");
      insert("older", "Older", "2026-08-09T00:00:00.000Z", "char-b");
      insert("new-character", "Character history", "2026-08-11T00:00:00.000Z", "char-b");
      insert("old-character", "Old character history", "2026-08-08T00:00:00.000Z", "char-a");
      insert("authoring", "Authoring history", "2026-08-12T00:00:00.000Z", "char-a", "character-authoring");
      storage?.setSessionPinned("older", true);

      const firstPage = storage?.listSessionSummaryPage({ scope: "recent", limit: 2 });
      assert.deepEqual(firstPage?.entries.map((entry) => entry.id), ["authoring", "new-character"]);
      assert.equal(firstPage?.hasMore, true);
      assert.ok(firstPage?.nextCursor);
      const secondPage = storage?.listSessionSummaryPage({ scope: "recent", limit: 2, cursor: firstPage?.nextCursor });
      assert.deepEqual(secondPage?.entries.map((entry) => entry.id), ["same-b", "same-a"]);
      assert.deepEqual(
        new Set([...(firstPage?.entries ?? []), ...(secondPage?.entries ?? [])].map((entry) => entry.id)).size,
        4,
      );

      const literalPercent = storage?.listSessionSummaryPage({ scope: "recent", searchText: "%", limit: 10 });
      assert.deepEqual(literalPercent?.entries.map((entry) => entry.id), ["same-a"]);
      const literalUnderscore = storage?.listSessionSummaryPage({ scope: "recent", searchText: "_", limit: 10 });
      assert.deepEqual(literalUnderscore?.entries.map((entry) => entry.id), ["same-b"]);
      assert.throws(
        () => storage?.listSessionSummaryPage({ scope: "recent", cursor: firstPage?.nextCursor, searchText: "changed" }),
        /一致しません/,
      );

      const pinnedPage = storage?.listSessionSummaryPage({ scope: "pinned" });
      assert.deepEqual(pinnedPage?.entries.map((entry) => entry.id), ["older"]);
      const openPage = storage?.listSessionSummaryPage({
        scope: "open",
        sessionIds: ["older", "same-a", "missing", "older"],
        searchText: "",
      });
      assert.deepEqual(openPage?.entries.map((entry) => entry.id).sort(), ["older", "same-a"]);
      assert.equal(openPage?.entries.length, 2);
      assert.equal(openPage?.hasMore, false);
      assert.equal(openPage?.nextCursor, null);
      assert.deepEqual(Object.keys(openPage?.entries[0] ?? {}).sort(), [
        "accessMode",
        "character",
        "characterIconPath",
        "characterId",
        "characterThemeColors",
        "id",
        "isPinned",
        "runState",
        "sessionKind",
        "sourceSchemaVersion",
        "status",
        "taskTitle",
        "updatedAt",
        "workspaceLabel",
        "workspacePath",
      ]);
      assert.equal("provider" in (openPage?.entries[0] ?? {}), false);
      assert.equal("threadId" in (openPage?.entries[0] ?? {}), false);
      assert.throws(
        () => storage?.listSessionSummaryPage({ scope: "open", sessionIds: ["older", "same-a"], limit: 1 }),
        /ID数以上/,
      );

      assert.deepEqual(storage?.listSessionCharacterUsage().map((entry) => entry.characterId), ["char-b", "char-a"]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("snapshot を作れない Character authoring Session も修復対象 ID を round-trip する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = buildNewSession({
        id: "repair-muse",
        taskTitle: "Muse の character.md 改善",
        workspaceLabel: "Muse authoring",
        workspacePath: "C:/characters/muse",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "muse",
        character: "Muse",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        characterRuntimeSnapshot: null,
        approvalMode: DEFAULT_APPROVAL_MODE,
      });

      storage.insertSession(session);
      storage.close();
      storage = new SessionStorageV6(dbPath);

      const reloaded = storage.getSession(session.id);
      assert.ok(reloaded);
      assert.equal(reloaded.characterId, "muse");
      assert.equal(reloaded.character, "Muse");
      assert.equal(reloaded.characterRuntimeSnapshot, null);

      const resolvedCharacterIds: string[] = [];
      const resolved = resolveCharacterAuthoringRuntimeSessionForTurn(reloaded, (characterId) => {
        resolvedCharacterIds.push(characterId);
        return {
          ...createCharacterRuntimeSnapshot(characterId, "Muse repaired"),
          description: "修復済み",
        };
      });

      assert.deepEqual(resolvedCharacterIds, ["muse"]);
      assert.equal(resolved.characterId, "muse");
      assert.equal(resolved.characterRuntimeSnapshot?.characterId, "muse");
      assert.equal(resolved.character, "Muse repaired");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("snapshot を作れない通常 Session も stable Character ID を round-trip する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const session = buildNewSession({
        id: "default-invalid-muse",
        taskTitle: "Muse session",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "muse-id",
        character: "Muse Display",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        characterRuntimeSnapshot: null,
        approvalMode: DEFAULT_APPROVAL_MODE,
      });

      storage.insertSession(session);
      storage.close();
      storage = new SessionStorageV6(dbPath);

      const reloaded = storage.getSession(session.id);
      assert.ok(reloaded);
      assert.equal(reloaded.sessionKind, "default");
      assert.equal(reloaded.characterId, "muse-id");
      assert.equal(reloaded.character, "Muse Display");
      assert.equal(reloaded.characterRuntimeSnapshot, null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("legacy row の owner を trim し、欠損時は表示名や snapshot から推測しない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse"]);
      const sessions = [
        buildNewSession({
          id: "whitespace-runtime-owner",
          taskTitle: "Whitespace owner",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "muse",
          character: "Muse Display",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          characterRuntimeSnapshot: null,
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        {
          ...buildNewSession({
            id: "missing-runtime-owner",
            taskTitle: "Missing owner",
            workspaceLabel: "workspace",
            workspacePath: "C:/workspace",
            branch: "main",
            characterId: "muse",
            character: "Display Name",
            characterIconPath: "",
            characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
            characterRuntimeSnapshot: null,
            approvalMode: DEFAULT_APPROVAL_MODE,
          }),
          threadId: "thread-missing-owner",
        },
        {
          ...buildNewSession({
            id: "snapshot-only-owner",
            taskTitle: "Snapshot only owner",
            workspaceLabel: "workspace",
            workspacePath: "C:/workspace",
            branch: "main",
            characterId: "muse",
            character: "Snapshot Display",
            characterIconPath: "",
            characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
            characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Snapshot Display"),
            approvalMode: DEFAULT_APPROVAL_MODE,
          }),
          threadId: "thread-snapshot-only",
        },
      ];
      sessions.forEach((session) => storage?.insertSession(session));
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      const updateOwner = db.prepare(`
        UPDATE sessions_v6
        SET character_id = NULL,
            runtime_policy_json = ?
        WHERE id = ?
      `);
      updateOwner.run(JSON.stringify({
        characterId: " muse ",
        characterName: "Muse Display",
      }), "whitespace-runtime-owner");
      updateOwner.run(JSON.stringify({
        characterName: "Display Name",
      }), "missing-runtime-owner");
      updateOwner.run(JSON.stringify({
        characterName: "Snapshot Display",
      }), "snapshot-only-owner");
      db.close();

      storage = new SessionStorageV6(dbPath);
      assert.equal(storage.getSession("whitespace-runtime-owner")?.characterId, "muse");

      const missingOwner = storage.getSession("missing-runtime-owner");
      assert.equal(missingOwner?.characterId, UNKNOWN_CHARACTER_OWNER_ID);
      assert.notEqual(missingOwner?.characterId, "Display Name");
      assert.equal(missingOwner?.characterRuntimeSnapshot, null);
      assert.equal(missingOwner?.threadId, "");

      const snapshotOnly = storage.getSession("snapshot-only-owner");
      assert.equal(snapshotOnly?.characterId, UNKNOWN_CHARACTER_OWNER_ID);
      assert.equal(snapshotOnly?.characterRuntimeSnapshot, null);
      assert.equal(snapshotOnly?.threadId, "");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("obsolete field や snapshot を欠損した Character owner の fallback に使わない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse"]);
      const session = buildNewSession({
        id: "obsolete-authoring-owner",
        taskTitle: "Muse authoring",
        workspaceLabel: "Muse authoring",
        workspacePath: "C:/characters/muse",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "muse",
        character: "Muse",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Muse"),
        approvalMode: DEFAULT_APPROVAL_MODE,
      });
      storage.insertSession(session);
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      db.prepare(`
        UPDATE sessions_v6
        SET character_id = NULL,
            runtime_policy_json = ?
        WHERE id = ?
      `).run(JSON.stringify({
        authoringCharacterId: "obsolete-owner",
        characterName: "Muse",
      }), session.id);
      db.close();

      storage = new SessionStorageV6(dbPath);
      const reloaded = storage.getSession(session.id);
      assert.ok(reloaded);
      assert.equal(reloaded.characterId, UNKNOWN_CHARACTER_OWNER_ID);
      assert.equal(reloaded.characterRuntimeSnapshot, null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("Character ID と runtime snapshot owner が異なる Session は保存しない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse", "other"]);
      const mismatched = {
        ...buildNewSession({
          id: "mismatched-owner",
          taskTitle: "Muse authoring",
          workspaceLabel: "Muse authoring",
          workspacePath: "C:/characters/muse",
          branch: "main",
          sessionKind: "character-authoring",
          characterId: "muse",
          character: "Muse",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Muse"),
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        characterRuntimeSnapshot: createCharacterRuntimeSnapshot("other", "Other"),
      };

      assert.throws(() => storage?.insertSession(mismatched), /保存できない session 形式/);
      assert.equal(storage.getSession(mismatched.id), null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("既存 row の runtime snapshot owner が不一致なら relational owner を維持して snapshot と thread を無効化する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      insertCharacterRows(dbPath, ["muse", "other"]);
      const sessions = (["default", "character-authoring"] as const).map((sessionKind) => ({
        ...buildNewSession({
          id: `corrupted-owner-${sessionKind}`,
          taskTitle: "Muse session",
          workspaceLabel: "Muse workspace",
          workspacePath: "C:/characters/muse",
          branch: "main",
          sessionKind,
          characterId: "muse",
          character: "Muse",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          characterRuntimeSnapshot: createCharacterRuntimeSnapshot("muse", "Muse"),
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        threadId: `thread-for-other-owner-${sessionKind}`,
      }));
      sessions.forEach((session) => storage?.insertSession(session));
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      const replaceSnapshot = db.prepare(`
        UPDATE sessions_v6
        SET character_snapshot_json = ?
        WHERE id = ?
      `);
      sessions.forEach((session) => replaceSnapshot.run(
        JSON.stringify(createCharacterRuntimeSnapshot("other", "Other")),
        session.id,
      ));
      db.close();

      storage = new SessionStorageV6(dbPath);
      const summaries = new Map(storage.listSessionSummaries().map((summary) => [summary.id, summary]));
      const reloaded = sessions.map((session) => storage?.getSession(session.id));
      reloaded.forEach((session) => {
        assert.ok(session);
        assert.equal(session.characterId, "muse");
        assert.equal(session.characterRuntimeSnapshot, null);
        assert.equal(session.threadId, "");
        assert.equal(summaries.get(session.id)?.threadId, "");
      });

      const authoringSession = reloaded.find((session) => session?.sessionKind === "character-authoring");
      assert.ok(authoringSession);
      const resolvedAuthoringSession = resolveCharacterAuthoringRuntimeSessionForTurn(
        authoringSession,
        () => createCharacterRuntimeSnapshot("muse", "Muse refreshed"),
      );
      assert.equal(resolvedAuthoringSession.characterRuntimeSnapshot?.characterId, "muse");
      assert.equal(resolvedAuthoringSession.threadId, "");

      reloaded.forEach((session) => storage?.upsertSession(session!));
      storage.close();
      storage = new SessionStorageV6(dbPath);
      sessions.forEach((session) => assert.equal(storage?.getSession(session.id)?.threadId, ""));
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("getLatestSessionSummaryForProvider は legacy provider 表記を正規化して最新一件だけを返す", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const createSession = (
        id: string,
        provider: string,
        model: string,
      ) => buildNewSession({
        id,
        taskTitle: id,
        workspaceLabel: id,
        workspacePath: `C:/${id}`,
        branch: "main",
        provider,
        model,
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      });
      storage.insertSession(createSession("codex-old", "codex", "gpt-old"));
      storage.insertSession(createSession("copilot-newest", "copilot", "copilot-model"));
      storage.insertSession(createSession("codex-before", "codex", "gpt-before"));
      storage.insertSession({
        ...createSession("codex-latest", "codex", "gpt-latest"),
        reasoningEffort: "xhigh",
        approvalMode: "never",
        codexSandboxMode: "danger-full-access",
        customAgentName: "reviewer",
      });

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sessions_v6 SET last_active_at = ? WHERE id = ?").run(100, "codex-old");
      db.prepare("UPDATE sessions_v6 SET last_active_at = ? WHERE id = ?").run(300, "copilot-newest");
      db.prepare("UPDATE sessions_v6 SET provider_id = ?, last_active_at = ? WHERE id = ?")
        .run("\tcodex\t", 200, "codex-before");
      db.prepare("UPDATE sessions_v6 SET provider_id = ?, last_active_at = ? WHERE id = ?")
        .run("\nCodex\u00a0", 200, "codex-latest");
      db.close();

      const latest = storage.getLatestSessionSummaryForProvider("codex");
      assert.equal(latest?.id, "codex-latest");
      assert.equal(latest?.provider, "codex");
      assert.equal(latest?.model, "gpt-latest");
      assert.equal(latest?.reasoningEffort, "xhigh");
      assert.equal(latest?.approvalMode, "never");
      assert.equal(latest?.codexSandboxMode, "danger-full-access");
      assert.equal(latest?.customAgentName, "reviewer");
      assert.equal(storage.getLatestSessionSummaryForProvider("missing"), null);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("insertSession は別 connection からの同一 ID create を拒否して既存 Session を保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let firstStorage: SessionStorageV6 | null = null;
    let secondStorage: SessionStorageV6 | null = null;

    try {
      firstStorage = new SessionStorageV6(dbPath);
      secondStorage = new SessionStorageV6(dbPath);
      const original = buildNewSession({
        id: "collision-session",
        taskTitle: "first",
        workspaceLabel: "workspace-a",
        workspacePath: "C:/workspace-a",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      });

      firstStorage.insertSession(original);
      assert.throws(
        () => secondStorage?.insertSession({
          ...original,
          taskTitle: "second",
          workspacePath: "C:/workspace-b",
        }),
        /同じ ID の Session がすでに存在するよ。/,
      );
      assert.equal(firstStorage.getSession(original.id)?.taskTitle, "first");
      assert.equal(firstStorage.getSession(original.id)?.workspacePath, "C:/workspace-a");
    } finally {
      secondStorage?.close();
      firstStorage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("既存の artifact_body なし schema は constructor で補完する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE session_messages_v6 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (session_id, seq),
          UNIQUE (id, session_id)
        );
      `);
      db.close();

      storage = new SessionStorageV6(dbPath);
      storage.close();
      storage = null;

      const reopenedDb = new DatabaseSync(dbPath);
      const columns = (reopenedDb.prepare("PRAGMA table_info(session_messages_v6)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      reopenedDb.close();
      assert.equal(columns.includes("artifact_body"), true);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("getSession は artifact summary を返し、detail は getSessionMessageArtifact で遅延取得する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [
          {
            role: "assistant",
            text: "done",
            artifact,
          },
        ],
      });

      const loaded = storage.getSession(session.id);
      const loadedArtifact = loaded?.messages[0]?.artifact;
      assert.ok(loadedArtifact);
      assert.equal(loadedArtifact.detailAvailable, true);
      assert.equal(loadedArtifact.operationTimeline?.[0]?.details, undefined);
      assert.deepEqual(loadedArtifact.changedFiles[0]?.diffRows, []);
      assert.deepEqual(loadedArtifact.runChecks, artifact.runChecks);

      const fullArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(fullArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(fullArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
      assert.deepEqual(fullArtifact?.runChecks, artifact.runChecks);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("last_active_at が cutoff より前の session id を列挙し、複数削除できる", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const oldSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "old" }),
        id: "old",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      const cutoffSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "cutoff" }),
        id: "cutoff",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
      const recentSession = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "recent" }),
        id: "recent",
        updatedAt: "2026-07-02T00:00:00.000Z",
      });

      assert.deepEqual(
        storage.listSessionIdsLastActiveBefore({
          cutoffDate: "2026-07-01",
          cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
          cutoffIso: "2026-07-01T00:00:00.000Z",
        }),
        [oldSession.id],
      );

      storage.deleteSessions([oldSession.id, recentSession.id]);

      assert.deepEqual(storage.listSessions().map((session) => session.id), [cutoffSession.id]);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("親 Session の削除経路で auxiliary_sessions を cleanup する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const deletedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "deleted parent" }),
        id: "deleted-parent",
      });
      const retainedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "retained parent" }),
        id: "retained-parent",
      });
      const replacedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "replaced parent" }),
        id: "replaced-parent",
      });

      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-deleted", parentSessionId: deletedParent.id },
        { id: "aux-retained", parentSessionId: retainedParent.id },
        { id: "aux-replaced", parentSessionId: replacedParent.id },
      ]);

      storage.deleteSession(deletedParent.id);
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), [replacedParent.id, retainedParent.id]);

      insertCompanionSessionRows(dbPath, [
        { id: "companion-active-parent", status: "active" },
        { id: "companion-recovery-parent", status: "recovery-required" },
        { id: "companion-merged-parent", status: "merged" },
        { id: "companion-discarded-parent", status: "discarded" },
      ]);
      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-companion-active", parentSessionId: "companion-active-parent" },
        { id: "aux-companion-recovery", parentSessionId: "companion-recovery-parent" },
        { id: "aux-companion-merged", parentSessionId: "companion-merged-parent" },
        { id: "aux-companion-discarded", parentSessionId: "companion-discarded-parent" },
      ]);

      storage.replaceSessions([{ ...retainedParent, taskTitle: "retained after replace" }]);
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), [
        "companion-active-parent",
        "companion-recovery-parent",
        retainedParent.id,
      ]);

      storage.clearSessions();
      assert.deepEqual(listAuxiliarySessionParentIds(dbPath), []);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("Session / Auxiliary 削除経路で session_turns_v6 payload を cleanup する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const baseInput = {
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      };
      const deletedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "deleted parent audit" }),
        id: "deleted-audit-parent",
      });
      const retainedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "retained parent audit" }),
        id: "retained-audit-parent",
      });
      const replacedParent = storage.upsertSession({
        ...buildNewSession({ ...baseInput, taskTitle: "replaced parent audit" }),
        id: "replaced-audit-parent",
      });
      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-audit-deleted", parentSessionId: deletedParent.id },
        { id: "aux-audit-retained", parentSessionId: retainedParent.id },
        { id: "aux-audit-replaced", parentSessionId: replacedParent.id },
      ]);
      insertSessionTurnRows(dbPath, [
        { sessionId: deletedParent.id, summary: "audit-deleted-session" },
        { sessionId: retainedParent.id, summary: "audit-retained-session" },
        { sessionId: replacedParent.id, summary: "audit-replaced-session" },
        { auxiliarySessionId: "aux-audit-deleted", summary: "audit-deleted-auxiliary" },
        { auxiliarySessionId: "aux-audit-retained", summary: "audit-retained-auxiliary" },
        { auxiliarySessionId: "aux-audit-replaced", summary: "audit-replaced-auxiliary" },
      ]);

      storage.deleteSession(deletedParent.id);
      assert.deepEqual(listSessionTurnSummaries(dbPath), [
        "audit-replaced-auxiliary",
        "audit-replaced-session",
        "audit-retained-auxiliary",
        "audit-retained-session",
      ]);

      insertCompanionSessionRows(dbPath, [
        { id: "companion-audit-active-parent", status: "active" },
        { id: "companion-audit-merged-parent", status: "merged" },
      ]);
      insertAuxiliarySessionRows(dbPath, [
        { id: "aux-audit-companion-active", parentSessionId: "companion-audit-active-parent" },
        { id: "aux-audit-companion-merged", parentSessionId: "companion-audit-merged-parent" },
      ]);
      insertSessionTurnRows(dbPath, [
        { auxiliarySessionId: "aux-audit-companion-active", summary: "audit-companion-active-auxiliary" },
        { auxiliarySessionId: "aux-audit-companion-merged", summary: "audit-companion-merged-auxiliary" },
      ]);

      storage.replaceSessions([{ ...retainedParent, taskTitle: "retained audit after replace" }]);
      assert.deepEqual(listSessionTurnSummaries(dbPath), [
        "audit-companion-active-auxiliary",
        "audit-retained-auxiliary",
        "audit-retained-session",
      ]);

      storage.clearSessions();
      assert.deepEqual(listSessionTurnSummaries(dbPath), []);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("artifact_body がない既存 row でも getSessionMessageArtifact は body から復元する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;
    let reopened: SessionStorageV6 | null = null;

    try {
      const artifact = createArtifact();
      storage = new SessionStorageV6(dbPath);
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "legacy artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });
      storage.close();
      storage = null;

      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE session_messages_v6 SET body = ?, artifact_body = NULL WHERE session_id = ? AND seq = 0")
        .run(JSON.stringify({ role: "assistant", text: "done", artifact }), session.id);
      db.close();

      reopened = new SessionStorageV6(dbPath);
      const loadedArtifact = reopened.getSessionMessageArtifact(session.id, 0);
      assert.equal(loadedArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(loadedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
    } finally {
      storage?.close();
      reopened?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("summary artifact を再保存しても既存 artifact_body の detail を保持する", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "preserve artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });

      const loaded = storage.getSession(session.id);
      assert.ok(loaded);
      assert.equal(loaded.messages[0]?.artifact?.detailAvailable, true);

      storage.upsertSession({
        ...loaded,
        taskTitle: "metadata only update",
        updatedAt: "2026-07-02T15:30:00.000Z",
      });

      const preservedArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(preservedArtifact?.operationTimeline?.[0]?.details, "large operation details");
      assert.equal(preservedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = true;");
      assert.deepEqual(preservedArtifact?.runChecks, artifact.runChecks);
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });

  it("summary が同じ full artifact 更新は既存 artifact_body で上書きしない", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-storage-v6-"));
    const dbPath = path.join(tempDirectory, "withmate-v6.db");
    let storage: SessionStorageV6 | null = null;

    try {
      storage = new SessionStorageV6(dbPath);
      const artifact = createArtifact();
      const session = storage.upsertSession({
        ...buildNewSession({
          taskTitle: "replace artifact detail",
          workspaceLabel: "workspace",
          workspacePath: "C:/workspace",
          branch: "main",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
        }),
        messages: [{ role: "assistant", text: "done", artifact }],
      });
      const updatedArtifact: MessageArtifact = {
        ...artifact,
        detailAvailable: true,
        operationTimeline: artifact.operationTimeline?.map((operation) => ({
          ...operation,
          details: "updated operation details",
        })),
        changedFiles: artifact.changedFiles.map((file) => ({
          ...file,
          diffRows: file.diffRows.map((row) => ({
            ...row,
            rightText: "const value = false;",
          })),
        })),
      };

      storage.upsertSession({
        ...session,
        updatedAt: "2026-07-02T15:31:00.000Z",
        messages: [{ role: "assistant", text: "done", artifact: updatedArtifact }],
      });

      const replacedArtifact = storage.getSessionMessageArtifact(session.id, 0);
      assert.equal(replacedArtifact?.operationTimeline?.[0]?.details, "updated operation details");
      assert.equal(replacedArtifact?.changedFiles[0]?.diffRows[0]?.rightText, "const value = false;");
    } finally {
      storage?.close();
      await removeDirectoryWithRetry(tempDirectory);
    }
  });
});
