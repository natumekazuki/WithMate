import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parsers } from "prettier/plugins/typescript";

import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";
import { SessionLaunchSelectionService } from "../../src-electron/session/session-launch-selection-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";

// @test-value v2
// kind = "contract"
// claim = "latest-sessionのAuxiliary作成は指定Providerと親Workspaceを起動設定の解決とmodel discoveryへ渡す"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#cacheと更新; docs/design/auxiliary-session.md#context-boundary" }
// fault = "mainのAuxiliary組立で親Workspaceまたは指定Providerを落とし、別contextのmodel候補を解決する"
// observable = "起動設定resolverとcatalog取得への引数、作成されたAuxiliaryのProviderとmodel、resolver前後のowner確認"
// observation_boundary = "component-behavior"
// scope = "auxiliary-main-launch-selection-wiring"
// lifecycle = "permanent"
// impact = "親Workspaceに対応しないmodel候補や既定modelでAuxiliaryを作成することを防ぐ"
// distinction = "service単独testと型検査はmainの実組立ラッパーによる引数脱落を検出できず、隔離DBと外部取得stubで短時間に確認する"
// @end-test-value
test("latest-sessionのAuxiliary作成はmainの組立を通じて親Workspaceを解決する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-launch-workspace-"));
  const sessionStorage = new SessionStorageV6(path.join(directory, "app.db"));
  const auxiliaryStorage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  try {
    const workspacePath = "C:/parent-workspace";
    const parent = buildNewSession({
      id: "parent-workspace",
      taskTitle: "parent",
      workspaceLabel: "parent-workspace",
      workspacePath,
      branch: "main",
      characterId: "main-character",
      character: "Main",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      provider: "codex",
    });
    sessionStorage.upsertSession(parent);

    const character: CharacterCatalogEntry = {
      id: "aux-character",
      name: "Auxiliary",
      description: "",
      iconFilePath: "",
      theme: { main: "#6f8cff", sub: "#6fb8c7" },
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    };
    const characterSnapshot: CharacterRuntimeSnapshot = {
      characterId: character.id,
      name: character.name,
      description: "",
      iconFilePath: "",
      theme: character.theme,
      definitionMarkdown: "# Auxiliary",
      definitionSha256: "test",
      definitionByteSize: 11,
      snapshotAt: "2026-01-01T00:00:00.000Z",
    };
    const catalogRequests: Array<[string | undefined, string | undefined]> = [];
    const resolver = new SessionLaunchSelectionService({
      getAppSettings: () => normalizeAppSettings({ codingProviderSettings: { copilot: { enabled: true } } }),
      getLatestSessionSummaryForProvider: () => null,
      getModelCatalogSnapshot: (workspace, providerId) => {
        catalogRequests.push([workspace, providerId]);
        const model = workspace === workspacePath ? "parent-workspace-model" : "other-workspace-model";
        return { providers: [{
          id: "copilot",
          label: "Copilot",
          defaultModelId: providerId ? model : "",
          defaultReasoningEffort: providerId ? "high" : "",
          models: providerId ? [{ id: model, label: model, reasoningEfforts: ["high"] }] : [],
        }] };
      },
    });
    const resolverRequests: Array<[string | null | undefined, string | undefined]> = [];
    const launchEvents: string[] = [];
    const owner = { auxiliarySessionStorage: auxiliaryStorage };
    const mainSource = await readFile(new URL("../../src-electron/main.ts", import.meta.url), "utf8");
    const options = { filepath: "src-electron/main.ts" } as Parameters<typeof parsers.typescript.parse>[1];
    const sourceFile = await parsers.typescript.parse(mainSource, options) as {
      body: Array<{ type: string; id?: { name: string }; range?: [number, number] }>;
    };
    const factory = sourceFile.body.find((statement) =>
      statement.type === "FunctionDeclaration" && statement.id?.name === "requireAuxiliarySessionService");
    assert.ok(factory?.range, "mainのAuxiliary組立関数が見つからない");
    const executable = stripTypeScriptTypes(mainSource.slice(...factory.range), { mode: "strip" });
    const service = runInNewContext(`${executable}\nrequireAuxiliarySessionService()`, {
      auxiliarySessionService: null,
      AuxiliarySessionService,
      requireActivePersistentStoreOwnerForFactory: () => owner,
      assertPersistentStoreOwnerIsActive: (captured: unknown, operation: string) => {
        assert.equal(captured, owner);
        if (operation === "Auxiliary session launch selection") launchEvents.push("owner-check");
      },
      getAuxiliaryParentSession: (id: string) => id === parent.id ? parent : null,
      requireSessionLaunchSelectionService: () => ({
        resolve: (providerId?: string | null, workspace?: string) => {
          launchEvents.push("resolve");
          resolverRequests.push([providerId, workspace]);
          return resolver.resolve(providerId, workspace);
        },
      }),
      requireCharacterService: () => ({
        listCharacters: () => [character],
        createRuntimeSnapshot: () => characterSnapshot,
      }),
      providerRuntimeOperationCoordinator: new ProviderRuntimeOperationCoordinator(),
      databaseMaintenanceRequested: false,
    }) as AuxiliarySessionService;

    const created = await service.createAuxiliarySession({
      parentSessionId: parent.id,
      provider: "copilot",
      runtimeSelection: "latest-session",
    });

    assert.deepEqual(resolverRequests, [["copilot", workspacePath]]);
    assert.deepEqual(catalogRequests, [[workspacePath, undefined], [workspacePath, "copilot"]]);
    assert.deepEqual(launchEvents, ["owner-check", "resolve", "owner-check"]);
    assert.equal(created.provider, "copilot");
    assert.equal(created.model, "parent-workspace-model");
  } finally {
    auxiliaryStorage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
