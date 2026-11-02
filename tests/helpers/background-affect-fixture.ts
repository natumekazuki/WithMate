import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { readConversationQuerySnapshot } from "../../src-electron/storage/conversation-query.js";
import type { StorageOperationDiagnosticSink } from "../../src-electron/storage/storage-operation-diagnostics.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import { BackgroundExecutionService } from "../../src-electron/providers/background-execution-service.js";
import { BackgroundAffectApplicationService, type BackgroundAffectMainSource } from "../../src-electron/character/background-affect-application-service.js";
import { CharacterAffectService } from "../../src-electron/character/character-affect-service.js";
import { CharacterContextApplicationService } from "../../src-electron/character/character-context-application-service.js";
import { MemoryV6WorkerClient } from "../../src-electron/memory/memory-v6-worker-client.js";
import { MemoryV6Service } from "../../src-electron/memory/memory-v6-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";

export const completedAt = "2026-11-01T15:00:00.000Z";
export const secondCompletedAt = "2026-11-01T15:01:00.000Z";

/** Replaces Provider/terminal wiring with saved input; persistence and background lifetime are real. */
export async function backgroundAffectFixture(diagnosticSink?: StorageOperationDiagnosticSink) {
  const directory = await mkdtemp(join(tmpdir(), "withmate-background-affect-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO characters(id,name,created_at,updated_at) VALUES ('character','Character',?,?)").run(completedAt, completedAt);
  const session = { ...buildNewSession({ taskTitle: "Source", workspaceLabel: "fixture", workspacePath: directory,
    branch: "main", characterId: "character", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#123456", sub: "#abcdef" }, approvalMode: "on-request" }), id: "main", incarnationId: "inc-main" };
  for (const id of ["main", "other"]) {
    db.prepare(`INSERT INTO sessions_v6(id,incarnation_id,title,state,provider_id,catalog_revision,model_id,approval_mode,
      character_id,character_snapshot_json,created_at,updated_at,last_active_at)
      VALUES (?,?,'Source','active','codex',1,'test','on-request','character','{}',?,?,?)`)
      .run(id, `inc-${id}`, completedAt, completedAt, completedAt);
    for (let seq = 0; seq < 6; seq++) {
      db.prepare("INSERT INTO session_messages_v6(session_id,seq,role,body,created_at) VALUES (?,?,?,?,?)")
        .run(id, seq, seq % 2 ? "assistant" : "user", JSON.stringify({ role: seq % 2 ? "assistant" : "user", text: `saved ${seq}` }), completedAt);
    }
  }
  db.prepare("INSERT INTO auxiliary_sessions(id,parent_session_id,status,created_at,updated_at) VALUES ('aux','main','active',?,?)")
    .run(completedAt, completedAt);
  db.prepare("INSERT INTO auxiliary_session_drafts(auxiliary_session_id,parent_session_id,incarnation,updated_at) VALUES ('aux','main','draft',?)").run(completedAt);
  for (const [id, owner, phase, seq] of [[1, "main", "completed", 1], [2, "main", "failed", 3],
    [3, "other", "completed", 1], [4, "main", "running", 3], [5, "main", "completed", 5]] as const) {
    db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, owner, phase, seq, completedAt,
      phase === "running" ? null : id === 2 ? secondCompletedAt : completedAt, completedAt);
  }
  const bindings = new AgentRuntimeBindingRegistry();
  const turns = new ProviderAgentRuntimeTurnCoordinator();
  const executions = new BackgroundExecutionService({ bindings, turns, closeConnection() {} });
  executions.start();
  const worker = new MemoryV6WorkerClient({ dbPath, workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
    diagnosticSink, now: () => new Date("2026-11-01T15:02:00.000Z") });
  let episodeCalls = 0;
  const affect = new CharacterAffectService(worker.affectStorage, { async evaluate() { return []; } }, {
    validateEpisode() { episodeCalls++; throw new Error("Background must not validate episodes"); },
    async writeEpisode() { episodeCalls++; throw new Error("Background must not write episodes"); },
  }, "active");
  const deps: ConstructorParameters<typeof BackgroundAffectApplicationService>[0] = {
    bindings, turns, affectService: affect,
    async readMainSource(scope) {
      // The test's app-owned resolver reads real saved Main rows, not model-supplied identity.
      const snapshot = readConversationQuerySnapshot(db, "session_messages_v6", scope.source.sessionId);
      const row = db.prepare("SELECT character_id AS characterId, incarnation_id AS incarnationId FROM sessions_v6 WHERE id = ?")
        .get(scope.source.sessionId) as { characterId: string; incarnationId: string } | undefined;
      if (!snapshot || !row) return null;
      const savedTurns = db.prepare(`SELECT id, session_id AS sessionId, phase, completed_at AS completedAt,
        assistant_message_seq AS assistantMessageSeq FROM session_turns_v6 WHERE session_id = ?`)
        .all(scope.source.sessionId) as Array<BackgroundAffectMainSource["turns"][number]>;
      return { session: { ...session, id: scope.source.sessionId, ...row }, ownerIdentity: snapshot.ownerIdentity, turns: savedTurns };
    },
  };
  const context = new CharacterContextApplicationService({ affectService: affect,
    memoryService: new MemoryV6Service({ storage: worker.storage }),
    resolveCharacterRuntimeSnapshot: (characterId) => ({ characterId, name: "Character", description: "", iconFilePath: "",
      theme: { main: "#123456", sub: "#abcdef" }, definitionMarkdown: "Character", definitionSha256: "fixture",
      definitionByteSize: 9, snapshotAt: completedAt }),
  });
  function scope(kind: "main" | "auxiliary" = "main"): BackgroundExecutionScope {
    const id = kind === "main" ? "main" : "aux";
    const snapshot = readConversationQuerySnapshot(db, kind === "main" ? "session_messages_v6" : "auxiliary_session_messages", id)!;
    return { purpose: "affect", history: { source: kind === "main"
      ? { kind, sessionId: id, incarnationId: snapshot.incarnationId, ownerIdentity: snapshot.ownerIdentity }
      : { kind, sessionId: id, incarnationId: snapshot.incarnationId, ownerIdentity: snapshot.ownerIdentity,
        parent: { sessionId: "main", incarnationId: "inc-main" } }, fromMessageSeq: 0, throughMessageSeq: 3 },
    processing: { afterTurnId: null, throughTurnId: 5 }, memoryTargets: [] };
  }
  function start(capturedScope = scope()) {
    const source = capturedScope.history.source;
    const result = executions.begin({ actorSessionId: source.sessionId, providerId: "codex",
      session: { ...session, id: source.sessionId, incarnationId: source.incarnationId }, scope: capturedScope,
      authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] }, operationGrants: [] });
    assert.ok(result.ok);
    return result.execution;
  }
  return { db, worker, affect, context, deps, bindings, turns, executions, scope, start, episodeCalls: () => episodeCalls,
    eventCount: () => (db.prepare("SELECT COUNT(*) AS count FROM character_affect_events_v6").get() as { count: number }).count,
    memoryCount: () => (db.prepare("SELECT COUNT(*) AS count FROM memory_entries_v6").get() as { count: number }).count,
    async close() {
      executions.stop(); await worker.close(); auxiliary.close(); db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
