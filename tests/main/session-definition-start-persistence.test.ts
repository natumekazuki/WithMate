import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary開始保存は定義とuser messageを同時保存し、legacy親snapshotも自身へ固定してdraft/thread/bookmarkを保持する"
// oracle = { type = "issue", ref = "GitHub Issue #775: Main/Auxiliaryの送信時定義更新と保存snapshot" }
// fault = "Auxiliary開始で定義が保存されない、親へ書き戻す、固定metadataを変える、draftやbookmarkを失う"
// observable = "実DB再読込のAuxiliary snapshot/messages/draft/threadと親snapshot、拒否後のmessage件数"
// observation_boundary = "component-behavior"
// scope = "AuxiliarySessionService.persistRunningTurnStart"
// lifecycle = "permanent"
// impact = "更新した定義が再開時に失われるか入力中draftと会話metadataが破壊される"
// distinction = "Mainのincremental storageと異なるAuxiliary CASとlegacy親projectionの実永続化を確認する"
// @end-test-value
test("Auxiliary定義開始保存はlegacy snapshotを固定しdraftと会話identityを守る", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-definition-start-"));
  const dbPath = path.join(directory, "withmate-v6.db");
  const parents = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  try {
    const snapshot = {
      characterId: "char-a", name: "A", description: "saved", iconFilePath: "",
      theme: { main: "#111111", sub: "#222222" }, definitionMarkdown: "# Old",
      definitionSha256: "old", definitionByteSize: 5, snapshotAt: "old",
    };
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(snapshot.characterId, snapshot.name, "old", "old");
    } finally {
      db.close();
    }
    const parent = parents.insertSession(buildNewSession({
      id: "parent", taskTitle: "Parent", workspaceLabel: "workspace", workspacePath: "C:/workspace",
      branch: "main", characterId: snapshot.characterId, character: snapshot.name,
      characterRuntimeSnapshot: snapshot, characterIconPath: "", characterThemeColors: snapshot.theme,
      approvalMode: "never",
    }));
    const service = new AuxiliarySessionService({
      getParentSession: (id) => parents.getSession(id), getStorage: () => auxiliary,
      runProviderRuntimeOperationExclusive: async (operation) => operation(),
      resolveSessionLaunchSelection: async () => { throw new Error("unused"); },
      listActiveCharacters: () => [], createCharacterRuntimeSnapshot: () => null,
    });
    const initial = auxiliary.upsertAuxiliarySession({
      ...parent, id: "aux", parentSessionId: parent.id, title: "Aux", status: "active",
      runState: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      closedAt: "", composerDraft: "keep draft", displayAfterMessageIndex: null,
      threadId: "keep-thread", characterId: undefined, characterRuntimeSnapshot: undefined,
      messages: [{ role: "assistant", text: "bookmarked", isBookmarked: true }],
    });
    const runtime = await service.getAuxiliaryRuntimeSession(initial.id);
    assert.ok(runtime);
    const updatedSnapshot = { ...snapshot, definitionMarkdown: "# Updated", definitionSha256: "updated", definitionByteSize: 9, snapshotAt: "later" };
    const running = { ...runtime, status: "running" as const, runState: "running" as const,
      updatedAt: "later", characterRuntimeSnapshot: updatedSnapshot,
      messages: [...runtime.messages, { role: "user" as const, text: "new prompt" }] };
    await assert.rejects(service.persistRunningTurnStart({ ...running,
      characterRuntimeSnapshot: { ...updatedSnapshot, name: "changed" } }, 1), /saved Session identity/);
    assert.equal(auxiliary.getAuxiliarySession(initial.id)?.messages.length, 1);
    const stored = await service.persistRunningTurnStart(running, 1);
    assert.deepEqual(stored.characterRuntimeSnapshot, updatedSnapshot);
    assert.equal(stored.threadId, "keep-thread");
    assert.equal(auxiliary.getAuxiliaryDraft(initial.id)?.text, "keep draft");
    assert.equal(stored.messages[0]?.isBookmarked, true);
    assert.equal(auxiliary.getAuxiliarySession(initial.id)?.characterId, snapshot.characterId);
    assert.deepEqual(parents.getSession(parent.id)?.characterRuntimeSnapshot, snapshot);
    await assert.rejects(service.persistRunningTurnStart(running, 1), /changed before starting/);
    assert.equal(auxiliary.getAuxiliarySession(initial.id)?.messages.length, 2);
  } finally {
    auxiliary.close();
    parents.close();
    await rm(directory, { recursive: true, force: true });
  }
});
