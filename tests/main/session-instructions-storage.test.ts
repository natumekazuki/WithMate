import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  RuntimeTurnInactiveError,
  runWithRuntimeTurnAdmission,
} from "../../src-electron/platform/agent-runtime/runtime-turn-admission.js";
import { APP_DATABASE_V6_FILENAME } from "../../src-electron/storage/database-schema-v6.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { openAppDatabase } from "../../src-electron/storage/sqlite-connection.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionInstructionsTarget } from "../../src-shared/session/session-instructions.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";

/** 列の追加を伴う移行、置換エラー、再オープンを経ても既存の会話が維持され、所有者間で指示が共有されないことを確認する。 */
it("persists exact UTF-8 instructions for Main and Auxiliary through the storage worker", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "withmate-instructions-"));
  const dbPath = join(userDataPath, APP_DATABASE_V6_FILENAME);
  const open = () => createV6StorageWorkerBundle({ dbPath, userDataPath });
  const parent = buildNewSession({
    id: "main", taskTitle: "Main", workspacePath: userDataPath, workspaceLabel: "Workspace", branch: "",
    characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#ffffff", sub: "#000000" },
    approvalMode: "on-request",
  });
  const auxiliary: AuxiliarySession = {
    id: "aux", parentSessionId: parent.id, title: "Auxiliary", runState: "idle",
    provider: "codex", catalogRevision: parent.catalogRevision, model: parent.model, reasoningEffort: parent.reasoningEffort,
    approvalMode: parent.approvalMode, codexSandboxMode: parent.codexSandboxMode, codexSpeed: parent.codexSpeed, codexReviewer: parent.codexReviewer, customAgentName: "",
    threadId: "aux-thread", composerDraft: "aux-draft", messages: [], displayAfterMessageIndex: null,
    createdAt: "2026-11-28T06:00:00.000Z", updatedAt: "2026-11-28T06:00:00.000Z",
  };
  let bundle = open();
  try {
    // 既存の所有者行を持つ合成 V6 データベースを作り、機能追加前のスキーマを再現する。
    await bundle.initialize();
    const storedParent = await bundle.stores.session.upsertSession({
      ...parent, threadId: "main-thread", messages: [{ role: "user", text: "saved message" }],
    });
    const main = { kind: "main", sessionId: parent.id, incarnationId: getSessionIncarnationId(storedParent) } as const;
    const aux: Extract<SessionInstructionsTarget, { kind: "auxiliary" }> = {
      kind: "auxiliary", sessionId: auxiliary.id, incarnationId: auxiliary.createdAt,
      mainSessionId: parent.id, mainIncarnationId: main.incarnationId,
    };
    await bundle.stores.auxiliary.upsertAuxiliarySession(auxiliary);
    await bundle.client.close();
    const db = openAppDatabase(dbPath);
    try {
      db.exec("ALTER TABLE sessions_v6 DROP COLUMN instructions_json; ALTER TABLE auxiliary_sessions DROP COLUMN instructions_json");
    } finally {
      db.close();
    }

    // 再オープン時に列を追加しても、既存の履歴、スレッド、下書きは変わらない。
    bundle = open();
    await bundle.initialize();
    const { instructions, session, auxiliary: auxiliaryStore } = bundle.stores;
    assert.equal(await instructions.get(main), "");
    assert.equal(await instructions.get(aux), "");
    const limit = "日🧪".repeat(1170) + " \n";
    assert.equal(Buffer.byteLength(limit), 8192);
    assert.deepEqual(await instructions.set(main, limit), { byteLength: 8192 });
    const auxBody = "  補助🧭\r\n末尾\u0000  ";
    assert.deepEqual(await instructions.set(aux, auxBody), { byteLength: Buffer.byteLength(auxBody) });
    await assert.rejects(instructions.set(main, limit + "x"), /8,192-byte limit/);
    await assert.rejects(instructions.set(aux, null), /must be text/);
    for (const stale of [{ ...main, incarnationId: "stale" }, { ...aux, incarnationId: "stale" },
      { ...aux, mainSessionId: "different-main" }, { ...aux, mainIncarnationId: "stale" }]) {
      assert.equal(await instructions.get(stale), null);
      assert.equal(await instructions.set(stale, "not applied"), null);
    }

    await session.setSessionTitle(main.sessionId, main.incarnationId, "Renamed Main");
    await auxiliaryStore.updateAuxiliaryTitleIfMatches({
      auxiliarySessionId: auxiliary.id, parentSessionId: parent.id, createdAt: auxiliary.createdAt,
      title: "Renamed Auxiliary", updatedAt: auxiliary.updatedAt,
    });
    assert.equal(await instructions.get(main), limit);
    assert.equal(await instructions.get(aux), auxBody);
    await bundle.client.close();

    // Worker を再起動した後、永続化された内容がバイト単位で一致することを確認し、もう一方の所有者に影響を与えず一方の指示を消去する。
    bundle = open();
    // 新しい Worker の準備完了前にキューへ入れるため、必ず実行の送出より先に失効が起きる。
    const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const pending = runWithRuntimeTurnAdmission({ state }, () => {
      const request = bundle.stores.instructions.set(main, "must not replace");
      Atomics.store(new Int32Array(state), 0, 1);
      return request;
    });
    await assert.rejects(pending, RuntimeTurnInactiveError);
    await bundle.initialize();
    const reopenedMain = await bundle.stores.session.getSession(parent.id);
    const reopenedAux = await bundle.stores.auxiliary.getAuxiliarySession(auxiliary.id);
    assert.equal(reopenedMain?.messages[0]?.text, "saved message");
    assert.equal(reopenedMain?.threadId, "main-thread");
    assert.equal(reopenedAux?.threadId, "aux-thread");
    assert.equal(reopenedAux?.composerDraft, "aux-draft");
    assert.equal(await bundle.stores.instructions.get(main), limit);
    assert.equal(await bundle.stores.instructions.get(aux), auxBody);
    assert.deepEqual(await bundle.stores.instructions.set(aux, ""), { byteLength: 0 });
    assert.equal(await bundle.stores.instructions.get(aux), "");
    assert.equal(await bundle.stores.instructions.get(main), limit);
  } finally {
    await bundle.client.close();
    await rm(userDataPath, { recursive: true, force: true });
  }
});
