import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { ConversationQueryCoordinator } from "../../src-electron/storage/conversation-query-coordinator.js";
import type { ConversationQuerySnapshot } from "../../src-electron/storage/conversation-query.js";
import { buildNewSession, type Message } from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "withmate-conversation-query-"));
  const options = { dbPath: join(directory, "withmate-v6.db"), userDataPath: directory,
    bundledModelCatalogPath: join(process.cwd(), "public", "model-catalog.json") };
  const bundle = createV6StorageWorkerBundle(options);
  await bundle.initialize();
  const session = await bundle.stores.session.insertSession({ ...buildNewSession({ taskTitle: "Query", workspaceLabel: "workspace",
    workspacePath: "C:/workspace", branch: "main", characterId: "char", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "never" }),
    messages: Array.from({ length: 135 }, (_, index): Message => ({ role: index === 0 ? "user" : "assistant",
      text: index === 3 ? "**needle** needle ![hidden](hidden.png)" : `message ${index} needle`, isBookmarked: index === 4 })) });
  const auxiliary: AuxiliarySession = { ...session, id: "query-aux", parentSessionId: session.id, status: "active", runState: "idle",
    title: "Query aux", preview: "", composerDraft: "", displayAfterMessageIndex: null,
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", closedAt: "" };
  await bundle.stores.auxiliary.upsertAuxiliarySession(auxiliary);
  return { directory, options, bundle, session, auxiliary, close: async () => { await bundle.client.close(); await rm(directory, { recursive: true, force: true }); } };
}

// @test-value v2
// kind = "contract"
// claim = "Main／AuxiliaryのどちらがCodexでも全履歴検索とnavigatorは各ownerのproviderで固有参照を投影し、Sourceを保持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "workerへproviderが届かないか親のproviderをAuxiliaryへ流用し、非表示属性が検索されるか他providerの本文を失う"
// observable = "実storage Workerから取得するpreview／Sourceの検索件数とnavigatorのpreview"
// observation_boundary = "public-boundary"
// scope = "Main／Auxiliary query ownerのprovider伝播"
// lifecycle = "permanent"
// impact = "表示と全履歴検索の一致が崩れ、誤った検索結果や要約を返す"
// distinction = "共有parser testと型検査ではDB ownerからCPU Workerまでの伝播を通らない。小さい2ownerのSQLite fixtureでCodex／非Codexの配置を入れ替えて確認する"
// @end-test-value
test("全履歴投影は会話ownerごとのproviderを使う", async () => {
  const text = 'visualize{"path":"/work/chart.html","title":"Hidden Title"}';
  for (const [mainProvider, auxiliaryProvider] of [["codex", "claude"], ["claude", "codex"]] as const) {
    const f = await fixture();
    try {
      await f.bundle.stores.session.upsertSession({ ...f.session, provider: mainProvider, messages: [{ role: "assistant", text }] });
      await f.bundle.stores.auxiliary.upsertAuxiliarySession({ ...f.auxiliary, provider: auxiliaryProvider, messages: [{ role: "assistant", text }] });
      for (const [store, id, isCodex] of [
        [f.bundle.stores.session, f.session.id, mainProvider === "codex"],
        [f.bundle.stores.auxiliary, f.auxiliary.id, auxiliaryProvider === "codex"],
      ] as const) {
        for (const mode of ["preview", "source"] as const) {
          const result = await store.searchConversation(id, { producerId: id, requestId: `${id}-${mode}`, query: "Hidden Title", mode });
          assert.equal(result.status, "complete");
          if (result.status !== "complete") throw new Error("missing provider search result");
          assert.equal(result.totalCount, isCodex && mode === "preview" ? 0 : 1);
        }
        const navigator = await store.listConversationNavigator(id, { producerId: id, requestId: `${id}-navigator`, filter: "all" });
        assert.equal(navigator.status, "complete");
        if (navigator.status !== "complete") throw new Error("missing provider navigator result");
        assert.equal(navigator.items[0]?.preview, isCodex ? "/work/chart.html" : text);
      }
    } finally { await f.close(); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Worker検索はMain/Auxiliary全履歴のsourceとpreview意味・seq・occurrenceを維持し、任意offsetを同じstampで64件以内に返す"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
// fault = "末尾会話だけを検索するか全matchを一度に返すかMarkdown非表示要素をpreview matchへ含める"
// observable = "実Workerから取得したtotalCount、64件page、stamp再取得page、source/preview件数、navigator Bookmarkとpreview"
// observation_boundary = "public-boundary"
// scope = "v6-storage-worker-conversation-query"
// lifecycle = "permanent"
// impact = "過去検索とBookmark移動の欠落、Rendererへの巨大結果転送を防ぐ"
// distinction = "同期page storage testや型検査ではCPU Worker・専用command・全履歴paged query結果を観測できない。小SQLite fixtureの実Workerを利用する"
// @end-test-value
test("実Worker検索は全履歴の意味と有限pageを維持する", async () => {
  const f = await fixture();
  try {
    for (const [store, id] of [[f.bundle.stores.session, f.session.id], [f.bundle.stores.auxiliary, f.auxiliary.id]] as const) {
      const req = { requestId: `find-${id}`, producerId: `window-1:${id}`, query: "needle", mode: "preview" as const };
      const first = await store.searchConversation(id, req);
      assert.equal(first.status, "complete");
      if (first.status !== "complete") throw new Error("missing query page");
      assert.equal(first.messageCount, 135);
      assert.equal(first.totalCount, 136);
      assert.equal(first.items.length, 64);
      assert.deepEqual(first.items.slice(3, 5), [{ messageIndex: 3, occurrenceIndex: 0 }, { messageIndex: 3, occurrenceIndex: 1 }]);
      const tail = await store.searchConversation(id, { ...req, offset: 130, stamp: first.stamp });
      assert.equal(tail.status, "complete");
      if (tail.status !== "complete") throw new Error("missing tail page");
      assert.deepEqual(tail.stamp, first.stamp);
      assert.equal(tail.items.length, 6);
      assert.equal(tail.items.at(-1)?.messageIndex, 134);
      const neighbors = await Promise.all([0, 64, 128].map((offset) => store.searchConversation(id, { ...req, offset, stamp: first.stamp })));
      assert.deepEqual(neighbors.map((page) => page.status), ["complete", "complete", "complete"]);
      assert.deepEqual(neighbors.map((page) => page.status === "complete" ? page.items.length : 0), [64, 64, 8]);
      const again = await store.searchConversation(id, { ...req, stamp: first.stamp });
      assert.deepEqual(again, first);
      const unicode = await store.searchConversation(id, { ...req, requestId: "unicode", query: "MESSAGE", mode: "source" });
      assert.equal(unicode.status, "complete");
      if (unicode.status === "complete") assert.equal(unicode.totalCount, 134);
      for (const mode of ["source", "preview"] as const) {
        const hidden = await store.searchConversation(id, { ...req, requestId: `hidden-${mode}`, query: "hidden", mode });
        assert.equal(hidden.status, "complete");
        if (hidden.status === "complete") assert.equal(hidden.totalCount, mode === "source" ? 2 : 0);
      }
      const bookmarks = await store.listConversationNavigator(id, { producerId: req.producerId, requestId: "bookmarks", filter: "bookmarks" });
      assert.equal(bookmarks.status, "complete");
      if (bookmarks.status === "complete") {
        assert.equal(bookmarks.totalCount, 1);
        assert.deepEqual(bookmarks.items, [{ messageIndex: 4, role: "assistant", preview: "message 4 needle", accent: false, isBookmarked: true }]);
      }
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "全履歴queryのPromiseはDB tailを所有せず、検索開始後の無関係なmetadata更新がquery完了前に返る"
// oracle = { type = "contract", ref = "docs/design/v6-database-foundation.md#runtime-ownerとschema" }
// fault = "conversation query全体を通常DB commandの直列tailへ入れてmetadata更新を待たせる"
// observable = "実Workerへの検索とtitle更新の完了event順序と保存されたtitle"
// observation_boundary = "public-boundary"
// scope = "storage-worker-query-and-db-command-isolation"
// lifecycle = "permanent"
// impact = "検索による保存・一覧・別操作のhead-of-line待ちを防ぐ"
// distinction = "型検査と同期store testはWorker tailの占有を検出しない。実Workerで完了順序を確認するため機器速度の閾値を必要としない"
// @end-test-value
test("query全体は通常DB commandのtailを占有しない", async () => {
  const f = await fixture();
  try {
    const events: string[] = [];
    const search = f.bundle.stores.session.searchConversation(f.session.id,
      { producerId: "window-1:isolation", requestId: "isolation", query: "needle", mode: "preview" }).then((result) => { events.push("query"); return result; });
    const update = f.bundle.stores.session.setSessionTitle(f.session.id, f.session.incarnationId!, "Independent metadata").then(() => { events.push("metadata"); });
    const [result] = await Promise.all([search, update]);
    assert.equal(result.status, "complete");
    assert.deepEqual(events, ["metadata", "query"]);
    assert.equal((await f.bundle.stores.session.getSessionSummary(f.session.id))?.taskTitle, "Independent metadata");
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "単独の256KiB超本文と大量occurrenceも無断で切らず全件数を数え、64件pageと160codepoint navigator previewを返す"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
// fault = "batch byte上限で巨大本文を切り捨てるかoccurrence上限で件数を減らすかpreviewをUTF-16単位で切る"
// observable = "巨大本文検索のtotalCountと末尾offset page、絵文字previewのcodepoint件数と末尾記号"
// observation_boundary = "public-boundary"
// scope = "v6-query-large-message-and-unicode-preview"
// lifecycle = "permanent"
// impact = "長い会話の検索漏れとpreviewの文字破損、巨大結果転送を防ぐ"
// distinction = "135件の小本文fixtureはbyte上限超過も一本文内の大量matchも検証しない。実Workerで1MiBのsourceを利用し巨大match配列をoracleに作らない"
// @end-test-value
test("巨大な単独本文を切らず大量matchを有限pageで返す", async () => {
  const f = await fixture();
  try {
    await f.bundle.stores.session.upsertSession({ ...f.session, messages: [{ role: "user", text: "😀".repeat(200) },
      { role: "assistant", text: "a".repeat(1024 * 1024) }] });
    const req = { producerId: "window-1:large", requestId: "large", query: "a", mode: "source" as const };
    const first = await f.bundle.stores.session.searchConversation(f.session.id, req);
    if (first.status !== "complete") throw new Error("missing large page");
    assert.equal(first.totalCount, 1024 * 1024);
    assert.equal(first.items.length, 64);
    const tail = await f.bundle.stores.session.searchConversation(f.session.id, { ...req, offset: 1024 * 1024 - 3, stamp: first.stamp });
    if (tail.status !== "complete") throw new Error("missing large tail");
    assert.deepEqual(tail.items, [0, 1, 2].map((index) => ({ messageIndex: 1, occurrenceIndex: 1024 * 1024 - 3 + index })));
    const nav = await f.bundle.stores.session.listConversationNavigator(f.session.id,
      { producerId: "window-1:nav", requestId: "unicode-preview", filter: "all" });
    if (nav.status !== "complete") throw new Error("missing Unicode preview");
    assert.equal(Array.from(nav.items[0].preview).length, 160);
    assert.equal(nav.items[0].preview, `${"😀".repeat(159)}…`);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "別会話やmetadataの変更はquery stampを維持し、対象本文・Bookmark・削除再作成とgeneration交換では古いstampを失効させる"
// oracle = { type = "contract", ref = "docs/design/v6-database-foundation.md#runtime-ownerとschema" }
// fault = "全mutationでqueryを失効させるか対象の変更後も古い結果pageを再公開する"
// observable = "metadata変更後のcompleteと本文・Bookmark・再作成・reopen後のinvalidated outcome"
// observation_boundary = "public-boundary"
// scope = "v6-query-owner-revision-and-generation"
// lifecycle = "permanent"
// impact = "実行中の別会話による検索取消と古い会話結果への移動を防ぐ"
// distinction = "SQL保存testや型検査はquery cacheのtarget revisionとgeneration寿命を観測しない。実Workerの操作結果を確認する"
// @end-test-value
test("query stampは対象revisionとgenerationだけに従う", async () => {
  const f = await fixture();
  try {
    const store = f.bundle.stores.session;
    const req = { requestId: "revision", producerId: "window-1:find", query: "needle", mode: "source" as const };
    const first = await store.searchConversation(f.session.id, req);
    if (first.status !== "complete") throw new Error("missing query page");
    await store.setSessionTitle(f.session.id, f.session.incarnationId!, "Metadata only");
    await f.bundle.stores.auxiliary.upsertAuxiliarySession({ ...f.auxiliary, messages: [{ role: "user", text: "unrelated change" }] });
    assert.equal((await store.searchConversation(f.session.id, { ...req, stamp: first.stamp })).status, "complete");
    await store.upsertSession({ ...f.session, taskTitle: "Metadata write", runState: "running" });
    assert.equal((await store.searchConversation(f.session.id, { ...req, stamp: first.stamp })).status, "complete");
    await store.setSessionMessageBookmark(f.session.id, f.session.incarnationId!, 3, true);
    assert.deepEqual(await store.searchConversation(f.session.id, { ...req, stamp: first.stamp }), { status: "invalidated" });
    const next = await store.searchConversation(f.session.id, { ...req, requestId: "next" });
    if (next.status !== "complete") throw new Error("missing replacement page");
    await store.upsertSession({ ...f.session, messages: [{ role: "user", text: "replacement" }] });
    assert.equal((await store.searchConversation(f.session.id, { ...req, requestId: "next", stamp: next.stamp })).status, "invalidated");
    const auxReq = { ...req, producerId: "window-1:aux", requestId: "aux-revision" };
    const auxFirst = await f.bundle.stores.auxiliary.searchConversation(f.auxiliary.id, auxReq);
    if (auxFirst.status !== "complete") throw new Error("missing aux page");
    await f.bundle.stores.auxiliary.deleteAuxiliarySessionsForParent(f.session.id);
    await f.bundle.stores.auxiliary.upsertAuxiliarySession(f.auxiliary);
    assert.equal((await f.bundle.stores.auxiliary.searchConversation(f.auxiliary.id, { ...auxReq, stamp: auxFirst.stamp })).status, "invalidated");
    await f.bundle.client.close();
    const reopened = createV6StorageWorkerBundle(f.options);
    try {
      await reopened.initialize();
      assert.equal((await reopened.stores.session.searchConversation(f.session.id, { ...req, stamp: first.stamp })).status, "invalidated");
    } finally { await reopened.client.close(); }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "Main/Auxiliaryの開始・steer・terminal appendは同ownerのqueryを失効させ新しい本文を検索へ反映し、runtime metadata checkpointはstampを維持する"
// oracle = { type = "contract", ref = "docs/design/v6-database-foundation.md#runtime-ownerとschema" }
// fault = "append commandがquery revision通知を欠いて古いpageとCPU投影を再利用するかmetadata checkpointが本文queryを取り消す"
// observable = "実Workerのappend後invalidated outcomeと再検索の件数・末尾seq、checkpoint後の同stamp complete"
// observation_boundary = "public-boundary"
// scope = "v6-storage-worker-runtime-append-query-revision"
// lifecycle = "permanent"
// impact = "実行中の追加入力と確定応答が検索から欠落すること、本文不変の更新による不要な検索取消を防ぐ"
// distinction = "full upsertやBookmarkのquery testはmetadata-only runtimeのappend経路を通らず、append保存testはquery cacheの寿命を観測しない。小SQLite fixtureで実Workerの結果を検査する"
// @end-test-value
test("runtime appendはqueryを失効させcheckpointは維持する", async () => {
  const f = await fixture();
  try {
    await f.bundle.stores.auxiliary.upsertAuxiliarySession({ ...f.auxiliary,
      characterId: undefined, characterRuntimeSnapshot: undefined, characterRuntimeSnapshotInvalid: false });
    for (const kind of ["main", "auxiliary"] as const) {
      const isMain = kind === "main";
      const store = isMain ? f.bundle.stores.session : f.bundle.stores.auxiliary;
      const id = isMain ? f.session.id : f.auxiliary.id;
      let requestIndex = 0;
      const request = () => ({ producerId: `window-1:append-${kind}`, requestId: `append-${requestIndex++}`,
        query: "needle", mode: "source" as const });
      const assertAppendInvalidates = async (append: () => Promise<unknown>) => {
        const req = request();
        const before = await store.searchConversation(id, req);
        if (before.status !== "complete") throw new Error("missing pre-append query");
        assert.ok(await append());
        assert.deepEqual(await store.searchConversation(id, { ...req, stamp: before.stamp }), { status: "invalidated" });
        const afterReq = request();
        const after = await store.searchConversation(id, { ...afterReq, offset: before.totalCount });
        if (after.status !== "complete") throw new Error("missing post-append query");
        assert.equal(after.totalCount, before.totalCount + 1);
        assert.equal(after.messageCount, before.messageCount + 1);
        assert.deepEqual(after.items, [{ messageIndex: before.messageCount, occurrenceIndex: 0 }]);
      };
      const auxiliaryOwner = { auxiliarySessionId: id, parentSessionId: f.session.id,
        createdAt: f.auxiliary.createdAt, updatedAt: f.auxiliary.updatedAt };
      const mainOwner = { sessionId: id, incarnationId: f.session.incarnationId! };
      await assertAppendInvalidates(() => isMain
        ? f.bundle.stores.session.appendRunningTurnStart({ ...mainOwner, expectedMessageCount: 135,
          userMessage: { role: "user", text: "start needle" }, updatedAt: f.auxiliary.updatedAt })
        : f.bundle.stores.auxiliary.appendAuxiliaryRunningTurnStart({ ...auxiliaryOwner, expectedMessageCount: 135,
          userMessage: { role: "user", text: "start needle" } }));
      const turn = await f.bundle.stores.turn.createSessionTurn({ sessionId: id, phase: "running",
        provider: f.session.provider, model: f.session.model, reasoningEffort: f.session.reasoningEffort,
        approvalMode: f.session.approvalMode, userMessageSeq: 135, threadId: "", errorMessage: "", createdAt: f.auxiliary.updatedAt });
      const checkpointReq = request();
      const checkpointQuery = await store.searchConversation(id, checkpointReq);
      if (checkpointQuery.status !== "complete") throw new Error("missing checkpoint query");
      if (isMain) {
        assert.ok(await f.bundle.stores.session.checkpointSessionRunMetadata({ ...mainOwner,
          expected: { status: "running", runState: "running", threadId: "" },
          next: { status: "running", runState: "running", threadId: "checkpoint", updatedAt: f.auxiliary.updatedAt } }));
      } else {
        assert.ok(await f.bundle.stores.auxiliary.checkpointAuxiliaryRuntimeMetadata({ ...auxiliaryOwner,
          expectedMessageCount: 136, provider: f.auxiliary.provider, expectedThreadId: "", expectedRunState: "running",
          threadId: "checkpoint", runState: "running" }));
      }
      const unchanged = await store.searchConversation(id, { ...checkpointReq, stamp: checkpointQuery.stamp });
      assert.equal(unchanged.status, "complete");
      if (unchanged.status === "complete") assert.deepEqual(unchanged.stamp, checkpointQuery.stamp);
      await assertAppendInvalidates(() => isMain
        ? f.bundle.stores.session.appendSessionSteer({ ...mainOwner, expectedMessageCount: 136,
          userMessage: { role: "user", text: "steer needle" }, turnId: turn.id, updatedAt: f.auxiliary.updatedAt })
        : f.bundle.stores.auxiliary.appendAuxiliarySteer({ ...auxiliaryOwner, expectedMessageCount: 136,
          userMessage: { role: "user", text: "steer needle" }, turnId: turn.id }));
      const terminalCommit = { sessionId: id, turnId: turn.id, phase: "completed" as const, assistantMessageSeq: 137,
        threadId: "checkpoint", completedAt: f.auxiliary.updatedAt, errorMessage: "" };
      await assertAppendInvalidates(() => isMain
        ? f.bundle.stores.session.appendSessionTerminal({ ...mainOwner, expectedMessageCount: 137,
          assistantMessage: { role: "assistant", text: "terminal needle" }, terminalCommit,
          metadata: { status: "saved", runState: "idle", threadId: "checkpoint", updatedAt: f.auxiliary.updatedAt } })
        : f.bundle.stores.auxiliary.appendAuxiliaryTerminal({ ...auxiliaryOwner, expectedMessageCount: 137,
          assistantMessage: { role: "assistant", text: "terminal needle" }, terminalCommit,
          runState: "idle", threadId: "checkpoint", preview: "terminal needle" }));
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "同producer最新queryと取消はobsolete CPU処理を停止して後継を進め、異なるrequestIdの取消は後継を止めない"
// oracle = { type = "contract", ref = "docs/design/v6-database-foundation.md#runtime-ownerとschema" }
// fault = "古いCPU処理を後継が待ち続けるか古いIDのcancelが最新queryを取り消す"
// observable = "obsolete queryのcancelled、新queryのcomplete、CPUが停止しない場合の試験deadline超過"
// observation_boundary = "component-behavior"
// scope = "generation-local-conversation-query-coordinator"
// lifecycle = "permanent"
// impact = "入力変更・Window閉鎖後のobsolete検索による長時間待ちを防ぐ"
// distinction = "通常の高速Markdown fixtureではhard-stop期限とlatest集約の欠陥を検出できない。専用CPU-only fixtureを実Workerとして使用する"
// @end-test-value
test("latestとcancelはobsolete CPU Workerを停止して後継を進める", { timeout: 10000 }, async () => {
  const snapshot: ConversationQuerySnapshot = { ownerIdentity: "test-owner", provider: "codex", incarnationId: "test-incarnation", messageCount: 1 };
  const reader = { getConversationQuerySnapshot: () => snapshot,
    readConversationQueryBatch: (_id: string, after: number) => after < 0 ? [{ seq: 0, role: "user", body: JSON.stringify({ text: "needle" }) }] : [] };
  const coordinator = new ConversationQueryCoordinator("test-generation", { session_messages_v6: reader, auxiliary_session_messages: reader },
    new URL("./fixtures/conversation-obsolete-cpu-worker.ts", import.meta.url));
  try {
    const old = coordinator.request("session_messages_v6", "main", { requestId: "old", producerId: "window-1:find", query: "obsolete", mode: "preview" }, "search", async (read) => read());
    await new Promise((resolve) => setTimeout(resolve, 750));
    const latest = coordinator.request("session_messages_v6", "main", { requestId: "latest", producerId: "window-1:find", query: "needle", mode: "source" }, "search", async (read) => read());
    coordinator.cancel({ requestId: "old", producerId: "window-1:find" });
    assert.deepEqual(await old, { status: "cancelled" });
    const result = await latest;
    assert.equal(result.status, "complete");
    if (result.status === "complete") assert.deepEqual(result.items, [{ messageIndex: 0, occurrenceIndex: 0 }]);
    const active = coordinator.request("session_messages_v6", "main", { requestId: "close", producerId: "window-1:find", query: "obsolete", mode: "preview" }, "search", async (read) => read());
    await new Promise((resolve) => setTimeout(resolve, 100));
    await coordinator.close();
    assert.deepEqual(await active, { status: "invalidated" });
  } finally { await coordinator.close(); }
});
