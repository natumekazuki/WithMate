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
test("新規Auxiliaryの初回draft保存からqueue受付まで成立する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "withmate-fresh-auxiliary-"));
  const bundle = createV6StorageWorkerBundle({ dbPath: join(directory, "withmate-v6.db"), userDataPath: directory });
  const dom = new JSDOM("<div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await bundle.initialize();
    const main = await bundle.stores.session.insertSession(buildNewSession({ id: "parent", taskTitle: "Draft",
      workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "main",
      character: "Main", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#abcdef" },
      approvalMode: DEFAULT_APPROVAL_MODE }));
    const service = new AuxiliarySessionService({ getParentSession: async () => main, getStorage: () => bundle.stores.auxiliary,
      resolveSessionLaunchSelection: async () => ({ ...captureSessionExecutionOptions(main), provider: main.provider,
        catalogRevision: main.catalogRevision, customAgentName: main.customAgentName }),
      runProviderRuntimeOperationExclusive: async (operation) => operation(),
      listActiveCharacters: () => [{ id: "aux-character", name: "Aux", description: "", iconFilePath: "",
        theme: { main: "#123456", sub: "#abcdef" }, state: "active", createdAt: "created", updatedAt: "created", archivedAt: null }],
      createCharacterRuntimeSnapshot: async () => ({ characterId: "aux-character", name: "Aux", description: "", iconFilePath: "",
        theme: { main: "#123456", sub: "#abcdef" }, definitionMarkdown: "# Aux", definitionSha256: "test",
        definitionByteSize: 5, snapshotAt: "created" }) });
    const auxiliary = await service.createAuxiliarySession({ parentSessionId: main.id, provider: main.provider, runtimeSelection: "latest-session" });
    const unused = async (): Promise<never> => { throw new Error("Unexpected Auxiliary API call."); };
    const api: WithMateWindowAuxiliaryApi = {
      getAuxiliaryDraft: (id) => service.getAuxiliaryDraft(id), getAuxiliarySessionStatus: (id) => service.getAuxiliarySessionStatus(id),
      saveAuxiliaryDraft: (input) => service.saveAuxiliaryDraft(input),
      listAuxiliarySessions: unused, listOpenActiveAuxiliarySessionSummaries: unused,
      getActiveAuxiliarySession: unused, getAuxiliarySession: unused, createAuxiliarySession: unused,
      getAuxiliaryCreationContext: unused, cancelAuxiliaryCreation: unused, getAuxiliaryCreation: unused,
      updateAuxiliarySession: unused, setAuxiliaryExecutionOptions: unused, setAuxiliaryTitle: unused,
      setAuxiliaryMessageBookmark: unused, closeAuxiliarySession: unused, runAuxiliarySessionTurn: unused,
      steerAuxiliarySessionTurn: unused, cancelAuxiliarySessionRun: unused,
    };
    const registry = new ComposerControllerRegistry();
    let persistence!: ReturnType<typeof useAuxiliaryDraftPersistence>;
    function Harness() {
      persistence = useAuxiliaryDraftPersistence({ api, composerRegistry: registry, touchRecency: () => undefined, isFrozen: () => false });
      return null;
    }
    await act(async () => root.render(<React.StrictMode><Harness /></React.StrictMode>));
    await persistence.changeDraft(auxiliary, "テストメッセージ", 9);
    const composerOwner = { kind: "auxiliary" as const, id: auxiliary.id };
    assert.equal(registry.get(composerOwner).saveState, "saved");
    const durable = persistence.getOwner(auxiliary)!.durableRecord!;
    assert.equal(durable.text, "テストメッセージ");
    assert.equal(durable.durableRevision, 1);
    assert.notEqual(durable.incarnation, auxiliary.createdAt);
    const owner = { sessionId: auxiliary.id, incarnationId: auxiliary.createdAt };
    const requestId = randomUUID();
    const receipt = await runMainSessionTurnOperation({
      api: { previewComposerInput: async () => ({ attachments: [], errors: [] }),
        enqueueSessionTurn: (id, request) => {
          assert.ok(request.clientRequestId);
          return bundle.stores.queue.enqueue({ sessionId: id, incarnationId: request.incarnationId },
            { request: { ...request, clientRequestId: request.clientRequestId }, provider: auxiliary.provider, workspacePath: main.workspacePath, attachments: [] });
        },
        getSessionTurnQueueReceipt: (id, requestId) => bundle.stores.queue.getReceipt({ ...owner, sessionId: id }, requestId) },
      sessionId: auxiliary.id, selectedSession: { ...main, id: auxiliary.id, incarnationId: auxiliary.createdAt },
      request: { userMessage: durable.text, clientRequestId: requestId, submitSource: "composer",
        executionOptions: captureSessionExecutionOptions(auxiliary) },
      composerRegistry: registry, composerOwner, submitCoordinator: new SessionSubmitCoordinator(), acceptance: new SessionTurnAcceptance(),
      auxiliaryDraftOwner: persistence.getOwner(auxiliary)!, queueTurn: true, clearDraft: true, collapseActionDock: false,
      selectedSessionRunState: "idle", blockedReason: null, isReadOnly: false, validateWorkspace: async () => true,
      state: { setComposerPreview: (preview) => registry.setPreview(composerOwner, preview), setPendingSubmitSessionId() {},
        setForceComposerBlockedFeedback() {}, collapseActionDock() {} }, log() {},
    });
    assert.ok(receipt);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.incarnationId, auxiliary.createdAt);
    assert.equal(receipt.captured.request.auxiliaryDraftIncarnation, durable.incarnation);
    assert.equal(receipt.captured.request.userMessage, "テストメッセージ");
    assert.equal(registry.get(composerOwner).draft, "");
    assert.notEqual(registry.get(composerOwner).saveState, "error");
    assert.equal((await bundle.stores.auxiliary.getAuxiliaryDraft(auxiliary.id))?.text, "");
    assert.equal((await bundle.stores.queue.enqueue(owner, receipt.captured)).id, receipt.id);
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
