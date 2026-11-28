import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNewSession,
  type Message,
} from "../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryの表示pageは全履歴seqと総件数を維持し、page保存で履歴を失わない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
// fault = "末尾pageを全履歴として保存するかpageのhistoryIndexを局所indexへ置換する"
// observable = "取得pageの件数とhistoryIndex、再取得したfull履歴"
// observation_boundary = "public-boundary"
// scope = "main-and-auxiliary-conversation-storage"
// lifecycle = "permanent"
// impact = "過去会話の不可逆消失と検索・Bookmarkからの移動不能を防ぐ"
// distinction = "既存full read/write testと型検査はpage保存時の切詰めや未取得履歴検索を観測しない。小さいSQLite fixtureで両保存ownerを確認する"
// @end-test-value
/** 親子いずれの履歴でも、末尾ページに全体の位置を残し、ページだけで全履歴を置き換えない。 */
test("会話pageは全履歴seqを維持しfull保存へ流れない", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-conversation-page-"),
  );
  const dbPath = path.join(directory, "app.db");
  const main = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  try {
    const messages: Message[] = Array.from({ length: 135 }, (_, index) => ({
      role: index === 0 ? "user" : "assistant",
      text: index === 3 ? "**needle** needle" : `message ${index}`,
      isBookmarked: index === 4,
    }));
    const session = main.insertSession({
      ...buildNewSession({
        taskTitle: "Pages",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char",
        character: "Character",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "never",
      }),
      messages,
    });
    const aux: AuxiliarySession = {
      id: "aux-pages",
      parentSessionId: session.id,
      runState: "idle",
      title: "",
      preview: "",
      provider: session.provider,
      catalogRevision: session.catalogRevision,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      approvalMode: session.approvalMode,
      codexSandboxMode: session.codexSandboxMode,
      codexSpeed: session.codexSpeed,
      codexReviewer: session.codexReviewer,
      customAgentName: "",
      threadId: "",
      composerDraft: "",
      messages,
      displayAfterMessageIndex: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    };
    auxiliary.upsertAuxiliarySession(aux);
    for (const [storage, id] of [
      [main, session.id],
      [auxiliary, aux.id],
    ] as const) {
      const page = storage.getConversationPage(id)!;
      assert.equal(page.totalCount, 135);
      assert.equal(page.startIndex, 75);
      assert.equal(page.messages.length, 60);
      assert.equal(page.messages[0].historyIndex, 75);
      assert.equal(
        storage.getConversationPage(id, { startIndex: 0 })?.messages[59]
          .historyIndex,
        59,
      );
    }
    const mainView = main.getSessionView(session.id)!;
    assert.equal(mainView.latestUserMessage?.historyIndex, 0);
    assert.throws(() => main.upsertSession(mainView), /paged conversation/);
    assert.throws(
      () =>
        auxiliary.upsertAuxiliarySession(
          auxiliary.getAuxiliarySessionView(aux.id)!,
        ),
      /paged conversation/,
    );
    assert.equal(main.getSession(session.id)?.messages.length, 135);
    assert.equal(auxiliary.getAuxiliarySession(aux.id)?.messages.length, 135);
  } finally {
    auxiliary.close();
    main.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Rendererのpaged Session metadata更新はMain/Auxiliaryの全保存履歴とBookmarkを保持し、別incarnationを拒否する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
// fault = "Rendererの60件本文またはBookmark状態をfull履歴へ置換して過去会話を消失させる"
// observable = "service更新後にSQLiteから再取得したtitle、全message本文・Bookmark、別incarnation更新のrejection"
// observation_boundary = "public-boundary"
// scope = "renderer-metadata-persistence-services"
// lifecycle = "permanent"
// impact = "設定変更による過去会話・Bookmarkの消失と再作成ownerへの古い更新を防ぐ"
// distinction = "storage入口のpage拒否testだけではserviceがfull履歴へmetadataを適用する成功経路を観測しない。実SQLiteを使う小さいfixtureで確認する"
// @end-test-value
/** ページ表示からのタイトル変更は許すが、本文・ブックマークの置換や旧会話からの更新は拒む。 */
test("paged Renderer metadata更新はfull履歴とBookmarkを保持する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-paged-service-"),
  );
  const dbPath = path.join(directory, "app.db");
  const main = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  try {
    const session = main.insertSession({
      ...buildNewSession({
        taskTitle: "Metadata",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "char",
        character: "Character",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "never",
      }),
      messages: Array.from({ length: 80 }, (_, index) => ({
        role: "user",
        text: `original ${index}`,
        isBookmarked: index === 2,
      })),
    });
    const aux: AuxiliarySession = {
      ...session,
      id: "aux-service",
      parentSessionId: session.id,
      runState: "idle",
      title: "Before",
      composerDraft: "",
      displayAfterMessageIndex: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      characterId: "char",
      characterRuntimeSnapshot: {
        characterId: "char",
        name: "Character",
        description: "",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        definitionMarkdown: "# Character",
        definitionSha256: "test",
        definitionByteSize: 11,
        snapshotAt: "2026-10-04T00:00:00.000Z",
      },
    };
    auxiliary.upsertAuxiliarySession(aux);
    let cached = [session];
    const mainService = new SessionPersistenceService({
      /** サービスへ現在の一覧キャッシュを渡す。 */
      getSessions: () => cached,
      /** 更新を後続のサービス呼び出しからも観測できるよう一覧に反映する。 */
      setSessions: (next) => {
        cached = next;
      },
      /** ID に対応する会話をテストの一覧から引く。 */
      getSession: (id) => cached.find((item) => item.id === id) ?? null,
      /** ページ化されていない保存済みの親会話を取得する。 */
      getStoredSession: (id) => main.getSession(id),
      /** 待機中の会話として、実行中でない保存経路を使う。 */
      isSessionRunInFlight: () => false,
      /** 誤って全件保存へ進んでも、実 DB の内容で変化を観測できるようにする。 */
      upsertStoredSession: (next) => main.upsertSession(next),
      patchStoredSessionMetadata: main.patchSessionMetadata.bind(main),
      /** 一覧の一括置換は検証対象から外す。 */
      replaceStoredSessions: () => undefined,
      /** 保存済み一覧を要求する経路には追加の会話を供給しない。 */
      listStoredSessions: () => [],
      /** 利用者による上書きのない既定設定を使う。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** モデル候補に依存しない更新を検証するため、空のカタログを与える。 */
      getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),

      /** 会話更新時の計測状態はこの検証で扱わない。 */
      clearSessionContextTelemetry: () => undefined,

      /** プロバイダーのスレッドへ副作用を及ぼさない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを用意せず、保存サービスだけを動かす。 */
      closeSessionWindow: () => undefined,
      /** 保存結果は再読込で確認し、ウィンドウへの配信は省く。 */
      broadcastSessions: () => undefined,
    });
    const auxService = new AuxiliarySessionService({
      /** 子会話の保存先として同じ実 DB を返す。 */
      getStorage: () => auxiliary,
      /** 子の所有者照合に使う親を保存先から取得する。 */
      getParentSession: (id) => main.getSession(id),
      /** 同時実行を作らないため、子の操作を待ち行列に入れず評価する。 */
      runProviderRuntimeOperationExclusive: async (operation) => operation(),
      /** 会話の更新で起動時の選択が必要になった場合は、想定外として失敗させる。 */
      resolveSessionLaunchSelection: async () => {
        throw new Error("unused");
      },
      /** 既存の定義を使うため、新しい候補は供給しない。 */
      listActiveCharacters: () => [],
      /** 既存会話の更新では新規スナップショットを提供しない。 */
      createCharacterRuntimeSnapshot: () => null,
    });
    const mainView = main.getSessionView(session.id)!;
    const auxView = auxiliary.getAuxiliarySessionView(aux.id)!;
    await mainService.patchSessionMetadata(
      session.id,
      mainView.incarnationId!,
      { title: "After" },
    );
    await auxService.patchAuxiliarySessionMetadata({
      auxiliarySessionId: aux.id,
      parentSessionId: aux.parentSessionId,
      createdAt: aux.createdAt,
      patch: { title: "After" },
    });
    await mainService.updateSession({
      ...mainView,
      taskTitle: "After",
      messages: mainView.messages.map((message) => ({
        ...message,
        text: "paged input must not be stored",
        isBookmarked: false,
      })),
    });
    await auxService.updateAuxiliarySession({
      ...auxView,
      title: "After",
      messages: auxView.messages.map((message) => ({
        ...message,
        text: "paged input must not be stored",
        isBookmarked: false,
      })),
    });
    assert.equal(main.getSession(session.id)?.taskTitle, "After");
    assert.equal(auxiliary.getAuxiliarySession(aux.id)?.title, "After");
    assert.deepEqual(main.getSession(session.id)?.messages, session.messages);
    assert.deepEqual(
      auxiliary.getAuxiliarySession(aux.id)?.messages,
      session.messages,
    );
    await assert.rejects(
      mainService.updateSession({ ...mainView, incarnationId: "other" }),
    );
    await assert.rejects(
      auxService.updateAuxiliarySession({ ...auxView, createdAt: "other" }),
    );
  } finally {
    auxiliary.close();
    main.close();
    await rm(directory, { recursive: true, force: true });
  }
});
