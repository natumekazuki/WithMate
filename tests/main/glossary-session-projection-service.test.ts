import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import {
  GlossaryApplicationService,
  serializeGlossaryDocument,
  type ResolvedGlossaryCheckout,
} from "../../src-electron/glossary/glossary-application-service.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { GlossarySessionProjectionService } from "../../src-electron/glossary/glossary-session-projection-service.js";
import type {
  GlossaryProjectionState,
  GlossarySnapshot,
  SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

/** 一時 Git リポジトリを作り、実サービスで確定したチェックアウトの識別情報も返す。 */
async function createRepository(): Promise<{
  root: string;
  target: ResolvedGlossaryCheckout;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "withmate-glossary-projection-"),
  );
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });
  const service = new GlossaryApplicationService();
  return { root, target: await service.resolvePrimaryCheckout(root) };
}

/** 各ケースが登録した一時リポジトリをテスト後に削除する。 */
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** チェックアウト権限や現在のバインディングに応じたレンダラー向け用語集の投影を検証する。 */
describe("GLOSSARY-CHECKOUT-AUTHORITY renderer projection", () => {
  /** 読込中にバインディング世代が変わったら旧応答を捨てて再読込し、現在のスコープを絶対パスを漏らさずに返す。 */
  it("binding generationがread中に変わった場合は旧scope responseを捨ててcurrent scopeを再読込する", async () => {
    const { root } = await createRepository();
    await mkdir(path.join(root, ".withmate"));
    await writeFile(
      path.join(root, ".withmate", "glossary.yaml"),
      serializeGlossaryDocument([
        { term: "Runtime", aliases: ["RT"], definition: "Current definition" },
      ]),
      "utf8",
    );

    let generation = "generation-1";
    /** 初回の実ファイル読込とその結果の返却の間にバインディング世代を進める。 */
    class GenerationChangingService extends GlossaryApplicationService {
      readCount = 0;

      /** 読み取った回数を記録し、初回の結果だけ旧世代の応答にする。 */
      override async read(
        target: ResolvedGlossaryCheckout,
      ): Promise<GlossarySnapshot> {
        this.readCount += 1;
        const snapshot = await super.read(target);
        if (this.readCount === 1) {
          generation = "generation-2";
        }
        return snapshot;
      }
    }
    const applicationService = new GenerationChangingService();
    const session = {
      id: "session-1",
      provider: "codex",
      workspacePath: root,
      workspaceLabel: "projection-repo",
      branch: "main",
    };
    const service = new GlossarySessionProjectionService({
      applicationService,
      /** 指定の ID に対応するセッションだけをチェックアウト解決へ提供する。 */
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      /** 実読込で切り替わったバインディング世代を返す。 */
      getBindingGeneration: () => generation,
      /** 読込中の世代比較だけを試すため、変更イベントは配信しない。 */
      subscribeBindingChanges: () => () => undefined,
    });

    const projection = await service.load(session.id);
    const current = await service.load(session.id);
    assert.equal(applicationService.readCount, 3);
    assert.equal(projection.scopeRevision, current.scopeRevision);
    assert.equal(projection.state.status, "valid");
    assert.equal(projection.checkout.pathLabel, path.basename(root));
    assert.equal(JSON.stringify(projection).includes(root), false);
    assert.ok(current.sequence > projection.sequence);
  });

  /** 用語集ファイルを不正に書き換えた後、表示にも検索にも直前の有効な項目を返さず、検索を検証エラーにする。 */
  it("invalid化ではlast valid entryを返さず、searchもapplication serviceのvalidationを共有する", async () => {
    const { root } = await createRepository();
    await mkdir(path.join(root, ".withmate"));
    const glossaryPath = path.join(root, ".withmate", "glossary.yaml");
    await writeFile(
      glossaryPath,
      serializeGlossaryDocument([
        { term: "Runtime", aliases: [], definition: "Current definition" },
      ]),
      "utf8",
    );
    const session = {
      id: "session-1",
      provider: "codex",
      workspacePath: root,
      workspaceLabel: "projection-repo",
      branch: "main",
    };
    const service = new GlossarySessionProjectionService({
      applicationService: new GlossaryApplicationService(),
      /** 有効から不正への遷移を見る対象セッションを返す。 */
      getSession: () => session,
      /** バインディングがないためチェックアウトを固定する。 */
      getBindingGeneration: () => null,
      /** 変更イベントではなく明示的な再読込で不正化を検出する。 */
      subscribeBindingChanges: () => () => undefined,
    });
    assert.equal((await service.load(session.id)).state.status, "valid");

    await writeFile(glossaryPath, "schemaVersion: [\n", "utf8");
    const invalid = await service.load(session.id);
    assert.equal(invalid.state.status, "invalid");
    assert.equal("entries" in invalid.state, false);
    const search = await service.search(session.id, { query: "runtime" });
    assert.equal(search.ok, false);
    if (!search.ok) {
      assert.equal(search.code, "GLOSSARY_INVALID_FILE");
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Git checkout解決の非適用と真の解決失敗をGlossary projectionの別stateへ投影する"
  // oracle = { type = "contract", ref = "src-shared/glossary/glossary-contract.ts; src-electron/glossary/glossary-session-projection-service.ts" }
  // fault = "非Git workspaceをwatch-errorとして表示するか、Git解決の真の失敗を正常な非適用として隠す"
  // observable = "projection state status、not-applicable reason、watch-error message"
  // observation_boundary = "public-boundary"
  // scope = "glossary-not-applicable-checkout"
  // lifecycle = "permanent"
  // distinction = "Git rev-parseの固定locale診断と、同じexit codeの真の解決失敗を同じprojection入力で比較する"
  // @end-test-value
  /** Git 管理外だけを対象外扱いとし、所有権エラーや不正なチェックアウトは監視エラーとして表示する。 */
  it("非Git checkoutはnot-applicableへ、別のGit解決失敗はwatch-errorへ投影する", async () => {
    const nonGitRoot = await mkdtemp(
      path.join(os.tmpdir(), "withmate-glossary-non-git-"),
    );
    temporaryDirectories.push(nonGitRoot);
    const session = {
      id: "session-non-git",
      provider: "codex",
      workspacePath: nonGitRoot,
      workspaceLabel: "non-git-workspace",
      branch: "",
    };
    /** 同じセッション条件で Git の診断だけを差し替えられる投影サービスを組み立てる。 */
    const createService = (
      runGit: (cwd: string, args: readonly string[]) => Promise<string>,
    ) =>
      new GlossarySessionProjectionService({
        applicationService: new GlossaryApplicationService({
          runGit,
        }),
        /** 異なる Git の終了理由を比較する間、同じ開始パスを使う。 */
        getSession: () => session,
        /** Git の診断をバインディング変更と切り離して検証する。 */
        getBindingGeneration: () => null,
        /** Git の初回解決だけを実行し、変更通知は配信しない。 */
        subscribeBindingChanges: () => () => undefined,
      });

    const notApplicable = await new GlossarySessionProjectionService({
      applicationService: new GlossaryApplicationService(),
      /** 実際に Git 管理外のディレクトリを指すセッションを返す。 */
      getSession: () => session,
      /** 非 Git 判定にはバインディングによる開始パスの上書きを使わない。 */
      getBindingGeneration: () => null,
      /** 非 Git の判定をスナップショット読込だけで行う。 */
      subscribeBindingChanges: () => () => undefined,
    }).load(session.id);
    assert.equal(notApplicable.state.status, "not-applicable");
    if (notApplicable.state.status === "not-applicable") {
      assert.equal(notApplicable.state.reason, "not-git");
    }

    const failed = await createService(async () => {
      throw Object.assign(
        new Error("fatal: detected dubious ownership in repository"),
        {
          code: 128,
          stderr: "fatal: detected dubious ownership in repository",
        },
      );
    }).load(session.id);
    assert.equal(failed.state.status, "watch-error");
    if (failed.state.status === "watch-error") {
      assert.equal(
        failed.state.message,
        "fatal: detected dubious ownership in repository",
      );
    }

    await mkdir(path.join(nonGitRoot, ".git"));
    const malformedCheckout = await new GlossarySessionProjectionService({
      applicationService: new GlossaryApplicationService(),
      /** 不正なチェックアウトの実パスを指すセッションを返す。 */
      getSession: () => session,
      /** このエラー判定ではバインディング世代を指定しない。 */
      getBindingGeneration: () => null,
      /** 監視エラーの判定に通知再登録を含めない。 */
      subscribeBindingChanges: () => () => undefined,
    }).load(session.id);
    assert.equal(malformedCheckout.state.status, "watch-error");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "並行watch deliveryは新しいeventを優先し遅れて完了した古いstateを破棄する"
  // oracle = { type = "contract", ref = "src-electron/glossary/glossary-session-projection-service.ts: watch delivery" }
  // fault = "古いdeliveryが新しいGlossary projectionを巻き戻す"
  // observable = "target stateとdelivery order"
  // observation_boundary = "public-boundary"
  // scope = "glossary-session-watch-race"
  // lifecycle = "permanent"
  // distinction = "直列watchでは検出できないdelivery raceを検証する"
  // @end-test-value
  /** 監視通知の解決順序を意図的に逆転させ、先に始まった古いイベントが後から届いても新しい投影だけを残す。 */
  it("並行watch deliveryは新しいeventを優先し、遅れて完了した古いstateを破棄する", async () => {
    const { root, target } = await createRepository();
    const firstScopeGate: { release: (() => void) | null } = { release: null };
    const firstScope = new Promise<void>((resolve) => {
      firstScopeGate.release = resolve;
    });
    let resolveCount = 0;
    const projectionGate: {
      emit: ((state: GlossaryProjectionState) => void) | null;
    } = { emit: null };
    /** チェックアウト解決を一時停止し、監視イベントを任意の順序で発行できるようにする。 */
    class DelayedProjectionService extends GlossaryApplicationService {
      /** 二度目の解決を解放待ちにして、後続イベントの方を先に完了できるようにする。 */
      override async resolvePrimaryCheckout(): Promise<ResolvedGlossaryCheckout> {
        resolveCount += 1;
        if (resolveCount === 2) {
          await firstScope;
        }
        return target;
      }

      /** イベント順の比較には同じチェックアウト表示を返す。 */
      override async describeCheckout() {
        return {
          repositoryName: "repository",
          branch: "main",
          pathLabel: "repository",
        };
      }

      /** 実ファイル監視の代わりに、テスト側から監視状態を通知できる登録先を保持する。 */
      override subscribe(
        _target: ResolvedGlossaryCheckout,
        listener: (state: GlossaryProjectionState) => void,
      ): () => void {
        projectionGate.emit = listener;
        return () => undefined;
      }
    }
    const session = {
      id: "session-1",
      provider: "codex",
      workspacePath: root,
      workspaceLabel: "projection-repo",
      branch: "main",
    };
    const service = new GlossarySessionProjectionService({
      applicationService: new DelayedProjectionService(),
      /** 二つの並行イベントの対象となるセッションを返す。 */
      getSession: () => session,
      /** 監視イベントの順序だけを試すため世代を固定する。 */
      getBindingGeneration: () => "generation-1",
      /** ファイル監視イベントに絞り、バインディング変更は配信しない。 */
      subscribeBindingChanges: () => () => undefined,
    });
    const projections: string[] = [];
    const dispose = await service.subscribe(session.id, (projection) => {
      projections.push(
        projection.state.status === "valid"
          ? (projection.state.entries[0]?.term ?? "")
          : projection.state.status,
      );
    });
    const firstState: GlossaryProjectionState = {
      status: "invalid",
      relativePath: ".withmate/glossary.yaml",
      revision: "old",
      issues: [
        { path: "$", code: "INVALID_YAML", message: "old invalid state" },
      ],
    };
    const secondState: GlossaryProjectionState = {
      status: "valid",
      relativePath: ".withmate/glossary.yaml",
      revision: "new",
      entries: [{ term: "Current", aliases: [], definition: "current state" }],
    };

    projectionGate.emit?.(firstState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    projectionGate.emit?.(secondState);
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstScopeGate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(projections, ["Current"]);
    dispose();
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "並行scope re-armは古いattemptを破棄しdisposeで全watch handleを閉じる"
  // oracle = { type = "contract", ref = "src-electron/glossary/glossary-session-projection-service.ts: scope lifecycle" }
  // fault = "旧attemptが新scopeへ書き込み、dispose後もwatch handleが残る"
  // observable = "projection state、attempt identity、closed handles"
  // observation_boundary = "public-boundary"
  // scope = "glossary-scope-rearm"
  // lifecycle = "permanent"
  // distinction = "単一scopeのdisposeでは検出できないre-arm競合を検証する"
  // @end-test-value
  /** 複数のチェックアウトへの監視切替が競合したとき古い試行を採用せず、破棄の際に作成済みの監視を全て閉じる。 */
  it("並行scope re-armは古いattemptを破棄し、disposeで全watch handleを閉じる", async () => {
    const repositoryA = await createRepository();
    const repositoryB = await createRepository();
    const repositoryC = await createRepository();
    let session = {
      id: "session-1",
      provider: "codex",
      workspacePath: repositoryA.root,
      workspaceLabel: "repository-a",
      branch: "main",
    };
    const slowArmGate: { release: (() => void) | null } = { release: null };
    const slowArm = new Promise<void>((resolve) => {
      slowArmGate.release = resolve;
    });
    let markSlowArmStarted: (() => void) | null = null;
    const slowArmStarted = new Promise<void>((resolve) => {
      markSlowArmStarted = resolve;
    });
    let repositoryBResolves = 0;
    /** 監視の登録先とイベントの送信先、解除済みかどうかを記録する。 */
    type Subscription = {
      target: ResolvedGlossaryCheckout;
      listener: (state: GlossaryProjectionState) => void;
      closed: boolean;
    };
    const subscriptions: Subscription[] = [];
    /** 指定したリポジトリの解決を遅らせて、並行する監視切替を再現する。 */
    class RearmingProjectionService extends GlossaryApplicationService {
      /** ワークスペースを登録先に解決し、不安定な順序を作るため指定の B 解決で待つ。 */
      override async resolvePrimaryCheckout(
        workspacePath: string,
      ): Promise<ResolvedGlossaryCheckout> {
        if (workspacePath === repositoryB.root) {
          repositoryBResolves += 1;
          if (repositoryBResolves === 2) {
            markSlowArmStarted?.();
            await slowArm;
          }
          return repositoryB.target;
        }
        return workspacePath === repositoryC.root
          ? repositoryC.target
          : repositoryA.target;
      }

      /** 監視切替後の対象をリポジトリの名前で識別できる表示値を返す。 */
      override async describeCheckout(target: ResolvedGlossaryCheckout) {
        return {
          repositoryName: path.basename(target.rootPath),
          branch: "main",
          pathLabel: path.basename(target.rootPath),
        };
      }

      /** すべての監視登録について、その対象と解除済みかどうかを追跡する。 */
      override subscribe(
        target: ResolvedGlossaryCheckout,
        listener: (state: GlossaryProjectionState) => void,
      ): () => void {
        const subscription = { target, listener, closed: false };
        subscriptions.push(subscription);
        return () => {
          subscription.closed = true;
        };
      }
    }
    const service = new GlossarySessionProjectionService({
      applicationService: new RearmingProjectionService(),
      /** 監視切替の間も参照するセッションを返す。 */
      getSession: () => session,
      /** 切替の競合はチェックアウトだけに絞るため世代を固定する。 */
      getBindingGeneration: () => "generation-1",
      /** ファイル監視と切替の競合以外の通知は配信しない。 */
      subscribeBindingChanges: () => () => undefined,
    });
    const dispose = await service.subscribe(session.id, () => undefined);
    const staleState: GlossaryProjectionState = {
      status: "invalid",
      relativePath: ".withmate/glossary.yaml",
      revision: "stale",
      issues: [{ path: "$", code: "INVALID_YAML", message: "stale state" }],
    };

    session = {
      ...session,
      workspacePath: repositoryB.root,
      workspaceLabel: "repository-b",
    };
    subscriptions[0].listener(staleState);
    await slowArmStarted;
    session = {
      ...session,
      workspacePath: repositoryC.root,
      workspaceLabel: "repository-c",
    };
    subscriptions[0].listener(staleState);
    for (
      let attempt = 0;
      attempt < 20 && subscriptions.length < 2;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    slowArmGate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      subscriptions.map((subscription) => subscription.target.rootPath),
      [repositoryA.target.rootPath, repositoryC.target.rootPath],
    );
    dispose();
    assert.equal(
      subscriptions.every((subscription) => subscription.closed),
      true,
    );
  });

  /** ファイル変更や別パスがなくてもバインディング世代が変われば監視を張り直し、投影のスコープを新しくする。 */
  it("binding generation変更だけでwatchを張り直し、current scopeを再読込する", async () => {
    const { root, target } = await createRepository();
    await mkdir(path.join(root, ".withmate"));
    await writeFile(
      path.join(root, ".withmate", "glossary.yaml"),
      serializeGlossaryDocument([
        { term: "Current", aliases: [], definition: "current definition" },
      ]),
      "utf8",
    );
    const session = {
      id: "session-binding-change",
      provider: "codex",
      workspacePath: root,
      workspaceLabel: "projection-repo",
      branch: "main",
    };
    const bindingRegistry = new AgentRuntimeBindingRegistry();
    const firstBinding = bindingRegistry.issueOrReuse({
      actorSessionId: session.id,
      providerId: session.provider,
      authoritySnapshot: { revision: "first" },
      operationGrants: ["glossary.read"],
    });
    const subscriptions: Array<{ closed: boolean }> = [];
    /** チェックアウトは固定したまま監視の登録と解除を計測する。 */
    class BindingProjectionService extends GlossaryApplicationService {
      /** 世代交代の前後で共通のチェックアウトを返す。 */
      override async resolvePrimaryCheckout(): Promise<ResolvedGlossaryCheckout> {
        return target;
      }

      /** パスやブランチが変わらない同じ表示情報を返す。 */
      override async describeCheckout() {
        return {
          repositoryName: "repository",
          branch: "main",
          pathLabel: "repository",
        };
      }

      /** 登録の数と終了済みかどうかをテストから確認できる監視ハンドルを返す。 */
      override subscribe(): () => void {
        const subscription = { closed: false };
        subscriptions.push(subscription);
        return () => {
          subscription.closed = true;
        };
      }
    }
    const service = new GlossarySessionProjectionService({
      applicationService: new BindingProjectionService(),
      /** バインディングを張り直す同一のセッションを返す。 */
      getSession: () => session,
      /** 実レジストリのセッションとプロバイダーに対応する実行世代を参照する。 */
      getBindingGeneration: (sessionId, providerId) =>
        bindingRegistry.getExecutionGeneration(sessionId, providerId),
      /** レジストリの変更を、投影サービスが購読するセッション・プロバイダー形式に変換する。 */
      subscribeBindingChanges: (listener) =>
        bindingRegistry.subscribeChanges((change) => {
          listener({
            sessionId: change.actorSessionId,
            providerId: change.providerId,
          });
        }),
    });
    const projections: SessionGlossaryProjection[] = [];
    const dispose = await service.subscribe(session.id, (projection) => {
      projections.push(projection);
    });
    const before = await service.load(session.id);

    const replacement = bindingRegistry.issueOrReuse({
      actorSessionId: session.id,
      providerId: session.provider,
      authoritySnapshot: { revision: "second" },
      operationGrants: ["glossary.read"],
    });
    for (
      let attempt = 0;
      attempt < 20 && projections.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(subscriptions.length, 2);
    assert.equal(subscriptions[0]?.closed, true);
    assert.equal(projections.length, 1);
    assert.notEqual(
      replacement.executionGeneration,
      firstBinding.executionGeneration,
    );
    assert.notEqual(projections[0]?.scopeRevision, before.scopeRevision);
    assert.equal(projections[0]?.state.status, "valid");
    dispose();
    assert.equal(
      subscriptions.every((subscription) => subscription.closed),
      true,
    );
  });
});
