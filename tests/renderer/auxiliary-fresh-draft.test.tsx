import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { useAuxiliaryDraftPersistence } from "../../src/chat/auxiliary/use-auxiliary-draft-persistence.js";
import { runMainSessionTurnOperation } from "../../src/chat/runtime/run-main-session-turn-operation.js";
import { SessionSubmitCoordinator } from "../../src/chat/runtime/session-submit-coordinator.js";
import { SessionTurnAcceptance } from "../../src/chat/runtime/session-turn-acceptance.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { WithMateWindowAuxiliaryApi } from "../../src-shared/ipc/withmate-window-api.js";

// @test-value v2
// kind = "contract"
// claim = "新規Auxiliaryの保存済draftは独立draft incarnationと会話createdAtを維持したまま実renderer Sendからqueue受付へ進み一度だけconsumeする"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Composer の更新・保存境界" }
// fault = "draft UUIDを会話createdAtと比較して保存済入力のSendを拒否するか、受付で保存本文が喪失する"
// observable = "Composer saveStateとACK後clear、Worker draft本文/revision/incarnation、queue receipt state/idと捕捉本文/owner"
// observation_boundary = "public-boundary"
// scope = "新規作成service→実Storage Worker→renderer draft persistence hook→実Send preflight→Worker queue受付"
// lifecycle = "permanent"
// impact = "新規AuxiliaryのSend不能と入力喪失を防ぐ"
// distinction = "既存Worker queue testはSend preflightを迂回し、renderer mockはdraft incarnationを会話incarnationと同値にできる。実作成の異なるidentityを1件の境界testで維持する"
// @end-test-value
/** 新規 Auxiliary の下書きと会話の世代が異なっても、保存本文を実 Worker の待機列に一度だけ渡して消費する。 */
test("新規Auxiliaryの初回draft保存からqueue受付まで成立する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-fresh-auxiliary-"));
  const bundle = createV6StorageWorkerBundle({
    dbPath: join(directory, "withmate-v6.db"),
    userDataPath: directory,
  });
  const dom = new JSDOM("<div id='root'></div>");
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await bundle.initialize();
    const main = await bundle.stores.session.insertSession(
      buildNewSession({
        id: "parent",
        taskTitle: "Draft",
        workspaceLabel: "workspace",
        workspacePath: "C:/workspace",
        branch: "main",
        characterId: "main",
        character: "Main",
        characterIconPath: "",
        characterThemeColors: { main: "#123456", sub: "#abcdef" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
    );
    const service = new AuxiliarySessionService({
      /** Auxiliary 作成の親として保存済み Main を返す。 */ getParentSession:
        async () => main,
      /** 作成および下書きの読み書きを実 Worker に接続する。 */ getStorage:
        () => bundle.stores.auxiliary,
      /** 親の実行設定を使い、新規 Auxiliary の選択内容を確定する。 */
      resolveSessionLaunchSelection: async () => ({
        ...captureSessionExecutionOptions(main),
        provider: main.provider,
        catalogRevision: main.catalogRevision,
        customAgentName: main.customAgentName,
      }),
      /** 並行する操作がないため、渡された作成処理をそのまま実行する。 */
      runProviderRuntimeOperationExclusive: async (operation) => operation(),
      /** 新規 Auxiliary 用の有効な Character を一件だけ提供する。 */
      listActiveCharacters: () => [
        {
          id: "aux-character",
          name: "Aux",
          description: "",
          iconFilePath: "",
          theme: { main: "#123456", sub: "#abcdef" },
          state: "active",
          createdAt: "created",
          updatedAt: "created",
          archivedAt: null,
        },
      ],
      /** 作成時に凍結する Character の定義を固定する。 */
      createCharacterRuntimeSnapshot: async () => ({
        characterId: "aux-character",
        name: "Aux",
        description: "",
        iconFilePath: "",
        theme: { main: "#123456", sub: "#abcdef" },
        definitionMarkdown: "# Aux",
        definitionSha256: "test",
        definitionByteSize: 5,
        snapshotAt: "created",
      }),
    });
    const auxiliary = await service.createAuxiliarySession({
      parentSessionId: main.id,
      provider: main.provider,
      runtimeSelection: "latest-session",
    });
    /** 下書き保存と送信受付に不要な API が呼ばれれば失敗とする。 */
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected Auxiliary API call.");
    };
    const api: WithMateWindowAuxiliaryApi = {
      /** 対象の Auxiliary で保存されている下書きをサービスから読む。 */
      getAuxiliaryDraft: (id) => service.getAuxiliaryDraft(id),
      /** 対象の Auxiliary の現在状態をサービスから返す。 */ getAuxiliarySessionStatus:
        (id) => service.getAuxiliarySessionStatus(id),
      /** フックによる下書きの保存要求を実サービスに渡す。 */
      saveAuxiliaryDraft: (input) => service.saveAuxiliaryDraft(input),
      listAuxiliarySessions: unused,
      listOpenAuxiliarySessionSummaries: unused,
      getLatestAuxiliarySession: unused,
      getAuxiliarySession: unused,
      createAuxiliarySession: unused,
      getAuxiliaryCreationContext: unused,
      cancelAuxiliaryCreation: unused,
      getAuxiliaryCreation: unused,
      updateAuxiliarySession: unused,
      setAuxiliaryExecutionOptions: unused,
      setAuxiliaryTitle: unused,
      setAuxiliaryMessageBookmark: unused,
      runAuxiliarySessionTurn: unused,
      steerAuxiliarySessionTurn: unused,
      cancelAuxiliarySessionRun: unused,
    };
    const registry = new ComposerControllerRegistry();
    let persistence!: ReturnType<typeof useAuxiliaryDraftPersistence>;
    /** 実フックを React のライフサイクルで動かし、その操作を外から利用できるようにする。 */
    function Harness() {
      persistence = useAuxiliaryDraftPersistence({
        api,
        composerRegistry: registry,
        /** 履歴の最近表示はこの永続化テストでは更新しない。 */ touchRecency:
          () => undefined,
        /** 編集が凍結されていない状態で初回保存を試す。 */ isFrozen: () =>
          false,
      });
      return null;
    }
    await act(async () =>
      root.render(
        <React.StrictMode>
          <Harness />
        </React.StrictMode>,
      ),
    );
    await persistence.changeDraft(auxiliary, "テストメッセージ", 9);
    const composerOwner = { kind: "auxiliary" as const, id: auxiliary.id };
    assert.equal(registry.get(composerOwner).saveState, "saved");
    const durable = persistence.getOwner(auxiliary)!.durableRecord!;
    assert.equal(durable.text, "テストメッセージ");
    assert.equal(durable.durableRevision, 1);
    assert.notEqual(durable.incarnation, auxiliary.createdAt);
    const owner = {
      sessionId: auxiliary.id,
      incarnationId: auxiliary.createdAt,
    };
    const requestId = randomUUID();
    const receipt = await runMainSessionTurnOperation({
      api: {
        /** 本文だけの送信を試すため、添付とプレビューエラーはないものとする。 */ previewComposerInput:
          async () => ({ attachments: [], errors: [] }),
        /** 送信前検査を通った要求を実 Worker の待機列へ渡す。 */
        enqueueSessionTurn: (id, request) => {
          assert.ok(request.clientRequestId);
          return bundle.stores.queue.enqueue(
            { sessionId: id, incarnationId: request.incarnationId },
            {
              request: { ...request, clientRequestId: request.clientRequestId },
              provider: auxiliary.provider,
              workspacePath: main.workspacePath,
              attachments: [],
            },
          );
        },
        /** 同じ会話と要求 ID で保存された受付結果を取得する。 */
        getSessionTurnQueueReceipt: (id, requestId) =>
          bundle.stores.queue.getReceipt(
            { ...owner, sessionId: id },
            requestId,
          ),
      },
      sessionId: auxiliary.id,
      selectedSession: {
        ...main,
        id: auxiliary.id,
        incarnationId: auxiliary.createdAt,
      },
      request: {
        userMessage: durable.text,
        clientRequestId: requestId,
        submitSource: "composer",
        executionOptions: captureSessionExecutionOptions(auxiliary),
      },
      composerRegistry: registry,
      composerOwner,
      submitCoordinator: new SessionSubmitCoordinator(),
      acceptance: new SessionTurnAcceptance(),
      auxiliaryDraftOwner: persistence.getOwner(auxiliary)!,
      queueTurn: true,
      clearDraft: true,
      collapseActionDock: false,
      selectedSessionRunState: "idle",
      blockedReason: null,
      isReadOnly: false,
      /** Workspace の妥当性は成立済みとし、下書きの識別に集中する。 */ validateWorkspace:
        async () => true,
      state: {
        /** 送信前のプレビューを Auxiliary の入力管理に反映する。 */ setComposerPreview:
          (preview) => registry.setPreview(composerOwner, preview),
        /** 送信中表示は使わず、保存状態と受付結果を観測する。 */ onSubmitStateChanged() {},
        /** ブロック時の表示は収集せず、受付の有無を検査する。 */
        setForceComposerBlockedFeedback() {},
        /** 操作ドックの開閉はこの送信で変更しない。 */ collapseActionDock() {},
      },
      /** ログの代わりに実 Worker の受付内容を観測する。 */ log() {},
    });
    assert.ok(receipt);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.incarnationId, auxiliary.createdAt);
    assert.equal(
      receipt.captured.request.auxiliaryDraftIncarnation,
      durable.incarnation,
    );
    assert.equal(receipt.captured.request.userMessage, "テストメッセージ");
    assert.equal(registry.get(composerOwner).draft, "");
    assert.notEqual(registry.get(composerOwner).saveState, "error");
    assert.equal(
      (await bundle.stores.auxiliary.getAuxiliaryDraft(auxiliary.id))?.text,
      "",
    );
    assert.equal(
      (await bundle.stores.queue.enqueue(owner, receipt.captured)).id,
      receipt.id,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await bundle.client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
