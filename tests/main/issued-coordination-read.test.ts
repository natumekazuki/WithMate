import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionTurnStorageV6 } from "../../src-electron/session/session-turn-storage-v6.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { CoordinationStorageV7 } from "../../src-electron/coordination/coordination-storage-v7.js";
import { SessionExecutionReadStorage } from "../../src-electron/storage/session-execution-read.js";
import {
  buildNewSession,
  getSessionIncarnationId,
} from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";

// @test-value v2
// kind = "contract"
// claim = "receiptなし起票も正確なMain/Auxiliaryと起票Turnへ結び、保存本文を保って20件までのcursorで継続読取する"
// oracle = { type = "contract", ref = "docs/design/session-history.md: list_issued_coordinations; docs/design/desktop-ui.md#turn-input-details" }
// fault = "receiptで絞ってユーザー宛起票を落とす、別TurnやMain/Auxを混ぜる、userとassistantへ二重投影する、ページ境界で欠落する"
// observable = "実SQLiteを通した公開readのID列・本文・sourceTurnId/sourceMessageSeq・cursorと不正identityの拒否"
// observation_boundary = "public-boundary"
// scope = "起票保存→exact owner/Turnの実readと公開schema。表示位置の厳密な発言順は対象外"
// lifecycle = "permanent"
// impact = "相談の欠落と別会話への誤帰属で判断対象を取り違える"
// distinction = "型検査やrenderer fixtureでは実保存recordとTurn結合・keyset境界・親incarnationを確認できない"
// @end-test-value
/** 受領記録のない相談も起票元の Turn に結び付け、本文を保持してページをまたいで取得できることを確認する。 */
test("issued Coordination reads preserve receipt-less Main and Auxiliary source membership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-issued-read-"));
  const dbPath = join(directory, "test.db");
  const sessions = new SessionStorageV6(dbPath),
    turns = new SessionTurnStorageV6(dbPath),
    auxiliary = new AuxiliarySessionStorage(dbPath);
  const store = new CoordinationStorageV7(dbPath),
    read = new SessionExecutionReadStorage(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const main = sessions.insertSession({
      ...buildNewSession({
        id: "issuer",
        taskTitle: "Issuer",
        workspaceLabel: "Workspace",
        workspacePath: "C:/workspace",
        branch: "task",
        characterId: "unknown",
        character: "Unknown",
        characterIconPath: "",
        characterThemeColors: { main: "#445566", sub: "#667788" },
        approvalMode: "on-request",
      }),
      messages: [
        { role: "user", text: "Input" },
        { role: "assistant", text: "Response" },
      ],
    });
    const identity = {
      kind: "main" as const,
      sessionId: main.id,
      incarnationId: getSessionIncarnationId(main),
    };
    const turnInput = {
      provider: main.provider,
      model: main.model,
      reasoningEffort: main.reasoningEffort,
      approvalMode: main.approvalMode,
      threadId: "",
      errorMessage: "",
      createdAt: "2026-11-17T00:00:00Z",
      phase: "running" as const,
    };
    const turn = turns.createSessionTurn({
      ...turnInput,
      sessionId: main.id,
      userMessageSeq: 0,
      assistantMessageSeq: 1,
    });
    const otherTurn = turns.createSessionTurn({
      ...turnInput,
      sessionId: main.id,
    });
    const aux = auxiliary.upsertAuxiliarySession({
      ...captureSessionExecutionOptions(main),
      id: "aux",
      parentSessionId: main.id,
      runState: "idle",
      title: "Aux",
      provider: main.provider,
      catalogRevision: 1,
      threadId: "",
      composerDraft: "",
      messages: [],
      displayAfterMessageIndex: null,
      createdAt: "2026-11-17T00:00:00Z",
      updatedAt: "2026-11-17T00:00:00Z",
    });
    const auxIdentity = {
      kind: "auxiliary" as const,
      sessionId: aux.id,
      incarnationId: aux.createdAt,
    };
    const auxTarget = {
      ...auxIdentity,
      mainSessionId: main.id,
      mainIncarnationId: identity.incarnationId,
    };
    const auxTurn = turns.createSessionTurn({
      ...turnInput,
      sessionId: aux.id,
    });
    /** 配送を行わず、指定された起票元と Turn にユーザー宛の相談を保存する。 */
    const create = (
      actor: typeof identity | typeof auxIdentity,
      turnId: number,
      body: string,
    ) => {
      const result = store.execute({
        actor: { ...actor, turnId: String(turnId) },
        request: {
          operation: "create",
          operationId: randomUUID(),
          kind: "blocker",
          body,
          choices: [],
          respondent: { kind: "user" },
          deliver: false,
        },
      });
      assert.ok("record" in result);
      return result.record;
    };
    const records = Array.from({ length: 23 }, (_, index) =>
      create(identity, turn.id, `Question ${index}`),
    );
    const unrelated = create(identity, otherTurn.id, "Another Turn");
    const auxRecord = create(auxIdentity, auxTurn.id, "Auxiliary Question");
    /** 読み取り条件を上書きして起票一覧を取得し、公開スキーマに照らして検証する。 */
    const call = (
      extra: object = {},
      target = identity as typeof identity | typeof auxTarget,
    ) =>
      executionOperationResultSchemas.list_issued_coordinations.parse(
        read.execute({
          target,
          operation: "list_issued_coordinations",
          request: { target, messageSeqs: [0, 1], ...extra },
        }),
      );
    const first = call(),
      second = call({ cursor: first.nextCursor });
    assert.equal(first.items.length, 20);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...second.items].map((entry) => entry.id),
      records.map((record) => record.id).sort(),
    );
    assert.ok(
      first.items.every(
        (entry) =>
          entry.sourceTurnId === String(turn.id) &&
          entry.sourceMessageSeq === 1,
      ),
    );
    assert.ok(
      first.items.every(
        (entry) =>
          records.find((record) => record.id === entry.id)?.body ===
          entry.consultation,
      ),
    );
    assert.ok(
      call({ messageSeqs: [0] }).items.every(
        (entry) => entry.sourceMessageSeq === 0,
      ),
    );
    assert.deepEqual(
      call({ messageSeqs: [], liveTurnIds: [String(otherTurn.id)] }).items,
      [
        {
          id: unrelated.id,
          sourceTurnId: String(otherTurn.id),
          sourceMessageSeq: null,
          consultation: "Another Turn",
        },
      ],
    );
    assert.deepEqual(
      call({ messageSeqs: [], liveTurnIds: [String(auxTurn.id)] }, auxTarget)
        .items,
      [
        {
          id: auxRecord.id,
          sourceTurnId: String(auxTurn.id),
          sourceMessageSeq: null,
          consultation: "Auxiliary Question",
        },
      ],
    );
    assert.equal(call({ messageSeqs: [] }).items.length, 0);
    db.prepare("DELETE FROM coordination_records_v7 WHERE id=?").run(
      first.items[0].id,
    );
    assert.ok(call().items.every((entry) => entry.id !== first.items[0].id));
    const bad = { ...auxTarget, mainIncarnationId: "replaced" };
    assert.equal(
      read.execute({
        target: bad,
        operation: "list_issued_coordinations",
        request: {
          target: bad,
          messageSeqs: [],
          liveTurnIds: [String(auxTurn.id)],
        },
      }).ok,
      false,
    );
  } finally {
    db.close();
    read.close();
    store.close();
    auxiliary.close();
    turns.close();
    sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
