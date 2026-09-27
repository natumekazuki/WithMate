import assert from "node:assert/strict";
import { it } from "node:test";
import { MainStoreContext } from "../../src-electron/app/main-store-context.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

function createSession() {
  return buildNewSession({
    id: "main-selection", taskTitle: "Selection", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main",
    characterId: "character", character: "Character", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "untrusted",
    provider: "codex", model: "model-a", reasoningEffort: "high",
  });
}

// @test-value v2
// kind = "contract"
// claim = "同一アプリの現在選択は保存応答を重ねても維持され、ownerの再作成とstorage generation終了で破棄される"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send" }
// fault = "古い保存結果を再表示するか、削除前の選択を別incarnationへ適用する"
// observable = "MainStoreContextのSession選択投影とprovider初期選択"
// observation_boundary = "component-behavior"
// scope = "current-execution-selections"
// lifecycle = "permanent"
// @end-test-value
it("現在選択と保存snapshotを分けてownerとgenerationの寿命を守る", () => {
  const context = new MainStoreContext();
  const session = createSession();
  context.setSessions([session]);
  const options = captureSessionExecutionOptions({ ...session, model: "model-b" });
  context.executionSelections.remember(session, options);
  context.setSessions([{ ...session, taskTitle: "Renamed", messages: [{ role: "user", text: "hello" }] }]);
  assert.equal(context.sessions[0]?.model, "model-b");
  assert.equal(context.sessions[0]?.taskTitle, "Renamed");
  assert.equal(context.sessions[0]?.messages[0]?.text, "hello");
  assert.equal(context.executionSelections.apply(session).model, "model-b");
  assert.equal(context.executionSelections.latestForProvider("codex")?.model, "model-b");
  context.setSessions([{ ...session, incarnationId: "new-owner" }]);
  assert.equal(context.sessions[0]?.model, "model-a");
  assert.equal(context.executionSelections.latestForProvider("codex"), null);
  context.executionSelections.remember(context.sessions[0]!, options);
  context.clearReferences();
  assert.equal(context.executionSelections.latestForProvider("codex"), null);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary選択は親ownerに従い、別会話と混ざらず親の再作成で消える"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send" }
// fault = "親の同ID再作成にAuxiliaryの旧選択を持ち越す"
// observable = "Auxiliaryに適用したmodelと親再作成後のprovider初期選択"
// observation_boundary = "component-behavior"
// scope = "current-execution-selections"
// lifecycle = "permanent"
// @end-test-value
it("Auxiliaryの現在選択を親ownerへ閉じる", () => {
  const context = new MainStoreContext();
  const session = createSession();
  context.setSessions([session]);
  const auxiliary = { ...session, id: "aux-selection", parentSessionId: session.id, createdAt: "2026-09-27T00:00:00Z" } as unknown as AuxiliarySessionSummary;
  context.executionSelections.remember(auxiliary, captureSessionExecutionOptions({ ...session, model: "aux-b" }));
  assert.equal(context.executionSelections.apply(auxiliary).model, "aux-b");
  assert.equal(context.executionSelections.apply(session).model, "model-a");
  assert.equal(context.executionSelections.apply({ ...auxiliary, createdAt: "2026-09-28T00:00:00Z" }).model, "model-a");
  context.setSessions([{ ...session, incarnationId: "new-parent" }]);
  assert.equal(context.executionSelections.apply(auxiliary).model, "model-a");
  assert.equal(context.executionSelections.latestForProvider("codex"), null);
});

// @test-value v2
// kind = "contract"
// claim = "catalog変更はMainとAuxiliaryの現在選択をactive revisionへ投影し、rollback・旧checkpoint・revisionが下がるresetにも追従する"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#現行の反映" }
// fault = "保存されていない選択を旧revisionに固定するか、importの一時的な正規化でrollback前の選択を失う"
// observable = "Main/Auxiliaryのmodel・depth・catalogRevisionと新規会話用の初期選択"
// observation_boundary = "component-behavior"
// scope = "current-selection-catalog-reconciliation"
// lifecycle = "permanent"
// @end-test-value
it("catalog importとrollbackは現在選択を新revisionへ揃える", () => {
  const context = new MainStoreContext();
  const main = createSession();
  const aux = { ...main, id: "aux-selection", parentSessionId: main.id, createdAt: "2026-09-27" } as unknown as AuxiliarySessionSummary;
  const selected = captureSessionExecutionOptions({ ...main, model: "model-b", reasoningEffort: "medium" });
  context.setSessions([main]);
  context.executionSelections.remember(main, selected);
  context.executionSelections.remember(aux, selected);
  const catalog: ModelCatalogSnapshot = { revision: 2, providers: [{
    id: "codex", label: "Codex", defaultModelId: "model-c", defaultReasoningEffort: "high",
    models: [{ id: "model-c", label: "C", reasoningEfforts: ["high"] }],
  }] };
  context.executionSelections.setModelCatalog(catalog);
  context.setSessions([main]);
  assert.equal(context.sessions[0]?.model, "model-c");
  assert.equal(context.sessions[0]?.catalogRevision, 2);
  assert.equal(context.executionSelections.apply(aux).reasoningEffort, "high");
  assert.equal(context.executionSelections.latestForProvider("codex")?.model, "model-c");
  context.executionSelections.setModelCatalog({ ...catalog, revision: 3, providers: [{ ...catalog.providers[0]!,
    models: [...catalog.providers[0]!.models, { id: "model-b", label: "B", reasoningEfforts: ["medium"] }],
  }] });
  context.setSessions([main]);
  assert.equal(context.sessions[0]?.model, "model-b");
  assert.equal(context.sessions[0]?.catalogRevision, 3);
  assert.equal(context.executionSelections.apply(aux).model, "model-b");
  assert.equal(context.executionSelections.apply(aux).catalogRevision, 3);
  assert.equal(context.executionSelections.latestForProvider("codex")?.reasoningEffort, "medium");
  context.executionSelections.setModelCatalog({ ...catalog, revision: 1 });
  context.setSessions([main]);
  assert.equal(context.sessions[0]?.catalogRevision, 1);
  assert.equal(context.sessions[0]?.model, "model-c");
  assert.equal(context.executionSelections.apply(aux).catalogRevision, 1);
  assert.equal(context.executionSelections.apply(aux).model, "model-c");
});
