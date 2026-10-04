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
// claim = "Main/Auxiliaryの表示pageは全履歴seqと総件数を維持し、未取得範囲の検索とBookmark移動を提供し、page保存で履歴を失わない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#storage-overview" }
// fault = "pageを全履歴として保存するか検索・navigatorを末尾pageへ限定する"
// observable = "取得pageの件数とhistoryIndex、検索match、navigator bookmark、再取得したfull履歴"
// observation_boundary = "public-boundary"
// scope = "main-and-auxiliary-conversation-storage"
// lifecycle = "permanent"
// impact = "過去会話の不可逆消失と検索・Bookmarkからの移動不能を防ぐ"
// distinction = "既存full read/write testと型検査はpage保存時の切詰めや未取得履歴検索を観測しない。小さいSQLite fixtureで両保存ownerを確認する"
// @end-test-value
test("会話pageは全履歴検索とseqを維持しfull保存へ流れない", async () => {
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
      status: "active",
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
      allowedAdditionalDirectories: [],
      threadId: "",
      composerDraft: "",
      messages,
      displayAfterMessageIndex: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      closedAt: "",
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
      assert.deepEqual(
        storage.searchConversation(id, { query: "needle", mode: "preview" }),
        [
          { messageIndex: 3, occurrenceIndex: 0 },
          { messageIndex: 3, occurrenceIndex: 1 },
        ],
      );
      assert.equal(
        storage
          .listConversationNavigator(id)
          .find((entry) => entry.messageIndex === 4)?.isBookmarked,
        true,
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
      status: "active",
      runState: "idle",
      title: "Before",
      composerDraft: "",
      displayAfterMessageIndex: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      closedAt: "",
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
      getSessions: () => cached,
      setSessions: (next) => {
        cached = next;
      },
      getSession: (id) => cached.find((item) => item.id === id) ?? null,
      getStoredSession: (id) => main.getSession(id),
      isSessionRunInFlight: () => false,
      upsertStoredSession: (next) => main.upsertSession(next),
      replaceStoredSessions: () => undefined,
      listStoredSessions: () => [],
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),
      syncSessionDependencies: () => undefined,
      clearSessionContextTelemetry: () => undefined,
      clearSessionBackgroundActivities: () => undefined,
      invalidateProviderSessionThread: () => undefined,
      closeSessionWindow: () => undefined,
      broadcastSessions: () => undefined,
    });
    const auxService = new AuxiliarySessionService({
      getStorage: () => auxiliary,
      getParentSession: (id) => main.getSession(id),
      runProviderRuntimeOperationExclusive: async (operation) => operation(),
      resolveSessionLaunchSelection: async () => {
        throw new Error("unused");
      },
      listActiveCharacters: () => [],
      createCharacterRuntimeSnapshot: () => null,
    });
    const mainView = main.getSessionView(session.id)!;
    const auxView = auxiliary.getAuxiliarySessionView(aux.id)!;
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
