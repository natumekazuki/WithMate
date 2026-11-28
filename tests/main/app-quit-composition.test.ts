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
  const source = await readFile(
    new URL("../../src-electron/main.ts", import.meta.url),
    "utf8",
  );
  /** 本番の終了時処理を抽出するときに参照するASTの形。 */
  type AstNode = {
    type: string;
    range?: [number, number];
    id?: { name: string };
    declarations?: AstNode[];
    callee?: AstNode;
    arguments?: AstNode[];
    object?: { name?: string };
    property?: { name?: string };
    value?: unknown;
  };
  const ast = (await parsers.typescript.parse(source, {
    filepath: "src-electron/main.ts",
  } as Parameters<typeof parsers.typescript.parse>[1])) as { body: AstNode[] };
  /** 構文ノードに対応する本番コードを、解釈を変えずに抽出する。 */
  const textOf = (node: AstNode) => {
    assert.ok(node.range);
    return source.slice(...node.range);
  };
  const functionNames = new Set([
    "requireMainInfrastructureRegistry",
    "requirePersistentStoreLifecycleService",
    "requireAppLifecycleService",
    "closePersistentStores",
  ]);
  const variableNames = new Set([
    "mainInfrastructureRegistry",
    "appLifecycleService",
    "allowQuitWithInFlightRuns",
  ]);
  const selected: string[] = [];
  for (const statement of ast.body) {
    if (
      statement.type === "FunctionDeclaration" &&
      statement.id &&
      functionNames.has(statement.id.name)
    ) {
      selected.push(textOf(statement));
      functionNames.delete(statement.id.name);
    }
    if (statement.type === "VariableDeclaration") {
      const declarations = statement.declarations!.filter(
        (entry) => entry.id && variableNames.has(entry.id.name),
      );
      if (declarations.length)
        selected.push(`let ${declarations.map(textOf).join(",")};`);
    }
  }
  assert.equal(
    functionNames.size,
    0,
    "production quit composition functions must be present",
  );
  const beforeQuitHandlers: string[] = [];
  /** AST内のイベント登録をたどり、本番の終了ハンドラーを抽出する。 */
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    if (
      node.type === "CallExpression" &&
      node.callee?.object?.name === "app" &&
      node.callee.property?.name === "on" &&
      node.arguments?.[0]?.value === "before-quit"
    ) {
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

  const counts = {
    instances: 0,
    flushes: 0,
    snapshots: 0,
    stops: 0,
    storeCloses: 0,
    quits: 0,
    accepted: 0,
    resumes: 0,
  };
  let running = false;
  let confirm = false;
  let flushResult = true;
  let handler:
    | ((event: {
        /** この終了イベントを取り消す。 */ preventDefault(): void;
      }) => void)
    | undefined;
  const storeContext = new MainStoreContext();
  // `closePersistentStores` のスタブではなく、実際の `MainStoreContext` から
  // `PersistentStoreLifecycleService.close` までの経路を、終了可能な実リソースで観測する。
  storeContext.setCharacterStorage({
    /** 実際のストア後処理がCharacterストアに届いた回数を数える。 */ close:
      () => {
        counts.storeCloses += 1;
      },
  } as MainStoreContext["characterStorage"]);
  const context = createContext({
    AppLifecycleService: class extends AppLifecycleService {
      /** レジストリ破棄後に終了サービスが作り直されないかを生成回数で観測する。 */
      constructor(deps: ConstructorParameters<typeof AppLifecycleService>[0]) {
        super(deps);
        counts.instances += 1;
      }
    },
    createAppLifecycleDeps,
    MainInfrastructureRegistry,
    PersistentStoreLifecycleService,
    /** 実DBファイルに触れる経路が選ばれたら、このフィクスチャでは失敗させる。 */
    truncateAppDatabaseWal() {
      throw new Error("No database file is used by this composition fixture");
    },
    mainStoreContext: storeContext,
    /** 終了確認の要否を、手順ごとに設定した実行中状態で決める。 */
    hasInFlightSessionRuns: () => running,
    dialog: {
      /** ユーザーが選んだ終了確認の応答を再現する。 */ showMessageBoxSync:
        () => (confirm ? 1 : 0),
    },
    /** 終了の検証中に実ウィンドウを開かない。 */
    createHomeWindow: async () => {},
    /** 下書き保存と終了スナップショットを別々に観測できる窓口を返す。 */
    requireSessionWindowBridge: () => ({
      /** 下書き保存を計数し、手順で設定した成否を返す。 */
      flushSessionWindowDrafts: async () => {
        counts.flushes += 1;
        return flushResult;
      },
      /** 終了前のスナップショット作成まで進んだことを記録する。 */
      prepareSnapshotForQuit: async () => {
        counts.snapshots += 1;
      },
    }),
    /** Agent Runtimeの停止まで進んだ回数を記録する。 */
    stopAgentRuntimeApiBestEffort: async () => {
      counts.stops += 1;
    },
    /** 外部Providerのスレッドを持たないため終了時の無効化を省く。 */
    invalidateAllProviderSessionThreads: async () => {},
    agentRuntimeBindingRegistry: {
      /** 登録済みバインディングを持たない終了依存。 */ revokeAll() {},
    },
    sessionTurnQueueService: {
      /** 実キューの投入を止めずに終了開始の依存を満たす。 */
      beginShutdown() {},
      /** 保存失敗後にキューを再開する要求を数える。 */
      resume() {
        counts.resumes += 1;
      },
      /** 閉じるべき実キューを持たない終了依存。 */
      async close() {},
    },
    sessionResultReadService: {
      /** 未読結果を保持しないため消去要求を受け流す。 */ clear() {},
    },
    auxiliaryLiveRunParents: {
      /** Auxiliary実行を生成しないため親マッピングの消去を省く。 */ clear() {},
    },
    /** 終了検証の記録をアプリログへ出力しない。 */
    writeAppLog() {},
    app: {
      /** 本番コードが登録する終了ハンドラーを、再入時にも使えるよう保持する。 */
      on(_name: string, callback: typeof handler) {
        handler = callback;
      },
      /** 終了イベントの再入と取消を模倣し、後処理の無限反復は検出する。 */
      quit() {
        counts.quits += 1;
        assert.ok(
          counts.quits <= 3,
          "quit must not repeat cleanup after registry destruction",
        );
        let prevented = false;
        handler!({
          /** ハンドラーが終了を取り消したことを記録する。 */ preventDefault() {
            prevented = true;
          },
        });
        if (!prevented) counts.accepted += 1;
      },
    },
  });
  // 起動直後と同じく、無関係な遅延初期化サービスはまだ存在しない。
  // 実際のストア後処理が各サービスを参照してクリアする。ファクトリーも後処理も置き換えない。
  for (const name of [
    "providerModelDiscoveryService",
    "sessionRuntimeService",
    "auxiliarySessionRuntimeService",
    "sessionObservabilityService",
    "characterService",
    "characterAuthoringService",
    "managedSkillDistributionService",
    "sessionTurnService",
    "auxiliarySessionService",
    "settingsCatalogService",
    "sessionApprovalService",
    "sessionElicitationService",
    "mainBroadcastFacade",
    "mainObservabilityFacade",
    "mainProviderFacade",
    "mainSessionCommandFacade",
    "mainSessionPersistenceFacade",
    "sessionLaunchSelectionService",
    "sessionPersistenceService",
    "mainWindowFacade",
    "mainQueryService",
    "mainSessionTurnQueueFacade",
  ])
    context[name] = null;
  const compiled = stripTypeScriptTypes(selected.join("\n"), { mode: "strip" });
  runInContext(compiled, context);
  return {
    counts,
    /** 本番の終了イベントを発行し、非同期後処理を観測できるまで待つ。 */
    attempt: async () => {
      // Electron と同様に、実際に登録された `before-quit` コールバックを呼び出す。
      runInContext("app.quit()", context);
      for (let i = 0; i < 5; i += 1) await setImmediate();
    },
    /** 次の終了試行で観測される実行中状態・確認応答・保存結果を設定する。 */
    setConditions: (next: {
      running: boolean;
      confirm: boolean;
      flush: boolean;
    }) => {
      running = next.running;
      confirm = next.confirm;
      flushResult = next.flush;
    },
    /** 本番の終了後処理が隔離環境のレジストリを破棄したかを返す。 */
    registryIsDestroyed: () =>
      runInContext("mainInfrastructureRegistry === null", context) as boolean,
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
/** ストア解放後の再入でサービスを再生成せず、一度の後処理で終了できることを確認する。 */
test("production quit composition はstore cleanupとregistry破棄後の再入で終了する", async () => {
  const fixture = await loadQuitComposition();
  await fixture.attempt();
  assert.deepEqual(fixture.counts, {
    instances: 1,
    flushes: 1,
    snapshots: 1,
    stops: 1,
    storeCloses: 1,
    quits: 2,
    accepted: 1,
    resumes: 0,
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
/** 確認取消と下書き保存失敗では終了せず、確認と保存が成功した再試行でのみ解放する。 */
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
  assert.equal(
    fixture.counts.flushes,
    1,
    "failed save must restore the running confirmation",
  );
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
