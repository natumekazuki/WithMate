import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { useMainSessionRuntime } from "../../src/chat/runtime/use-main-session-runtime.js";
import type { SetExecutionOptionsResult } from "../../src-shared/session/session-mutation-contract.js";
import type { Session, SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

function session(reasoningEffort: Session["reasoningEffort"] = "medium"): Session {
  return {
    id: "session-1", incarnationId: "owner-1", taskTitle: "test", status: "idle", updatedAt: "2026-09-28T00:00:00.000Z",
    isPinned: false, provider: "codex", catalogRevision: 1, workspaceLabel: "workspace", workspacePath: "C:\\workspace",
    branch: "main", sessionKind: "default", accessMode: "active", sourceSchemaVersion: 5,
    characterId: "character-1", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#000000" }, characterRuntimeSnapshot: null,
    runState: "idle", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard",
    codexReviewer: "user", model: "model", reasoningEffort, customAgentName: "", allowedAdditionalDirectories: [],
    threadId: "thread-1", messages: [], stream: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// @test-value v2
// kind = "contract"
// claim = "Mainの現在選択はcatalog import・rollback・revisionが下がるresetに追従し、旧再取得応答でもSend捕捉値をactive revisionに保つ"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#現行の反映" }
// fault = "rendererのlocal選択を旧revisionに固定するか、catalog正規化でrollback前の選択を消す"
// observable = "hookの表示modelと現在Sessionから捕捉するexecutionOptions"
// observation_boundary = "component-behavior"
// scope = "main-selection-catalog"
// lifecycle = "permanent"
// @end-test-value
test("Mainのcatalog更新は表示と次Sendの捕捉値を揃える", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  let invalidate: ((payload: SessionSummaryInvalidation) => void) | undefined;
  const api = {
    getSession: async () => session(),
    subscribeSessionInvalidation: (listener: (payload: SessionSummaryInvalidation) => void) => { invalidate = listener; return () => undefined; },
    setSessionExecutionOptions: async () => ({ status: "accepted", checkpointSaved: false }),
    reportRendererLog: async () => undefined,
  } as unknown as Parameters<typeof useMainSessionRuntime>[0]["api"];
  const registry = new ComposerControllerRegistry();
  let current: ReturnType<typeof useMainSessionRuntime> | null = null;
  function Probe() {
    current = useMainSessionRuntime({ api, selectedId: "session-1", composerRegistry: registry });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  const catalog: ModelCatalogSnapshot = { revision: 2, providers: [{
    id: "codex", label: "Codex", defaultModelId: "imported", defaultReasoningEffort: "high",
    models: [{ id: "imported", label: "Imported", reasoningEfforts: ["high"] }],
  }] };
  try {
    await act(async () => { root.render(React.createElement(Probe)); });
    await act(async () => { current!.selectExecutionOptions({ ...session(), model: "chosen" }); });
    await act(async () => { current!.applyModelCatalog(catalog); });
    assert.equal(current!.sessions[0]?.model, "imported");
    await act(async () => { invalidate?.({ scope: "all" }); });
    assert.deepEqual(captureSessionExecutionOptions(current!.getCurrentSession()!), {
      ...captureSessionExecutionOptions(session()), catalogRevision: 2, model: "imported", reasoningEffort: "high",
    });
    await act(async () => { current!.applyModelCatalog({ ...catalog, revision: 3, providers: [{ ...catalog.providers[0]!,
      models: [...catalog.providers[0]!.models, { id: "chosen", label: "Chosen", reasoningEfforts: ["medium"] }],
    }] }); });
    await act(async () => { invalidate?.({ scope: "all" }); });
    assert.equal(current!.sessions[0]?.model, "chosen");
    assert.equal(current!.getCurrentSession()?.catalogRevision, 3);
    assert.equal(current!.getCurrentSession()?.reasoningEffort, "medium");
    await act(async () => { current!.applyModelCatalog({ ...catalog, revision: 1 }); });
    await act(async () => { invalidate?.({ scope: "all" }); });
    assert.equal(current!.getCurrentSession()?.catalogRevision, 1);
    assert.equal(current!.getCurrentSession()?.model, "imported");
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, { window: previousWindow });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "同一owner内の実行設定の拒否は最新選択だけを正本へ戻し、B→C→Bで古い拒否が後続Bを消さない"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md: 実行設定と Send" }
// fault = "拒否応答を要求順の確認なしにrollbackし、後続選択または新着本文を上書きする"
// observable = "hookの表示選択と新着本文、正本再読込回数、拒否feedback"
// observation_boundary = "component-behavior"
// scope = "main-execution-options-rejection"
// lifecycle = "permanent"
// impact = "Sendが利用者の最後の選択と異なる条件で実行される"
// distinction = "service validation testと異なり非同期IPC拒否後のrenderer overlayを観測する"
// @end-test-value
test("古い拒否は後続選択を消さず最新拒否だけ正本へ戻す", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test" });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  const pending: ReturnType<typeof deferred<SetExecutionOptionsResult>>[] = [];
  const feedback: string[] = [];
  let reads = 0;
  const api = {
    getSession: async () => { reads += 1; return session(); },
    subscribeSessionInvalidation: () => () => undefined,
    setSessionExecutionOptions: () => {
      const request = deferred<SetExecutionOptionsResult>();
      pending.push(request);
      return request.promise;
    },
    reportRendererLog: async () => undefined,
  } as unknown as Parameters<typeof useMainSessionRuntime>[0]["api"];
  const registry = new ComposerControllerRegistry();
  let current: ReturnType<typeof useMainSessionRuntime> | null = null;
  function Probe() {
    current = useMainSessionRuntime({ api, selectedId: "session-1", composerRegistry: registry,
      onExecutionOptionsError: (_id, message) => feedback.push(message) });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  try {
    await act(async () => { root.render(React.createElement(Probe)); });
    assert.equal(current!.sessions[0]?.reasoningEffort, "medium");
    await act(async () => {
      current!.selectExecutionOptions(session("high"));
      current!.selectExecutionOptions(session("low"));
      current!.selectExecutionOptions(session("high"));
    });
    assert.equal(current!.sessions[0]?.reasoningEffort, "high");
    await act(async () => {
      current!.updateSessionProjection("session-1", (value) => ({
        ...value, messages: [{ role: "assistant", text: "new streaming text" }],
      }));
    });
    await act(async () => {
      pending[0]!.reject(new Error("old B rejected"));
      pending[1]!.reject(new Error("old C rejected"));
      await Promise.allSettled([pending[0]!.promise, pending[1]!.promise]);
    });
    assert.equal(current!.sessions[0]?.reasoningEffort, "high");
    assert.equal(reads, 1);
    await act(async () => {
      pending[2]!.reject(new Error("latest B rejected"));
      await Promise.allSettled([pending[2]!.promise]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(current!.sessions[0]?.reasoningEffort, "medium");
    assert.equal(current!.sessions[0]?.messages[0]?.text, "new streaming text");
    assert.equal(reads, 2);
    assert.equal(feedback.length, 1);
    assert.match(feedback[0]!, /latest B rejected/);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, { window: previousWindow });
  }
});
