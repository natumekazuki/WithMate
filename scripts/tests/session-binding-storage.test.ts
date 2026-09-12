import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  SessionBindingStorage,
  buildSessionBindingEventPayload,
} from "../../src-electron/session-binding-storage.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE session_resource_events_v6 (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );`);
  return db;
}

const binding = {
  sessionId: "session-a",
  revision: 2,
  providerId: "codex",
  modelId: "gpt-5",
  reasoningEffort: "high",
  customAgentName: "",
  catalogRevision: 4,
  threadId: "thread-a",
  workspaceLabel: "Workspace A",
  workspacePath: "C:/workspace/a",
  branch: "main",
  accessMode: "active",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
  codexSpeed: "balanced",
  codexReviewer: "none",
  allowedAdditionalDirectories: [],
  characterId: "character-a",
  characterName: "Character A",
  characterIconPath: "",
  characterThemeColors: { main: "#000", sub: "#fff" },
  characterRuntimeSnapshot: null,
  characterRuntimeIdentity: "character-a",
  workspaceGrant: { workspaceId: "workspace-a", revision: 3 },
  providerGeneration: "provider-generation-a",
  executionGeneration: "execution-generation-a",
  roleBinding: {
    sessionRole: "standalone",
    roleContractRevision: 1,
    rootSessionId: "session-a",
    parentSessionId: null,
    delegationDepth: 0,
  },
} as const;

// @test-value v2
// kind = "invariant"
// claim = "active bindingは最新のbinding eventを使い、過去revisionは変更後へ再帰属しない"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Session identity と変更可能性" }
// fault = "configure後に旧Turnのbindingが最新bindingへ置換される"
// observable = "SessionBindingStorageが返すactiveと過去revisionのbinding tuple"
// observation_boundary = "implementation"
// scope = "session-binding-storage"
// lifecycle = "permanent"
// @end-test-value
test("Session binding historyはactiveと過去revisionを分離して読む", () => {
  const db = createDb();
  db.prepare("INSERT INTO session_resource_events_v6 VALUES (?, ?, ?, ?, ?)").run(
    "event-1", "session-a", 1, "migration_baseline", JSON.stringify({ binding: { ...binding, revision: 1, threadId: "thread-old" } }),
  );
  db.prepare("INSERT INTO session_resource_events_v6 VALUES (?, ?, ?, ?, ?)").run(
    "event-2", "session-a", 2, "configured", JSON.stringify(buildSessionBindingEventPayload(binding)),
  );
  const storage = new SessionBindingStorage(db);
  assert.deepEqual(storage.getActive("session-a"), binding);
  assert.deepEqual(storage.getAtRevision("session-a", 1), { ...binding, revision: 1, threadId: "thread-old" });
  assert.deepEqual(storage.getAtRevision("session-a", 2), binding);
  db.close();
});

// @test-value v2
// kind = "invariant"
// claim = "catalogRevisionが不正なbinding tupleをdecoderが例外として拒否する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Migration" }
// fault = "不正なbinding eventが有効bindingとして返される"
// observable = "SessionBindingStorage.getActiveが返すinvalid binding tuple例外"
// observation_boundary = "implementation"
// scope = "session-binding-storage"
// lifecycle = "permanent"
// @end-test-value
test("Session binding historyは不正payloadをfail closedする", () => {
  const db = createDb();
  db.prepare("INSERT INTO session_resource_events_v6 VALUES (?, ?, ?, ?, ?)").run(
    "event-1", "session-a", 1, "migration_baseline", JSON.stringify({ binding: { ...binding, catalogRevision: 0 } }),
  );
  assert.throws(
    () => new SessionBindingStorage(db).getActive("session-a"),
    /invalid binding tuple/,
  );
  db.close();
});
