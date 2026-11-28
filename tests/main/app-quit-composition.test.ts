import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { parsers } from "prettier/plugins/typescript";

import { AppLifecycleService } from "../../src-electron/app/app-lifecycle-service.js";
import { createAppLifecycleDeps } from "../../src-electron/app/app-lifecycle-deps.js";
import { MainInfrastructureRegistry } from "../../src-electron/app/main-infrastructure-registry.js";
import { MainStoreContext } from "../../src-electron/app/main-store-context.js";
import { PersistentStoreLifecycleService } from "../../src-electron/storage/persistent-store-lifecycle-service.js";

/** 本番の組み立て処理を、`main.ts` の無関係な起動時の副作用なしで実行する。
 * ファクトリー、ストアの後処理、レジストリの破棄、イベントコールバックは `main.ts` の実装を使い、
 * 外部のランタイムと Window の操作だけを fixture で置き換える。
 */
async function loadQuitComposition() {
  const source = await readFile(new URL("../../src-electron/main.ts", import.meta.url), "utf8");
  type AstNode = {
    type: string; range?: [number, number]; id?: { name: string };
    declarations?: AstNode[]; callee?: AstNode; arguments?: AstNode[];
    object?: { name?: string }; property?: { name?: string }; value?: unknown;
  };
  const ast = await parsers.typescript.parse(source, {
    filepath: "src-electron/main.ts",
  } as Parameters<typeof parsers.typescript.parse>[1]) as { body: AstNode[] };
  const textOf = (node: AstNode) => { assert.ok(node.range); return source.slice(...node.range); };
  const functionNames = new Set([
    "requireMainInfrastructureRegistry", "requirePersistentStoreLifecycleService",
    "requireAppLifecycleService", "closePersistentStores",
  ]);
  const variableNames = new Set(["mainInfrastructureRegistry", "appLifecycleService", "allowQuitWithInFlightRuns"]);
  const selected: string[] = [];
  for (const statement of ast.body) {
    if (statement.type === "FunctionDeclaration" && statement.id && functionNames.has(statement.id.name)) {
      selected.push(textOf(statement));
      functionNames.delete(statement.id.name);
    }
    if (statement.type === "VariableDeclaration") {
      const declarations = statement.declarations!.filter((entry) => entry.id && variableNames.has(entry.id.name));
      if (declarations.length) selected.push(`let ${declarations.map(textOf).join(",")};`);
    }
  }
  assert.equal(functionNames.size, 0, "production quit composition functions must be present");
  const beforeQuitHandlers: string[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    if (node.type === "CallExpression" && node.callee?.object?.name === "app"
      && node.callee.property?.name === "on" && node.arguments?.[0]?.value === "before-quit") {
      beforeQuitHandlers.push(textOf(node));
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(ast);
  assert.equal(beforeQuitHandlers.length, 1);
  selected.push(`${beforeQuitHandlers[0]};`);

  const counts = { instances: 0, flushes: 0, snapshots: 0, stops: 0, storeCloses: 0, quits: 0, accepted: 0, resumes: 0 };
  let running = false;
  let confirm = false;
  let flushResult = true;
  let handler: ((event: { preventDefault(): void }) => void) | undefined;
  const storeContext = new MainStoreContext();
  // `closePersistentStores` のスタブではなく、実際の `MainStoreContext` から
  // `PersistentStoreLifecycleService.close` までの経路を、終了可能な実リソースで観測する。
  storeContext.setCharacterStorage({ close: () => { counts.storeCloses += 1; } } as MainStoreContext["characterStorage"]);
  const context = createContext({
    AppLifecycleService: class extends AppLifecycleService {
      constructor(deps: ConstructorParameters<typeof AppLifecycleService>[0]) {
        super(deps);
        counts.instances += 1;
      }
    },
    createAppLifecycleDeps, MainInfrastructureRegistry, PersistentStoreLifecycleService,
    truncateAppDatabaseWal() { throw new Error("No database file is used by this composition fixture"); },
    mainStoreContext: storeContext,
    hasInFlightSessionRuns: () => running,
    dialog: { showMessageBoxSync: () => confirm ? 1 : 0 },
    createHomeWindow: async () => {},
    requireSessionWindowBridge: () => ({
      flushSessionWindowDrafts: async () => { counts.flushes += 1; return flushResult; },
      prepareSnapshotForQuit: async () => { counts.snapshots += 1; },
    }),
    stopAgentRuntimeApiBestEffort: async () => { counts.stops += 1; },
    invalidateAllProviderSessionThreads: async () => {},
    agentRuntimeBindingRegistry: { revokeAll() {} },
    sessionTurnQueueService: { beginShutdown() {}, resume() { counts.resumes += 1; }, async close() {} },
    sessionResultReadService: { clear() {} },
    auxiliaryLiveRunParents: { clear() {} },
    writeAppLog() {},
    app: {
      on(_name: string, callback: typeof handler) { handler = callback; },
      quit() {
        counts.quits += 1;
        assert.ok(counts.quits <= 3, "quit must not repeat cleanup after registry destruction");
        let prevented = false;
        handler!({ preventDefault() { prevented = true; } });
        if (!prevented) counts.accepted += 1;
      },
    },
  });
  // 起動直後と同じく、無関係な遅延初期化サービスはまだ存在しない。
  // 実際のストア後処理が各サービスを参照してクリアする。ファクトリーも後処理も置き換えない。
  for (const name of [
    "providerModelDiscoveryService", "sessionRuntimeService", "auxiliarySessionRuntimeService",
    "sessionObservabilityService", "characterService", "characterAuthoringService",
    "managedSkillDistributionService", "sessionTurnService", "auxiliarySessionService",
    "settingsCatalogService", "sessionApprovalService", "sessionElicitationService",
    "mainBroadcastFacade", "mainObservabilityFacade", "mainProviderFacade", "mainSessionCommandFacade",
    "mainSessionPersistenceFacade", "sessionLaunchSelectionService", "sessionPersistenceService",
    "mainWindowFacade", "mainQueryService", "mainSessionTurnQueueFacade",
  ]) context[name] = null;
  const compiled = stripTypeScriptTypes(selected.join("\n"), { mode: "strip" });
  runInContext(compiled, context);
  return {
    counts,
    attempt: async () => {
      // Electron と同様に、実際に登録された `before-quit` コールバックを呼び出す。
      runInContext("app.quit()", context);
      for (let i = 0; i < 5; i += 1) await setImmediate();
    },
    setConditions: (next: { running: boolean; confirm: boolean; flush: boolean }) => {
      running = next.running; confirm = next.confirm; flushResult = next.flush;
    },
    registryIsDestroyed: () => runInContext("mainInfrastructureRegistry === null", context) as boolean,
  };
}

// @test-value v2
// kind = "contract"
// claim = "通常quitはpersistent store cleanupによるregistry破棄後のbefore-quit再入でも一度のcleanupで終了を許可する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#app-quit; https://github.com/natumekazuki/WithMate/issues/952" }
// fault = "DB世代registryと共に終了状態を破棄し、再入で新serviceがflushとcleanupを反復する"
// observable = "production callbackの再入回数、service生成数、flush/snapshot/runtime stop/store close回数、registry破棄と終了許可"
// observation_boundary = "component-behavior"
// scope = "main.ts quit composition + MainStoreContext + PersistentStoreLifecycleService + MainInfrastructureRegistry"
// lifecycle = "permanent"
// impact = "通常Exitが収束せずprocessとuserData lockが残り、再起動できない"
// distinction = "単独service unitや型検査は実cleanupによるregistry破棄とproduction getter/event callbackの再入を通らない。短いin-process境界testで継続的に検出する"
// @end-test-value
test("production quit composition はstore cleanupとregistry破棄後の再入で終了する", async () => {
  const fixture = await loadQuitComposition();
  await fixture.attempt();
  assert.deepEqual(fixture.counts, {
    instances: 1, flushes: 1, snapshots: 1, stops: 1, storeCloses: 1, quits: 2, accepted: 1, resumes: 0,
  });
  assert.equal(fixture.registryIsDestroyed(), true);
});

// @test-value v2
// kind = "contract"
// claim = "production quitは実行中の確認取消とdraft保存失敗で終了を止め、再試行の保存成功後だけcleanupと終了へ進む"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#app-quit" }
// fault = "確認取消でcleanupを開始する、保存失敗を成功扱いする、または失敗後にqueue/確認の再試行を不能にする"
// observable = "各quit試行後のflush/cleanup/終了許可/queue resume回数と確認dialog結果の再評価"
// observation_boundary = "component-behavior"
// scope = "production quit compositionの実行中確認・保存失敗・再試行"
// lifecycle = "permanent"
// impact = "実行中の意図しない終了や未保存draft喪失、または保存修復後も終了不能になる"
// distinction = "service unitではmain.tsのqueue beginShutdown/resumeと確認依存の接続を確認できない。既存の境界fixtureを使い追加負担を抑える"
// @end-test-value
test("production quit composition は実行中確認取消と保存失敗を中止し再試行できる", async () => {
  const fixture = await loadQuitComposition();
  fixture.setConditions({ running: true, confirm: false, flush: true });
  await fixture.attempt();
  assert.equal(fixture.counts.flushes, 0);
  assert.equal(fixture.counts.storeCloses, 0);
  assert.equal(fixture.counts.accepted, 0);
  fixture.setConditions({ running: true, confirm: true, flush: false });
  await fixture.attempt();
  assert.equal(fixture.counts.flushes, 1);
  assert.equal(fixture.counts.resumes, 1);
  assert.equal(fixture.counts.stops, 0);
  assert.equal(fixture.counts.storeCloses, 0);
  assert.equal(fixture.counts.accepted, 0);
  fixture.setConditions({ running: true, confirm: false, flush: true });
  await fixture.attempt();
  assert.equal(fixture.counts.flushes, 1, "failed save must restore the running confirmation");
  // 次の終了が受理されると、その初回イベントと、後処理による再入が発生する。
  fixture.counts.quits = 0;
  fixture.setConditions({ running: true, confirm: true, flush: true });
  await fixture.attempt();
  assert.equal(fixture.counts.instances, 1);
  assert.equal(fixture.counts.flushes, 2);
  assert.equal(fixture.counts.snapshots, 1);
  assert.equal(fixture.counts.stops, 1);
  assert.equal(fixture.counts.storeCloses, 1);
  assert.equal(fixture.counts.accepted, 1);
});
