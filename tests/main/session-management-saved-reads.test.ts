import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import {
  SessionManagementApplication,
  SessionManagementError,
} from "../../src-electron/session/session-management-application.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { resolveV6FreshDatabasePath } from "../../src-electron/storage/database-schema-v6.js";
import {
  createV6StorageWorkerBundle,
  type V6StorageWorkerBundle,
} from "../../src-electron/storage/storage-worker-bundle.js";
import {
  buildNewSession,
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import {
  sessionOperationSuccessSchemas,
  type SessionOperationRequest,
} from "../../src-shared/session/session-management-contract.js";

const date = "2026-11-20T00:00:00.000Z";
/** 固定時刻からのずれを ISO 形式へ変換し、永続化された順序をミリ秒単位で組み立てる。 */
const timestamp = (n: number) => new Date(Date.parse(date) + n).toISOString();
/** Main の ID と保存世代を含む、単体読取りに使う参照を作る。 */
const mainTarget = (session: Session) => ({
  kind: "main" as const,
  sessionId: session.id,
  incarnationId: getSessionIncarnationId(session),
});

/** V6 の SQLite 保存先を分離し、直接読取りと Worker を経由する読取りを同じデータで試せるようにする。 */
function fixture(t: TestContext) {
  const dir = mkdtempSync(
    path.join(os.tmpdir(), "withmate-saved-session-reads-"),
  );
  const dbPath = resolveV6FreshDatabasePath(dir);
  const mains = new SessionStorageV6(dbPath);
  const auxiliaries = new AuxiliarySessionStorage(dbPath);
  const sql = new DatabaseSync(dbPath);
  let worker: V6StorageWorkerBundle | undefined;
  /** fixture を書き込んだ DB を参照する Storage Worker を初期化する。 */
  async function startWorker() {
    worker = createV6StorageWorkerBundle({ dbPath, userDataPath: dir });
    await worker.initialize();
    return worker;
  }
  /** 試験終了時に Worker を先に閉じ、SQLite 接続と試験ディレクトリを解放する。 */
  t.after(async () => {
    try {
      await worker?.client.close();
    } finally {
      sql.close();
      auxiliaries.close();
      mains.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const snapshot = {
    characterId: "fixture",
    name: "ÉCHO",
    description: "公開紹介",
    theme: { main: "#fff", sub: "#000" },
    iconFilePath: "",
    definitionMarkdown: "private-fixture-definition",
    definitionSha256: "",
    definitionByteSize: 26,
    snapshotAt: date,
  };
  sql
    .prepare(
      "INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(snapshot.characterId, snapshot.name, date, date);
  /** 指定の時刻と親関係を持つ Main を保存し、一覧順や作成関係を組み立てる。 */
  const main = (id: string, order: number, parent?: Session) =>
    mains.insertSession({
      ...buildNewSession({
        id,
        taskTitle: id,
        workspaceLabel: "Fixture",
        workspacePath: "C:/synthetic",
        branch: "main",
        characterId: snapshot.characterId,
        character: snapshot.name,
        characterIconPath: "",
        characterThemeColors: snapshot.theme,
        characterRuntimeSnapshot: snapshot,
        approvalMode: "on-request",
        sessionRole: parent ? "executor" : "overall-coordinator",
      }),
      updatedAt: timestamp(order),
      ...(parent && {
        parentSessionId: parent.id,
        rootSessionId: parent.id,
        createdBySessionId: parent.id,
      }),
    });
  /** Auxiliary と任意の下書き更新時刻を保存し、親 Main の世代を含む参照を返す。 */
  const aux = (
    id: string,
    parent: Session,
    order: number,
    draftTime?: number,
  ) => {
    auxiliaries.upsertAuxiliarySession({
      id,
      parentSessionId: parent.id,
      title: id,
      description: "Auxiliary task",
      runState: "idle",
      provider: parent.provider,
      catalogRevision: parent.catalogRevision,
      model: parent.model,
      reasoningEffort: parent.reasoningEffort,
      approvalMode: parent.approvalMode,
      codexSandboxMode: parent.codexSandboxMode,
      codexSpeed: parent.codexSpeed,
      codexReviewer: parent.codexReviewer,
      customAgentName: "",
      threadId: "",
      composerDraft: "",
      messages: [{ role: "user", text: `message for ${id}` }],
      displayAfterMessageIndex: null,
      createdAt: date,
      updatedAt: timestamp(order),
      characterId: snapshot.characterId,
      characterRuntimeSnapshot: {
        ...snapshot,
        description: "公開紹介（補助）",
      },
    });
    if (draftTime !== undefined) {
      sql
        .prepare(
          "UPDATE auxiliary_session_drafts SET durable_revision = 1, draft_text = ?, updated_at = ? WHERE auxiliary_session_id = ?",
        )
        .run(`draft for ${id}`, timestamp(draftTime), id);
    } else {
      // 下書き行を持たない保存済み Auxiliary では、従来の並び順を維持する。
      sql
        .prepare(
          "DELETE FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?",
        )
        .run(id);
    }
    return {
      kind: "auxiliary" as const,
      sessionId: id,
      incarnationId: date,
      mainSessionId: parent.id,
      mainIncarnationId: getSessionIncarnationId(parent),
    };
  };
  /** 読取り専用の試験で別の操作に進んだら、その場で失敗させる。 */
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected operation");
  };
  const application = new SessionManagementApplication({
    /** Worker 起動後は Worker に、それ以前は直接の SQLite 読取りに一覧や単体照会を渡す。 */
    readSessionScope: async (actor, selection) =>
      worker
        ? worker.stores.session.readSessionManagementScope(actor, selection)
        : mains.readSessionManagementScope(actor, selection),
    /** 実行中のターンがない状態を単体読取りの結果に重ねる。 */
    currentTurn: async () => ({ turnId: null, receipt: null, origin: null }),
    /** 解決済みセッションのルートを識別できる試験用 Crew Folder を返す。 */
    crewFolder: async (actor) => ({
      rootSessionId: actor.rootSessionId,
      path: `fixture/${actor.rootSessionId}`,
    }),
    operatingPolicy: unused,
    directories: unused,
    updateMetadata: unused,
    enqueue: unused,
    getReceipt: unused,
    getInstructions: unused,
    setInstructions: unused,
    cancelReceipt: unused,
    stopTurn: unused,
    steer: unused,
    readExecution: unused,
    coordinate: unused,
    createChild: unused,
    catalog: unused,
  });
  return { main, aux, application, mains, startWorker, unused };
}

// @test-value v2
// kind = "contract"
// claim = "Session探索はCrew、Role、作成関係、公開検索をページ境界より先に適用し、既存順序で正確な件数を返す"
// oracle = { type = "contract", ref = "https://app.notion.com/4239d4b6f2628041b656c1473047eafe#受け入れ条件" }
// fault = "MainとAuxiliaryを別々にsliceするか、Crew・公開検索・作成関係のいずれかをcountから落とす"
// observable = "合成SQLiteを使ったlistの順序付きSession ID、total、hasMoreと公開プロフィール"
// observation_boundary = "public-boundary"
// scope = "session-management-stored-list"
// lifecycle = "permanent"
// @end-test-value
/** 保留中の作成を除外し、Crew・Role・作成関係・公開検索の絞込みを全件数とページ分割より先に適用して Main、Auxiliary の順で返すことを確認する。 */
test("saved discovery filters before counting and paging in Main-then-Auxiliary order", async (t) => {
  const { main, aux, application, mains, startWorker } = fixture(t);
  const root = main("root", 5),
    other = main("other", 5),
    child = main("child", 4, root);
  const pending = main("pending", 9, root);
  aux("pending-aux", pending, 0);
  mains.beginSessionLifecycleOperation({
    operationId: "pending-op",
    kind: "create",
    input: {},
    targets: [{ id: pending.id }],
  });
  aux("aux-last", child, 0, 30);
  aux("aux-first", child, 100);
  aux("root-aux", root, 0, 0);
  aux("other-aux", other, 0, 0);
  await startWorker();
  /** 一覧 API の公開スキーマを使い、順序・総数・次ページの有無と Character 紹介だけが返ることを照合する。 */
  async function page(
    actor: ReturnType<typeof mainTarget>,
    query: SessionOperationRequest<"list">,
    ids: string[],
    total: number,
    hasMore: boolean,
  ) {
    const result = sessionOperationSuccessSchemas.list.parse(
      await application.execute("list", query, {
        actor,
        /** ページング試験では呼出元の世代変化を発生させない。 */
        assertCurrent() {},
      }),
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.id),
      ids,
    );
    assert.equal(result.total, total);
    assert.equal(result.hasMore, hasMore);
    for (const entry of result.entries) {
      assert.deepEqual(entry.character, {
        id: "fixture",
        name: "ÉCHO",
        description: entry.kind === "main" ? "公開紹介" : "公開紹介（補助）",
      });
    }
    assert.ok(!JSON.stringify(result).includes("private-fixture-definition"));
  }
  const actor = mainTarget(root);
  await page(
    actor,
    {},
    ["root", "child", "aux-first", "aux-last", "root-aux"],
    5,
    false,
  );
  await page(
    actor,
    { rootSessionId: "other" },
    ["other", "other-aux"],
    2,
    false,
  );
  await page(actor, { rootSessionId: "missing" }, [], 0, false);
  await page(
    actor,
    { rootSessionId: "missing", allCrews: true, offset: 1, limit: 3 },
    ["other", "child", "aux-first"],
    7,
    true,
  );
  await page(
    actor,
    { role: "auxiliary", limit: 1, offset: 1 },
    ["aux-last"],
    3,
    true,
  );
  await page(actor, { role: "executor" }, ["child"], 1, false);
  await page(
    actor,
    { relationship: "created", allCrews: true },
    ["child"],
    1,
    false,
  );
  await page(
    mainTarget(child),
    { relationship: "creator" },
    ["root"],
    1,
    false,
  );
  await page(actor, { relationship: "creator" }, [], 0, false);
  await page(
    actor,
    { searchText: " écho\n公開 " },
    ["root", "child", "aux-first", "aux-last", "root-aux"],
    5,
    false,
  );
  await page(
    actor,
    { searchText: "AUXILIARY TASK" },
    ["aux-first", "aux-last", "root-aux"],
    3,
    false,
  );
  await page(actor, { searchText: "private-fixture-definition" }, [], 0, false);
  await page(actor, { offset: 21, limit: 1 }, [], 5, false);
});

// @test-value v2
// kind = "security"
// claim = "保存Sessionの単体読取は実actorと対象を識別し、Auxiliaryは保存された親Main世代まで照合する"
// oracle = { type = "contract", ref = "https://app.notion.com/4239d4b6f2628041b656c1473047eafe#受け入れ条件" }
// fault = "Auxiliaryの親Mainを照合せず、親の再作成後も古いbindingまたは対象参照を通す"
// observable = "実SQLiteからのself/get内容と、対象・親の古い世代や削除済み対象のエラーコード"
// observation_boundary = "public-boundary"
// scope = "session-management-exact-read"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// @end-test-value
/** Auxiliary の自身読取りと別 actor からの単体読取りが同じ公開データを返し、対象の削除や対象・親の世代不一致を区別して拒否することを確かめる。 */
test("self and exact get distinguish the saved Auxiliary and its parent incarnation", async (t) => {
  const { main, aux, application, mains } = fixture(t);
  const root = main("actor", 3),
    other = main("other", 2);
  const actor = mainTarget(root),
    target = aux("target", other, 1);
  /** 呼出中の actor 更新を再現せず、保存された世代の照合に試験を限定する。 */
  const assertCurrent = () => {};
  /** 例外を Session 管理エラーに限定し、失敗理由を指定のコードで照合する。 */
  const error = (code: string) => (e: unknown) =>
    e instanceof SessionManagementError && e.code === code;
  const self = sessionOperationSuccessSchemas.self.parse(
    await application.execute("self", {}, { actor: target, assertCurrent }),
  );
  const get = sessionOperationSuccessSchemas.get.parse(
    await application.execute("get", { target }, { actor, assertCurrent }),
  );
  assert.deepEqual(get, self);
  assert.deepEqual(self.session, {
    id: target.sessionId,
    incarnationId: date,
    kind: "auxiliary",
    role: "auxiliary",
    sessionRole: "overall-coordinator",
    rootSessionId: other.id,
    parentSessionId: null,
    createdBySessionId: null,
    mainSessionId: other.id,
    mainIncarnationId: target.mainIncarnationId,
    title: "target",
    description: "Auxiliary task",
    workspacePath: "C:/synthetic",
    provider: "codex",
    runState: "idle",
    character: { id: "fixture", name: "ÉCHO", description: "公開紹介（補助）" },
  });
  assert.deepEqual(self.currentTurn, {
    turnId: null,
    receipt: null,
    origin: null,
  });
  assert.equal(self.crewFolder.rootSessionId, other.id);

  for (const wrong of [
    { ...target, incarnationId: "old-aux" },
    { ...target, mainIncarnationId: "old-main" },
    { ...target, mainSessionId: root.id },
  ]) {
    await assert.rejects(
      application.execute("self", {}, { actor: wrong, assertCurrent }),
      error("SESSION_ACTOR_UNAVAILABLE"),
    );
    await assert.rejects(
      application.execute("get", { target: wrong }, { actor, assertCurrent }),
      error("SESSION_REPLACED"),
    );
  }
  mains.deleteSession(other.id);
  await assert.rejects(
    application.execute("get", { target }, { actor, assertCurrent }),
    error("SESSION_NOT_FOUND"),
  );
  const replacement = main(other.id, 4);
  const recreated = aux(target.sessionId, replacement, 1);
  assert.notEqual(recreated.mainIncarnationId, target.mainIncarnationId);
  await assert.rejects(
    application.execute("self", {}, { actor: target, assertCurrent }),
    error("SESSION_ACTOR_UNAVAILABLE"),
  );
  await assert.rejects(
    application.execute("get", { target }, { actor, assertCurrent }),
    error("SESSION_REPLACED"),
  );
});

// @test-value v2
// kind = "contract"
// claim = "最新Auxiliaryの読取は親内のdraft込み最終使用順を維持し、現在のstoreで選んだ会話Viewに実行設定を重ねる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Auxiliaryの一覧の最終使用順; docs/design/auxiliary-session.md#persistence; docs/design/electron-session-store.md#読取と通知" }
// fault = "会話だけの時刻や他の親を採用する、Viewのdraftや実行設定を落とす、store交代後に旧Viewを返す"
// observable = "親別の選択ID、messageCount、会話、draft、modelとstore交代時の拒否"
// observation_boundary = "component-behavior"
// scope = "latest-auxiliary-view"
// lifecycle = "permanent"
// @end-test-value
/** 同じ親の Auxiliary から下書きを含む最終使用順で選び、会話と実行設定を返す一方、読取り中の保存先交代は拒否することを確かめる。 */
test("latest Auxiliary View keeps draft ordering, the right parent and execution overlay", async (t) => {
  const { main, aux, startWorker, unused } = fixture(t);
  const root = main("root", 1),
    other = main("other", 2);
  aux("conversation-newest", root, 60, 10);
  aux("draft-a", root, 1, 70);
  aux("draft-z", root, 2, 70);
  aux("no-draft", root, 90);
  aux("other-parent", other, 100, 100);
  const { stores } = await startWorker();
  const store = {};
  let currentStore = store;
  const service = new AuxiliarySessionService({
    /** 初期化済み Worker の Auxiliary ストアを読取り先にする。 */
    getStorage: () => stores.auxiliary,
    /** 実行設定を重ねるための親 Main として fixture のルートを返す。 */
    getParentSession: () => root,
    /** 最新の会話読取りには Character 一覧を供給しない。 */
    listActiveCharacters: () => [],
    createCharacterRuntimeSnapshot: unused,
    resolveSessionLaunchSelection: unused,
    /** 排他制御の代わりに渡された処理をその場で実行する。 */
    runProviderRuntimeOperationExclusive: async (operation) => operation(),
    /** 読取り開始時の保存先の同一性を識別するオブジェクトを返す。 */
    captureStorageIdentity: () => currentStore,
    /** 読取り中に差し替えた保存先を開始時と同一でないと判定する。 */
    isStorageIdentityCurrent: (identity) => identity === currentStore,
    /** 保存されている設定と区別できるモデルを View に重ねる。 */
    overlayCurrentExecutionOptions: (session) => ({
      ...session,
      model: "overlay-model",
    }),
  });
  const selected = await service.getLatestAuxiliarySessionView(root.id);
  assert.ok(selected);
  assert.equal(selected.id, "draft-z");
  assert.equal(selected.composerDraft, "draft for draft-z");
  assert.equal(selected.messageCount, 1);
  assert.deepEqual(
    selected.messages.map((message) => message.text),
    ["message for draft-z"],
  );
  assert.equal(selected.model, "overlay-model");
  assert.equal(await service.getLatestAuxiliarySessionView("missing"), null);
  const stale = service.getLatestAuxiliarySessionView(root.id);
  currentStore = {};
  await assert.rejects(stale, /storage changed/);
});
