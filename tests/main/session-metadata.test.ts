import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";


// @test-value v2
// kind = "invariant"
// claim = "実行中MainとAuxのmetadata patchは古い全文保存で巻き戻らず、独立した現在値を取得できる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/735" }
// fault = "runtimeの古いsnapshotが説明を戻すかAuxの説明をMainへ保存する"
// observable = "再取得したMain/Auxのtitle・description・thread・本文"
// observation_boundary = "component-behavior"
// scope = "Session metadata storage"
// lifecycle = "permanent"
// @end-test-value
it("keeps current metadata across stale Main and Auxiliary runtime saves", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-metadata-"));
  const dbPath = path.join(directory, "app.db");
  const main = new SessionStorageV6(dbPath);
  const aux = new AuxiliarySessionStorage(dbPath);
  try {
    const root = main.insertSession({ ...buildNewSession({ id: "root", taskTitle: "Root", workspaceLabel: "Workspace", workspacePath: "C:/work", branch: "", characterId: "azki", character: "AZKi", characterIconPath: "", characterThemeColors: { main: "#fff", sub: "#000" }, approvalMode: "on-request" }), status: "running", runState: "running", threadId: "thread-main", messages: [{ role: "user", text: "request" }] });
    const auxiliary = aux.upsertAuxiliarySession({ ...root, id: "aux", parentSessionId: root.id, title: "Aux", createdAt: "2026-11-07T00:00:00Z", runState: "running", composerDraft: "draft", displayAfterMessageIndex: null });
    main.patchSessionMetadata(root.id, root.incarnationId!, { title: "Main current", description: "Main scope\nCurrent phase" });
    aux.patchAuxiliarySessionMetadata({ auxiliarySessionId: auxiliary.id, parentSessionId: root.id, createdAt: auxiliary.createdAt, updatedAt: root.updatedAt, patch: { title: "Aux current", description: "Aux scope" } });
    main.updateSession(root);
    aux.upsertAuxiliarySession(auxiliary);
    const current = main.getSession(root.id)!;
    const currentAux = aux.getAuxiliarySession(auxiliary.id)!;
    assert.deepEqual([current.taskTitle, current.description, currentAux.title, currentAux.description], ["Main current", "Main scope\nCurrent phase", "Aux current", "Aux scope"]);
    assert.equal(current.threadId, "thread-main");
    assert.deepEqual(current.messages, root.messages);
    assert.throws(() => main.patchSessionMetadata(root.id, "wrong", { description: "incorrect" }));
  } finally {
    aux.close();
    main.close();
    await rm(directory, { recursive: true, force: true });
  }
});
