import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { DeleteSessionsLastActiveBeforeCutoff } from "../../src-shared/window/withmate-window-types.js";
import { MainSessionCommandFacade } from "../../src-electron/app/main-session-command-facade.js";
import {
  ProviderRuntimeOperationCoordinator,
  type RunProviderRuntimeOperationExclusive,
} from "../../src-electron/providers/provider-runtime-operation-coordinator.js";
import type { SessionLaunchSelection } from "../../src-electron/session/session-launch-selection-service.js";
import type { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import type { SessionLifecycleOperation } from "../../src-electron/session/session-lifecycle-operation.js";
import { SettingsCatalogService } from "../../src-electron/settings/settings-catalog-service.js";

/** 排他制御を検査しないケースでは、受けた操作をその場で実行する。 */
const runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive =
  async (operation) => await operation();

/** 非同期ステップの解放をテストの任意の順序で制御する。 */
function createDeferred<T = void>(): {
  promise: Promise<T>;
  /** 保留中の Promise を指定した結果で完了させる。 */
  resolve(value: T): void;
} {
  /** Promise 初期化時に実際の解決関数へ交換するまでの初期値。 */
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

/** 起動設定の既定値を揃え、検査したい項目だけを上書きできるようにする。 */
function createLaunchSelection(
  overrides: Partial<SessionLaunchSelection> = {},
): SessionLaunchSelection {
  return {
    provider: "codex",
    model: "gpt-5.6",
    reasoningEffort: "high",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    ...overrides,
  };
}

/** キャラクター情報を固定し、指定のワークスペースを選ぶ作成要求を構成する。 */
function createSessionRequest(
  workspace: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider: "codex",
    taskTitle: "test task",
    workspace,
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: {
      main: "#112233",
      sub: "#445566",
    },
    approvalMode: "untrusted",
  };
}

/** ファサードが本番のコンストラクターで受ける依存関係の型。 */
type MainSessionCommandFacadeDeps = ConstructorParameters<
  typeof MainSessionCommandFacade
>[0];
/** テスト側で安全な既定値を補える依存関係の名前。 */
type DefaultMainSessionCommandFacadeDep =
  | "dismissSessionTurnNotification"
  | "validateWorkspaceDirectory"
  | "initializeCreatedSession"
  | "getSessionStorageIdentity";
/** 既定値のある依存関係だけ省略できる、テスト用ファサードの入力。 */
type MainSessionCommandFacadeTestDeps = Omit<
  MainSessionCommandFacadeDeps,
  DefaultMainSessionCommandFacadeDep
> &
  Partial<
    Pick<MainSessionCommandFacadeDeps, DefaultMainSessionCommandFacadeDep>
  >;

/** 永続化の主要操作を差し替えながら、作成時のライフサイクルをメモリ上で再現する。 */
function createMainSessionCommandFacade(
  deps: MainSessionCommandFacadeTestDeps,
): MainSessionCommandFacade {
  const defaultStorageIdentity = {};
  const operations = new Map<string, SessionLifecycleOperation>();
  const sessions = new Map<string, Session>();
  /** 依存先から取得したストレージに、テスト用のライフサイクル操作を重ねる。 */
  const getPersistence = (): SessionPersistenceService => {
    const service = deps.getSessionPersistenceService();
    return {
      ...service,
      /** 作成結果を保持し、後続段階が同じセッションを参照できるようにする。 */
      createSession: async (
        ...args: Parameters<SessionPersistenceService["createSession"]>
      ) => {
        const created = await service.createSession(...args);
        sessions.set(created.id, created);
        return created;
      },
      /** 既存の操作を優先し、未登録 ID にだけ準備段階の操作を割り当てる。 */
      beginSessionLifecycleOperation: async (
        input: Parameters<
          SessionPersistenceService["beginSessionLifecycleOperation"]
        >[0],
      ) => {
        const operation: SessionLifecycleOperation = operations.get(
          input.operationId,
        ) ?? {
          ...input,
          resources: input.resources ?? [],
          phase: "preparing",
          createdAt: "now",
          updatedAt: "now",
        };
        operations.set(input.operationId, operation);
        return operation;
      },
      /** 公開前のセッションをライフサイクル ID で読み取る。 */
      readSessionForLifecycle: async (id: string) => sessions.get(id) ?? null,
      /** 操作段階を更新し、指定された場合だけ資源一覧も差し替える。 */
      advanceSessionLifecycleOperation: async (
        id: string,
        phase: SessionLifecycleOperation["phase"],
        resources?: SessionLifecycleOperation["resources"],
      ) => {
        const operation = {
          ...operations.get(id)!,
          phase,
          ...(resources ? { resources } : {}),
        };
        operations.set(id, operation);
        return operation;
      },
      /** 作成時に保存したセッションを公開結果として返す。 */
      publishCreatedSession: async (id: string) => sessions.get(id)!,
    } as unknown as SessionPersistenceService;
  };
  return new MainSessionCommandFacade({
    /** 初期化処理を観測しないケースでは追加の書き込みを行わない。 */
    initializeCreatedSession: async () => undefined,
    /** 通知の撤去を観測するケースだけが独自の処理を与える。 */
    dismissSessionTurnNotification: () => undefined,
    /** ディレクトリ再検証を扱わないケースの既定結果を有効とする。 */
    validateWorkspaceDirectory: async () => ({ valid: true }),
    /** ストレージ切替を模擬しないケースでは同じ識別子を返す。 */
    getSessionStorageIdentity: () => defaultStorageIdentity,
    ...deps,
    getSessionPersistenceService: getPersistence,
    /** 既存資源を再利用し、未作成ならディレクトリを作って資源記録を永続化する。 */
    prepareSessionLifecycleFiles: async (input, sessionId) => {
      if (input.resource) return input.resource.path;
      const directoryPath = await deps.createSessionFilesDirectory(sessionId);
      await input.persistResource({
        path: directoryPath,
        device: "1",
        inode: "1",
        cleaned: false,
      });
      return directoryPath;
    },
  });
}

/** 保存済みセッションの既定状態を定義し、各検査で必要な属性だけ変えられるようにする。 */
function createSessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    taskTitle: "task",
    status: "idle",
    updatedAt: "2026-09-21T00:00:00.000Z",
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#112233", sub: "#445566" },
    characterRuntimeSnapshot: null,
    runState: "idle",
    approvalMode: "untrusted",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    model: "gpt-5.6",
    reasoningEffort: "high",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    messages: [],
    stream: [],
    ...overrides,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Session削除結果に含まれる親SessionとAuxiliaryの通知対象をすべて撤去する"
// oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
// fault = "削除結果に含まれるAuxiliary通知の追跡keyを通知撤去へ渡さない"
// observable = "dismissSessionTurnNotificationへ渡されたID"
// observation_boundary = "component-behavior"
// scope = "main-session-command-facade-notification-cleanup"
// lifecycle = "permanent"
// distinction = "通知service単体ではなく、削除結果から親・Auxiliaryの通知撤去へ渡すfacade境界を検証する"
// @end-test-value
/** 削除結果に含まれる親と補助セッションの双方について、ターン通知を撤去する。 */
test("MainSessionCommandFacade は削除結果に含まれるAuxiliary通知も撤去する", async () => {
  const dismissedIds: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 親セッションを別経路から読み戻さずに削除結果だけで処理させる。 */
    getSession: () => null,
    /** メモリ上に残るセッション一覧には依存させない。 */
    getSessions: () => [],
    /** 保存済み一覧は空にし、撤去すべき ID を削除結果に限定する。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 削除とは無関係な起動設定を既定値で満たす。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 親と補助セッションを一緒に削除した保存結果を供給する。 */
    getSessionPersistenceService: () =>
      ({
        /** 一件ずつの親・補助 ID を返し、実行中で除外された ID はないことを示す。 */
        deleteSession: () => ({
          deletedSessionIds: ["session-1"],
          deletedAuxiliarySessionIds: ["auxiliary-1"],
          skippedRunningSessionIds: [],
        }),
      }) as never,
    /** 削除後の通知判定にランタイム固有の処理を介在させない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 通知撤去の検査では利用枠データを返さない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の古さを通知撤去の条件に加えない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の更新経路は空値で満たす。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 削除では使用しない新規 ID を固定する。 */
    createSessionId: () => "launch-test",
    /** 作成されないディレクトリの既定パスを返す。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** セッションフォルダーを作業場所として扱わない。 */
    isSessionFilesWorkspace: () => false,
    /** 通知撤去の対象を呼び出し順に記録する。 */
    dismissSessionTurnNotification(sessionId) {
      dismissedIds.push(sessionId);
    },
  });

  await facade.deleteSession("session-1");

  assert.deepEqual(dismissedIds, ["session-1", "auxiliary-1"]);
});

// @test-value v2
// kind = "contract"
// claim = "MainSessionCommandFacadeはcreate、update、pin、deleteを対応serviceへ委譲し、delete成功後にnotificationとSessionFolder cleanupを実行する"
// oracle = { type = "contract", ref = "src-electron/app/main-session-command-facade.ts" }
// fault = "操作を誤ったserviceへ送る、またはdelete成功後のcleanupを省く"
// observable = "各service mockへ記録された呼出し順と引数"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-command-routing"
// lifecycle = "permanent"
// @end-test-value
/** 作成・更新・ピン留め・削除と、削除後の通知およびフォルダーの片付けの順序を照合する。 */
test("MainSessionCommandFacade は create/update/pin/delete を各 service に委譲する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 単件の参照で追加のセッションを見せない。 */
    getSession: () => null,
    /** 操作対象のセッションを作業場所付きで一覧に載せる。 */
    getSessions: () => [{ id: "s-1", workspacePath: "C:/work/repo" } as never],
    /** 永続化の一覧を空にして個別コマンドの委譲を観測する。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 作成に渡す既定モデルと実行承認設定を解決する。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 操作先の永続化 API を同じ呼び出し履歴につなぐ。 */
    getSessionPersistenceService: () =>
      ({
        /** 新規に発行された ID を記録し、その入力を保存結果として返す。 */
        createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          calls.push(`create:${input.id}`);
          return input as never;
        },
        /** 更新対象の ID を記録し、受け取ったセッションを返す。 */
        updateSession(
          session: Parameters<SessionPersistenceService["updateSession"]>[0],
        ) {
          calls.push(`update:${session.id}`);
          return session as never;
        },
        /** 空白が除かれた ID とピン状態を記録する。 */
        setSessionPinned(sessionId: string, isPinned: boolean) {
          calls.push(`pin:${sessionId}:${isPinned}`);
          return { id: sessionId, isPinned } as never;
        },
        /** 単件削除を記録し、その ID だけを成功結果に載せる。 */
        deleteSession(sessionId: string) {
          calls.push(`delete:${sessionId}`);
          return {
            deletedSessionIds: [sessionId],
            skippedRunningSessionIds: [],
          };
        },
        /** 一括削除が呼ばれた場合は、単件削除と区別できる履歴を残す。 */
        deleteSessionsLastActiveBefore() {
          calls.push("delete-old");
          return {
            deletedSessionIds: ["s-old"],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    /** 削除可否を調べるための実行状態サービスを提供する。 */
    getSessionRuntimeService: () =>
      ({
        /** 操作対象は実行中ではないと報告する。 */
        isRunInFlight() {
          return false;
        },
      }) as never,
    /** コマンド配送に利用枠を混ぜない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の再取得条件は成立させない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 外部の利用枠問い合わせは発生させない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 作成と保存の履歴を照合するため ID を固定する。 */
    createSessionId: () => "launch-test",
    /** 作成されるセッションフォルダーのパスを固定する。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 明示されたリポジトリをフォルダー特例として扱わない。 */
    isSessionFilesWorkspace: () => false,
    /** 削除後の通知撤去を同じコマンド履歴に追加する。 */
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
    /** 通知撤去に続くフォルダーの片付けを ID 付きで記録する。 */
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
    },
  });

  await facade.createSession({
    taskTitle: "test",
    workspaceLabel: "repo",
    workspacePath: "C:/work/repo",
    branch: "main",
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: {
      main: "#112233",
      sub: "#445566",
    },
    approvalMode: "untrusted",
  });
  facade.updateSession({ id: "s-1" } as never);
  await facade.setSessionPinned({ sessionId: " s-1 ", isPinned: true });
  await facade.deleteSession("s-1");

  assert.deepEqual(calls, [
    "create:launch-test",
    "update:s-1",
    "pin:s-1:true",
    "delete:s-1",
    "dismiss-notification:s-1",
    "cleanup-files:s-1",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "Session削除が失敗した場合、通知撤去などの削除後副作用を実行しない"
// oracle = { type = "contract", ref = "src-electron/app/main-session-command-facade.ts deleteSession" }
// fault = "永続化deleteの例外を握り潰す、または削除未成立なのにnotificationを撤去する"
// observable = "delete errorと、notification serviceの呼出し記録"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-delete-failure"
// lifecycle = "permanent"
// @end-test-value
/** 保存先で削除が失敗したら、その例外を伝播し通知を残す。 */
test("MainSessionCommandFacade は Session 削除失敗時に通知を撤去しない", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 削除時の単件読み取りに結果を与えない。 */
    getSession: () => null,
    /** 削除の入力 ID に対応するセッションを一覧に置く。 */
    getSessions: () => [{ id: "s-1", workspacePath: "C:/work/repo" } as never],
    /** 追加の要約データには依存しない。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 作成が不要な検査向けに起動設定を満たす。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 削除失敗を注入する永続化先を返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 削除の試行を記録した後、保存先の失敗を発生させる。 */
        deleteSession(sessionId: string) {
          calls.push(`delete:${sessionId}`);
          throw new Error("delete failed");
        },
      }) as never,
    /** 保存処理の失敗を他のランタイム動作と切り離す。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 削除検査に影響する残量スナップショットは返さない。 */
    getProviderQuotaTelemetry: () => null,
    /** 残量キャッシュの期限切れを模擬しない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 失敗する削除とは無関係な残量更新を空の結果にする。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 作成されないセッションの既定 ID。 */
    createSessionId: () => "launch-test",
    /** この削除経路では使用しないフォルダーパス。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 削除対象をセッションフォルダーの作業場所とはみなさない。 */
    isSessionFilesWorkspace: () => false,
    /** 誤って通知を撤去した場合は検査履歴に残す。 */
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
  });

  await assert.rejects(facade.deleteSession("s-1"), /delete failed/);
  assert.deepEqual(calls, ["delete:s-1"]);
});

// @test-value v2
// kind = "contract"
// claim = "SessionFolderと保存するSessionは同じMain発行IDを使い、再検証済みの起動設定で保存する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "folderとSessionのIDが分岐する、またはworkspace情報や継承する起動設定を欠落させる"
// observable = "folder作成・保存へ渡すID、永続化入力のworkspaceと起動設定"
// observation_boundary = "component-behavior"
// scope = "MainSessionCommandFacadeのSessionFolder作成入力"
// lifecycle = "permanent"
// @end-test-value
/** 起動設定の再検証を経て、割り当てた ID とフォルダーを同じ保存レコードに結び付ける。 */
test("MainSessionCommandFacade は SessionFolder を作成してから同じ ID の session を永続化する", async () => {
  const calls: string[] = [];
  const discoveryRequests: Array<{
    workspacePath: string | undefined;
    capturedDefaults: SessionLaunchSelection | undefined;
  }> = [];
  const persisted = {
    input: null as
      Parameters<SessionPersistenceService["createSession"]>[0] | null,
  };
  const facade = createMainSessionCommandFacade({
    /** 作成前の単件検索では保存済みセッションを発見しない。 */
    getSession: () => null,
    /** 既存セッションによる入力の上書きを避けるため空一覧を返す。 */
    getSessions: () => [],
    /** 履歴のない状態からフォルダー作成を始める。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** フォルダーの実パスと前回選択を記録し、保存すべき起動設定を返す。 */
    resolveSessionLaunchSelection: async (
      providerId,
      workspacePath,
      capturedDefaults,
    ) => {
      discoveryRequests.push({ workspacePath, capturedDefaults });
      calls.push(`resolve:${providerId}`);
      return createLaunchSelection({
        model: "gpt-5.6-pro",
        reasoningEffort: "xhigh",
        approvalMode: "never",
        codexSandboxMode: "danger-full-access",
        customAgentName: "reviewer",
      });
    },
    /** 実際の保存入力を照合する永続化先を返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 作成の順序に保存を記録し、起動値と作業場所を比較用に保持する。 */
        createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          calls.push(`persist:${input.id}`);
          persisted.input = input;
          return input as never;
        },
      }) as never,
    /** 新しいセッションの作成に既存ランタイムの状態を追加しない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 保存入力の確認に無関係な利用枠は空とする。 */
    getProviderQuotaTelemetry: () => null,
    /** モデル選択を利用枠の期限切れに依存させない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の更新には外部処理を割り当てない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 採番がディレクトリ作成より前に行われたか記録する。 */
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-managed";
    },
    /** ID を受け取ってフォルダーを用意した時点と、そのパスを再現する。 */
    createSessionFilesDirectory: (sessionId) => {
      calls.push(`mkdir:${sessionId}`);
      return "C:/WithMate/session-files/launch-managed";
    },
    /** 既存ワークスペースに対するフォルダー判定は常に否定する。 */
    isSessionFilesWorkspace: () => false,
  });

  await facade.createSessionFromRequest(
    createSessionRequest({ kind: "session-folder" }) as never,
  );

  assert.deepEqual(calls, [
    "issue-id",
    "mkdir:launch-managed",
    "resolve:codex",
    "resolve:codex",
    "persist:launch-managed",
  ]);
  assert.deepEqual(
    discoveryRequests.map((request) => request.workspacePath),
    [
      "C:/WithMate/session-files/launch-managed",
      "C:/WithMate/session-files/launch-managed",
    ],
  );
  assert.equal(discoveryRequests[0]?.capturedDefaults, undefined);
  assert.equal(discoveryRequests[1]?.capturedDefaults?.model, "gpt-5.6-pro");
  assert.deepEqual(
    {
      id: persisted.input?.id,
      workspaceLabel: persisted.input?.workspaceLabel,
      workspacePath: persisted.input?.workspacePath,
      branch: persisted.input?.branch,
      workspace: persisted.input
        ? Reflect.get(persisted.input, "workspace")
        : undefined,
      model: persisted.input?.model,
      reasoningEffort: persisted.input?.reasoningEffort,
      approvalMode: persisted.input?.approvalMode,
      codexSandboxMode: persisted.input?.codexSandboxMode,
      customAgentName: persisted.input?.customAgentName,
    },
    {
      id: "launch-managed",
      workspaceLabel: "SessionFolder",
      workspacePath: "C:/WithMate/session-files/launch-managed",
      branch: "",
      workspace: undefined,
      model: "gpt-5.6-pro",
      reasoningEffort: "xhigh",
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
      customAgentName: "reviewer",
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "Main Sessionの永続化後に行う初期Auxiliary作成はprovider runtime lockの外で実行し、同じlockを使う初期化処理を完了できる"
// oracle = { type = "contract", ref = "accepted behavior: created session initialization runs after provider-exclusive creation" }
// fault = "初期Auxiliary作成がprovider runtime lockを再取得してdeadlockする、または初期化前に作成結果を返す"
// observable = "initializeCreatedSession内のprovider runtime lock再取得とcreateSessionFromRequestの完了"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
/** 新規セッションの公開後に、実行ロックを再取得する初期化がデッドロックせず完了する。 */
test("MainSessionCommandFacade は Main Session 作成後の初期化を provider runtime lock の外で完了する", async () => {
  const coordinator = new ProviderRuntimeOperationCoordinator();
  const events: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 既存の同一セッションを読み込まず、新規作成経路を使う。 */
    getSession: () => null,
    /** 初期化検査に既存のメモリ上のセッションを加えない。 */
    getSessions: () => [],
    /** 永続化要約一覧なしで新規セッションを作る。 */
    getStoredSessionSummaries: () => [],
    /** 作成と初期化で同じ実排他コーディネーターを利用する。 */
    runProviderRuntimeOperationExclusive: (operation) =>
      coordinator.runExclusive(operation),
    /** ロックの外側・内側のいずれでも同じ起動候補を返す。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** ロック付きの作成が永続化に到達するか観測できるようにする。 */
    getSessionPersistenceService: () =>
      ({
        /** 公開されたセッションを初期化する前に、保存時の ID を記録する。 */
        createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          events.push(`persist:${input.id}`);
          return input as never;
        },
      }) as never,
    /** 初期化と排他の検査にターン実行を導入しない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 既存の利用枠観測値を参照させない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠が古いことによる更新を発生させない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の取得があっても外部へ接続しない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 同じ排他を再取得し、初期化の始点・取得・終点を記録する。 */
    initializeCreatedSession: async (session) => {
      events.push(`initialize:start:${session.id}`);
      await coordinator.runExclusive(() => {
        events.push(`initialize:lock:${session.id}`);
      });
      events.push(`initialize:end:${session.id}`);
    },
    /** 保存と初期化の両方で追える ID を発行する。 */
    createSessionId: () => "launch-initialized",
    /** 初期化用セッションに対応するファイル領域のパスを返す。 */
    createSessionFilesDirectory: () =>
      "C:/WithMate/session-files/launch-initialized",
    /** 指定の作業ディレクトリをセッションフォルダーとして扱わない。 */
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.createSessionFromRequest(
    createSessionRequest({
      kind: "directory",
      label: "repo",
      path: "C:/repo",
      branch: "main",
    }) as never,
  );

  assert.equal(result.id, "launch-initialized");
  assert.deepEqual(events, [
    "persist:launch-initialized",
    "initialize:start:launch-initialized",
    "initialize:lock:launch-initialized",
    "initialize:end:launch-initialized",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Main Session保存後の初期Auxiliary作成失敗は保存済みSessionを保持し、再開用IDをエラーへ含める"
// oracle = { type = "contract", ref = "src-electron/app/main-session-command-facade.ts#createSessionFromRequest" }
// fault = "初期化失敗後に保存済みMain Sessionを削除し、利用者が再開できるSession IDを失う"
// observable = "返却されたError messageの保存済みSession IDとdeleteSessionが呼ばれていないこと"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
/** 作成後の初期化失敗を保存済み ID と原因付きで返し、セッションとファイルを残す。 */
test("MainSessionCommandFacade は保存後の初期化失敗時に Main Session と SessionFolder を保持する", async () => {
  const calls: string[] = [];
  const existingSession = createSessionFixture({
    id: "existing-session",
    workspacePath: "C:/existing",
  });
  const createdSession = createSessionFixture({
    id: "launch-initialize-failed",
    workspacePath: "C:/WithMate/session-files/launch-initialize-failed",
  });
  const facade = createMainSessionCommandFacade({
    /** 単件取得で既存項目を返さない。 */
    getSession: () => null,
    /** 作成対象と異なる既存セッションを一覧に含める。 */
    getSessions: () => [existingSession],
    /** 保存済み一覧にも同じ既存セッションを見せる。 */
    getStoredSessionSummaries: () => [existingSession],
    runProviderRuntimeOperationExclusive,
    /** 失敗を起動選択に混ぜず、補助セッション初期化へ絞る。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 作成・削除の呼び出しを観測する保存サービスを返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 初期化前に親セッションの保存が成立したことを記録する。 */
        createSession() {
          calls.push("persist");
          return createdSession;
        },
        /** 初期化失敗後に誤って親を削除した場合に記録する。 */
        deleteSession(sessionId: string) {
          calls.push(`delete:${sessionId}`);
          return {
            deletedSessionIds: [sessionId],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    /** ランタイムの実処理ではなく作成後のフックだけを失敗させる。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 初期化失敗の経路に既存の利用枠を与えない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の経過時間を失敗の原因にしない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 外部の利用枠問い合わせを代替する。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 親保存後の既定補助セッション作成だけを失敗させる。 */
    initializeCreatedSession: async () => {
      calls.push("initialize");
      throw new Error("default Auxiliary を作成できない");
    },
    /** エラーの再開案内で照合する新規セッション ID。 */
    createSessionId: () => "launch-initialize-failed",
    /** 失敗後にも維持すべき新規フォルダーのパス。 */
    createSessionFilesDirectory: () =>
      "C:/WithMate/session-files/launch-initialize-failed",
    /** 新規セッションだけが専用フォルダーを作業場所にする。 */
    isSessionFilesWorkspace: (session) => session.id === createdSession.id,
    /** 通知まで撤去した場合は、その副作用を履歴に残す。 */
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss:${sessionId}`);
    },
    /** 保持すべきフォルダーの後処理が実行された場合に記録する。 */
    cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup:${sessionId}`);
      return Promise.resolve();
    },
  });

  await assert.rejects(
    facade.createSessionFromRequest(
      createSessionRequest({ kind: "session-folder" }) as never,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Saved Session ID: launch-initialize-failed/);
      assert.match(error.message, /default Auxiliary を作成できない/);
      assert.equal(
        error.cause instanceof Error ? error.cause.message : error.cause,
        "default Auxiliary を作成できない",
      );
      return true;
    },
  );
  assert.deepEqual(calls, ["persist", "initialize"]);
  assert.equal(
    calls.some((call) => call.startsWith("delete:")),
    false,
  );
  assert.equal(
    calls.some((call) => call.startsWith("cleanup:")),
    false,
  );
});

// @test-value v2
// kind = "contract"
// claim = "初期化失敗中に同じMain Sessionが更新されても保存済みSessionを削除しない"
// oracle = { type = "contract", ref = "src-electron/app/main-session-command-facade.ts#createSessionFromRequest" }
// fault = "初期化失敗時の無条件rollbackが並行updateの変更を破壊する"
// observable = "並行updateの完了とdeleteSessionの不在"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
/** 初期化が保留中でも同じセッションの更新を許し、初期化失敗で保存分を消さない。 */
test("MainSessionCommandFacade は並行操作中の初期化失敗でも保存済みSessionを削除しない", async () => {
  const initializationError = new Error("Auxiliary initialization failed");
  const initializationStarted = createDeferred<void>();
  const releaseInitialization = createDeferred<never>();
  const calls: string[] = [];
  const createdSession = createSessionFixture({
    id: "launch-cleanup-failed",
    workspacePath: "C:/WithMate/session-files/launch-cleanup-failed",
  });
  const facade = createMainSessionCommandFacade({
    /** 単件検索には結果を用意せず、更新の入力をそのまま使う。 */
    getSession: () => null,
    /** 初期化待ちと並行して更新するセッションを列挙する。 */
    getSessions: () => [createdSession],
    /** 保存要約は並行更新の判定に使わない。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 初期化に進める既定の起動選択を提供する。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 保存・更新・意図しない削除を同じ履歴で追える保存先。 */
    getSessionPersistenceService: () =>
      ({
        /** 初期化待ちに入る前に保存された親セッションを返す。 */
        createSession() {
          calls.push("persist");
          return createdSession;
        },
        /** 初期化の停止中に受理したタイトル更新を保存結果として返す。 */
        updateSession(session: unknown) {
          calls.push("update");
          return session;
        },
        /** 誤ったロールバックを検出する削除処理。 */
        deleteSession() {
          calls.push("delete");
          return {
            deletedSessionIds: [createdSession.id],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    /** 競合の対象を作成と保存更新に絞るため、ターン実行機能を用いない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 並行更新に関係しない残量キャッシュは空とする。 */
    getProviderQuotaTelemetry: () => null,
    /** 枠の再取得が必要という状態にはしない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 並行処理の計測に利用枠更新を加えない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 初期化開始を通知し、並行更新が終わるまで例外の送出を止める。 */
    initializeCreatedSession: async () => {
      initializationStarted.resolve();
      await releaseInitialization.promise;
      throw initializationError;
    },
    /** 並行更新の対象を作成結果と同じ ID に揃える。 */
    createSessionId: () => createdSession.id,
    /** 並行操作中も保持する作業場所を返す。 */
    createSessionFilesDirectory: () =>
      "C:/WithMate/session-files/launch-cleanup-failed",
    /** 新規セッションは専用フォルダーを作業場所とする。 */
    isSessionFilesWorkspace: () => true,
    /** 通知撤去は並行保存の検査から切り離す。 */
    dismissSessionTurnNotification: () => undefined,
  });

  const createPromise = facade.createSessionFromRequest(
    createSessionRequest({ kind: "session-folder" }) as never,
  );
  await initializationStarted.promise;
  const update = await facade.updateSession({
    ...createdSession,
    taskTitle: "updated while initializing",
  } as never);
  releaseInitialization.resolve(undefined as never);

  await assert.rejects(createPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, initializationError);
    assert.match(error.message, /Saved Session ID: launch-cleanup-failed/);
    return true;
  });
  assert.equal(
    (update as { taskTitle: string }).taskTitle,
    "updated while initializing",
  );
  assert.deepEqual(calls, ["persist", "update"]);
});

// @test-value v2
// kind = "contract"
// claim = "空または空白だけのCharacter IDはSessionFolder作成やselection解決より前に拒否する"
// oracle = { type = "contract", ref = "src-electron/session/create-session-request.ts#parseCreateSessionRequest" }
// fault = "空のCharacter IDを受け入れて副作用を開始するか、入力エラーを別のvalidationへ変換する"
// observable = "rejection message and selection/ID/folder/persistence calls"
// observation_boundary = "public-boundary"
// scope = "main-session-create-character-id-validation"
// lifecycle = "permanent"
// impact = "不正なSessionが保存されるか、拒否前にSessionFolderなどの副作用が発生する"
// distinction = "session-folderとdirectoryの両workspaceで空・whitespace入力を通し、全副作用不在を確認する"
// @end-test-value
/** 空文字や空白だけのキャラクター ID は、いずれの作業場所でも副作用の前に拒否する。 */
test("MainSessionCommandFacade は空の Character ID を SessionFolder 作成前に拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 不正入力の検査を既存セッションの有無と切り離す。 */
    getSession: () => null,
    /** 既存セッションに紐づかない新規作成として受ける。 */
    getSessions: () => [],
    /** 要約のロードは入力検証の対象にしない。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 起動選択が検証に先行した場合に、順序違反を記録する。 */
    resolveSessionLaunchSelection: async () => {
      calls.push("resolve-selection");
      return createLaunchSelection();
    },
    /** 不正な入力が保存まで進んだことを検出する永続化先。 */
    getSessionPersistenceService: () =>
      ({
        /** 入力検証をすり抜けた保存を記録し、ただちに失敗させる。 */
        createSession() {
          calls.push("persist");
          throw new Error("unexpected persistence");
        },
      }) as never,
    /** 既存ターンの情報を入力エラーの判断に使わない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 残量情報なしでキャラクター ID の検証を行う。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の更新が要らない状態にする。 */
    isProviderQuotaTelemetryStale: () => false,
    /** この経路では照会先のない利用枠更新を用意する。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 不正入力でも採番した場合に履歴を残す。 */
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-empty-character";
    },
    /** 不正入力によるフォルダー作成が起きれば記録する。 */
    createSessionFilesDirectory: () => {
      calls.push("create-folder");
      return "C:/WithMate/session-files/launch-empty-character";
    },
    /** 入力検証用の既定判定は専用フォルダーなしとする。 */
    isSessionFilesWorkspace: () => false,
  });

  for (const workspace of [
    { kind: "session-folder" },
    { kind: "directory", label: "repo", path: "C:/repo", branch: "main" },
  ]) {
    for (const characterId of ["", " \t\n "]) {
      const request = createSessionRequest(workspace);
      request.characterId = characterId;
      request.characterRuntimeSnapshot = null;

      await assert.rejects(
        facade.createSessionFromRequest(request as never),
        /characterId cannot be empty/,
      );
    }
  }
  assert.deepEqual(calls, []);
});

// @test-value v2
// kind = "invariant"
// claim = "Session作成時のcharacterIdとruntime snapshotのowner IDはtrim後に同じ値として永続化される"
// oracle = { type = "contract", ref = "character runtime snapshot ownership" }
// fault = "入力の空白を含むowner IDをそのまま保存し、Sessionとsnapshotのowner identityを不一致にする"
// observable = "createSessionへ渡されたcharacterIdとcharacterRuntimeSnapshot.characterId"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-character-owner"
// lifecycle = "permanent"
// @end-test-value
/** 所有者 ID の周囲の空白を除き、セッションとスナップショットへ同じ値を保存する。 */
test("MainSessionCommandFacade は Character owner ID と snapshot owner ID を trim 後の値で保存する", async () => {
  const persisted = {
    input: null as
      Parameters<SessionPersistenceService["createSession"]>[0] | null,
  };
  const facade = createMainSessionCommandFacade({
    /** 別の保存済みキャラクター所有者を持ち込まない。 */
    getSession: () => null,
    /** 新しいセッション以外のメモリ一覧は空とする。 */
    getSessions: () => [],
    /** 要約一覧を所有者の正規化に使わない。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 既定の起動値を使って所有者 ID だけを変える。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 実際に渡された二つの所有者 ID を検査できる保存先。 */
    getSessionPersistenceService: () =>
      ({
        /** 正規化後のセッション作成入力をそのまま捕捉する。 */
        createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          persisted.input = input;
          return input as never;
        },
      }) as never,
    /** 所有者の正規化にランタイム依存を追加しない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** この作成ケースには利用枠情報を与えない。 */
    getProviderQuotaTelemetry: () => null,
    /** 枠の鮮度による副作用を抑える。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の外部取得を空の結果で代替する。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 正規化を観測するための新規セッション ID を固定する。 */
    createSessionId: () => "launch-normalized-owner",
    /** 所有者を保存するセッションの作業場所を返す。 */
    createSessionFilesDirectory: () =>
      "C:/WithMate/session-files/launch-normalized-owner",
    /** 既存セッションに対する専用フォルダー特例を使わない。 */
    isSessionFilesWorkspace: () => false,
  });
  const request = createSessionRequest({ kind: "session-folder" });
  request.characterId = " character-1 ";
  request.characterRuntimeSnapshot = {
    characterId: "\tcharacter-1\n",
    name: "Character",
    description: "",
    iconFilePath: "",
    theme: { main: "#112233", sub: "#445566" },
    definitionMarkdown: "# Character\nCharacter",
    definitionSha256: "character-sha256",
    definitionByteSize: 21,
    snapshotAt: "2026-08-01T00:00:00.000Z",
  };

  await facade.createSessionFromRequest(request as never);

  assert.equal(persisted.input?.characterId, "character-1");
  assert.equal(
    (
      persisted.input?.characterRuntimeSnapshot as
        { characterId?: unknown } | undefined
    )?.characterId,
    "character-1",
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Character IDとruntime snapshot ownerが一致しないSession作成入力は副作用前に拒否する"
// oracle = { type = "contract", ref = "src-electron/session/create-session-request.ts#parseCreateSessionRequest" }
// fault = "owner不一致を受け入れてSessionFolder作成または永続化を開始する"
// observable = "rejection message and create/selection/folder calls"
// observation_boundary = "public-boundary"
// scope = "main-session-create-character-runtime-owner"
// lifecycle = "permanent"
// impact = "SessionとCharacter runtime snapshotのowner identityが不一致になり、別Characterの状態を参照する"
// distinction = "入力validationのrejectionと副作用callの不在を同じfacade境界で確認する"
// @end-test-value
/** 別のキャラクターを所有者とするスナップショットを受け付けず、選択や保存に進まない。 */
test("MainSessionCommandFacade は Character ID と runtime snapshot owner の不一致を副作用前に拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 単件検索からキャラクター情報を補完させない。 */
    getSession: () => null,
    /** 他セッションとの関係を作らず、要求内の所有者だけを比較する。 */
    getSessions: () => [],
    /** 既存の要約が不要な作成経路にする。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 所有者の不一致を調べる前に起動選択が走れば記録する。 */
    resolveSessionLaunchSelection: async () => {
      calls.push("resolve-selection");
      return createLaunchSelection();
    },
    /** 拒否前の書き込みを観測するため、失敗する保存先を用意する。 */
    getSessionPersistenceService: () =>
      ({
        /** 所有者の合わない入力を保存しようとした場合は検査を失敗させる。 */
        createSession() {
          calls.push("persist");
          throw new Error("unexpected persistence");
        },
      }) as never,
    /** 所有者確認にランタイム情報を提供しない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 利用枠はスナップショット所有者の判定に使わない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠再取得の条件を成立させない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の取得先を空の応答で代替する。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 誤って作成に進んだ場合のセッション ID を用意する。 */
    createSessionId: () => "launch-mismatch",
    /** 不一致の要求が専用フォルダー準備まで進めば記録する。 */
    createSessionFilesDirectory: () => {
      calls.push("create-folder");
      return "C:/WithMate/session-files/launch-mismatch";
    },
    /** 既存フォルダーの利用判定を所有者の検証から除外する。 */
    isSessionFilesWorkspace: () => false,
  });
  const request = createSessionRequest({ kind: "session-folder" });
  request.characterRuntimeSnapshot = {
    characterId: "other-character",
    name: "Other",
    description: "",
    iconFilePath: "",
    theme: { main: "#112233", sub: "#445566" },
    definitionMarkdown: "# Character\nOther",
    definitionSha256: "other-sha256",
    definitionByteSize: 17,
    snapshotAt: "2026-08-01T00:00:00.000Z",
  };

  await assert.rejects(
    facade.createSessionFromRequest(request as never),
    /characterRuntimeSnapshot\.characterId does not match characterId/,
  );
  assert.deepEqual(calls, []);
});

// @test-value v2
// kind = "contract"
// claim = "SessionFolder準備中のSettings更新は待機せず、起動設定の最終解決と保存中のSettings更新だけを直列化する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "folder準備がprovider coordinatorを保持してSettings更新を待たせる、または再検証と保存の途中にSettings更新が割り込む"
// observable = "folder barrier解放前のSettings更新完了、再解決・永続化event、保存後の次Settings更新event"
// observation_boundary = "component-behavior"
// scope = "実provider coordinatorとSettingsCatalogServiceを接続したMain作成境界"
// lifecycle = "permanent"
// impact = "filesystem待機がSettings操作を停止させるか、古い起動設定で作成する"
// distinction = "任意sleepではなくfolder barrierを保持した状態で別の実service操作が完了することを確認する"
// @end-test-value
/** フォルダー準備中の設定更新は許可し、起動候補の確定と保存の間は設定更新を待たせる。 */
test("Session 作成中は Settings 更新を同じ runtime 選択境界の完了まで待機させる", async () => {
  const coordinator = new ProviderRuntimeOperationCoordinator();
  /** 設定サービスとセッション作成を同じ排他境界へ接続する。 */
  const runExclusive: RunProviderRuntimeOperationExclusive = (operation) =>
    coordinator.runExclusive(operation);
  const folderEntered = createDeferred();
  const releaseFolder = createDeferred();
  const persistenceEntered = createDeferred();
  const releasePersistence = createDeferred();
  const events: string[] = [];
  let settings = createDefaultAppSettings();
  const settingsService = new SettingsCatalogService({
    runProviderRuntimeOperationExclusive: runExclusive,
    /** 更新する設定の現在値を返す。 */
    getAppSettings: () => settings,
    /** 設定が実際に書き換わった時点をイベントとして残す。 */
    updateAppSettings: (nextSettings: AppSettings) => {
      events.push("settings:update");
      settings = nextSettings;
      return settings;
    },
    /** 設定変更で走査するメインセッションはない。 */
    listSessions: () => [],
    /** 設定変更で走査する補助セッションはない。 */
    listAuxiliarySessions: () => [],
    /** 設定の書き換え以外の副作用を発生させない。 */
    applyAppSettingsSideEffects: () => undefined,
    /** 設定更新に続く配信を順序比較用に記録する。 */
    broadcastAppSettings: () => {
      events.push("settings:broadcast");
    },
  } as never);
  const facade = createMainSessionCommandFacade({
    /** 単件検索では保存前のセッションを返さない。 */
    getSession: () => null,
    /** 既存セッションによる作成手順の分岐を避ける。 */
    getSessions: () => [],
    /** 要約一覧を空にして作成中の排他を見る。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive: runExclusive,
    /** 起動候補を解決する時点を記録する。 */
    resolveSessionLaunchSelection: async () => {
      events.push("selection:resolve");
      return createLaunchSelection();
    },
    /** 保存と設定変更の順序を制御できる保存先を返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 保存開始を通知して停止し、設定更新が待機する時間を作る。 */
        async createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          persistenceEntered.resolve();
          await releasePersistence.promise;
          events.push("session:persist");
          return input as never;
        },
      }) as never,
    /** 排他の競合を設定更新とセッション保存に絞る。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 利用枠テレメトリーを設定更新の順序に加えない。 */
    getProviderQuotaTelemetry: () => null,
    /** 古い利用枠に対する非同期更新は誘発しない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の取得には外部 I/O を導入しない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 作成中のセッションに固定 ID を割り当てる。 */
    createSessionId: () => "launch-serialized",
    /** フォルダー準備を一時停止し、その間に設定変更が完了できるか観測する。 */
    createSessionFilesDirectory: async () => {
      events.push("folder:start");
      folderEntered.resolve();
      await releaseFolder.promise;
      events.push("folder:end");
      return "C:/WithMate/session-files/launch-serialized";
    },
    /** 新規作成に既存フォルダー付きセッションを混ぜない。 */
    isSessionFilesWorkspace: () => false,
  });

  const createPromise = facade.createSessionFromRequest(
    createSessionRequest({ kind: "session-folder" }) as never,
  );
  await folderEntered.promise;
  const settingsPromise = settingsService.updateAppSettings({
    ...settings,
    launchAtLoginEnabled: !settings.launchAtLoginEnabled,
  });

  await settingsPromise;
  assert.deepEqual(events, [
    "folder:start",
    "settings:update",
    "settings:broadcast",
  ]);
  releaseFolder.resolve();
  await persistenceEntered.promise;
  const nextSettingsPromise = settingsService.updateAppSettings({
    ...settings,
    launchAtLoginEnabled: !settings.launchAtLoginEnabled,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event === "settings:update").length, 1);
  releasePersistence.resolve();
  await Promise.all([createPromise, nextSettingsPromise]);

  assert.deepEqual(events, [
    "folder:start",
    "settings:update",
    "settings:broadcast",
    "folder:end",
    "selection:resolve",
    "selection:resolve",
    "session:persist",
    "settings:update",
    "settings:broadcast",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Character authoring の Main Session 作成も SessionFolder を provider 排他外で準備し、保存中は Settings 更新と直列化する"
// oracle = { type = "contract", ref = "docs/design/character-authoring-growth.md#launch-boundary" }
// fault = "Character authoring 経路だけ SessionFolder を作らない、または folder 準備中に Settings を塞ぐ"
// observable = "folder 準備中の Settings 更新完了、保存中の更新待機、folder と同じ Session ID および Character workspace path の保存入力"
// observation_boundary = "public-boundary"
// scope = "main-session-character-authoring-create-boundary"
// lifecycle = "permanent"
// impact = "Character authoring 初回 turn に未作成の SessionFolder を渡すか、filesystem 待機が Settings 操作を塞ぐ"
// distinction = "Character authoring が使う createSession 入口を実 coordinator と folder・persistence barrier で検証する"
// @end-test-value
/** キャラクター作成用でもフォルダー準備を排他の外に置き、保存は設定操作と直列化する。 */
test("Character authoring Session も SessionFolder 準備後に provider 排他内で保存する", async () => {
  const coordinator = new ProviderRuntimeOperationCoordinator();
  const folderEntered = createDeferred();
  const releaseFolder = createDeferred();
  const persistenceEntered = createDeferred();
  const releasePersistence = createDeferred();
  const events: string[] = [];
  const persistedInputs: Parameters<
    SessionPersistenceService["createSession"]
  >[0][] = [];
  const facade = createMainSessionCommandFacade({
    /** 新規キャラクター作成用セッションに対応する既存データはない。 */
    getSession: () => null,
    /** 作成前のセッション一覧は空として扱う。 */
    getSessions: () => [],
    /** キャラクター作成時に保存要約を与えない。 */
    getStoredSessionSummaries: () => [],
    /** 通常のセッション作成と同じ実行コーディネーターで排他に入る。 */
    runProviderRuntimeOperationExclusive: (operation) =>
      coordinator.runExclusive(operation),
    /** 作業場所の検査とは独立した起動候補を返す。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** キャラクターの作業場所とセッション種別を観測できる保存先。 */
    getSessionPersistenceService: () =>
      ({
        /** 保存入力を捕捉し、排他中の別操作が待機する間は完了を止める。 */
        async createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          persistedInputs.push(input);
          persistenceEntered.resolve();
          await releasePersistence.promise;
          events.push("session:persist");
          return input as never;
        },
      }) as never,
    /** 保存中のロックをアクティブなターンの有無と切り離す。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 利用枠はキャラクター作成で使わない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の時刻に基づく更新を発生させない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** キャラクター作成が外部の枠サービスを必要としないようにする。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** フォルダーと保存レコードの照合用に同じ ID を発行する。 */
    createSessionId: () => "launch-authoring",
    /** フォルダー用の ID を記録し、作業場所とは別の準備を一時停止する。 */
    createSessionFilesDirectory: async (sessionId) => {
      events.push(`folder:${sessionId}`);
      folderEntered.resolve();
      await releaseFolder.promise;
      return "C:/WithMate/session-files/launch-authoring";
    },
    /** キャラクターのディレクトリ自体は専用セッションフォルダーではない。 */
    isSessionFilesWorkspace: () => false,
  });

  const creation = facade.createSession({
    taskTitle: "authoring",
    workspaceLabel: "Character authoring",
    workspacePath: "C:/characters/char-muse",
    branch: "main",
    sessionKind: "character-authoring",
    provider: "codex",
    characterId: "char-muse",
    character: "Muse",
    characterIconPath: "",
    characterThemeColors: { main: "#112233", sub: "#445566" },
    approvalMode: "untrusted",
  });
  await folderEntered.promise;
  await coordinator.runExclusive(() => {
    events.push("settings:during-folder");
  });
  releaseFolder.resolve();
  await persistenceEntered.promise;
  const settingsDuringSave = coordinator.runExclusive(() => {
    events.push("settings:during-save");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "folder:launch-authoring",
    "settings:during-folder",
  ]);
  releasePersistence.resolve();
  await Promise.all([creation, settingsDuringSave]);

  assert.deepEqual(events, [
    "folder:launch-authoring",
    "settings:during-folder",
    "session:persist",
    "settings:during-save",
  ]);
  assert.equal(persistedInputs[0]?.id, "launch-authoring");
  assert.equal(persistedInputs[0]?.workspacePath, "C:/characters/char-muse");
  assert.equal(persistedInputs[0]?.sessionKind, "character-authoring");
});

// @test-value v2
// kind = "contract"
// claim = "SessionFolder準備後のcommitは初回のstorage identityとlaunch selectionを再検証し、不一致時は古い設定を保存しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "準備中のSettings/catalog/providerまたはDB resetの変更を検知せず古い選択でSessionを保存する"
// observable = "再解決回数、Persistence Service呼出しと再検証失敗"
// observation_boundary = "public-boundary"
// scope = "main-session-create-session-folder-revalidation"
// lifecycle = "permanent"
// distinction = "SessionFolder準備中の外部待機とcoordinator内のcommit再検証を、Persistence Serviceの保存結果ではなく作成境界で確認する"
// @end-test-value
/** 準備中に起動設定やストレージが変わったときは、確定後の保存を中止する。 */
test("SessionFolder のcommit前再検証は selection と storage の変更を保存しない", async () => {
  const selectionChanges: Partial<SessionLaunchSelection>[] = [
    { provider: "copilot" },
    { model: "gpt-5.6-pro" },
    { reasoningEffort: "medium" },
    { approvalMode: "never" },
    { codexSandboxMode: "read-only" },
    { codexSpeed: "fast" },
    { codexReviewer: "auto-review" },
    { customAgentName: "reviewer" },
  ];
  for (const change of selectionChanges) {
    const calls: string[] = [];
    let resolveCount = 0;
    let persisted = false;
    const baseSelection = createLaunchSelection();
    const facade = createMainSessionCommandFacade({
      /** 設定変更の各反復に既存セッションを与えない。 */
      getSession: () => null,
      /** 初回と再解決の間で変わる情報を起動設定だけに限定する。 */
      getSessions: () => [],
      /** 要約の読み取りを再解決の検査から切り離す。 */
      getStoredSessionSummaries: () => [],
      runProviderRuntimeOperationExclusive,
      /** 初回は基準値を、確定時は一項目だけ変更した選択を返す。 */
      resolveSessionLaunchSelection: async () => {
        resolveCount += 1;
        calls.push(`resolve:${resolveCount}`);
        return resolveCount === 1
          ? baseSelection
          : { ...baseSelection, ...change };
      },
      /** 設定の不一致時に保存されないことを観測する保存先。 */
      getSessionPersistenceService: () =>
        ({
          /** 古い設定のまま作成した場合に検出できるようにする。 */
          createSession() {
            persisted = true;
            return {} as never;
          },
        }) as never,
      /** 設定比較にランタイム側の条件を追加しない。 */
      getSessionRuntimeService: () => ({}) as never,
      /** 利用枠スナップショットなしで選択値を再検証する。 */
      getProviderQuotaTelemetry: () => null,
      /** キャッシュの鮮度による条件分岐は起こさない。 */
      isProviderQuotaTelemetryStale: () => false,
      /** 再検証中の残量更新を外部につながない。 */
      refreshProviderQuotaTelemetry: async () => null,
      /** 各変更条件で同じ識別子を用意する。 */
      createSessionId: () => "launch-selection-changed",
      /** 選択値の再検証より先に準備されたフォルダーを表す。 */
      createSessionFilesDirectory: () =>
        "C:/WithMate/session-files/launch-selection-changed",
      /** 未作成の保存レコードを専用フォルダー付きとみなさない。 */
      isSessionFilesWorkspace: () => false,
      /** 不一致時に直接後処理を呼んだ場合は記録する。 */
      cleanupSessionFilesDirectory: async (sessionId) => {
        calls.push(`cleanup:${sessionId}`);
      },
    });

    await assert.rejects(
      facade.createSessionFromRequest(
        createSessionRequest({ kind: "session-folder" }) as never,
      ),
      /Startup settings changed during creation/,
    );
    assert.equal(persisted, false);
    assert.deepEqual(calls, ["resolve:1", "resolve:2"]);
  }

  for (const mode of ["storage", "resolve-error"] as const) {
    const calls: string[] = [];
    const initialStorage = {};
    let currentStorage = initialStorage;
    let resolveCount = 0;
    const facade = createMainSessionCommandFacade({
      /** ストレージ差し替え検査で単件取得の結果を与えない。 */
      getSession: () => null,
      /** ストレージ差し替え以外のセッション変化を起こさない。 */
      getSessions: () => [],
      /** 再検証に別の保存済み要約を混ぜない。 */
      getStoredSessionSummaries: () => [],
      runProviderRuntimeOperationExclusive,
      /** フォルダー準備後に変わりうる保存先の識別子を返す。 */
      getSessionStorageIdentity: () => currentStorage,
      /** 再解決エラーの反復だけ、二回目の問い合わせを失敗させる。 */
      resolveSessionLaunchSelection: async () => {
        resolveCount += 1;
        if (mode === "resolve-error" && resolveCount === 2) {
          throw new Error("latest selection read failed");
        }
        return createLaunchSelection();
      },
      /** 保存が成立してはいけない条件に限定した永続化先。 */
      getSessionPersistenceService: () =>
        ({
          /** 再検証後に作成まで到達した場合は直ちに失敗させる。 */
          createSession() {
            throw new Error("should not persist");
          },
        }) as never,
      /** ストレージの同一性を実行中のターンと切り離す。 */
      getSessionRuntimeService: () => ({}) as never,
      /** 検査する保存先に利用枠テレメトリーを供給しない。 */
      getProviderQuotaTelemetry: () => null,
      /** 利用枠の期限切れによる更新を発生させない。 */
      isProviderQuotaTelemetryStale: () => false,
      /** 利用枠更新が外部に依存しないようにする。 */
      refreshProviderQuotaTelemetry: async () => null,
      /** ストレージ再検証で使う作成 ID を固定する。 */
      createSessionId: () => "launch-storage-changed",
      /** フォルダー準備の途中で保存先が別物に切り替わるケースを作る。 */
      createSessionFilesDirectory: () => {
        if (mode === "storage") {
          currentStorage = {};
        }
        return "C:/WithMate/session-files/launch-storage-changed";
      },
      /** 既存レコードには専用フォルダー判定を適用しない。 */
      isSessionFilesWorkspace: () => false,
      /** 作成中止時に直接片付けを呼んだか観測する。 */
      cleanupSessionFilesDirectory: async (sessionId) => {
        calls.push(`cleanup:${sessionId}`);
      },
    });

    await assert.rejects(
      facade.createSessionFromRequest(
        createSessionRequest({ kind: "session-folder" }) as never,
      ),
      mode === "storage"
        ? /Session storage changed during creation/
        : /latest selection read failed/,
    );
    assert.deepEqual(calls, []);
  }
});

// @test-value v2
// kind = "contract"
// claim = "Browseで選んだworkspaceを保持し、SessionFolderを作成してからSessionを保存する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "Browseのworkspaceを置換する、またはSessionFolderのないSessionを保存する"
// observable = "folder作成と保存の呼出し順、保存入力のworkspaceLabel、workspacePath、branch"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-directory-launch"
// lifecycle = "permanent"
// @end-test-value
/** 参照ダイアログの作業場所を保持し、専用フォルダー準備の後に同じ ID で保存する。 */
test("MainSessionCommandFacade は Browse で選んだ directory をそのまま session に使う", async () => {
  const calls: string[] = [];
  const persisted = {
    input: null as
      Parameters<SessionPersistenceService["createSession"]>[0] | null,
  };
  const facade = createMainSessionCommandFacade({
    /** 選択された作業場所を既存セッションから補完しない。 */
    getSession: () => null,
    /** 既存の作業場所一覧を使わず、要求から作成する。 */
    getSessions: () => [],
    /** 保存済み要約なしでディレクトリ指定を処理する。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 選択したディレクトリを調べる経路に既定モデルを提供する。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 作業場所の保存値と前後関係を観測できる保存先を用意する。 */
    getSessionPersistenceService: () =>
      ({
        /** ユーザーが選んだディレクトリが保存入力に保たれているかを捕捉する。 */
        createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          calls.push(`persist:${input.id}`);
          persisted.input = input;
          return input as never;
        },
      }) as never,
    /** ディレクトリ選択ではセッションのランタイムを稼働させない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 作業場所の選択から利用枠情報を切り離す。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の再取得が必要な条件を作らない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** ディレクトリ選択検査に外部の利用枠更新を導入しない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** フォルダー準備と保存より先に ID を発行したか記録する。 */
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-directory";
    },
    /** 作業場所とは別に必要な専用領域を、発行済み ID で用意したことを記録する。 */
    createSessionFilesDirectory: (sessionId) => {
      calls.push(`mkdir:${sessionId}`);
      return "C:/WithMate/session-files/launch-directory";
    },
    /** 選択した外部ディレクトリを専用フォルダーと区別する。 */
    isSessionFilesWorkspace: () => false,
  });

  await facade.createSessionFromRequest(
    createSessionRequest({
      kind: "directory",
      label: "repo",
      path: "C:/work/repo",
      branch: "main",
    }) as never,
  );

  assert.deepEqual(calls, [
    "issue-id",
    "mkdir:launch-directory",
    "persist:launch-directory",
  ]);

  assert.deepEqual(
    {
      id: persisted.input?.id,
      workspaceLabel: persisted.input?.workspaceLabel,
      workspacePath: persisted.input?.workspacePath,
      branch: persisted.input?.branch,
    },
    {
      id: "launch-directory",
      workspaceLabel: "repo",
      workspacePath: "C:/work/repo",
      branch: "main",
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "Main Session作成はlaunch selectionのCodex speedとReviewerをPersistence Serviceへ渡し、IPC payloadで上書きさせない"
// oracle = { type = "contract", ref = "accepted behavior: new Session runtime selection inheritance" }
// fault = "IPC payloadのspeedまたはReviewerがlaunch selectionの値を上書きする、または解決値がPersistence Serviceへの入力から欠落する"
// observable = "Session persistence serviceへ渡された作成入力のcodexSpeedとcodexReviewer"
// observation_boundary = "public-boundary"
// scope = "main-session-create"
// lifecycle = "permanent"
// @end-test-value
/** IPC の上書き値を採用せず、メイン側で確定した ID、作業場所、実行設定を永続化する。 */
test("MainSessionCommandFacade は IPC payload のMain-owned fieldsを無視する", async () => {
  const persisted = {
    input: null as
      Parameters<SessionPersistenceService["createSession"]>[0] | null,
  };
  const facade = createMainSessionCommandFacade({
    /** IPC が指定した既存 ID からセッションを取得させない。 */
    getSession: () => null,
    /** 新規作成のため既存のセッション一覧は空にする。 */
    getSessions: () => [],
    /** 保存済み要約由来の値で入力を補わない。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** IPC の競合値と比較できる、メイン側の起動設定を返す。 */
    resolveSessionLaunchSelection: async () =>
      createLaunchSelection({
        model: "gpt-5.6-pro",
        reasoningEffort: "xhigh",
        approvalMode: "on-request",
        codexSandboxMode: "read-only",
        codexSpeed: "fast",
        codexReviewer: "auto-review",
        customAgentName: "stored-agent",
      }),
    /** 実際に選ばれたメイン側管理項目を取得できる永続化先。 */
    getSessionPersistenceService: () =>
      ({
        /** IPC の入力自体ではなく保存直前に整形された値を記録する。 */
        createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          persisted.input = input;
          return input as never;
        },
      }) as never,
    /** 新規作成の IPC に既存ランタイム情報を与えない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 選択された実行設定に利用枠を混ぜない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の鮮度に伴う再取得は誘発しない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠取得が必要でも外部通信は行わない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 呼出元の入力ではなくメインで決まる ID を返す。 */
    createSessionId: () => {
      return "launch-directory";
    },
    /** メイン側採番に対応する専用ディレクトリを返す。 */
    createSessionFilesDirectory: () =>
      "C:/WithMate/session-files/launch-directory",
    /** Browse で指定された作業場所を専用フォルダーから区別する。 */
    isSessionFilesWorkspace: () => false,
  });
  const request = {
    ...createSessionRequest({
      kind: "directory",
      label: "repo",
      path: "C:/work/repo",
      branch: "main",
    }),
    id: "existing-session",
    workspaceLabel: "forged",
    workspacePath: "C:/forged",
    branch: "forged",
    model: "forged-model",
    reasoningEffort: "low",
    approvalMode: "never",
    codexSandboxMode: "danger-full-access",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "forged-agent",
  };

  await facade.createSessionFromRequest(request as never);

  assert.deepEqual(
    {
      id: persisted.input?.id,
      workspaceLabel: persisted.input?.workspaceLabel,
      workspacePath: persisted.input?.workspacePath,
      branch: persisted.input?.branch,
      model: persisted.input?.model,
      reasoningEffort: persisted.input?.reasoningEffort,
      approvalMode: persisted.input?.approvalMode,
      codexSandboxMode: persisted.input?.codexSandboxMode,
      codexSpeed: persisted.input?.codexSpeed,
      codexReviewer: persisted.input?.codexReviewer,
      customAgentName: persisted.input?.customAgentName,
    },
    {
      id: "launch-directory",
      workspaceLabel: "repo",
      workspacePath: "C:/work/repo",
      branch: "main",
      model: "gpt-5.6-pro",
      reasoningEffort: "xhigh",
      approvalMode: "on-request",
      codexSandboxMode: "read-only",
      codexSpeed: "fast",
      codexReviewer: "auto-review",
      customAgentName: "stored-agent",
    },
  );
});

// @test-value v2
// kind = "invariant"
// claim = "SessionFolder workspaceの起動選択取得失敗時は未完成のSessionを保存しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/833" }
// fault = "discovery失敗でもSessionを保存する"
// observable = "discovery失敗の拒否とSession保存呼出しなし"
// observation_boundary = "public-boundary"
// scope = "main-session-creation-discovery-failure"
// lifecycle = "permanent"
// impact = "設定不明の未完成Sessionを実行可能な会話にしない"
// distinction = "provider単独の失敗testではMain作成境界の保存拒否を確認できない"
// @end-test-value
/** 管理フォルダーを準備できても、起動候補の取得に失敗すれば未完成のセッションを保存しない。 */
test("MainSessionCommandFacade は起動設定の取得失敗時にSessionを永続化しない", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 失敗した作成の代わりに既存レコードを返さない。 */
    getSession: () => null,
    /** 既存セッション情報なしで起動候補を取りに行く。 */
    getSessions: () => [],
    /** 要約データは候補取得失敗の判定に関与させない。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 選択取得に到達したことを記録し、読み取りを失敗させる。 */
    resolveSessionLaunchSelection: async () => {
      calls.push("resolve");
      throw new Error("latest selection read failed");
    },
    /** 取得失敗後に永続化されたことを検出するための保存先を返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 保存まで進んでいれば履歴に残して失敗させる。 */
        createSession() {
          calls.push("persist");
          throw new Error("should not persist");
        },
      }) as never,
    /** 起動候補の取得とは関係のないランタイム操作を代替する。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 利用枠を候補取得の前提にしない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠不足や古さによる追加の分岐を設けない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 候補取得そのものの失敗に検査を限定する。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 候補取得に失敗する前の採番を記録する。 */
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-managed";
    },
    /** 取得に失敗する前にフォルダーが準備されたことを記録する。 */
    createSessionFilesDirectory: () => {
      calls.push("mkdir");
      return "C:/WithMate/session-files/launch-managed";
    },
    /** 直接のフォルダー削除が起きた場合に記録する。 */
    cleanupSessionFilesDirectory: async () => {
      calls.push("cleanup");
    },
    /** 保存前なので既存の専用作業場所はない。 */
    isSessionFilesWorkspace: () => false,
  });

  await assert.rejects(
    facade.createSessionFromRequest(
      createSessionRequest({ kind: "session-folder" }) as never,
    ),
    /latest selection read failed/,
  );
  assert.deepEqual(calls, ["issue-id", "mkdir", "resolve"]);
});

// @test-value v2
// kind = "invariant"
// claim = "workspace種別に関係なくSessionFolderの作成に失敗した場合、Sessionを永続化しない"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "folder作成例外後もSession persistenceを実行し、folderなしのSessionを残す"
// observable = "folder作成errorとcreateSession呼出し回数"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-folder-creation-failure"
// lifecycle = "permanent"
// @end-test-value
/** 専用フォルダーの作成に失敗したら、どのワークスペース指定でも保存へ進まない。 */
test("MainSessionCommandFacade は SessionFolder 作成失敗時に session を永続化しない", async () => {
  let persistCount = 0;
  const facade = createMainSessionCommandFacade({
    /** 作成に失敗したセッションは直接取得できない。 */
    getSession: () => null,
    /** フォルダー作成以外の既存セッション条件を作らない。 */
    getSessions: () => [],
    /** 保存前の要約一覧は空にする。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** フォルダーを用意できないことにだけ失敗条件を限定する。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** フォルダーの準備失敗後に到達してはならない保存先。 */
    getSessionPersistenceService: () =>
      ({
        /** 保存が誤って呼ばれた回数を数える。 */
        createSession(
          input: Parameters<SessionPersistenceService["createSession"]>[0],
        ) {
          persistCount += 1;
          return input as never;
        },
      }) as never,
    /** フォルダー失敗にセッションの実行状態を関与させない。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 利用枠なしでフォルダー準備の失敗を見る。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の鮮度がエラー経路を変えないようにする。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の外部更新なしで検査を完結させる。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** フォルダー作成を試みるための ID を発行する。 */
    createSessionId: () => "launch-managed",
    /** 専用フォルダー作成の失敗を注入する。 */
    createSessionFilesDirectory: () => {
      throw new Error("mkdir failed");
    },
    /** 既存セッションのフォルダー判定は使わない。 */
    isSessionFilesWorkspace: () => false,
  });

  for (const workspace of [
    { kind: "session-folder" },
    { kind: "directory", label: "repo", path: "C:/work/repo", branch: "main" },
  ] as const) {
    await assert.rejects(
      facade.createSessionFromRequest(createSessionRequest(workspace) as never),
      /mkdir failed/,
    );
  }
  assert.equal(persistCount, 0);
});

/** コミット後とみなせる保存失敗を受けても、準備済みフォルダーを早まって削除しない。 */
test("MainSessionCommandFacade は session 永続化失敗後に作成済み SessionFolder を削除しない", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 例外後の単件取得で別セッションを補わない。 */
    getSession: () => null,
    /** この作成失敗に関係する既存セッションは列挙しない。 */
    getSessions: () => [],
    /** 既存要約なしで保存例外を観測する。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 起動設定は解決できる状態にして保存段階へ進める。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 呼び出し後にエラーを返す作成処理を用意する。 */
    getSessionPersistenceService: () =>
      ({
        /** コミット後に応答だけを失敗した場合を再現する。 */
        createSession() {
          calls.push("persist");
          throw new Error("persist failed after commit");
        },
      }) as never,
    /** 永続化の失敗をターンの状態と切り離す。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 保存結果の判定に利用枠を使わない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の再取得を誘発しない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠更新には値を返さず外部への問い合わせもしない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 保存例外より前に発行した ID を順序に記録する。 */
    createSessionId: () => {
      calls.push("issue-id");
      return "launch-managed";
    },
    /** 保存より先に専用フォルダーが準備されたことを記録する。 */
    createSessionFilesDirectory: () => {
      calls.push("mkdir");
      return "C:/WithMate/session-files/launch-managed";
    },
    /** まだ保存を確認できない作業場所なので既存フォルダーとは判定しない。 */
    isSessionFilesWorkspace: () => false,
    /** 保存例外後の不適切な片付けを履歴から検出する。 */
    async cleanupSessionFilesDirectory() {
      calls.push("cleanup");
    },
  });

  await assert.rejects(
    facade.createSessionFromRequest(
      createSessionRequest({ kind: "session-folder" }) as never,
    ),
    /persist failed after commit/,
  );
  assert.deepEqual(calls, ["issue-id", "mkdir", "persist"]);
});

// @test-value v2
// kind = "invariant"
// claim = "cutoff deleteは削除済みSessionだけのnotification撤去とSessionFolder cleanupを行い、skipped running Sessionには触れない"
// oracle = { type = "contract", ref = "session persistence cutoff deletion" }
// fault = "skipped running Sessionをcleanupする、削除済みSessionのcleanupを漏らす、またはcutoff resultを改変する"
// observable = "delete resultとdismiss/cleanup serviceへ渡されたSession ID"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-cutoff-delete"
// lifecycle = "permanent"
// @end-test-value
/** 期限による削除から返された完了 ID だけを後処理し、実行中で除外された ID は残す。 */
test("MainSessionCommandFacade は cutoff delete の削除済み session だけ cleanup する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 個別取得で削除対象を追加しない。 */
    getSession: () => null,
    /** 削除済み候補と実行中の除外候補を、同じ作業場所付きで列挙する。 */
    getSessions: () =>
      [
        { id: "s-old", workspacePath: "C:/work/repo", status: "idle" },
        { id: "s-running", workspacePath: "C:/work/repo", status: "running" },
      ] as never,
    /** 削除対象リストをメモリ上の候補と保存結果から観測する。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 期限による削除とは無関係な起動候補を返す。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 削除済み・除外済みの両方を返す永続化処理を提供する。 */
    getSessionPersistenceService: () =>
      ({
        /** 正規化された期限を受け取り、削除 ID と除外 ID をそれぞれ返す。 */
        deleteSessionsLastActiveBefore(
          cutoff: DeleteSessionsLastActiveBeforeCutoff,
        ) {
          calls.push(`delete-before:${cutoff.cutoffDate}`);
          return {
            cutoffDate: cutoff.cutoffDate,
            cutoffTimestampMs: cutoff.cutoffTimestampMs,
            deletedSessionIds: ["s-old"],
            skippedRunningSessionIds: ["s-running"],
          };
        },
      }) as never,
    /** 一括削除の成否は永続化が返す結果に任せる。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 削除操作に利用枠情報を与えない。 */
    getProviderQuotaTelemetry: () => null,
    /** 削除の前後で利用枠を更新する必要がない状態にする。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 一括削除の検査から外部の利用枠問い合わせを除く。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** この検査で新規作成はしないため固定の既定 ID を使う。 */
    createSessionId: () => "launch-test",
    /** 作成用依存関係を満たすテスト専用フォルダーパス。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 削除済み候補を作業場所ではない専用領域の片付け対象にする。 */
    isSessionFilesWorkspace: () => false,
    /** 通知の撤去が削除済み ID に限定されるか記録する。 */
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
    /** フォルダーを片付けた対象を記録し、除外 ID の混入を検出する。 */
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
    },
  });

  const result = await facade.deleteSessionsLastActiveBefore({
    cutoffDate: "2026-07-01",
  });

  assert.deepEqual(result.deletedSessionIds, ["s-old"]);
  assert.deepEqual(result.skippedRunningSessionIds, ["s-running"]);
  assert.deepEqual(calls, [
    "delete-before:2026-07-01",
    "dismiss-notification:s-old",
    "cleanup-files:s-old",
  ]);
});

/** 要約のキャッシュ有無によらず専用作業場所は残し、外部作業場所の付帯フォルダーだけを片付ける。 */
test("MainSessionCommandFacade は cached/uncached の SessionFolder を保持し directory workspace だけ cleanup する", async () => {
  const dismissedSessionIds: string[] = [];
  const cleanedSessionIds: string[] = [];
  const cachedManagedSession = {
    id: "s-cached-managed",
    workspacePath: "C:/WithMate/session-files/s-cached-managed",
  } as never;
  const cachedDirectorySession = {
    id: "s-cached-directory",
    workspacePath: "C:/work/cached",
  } as never;
  const facade = createMainSessionCommandFacade({
    /** 単件参照を使用せず、一覧と永続化要約から削除対象を解決させる。 */
    getSession: () => null,
    /** キャッシュに載った専用・外部作業場所を渡す。 */
    getSessions: () => [cachedManagedSession, cachedDirectorySession],
    /** メモリ一覧にない二件も含め、永続化側の全対象を返す。 */
    getStoredSessionSummaries: () => [
      cachedManagedSession,
      cachedDirectorySession,
      {
        id: "s-uncached-managed",
        workspacePath: "C:/WithMate/session-files/s-uncached-managed",
      } as never,
      {
        id: "s-uncached-directory",
        workspacePath: "C:/work/uncached",
      } as never,
    ],
    runProviderRuntimeOperationExclusive,
    /** 削除する四件とは無関係な起動選択を既定にする。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 四件の削除済み ID を返す保存先を用意する。 */
    getSessionPersistenceService: () =>
      ({
        /** 作業場所の種類とキャッシュ有無を問わず四件すべてを削除済みにする。 */
        deleteSessionsLastActiveBefore() {
          return {
            deletedSessionIds: [
              "s-cached-managed",
              "s-cached-directory",
              "s-uncached-managed",
              "s-uncached-directory",
            ],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    /** ターン実行は使わず、保存結果から後処理へ進む。 */
    getSessionRuntimeService: () => ({}) as never,
    /** フォルダー保存判断に利用枠を持ち込まない。 */
    getProviderQuotaTelemetry: () => null,
    /** 後処理時には利用枠を再取得させない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 利用枠の更新から外部へのアクセスを発生させない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** このケースで使用しない新規作成 ID。 */
    createSessionId: () => "launch-test",
    /** 新規作成は行わないためパスを固定する。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 専用作業場所と外部ディレクトリを識別子の接尾辞で判定する。 */
    isSessionFilesWorkspace: (session) => session.id.endsWith("-managed"),
    /** 保存されたセッションの通知を撤去したか一覧に加える。 */
    dismissSessionTurnNotification(sessionId) {
      dismissedSessionIds.push(sessionId);
    },
    /** 付帯フォルダーの片付けが呼ばれた ID だけを蓄積する。 */
    async cleanupSessionFilesDirectory(sessionId) {
      cleanedSessionIds.push(sessionId);
    },
  });

  await facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" });

  assert.deepEqual(dismissedSessionIds, [
    "s-cached-managed",
    "s-cached-directory",
    "s-uncached-managed",
    "s-uncached-directory",
  ]);
  assert.deepEqual(cleanedSessionIds, [
    "s-cached-directory",
    "s-uncached-directory",
  ]);
});

/** 最初のフォルダーの片付けで例外が出ても、その前に削除済み全件の通知を閉じる。 */
test("MainSessionCommandFacade は directory cleanup が失敗しても削除済み Session の通知をすべて先に閉じる", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 単件キャッシュの情報から後処理対象を決めない。 */
    getSession: () => null,
    /** メモリ一覧を空にし、保存済み要約から対象を得させる。 */
    getSessions: () => [],
    /** 片付けを試みる二件の外部作業場所を用意する。 */
    getStoredSessionSummaries: () => [
      {
        id: "s-first",
        workspacePath: "C:/work/first",
      } as never,
      {
        id: "s-second",
        workspacePath: "C:/work/second",
      } as never,
    ],
    runProviderRuntimeOperationExclusive,
    /** 後処理とは無関係な起動候補を既定にする。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 期限付き削除を成功させ、後処理対象を二件返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 削除の成立を記録し、両方のセッションを通知撤去の対象にする。 */
        deleteSessionsLastActiveBefore() {
          calls.push("delete-before");
          return {
            deletedSessionIds: ["s-first", "s-second"],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    /** 後処理の順序をターン実行から切り離す。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 通知撤去とファイル処理に利用枠を加えない。 */
    getProviderQuotaTelemetry: () => null,
    /** 後処理で利用枠の更新が起きる条件は与えない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 残量を外部サービスから取得しない。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 一括削除と無関係な採番結果を固定する。 */
    createSessionId: () => "launch-test",
    /** ディレクトリ新規作成を伴わないケースの既定パス。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 削除された二件とも付帯フォルダー片付けが必要とする。 */
    isSessionFilesWorkspace: () => false,
    /** どちらの通知をいつ閉じたか共通の順序表に記録する。 */
    dismissSessionTurnNotification(sessionId) {
      calls.push(`dismiss-notification:${sessionId}`);
    },
    /** 一件目の片付けで失敗を発生させ、その時点までの処理順を残す。 */
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
      if (sessionId === "s-first") {
        throw new Error("cleanup failed");
      }
    },
  });

  await assert.rejects(
    facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-07-01" }),
    /cleanup failed/,
  );
  assert.deepEqual(calls, [
    "delete-before",
    "dismiss-notification:s-first",
    "dismiss-notification:s-second",
    "cleanup-files:s-first",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "実在しないcutoff日付はSession削除serviceを呼び出す前に拒否する"
// oracle = { type = "contract", ref = "src-shared/window/withmate-window-types.ts#resolveDeleteSessionsLastActiveBeforeCutoff" }
// fault = "存在しない日付を有効なcutoffとして削除処理へ渡すか、validation errorを失う"
// observable = "rejection message and delete/cleanup calls"
// observation_boundary = "public-boundary"
// scope = "main-session-delete-cutoff-validation"
// lifecycle = "permanent"
// impact = "意図しないSessionが削除される"
// distinction = "calendar-invalid dateをfacadeへ渡し、削除関連の副作用がないことを確認する"
// @end-test-value
/** カレンダーに存在しない期限を入力エラーとし、削除も片付けも開始しない。 */
test("MainSessionCommandFacade は実在しない cutoff delete 日付を拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 期限の妥当性を単件の参照結果から推測させない。 */
    getSession: () => null,
    /** 無効な期限の検査に既存セッションを与えない。 */
    getSessions: () => [],
    /** 要約なしでも期限の構文検証を先に行える状態にする。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 削除期限の検証では起動候補を使わない。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 無効な期限で消去が呼ばれた場合に観測できる保存先を返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 入力検証漏れの一括削除があれば呼び出しを記録する。 */
        deleteSessionsLastActiveBefore() {
          calls.push("delete-old");
          return {
            deletedSessionIds: ["s-old"],
            skippedRunningSessionIds: [],
          };
        },
      }) as never,
    /** 期限の検証をターンの状態と切り離す。 */
    getSessionRuntimeService: () => ({}) as never,
    /** 期限の解釈に関係のない利用枠を返さない。 */
    getProviderQuotaTelemetry: () => null,
    /** 削除入力による利用枠の再取得を起こさない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 期限不正時の外部問い合わせを代替する。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 期限の検査中は使わない新規 ID を返す。 */
    createSessionId: () => "launch-test",
    /** 作成を行わないケースのフォルダー依存を満たす。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 保存済み作業場所の特例は期限の判定に関与させない。 */
    isSessionFilesWorkspace: () => false,
    /** 入力拒否の前にフォルダーを片付けた場合は履歴に残す。 */
    async cleanupSessionFilesDirectory(sessionId) {
      calls.push(`cleanup-files:${sessionId}`);
    },
  });

  await assert.rejects(
    facade.deleteSessionsLastActiveBefore({ cutoffDate: "2026-02-31" }),
    /The deletion cutoff date could not be parsed\./,
  );
  assert.deepEqual(calls, []);
});

// @test-value v2
// kind = "contract"
// claim = "staleなCopilot quotaはrun開始前に非同期refreshされ、その後Session turnがruntime serviceへ委譲される"
// oracle = { type = "contract", ref = "provider quota telemetry refresh" }
// fault = "stale quotaを更新せずrunする、Copilot以外を更新する、またはruntime turnを委譲しない"
// observable = "refreshProviderQuotaTelemetryのprovider ID、runtime run call、両者の呼出し順、返却Session ID"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-copilot-quota"
// lifecycle = "permanent"
// @end-test-value
/** Copilot の古い利用枠を対象プロバイダーへ更新要求してから、同じセッションのターンを委譲する。 */
test("MainSessionCommandFacade は stale な Copilot quota を非同期更新して run を委譲する", async () => {
  const calls: string[] = [];
  let refreshedProviderId: string | null = null;
  const facade = createMainSessionCommandFacade({
    /** 送信対象として Copilot のセッションを返す。 */
    getSession: () => ({ id: "s-1", provider: "copilot" }) as never,
    /** 送信対象以外のメモリ一覧は空とする。 */
    getSessions: () => [],
    /** 要約一覧を使わず単件検索結果でプロバイダーを決める。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 既存のターン送信では新規作成用候補を使わない。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 送信を新規保存の処理と分離する。 */
    getSessionPersistenceService: () => ({}) as never,
    /** 送信と利用枠の更新順を観測するランタイムを返す。 */
    getSessionRuntimeService: () =>
      ({
        /** ランタイムに渡された ID と、ターン開始の時点を記録する。 */
        async runSessionTurn(sessionId: string) {
          calls.push(`run:${sessionId}`);
          return { id: sessionId } as never;
        },
        /** 先行ターンがない状態から送信を開始する。 */
        isRunInFlight() {
          return false;
        },
      }) as never,
    /** 更新時刻が古い Copilot の利用枠を用意する。 */
    getProviderQuotaTelemetry: () =>
      ({ providerId: "copilot", updatedAt: "old" }) as never,
    /** 利用枠を期限切れと判断させる。 */
    isProviderQuotaTelemetryStale: () => true,
    /** 更新要求のプロバイダーと開始順を記録する。 */
    refreshProviderQuotaTelemetry: async (providerId) => {
      refreshedProviderId = providerId;
      calls.push(`refresh:${providerId}`);
      return null;
    },
    /** 既存セッションへの送信で使わない新規 ID を固定する。 */
    createSessionId: () => "launch-test",
    /** 送信時に新規フォルダーを作らないケースの既定パス。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 作業場所を専用フォルダーとして扱わない。 */
    isSessionFilesWorkspace: () => false,
  });

  const result = await facade.runSessionTurn("s-1", {
    userMessage: "hello",
  } as never);

  assert.equal(result.id, "s-1");
  assert.equal(refreshedProviderId, "copilot");
  assert.deepEqual(calls, ["refresh:copilot", "run:s-1"]);
});

// @test-value v2
// kind = "invariant"
// claim = "non-Copilot SessionのrunではCopilot quota refreshを実行しない"
// oracle = { type = "contract", ref = "provider quota telemetry refresh" }
// fault = "provider種別を無視してquota refreshを実行し、不要な外部更新を発生させる"
// observable = "refreshProviderQuotaTelemetryが呼ばれたかどうか"
// observation_boundary = "public-boundary"
// scope = "main-session-command-facade-non-copilot-quota"
// lifecycle = "permanent"
// @end-test-value
/** 利用枠の期限切れ判定が真でも、Copilot 以外のターンでは更新しない。 */
test("MainSessionCommandFacade は non-Copilot session では quota refresh を行わない", async () => {
  let refreshed = false;
  const facade = createMainSessionCommandFacade({
    /** 同じ送信 ID を Copilot ではなく Codex に割り当てる。 */
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    /** 対象以外のメモリ上のセッションを列挙しない。 */
    getSessions: () => [],
    /** 永続化要約ではなく取得したセッションから送信先を決める。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 既存セッションに対して新規作成の起動選択は不要とする。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 新規作成する保存レコードはない。 */
    getSessionPersistenceService: () => ({}) as never,
    /** 利用枠の取得なしでも送信できるランタイムを返す。 */
    getSessionRuntimeService: () =>
      ({
        /** 代替ランタイムは受け取ったセッション ID を返して完了する。 */
        async runSessionTurn(sessionId: string) {
          return { id: sessionId } as never;
        },
        /** 送信を既存ターンでブロックしない。 */
        isRunInFlight() {
          return false;
        },
      }) as never,
    /** Codex 側には利用枠のキャッシュ値がない状態を作る。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠が古い場合でもプロバイダーの条件が優先されるようにする。 */
    isProviderQuotaTelemetryStale: () => true,
    /** 非 Copilot で誤って呼ばれた利用枠更新を検出する。 */
    refreshProviderQuotaTelemetry: async () => {
      refreshed = true;
      return null;
    },
    /** ターン実行では発行しないセッション ID の既定値。 */
    createSessionId: () => "launch-test",
    /** この送信では未使用の作成用フォルダーパス。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 既存送信時に作業場所を特例とみなさない。 */
    isSessionFilesWorkspace: () => false,
  });

  await facade.runSessionTurn("s-1", { userMessage: "hello" } as never);

  assert.equal(refreshed, false);
});

/** 作業ディレクトリを検証し、見つからなければプロバイダーでターンを実行しない。 */
test("MainSessionCommandFacade は Workspace が利用不可なら provider runtime の前で送信を拒否する", async () => {
  const calls: string[] = [];
  const facade = createMainSessionCommandFacade({
    /** 送信対象に失われたディレクトリを持つセッションを返す。 */
    getSession: () =>
      ({ id: "s-1", provider: "codex", workspacePath: "C:/missing" }) as never,
    /** 無効な作業場所の代わりとなるセッションを一覧に置かない。 */
    getSessions: () => [],
    /** 保存要約から作業場所を補う経路を設けない。 */
    getStoredSessionSummaries: () => [],
    runProviderRuntimeOperationExclusive,
    /** 既存セッション送信に使われない起動候補を既定にする。 */
    resolveSessionLaunchSelection: async () => createLaunchSelection(),
    /** 送信で新規永続化を行う依存は使わない。 */
    getSessionPersistenceService: () => ({}) as never,
    /** 作業場所を検証せずに到達したランタイム呼び出しを捕捉する。 */
    getSessionRuntimeService: () =>
      ({
        /** 誤って送信を開始した場合は履歴に残す。 */
        async runSessionTurn() {
          calls.push("run");
          return { id: "s-1" } as never;
        },
      }) as never,
    /** 作業場所の検証より先に利用枠情報を与えない。 */
    getProviderQuotaTelemetry: () => null,
    /** 利用枠の再取得をこの失敗経路に混ぜない。 */
    isProviderQuotaTelemetryStale: () => false,
    /** 外部の利用枠更新を必要としない設定にする。 */
    refreshProviderQuotaTelemetry: async () => null,
    /** 既存セッションへの送信で参照しない新規 ID。 */
    createSessionId: () => "launch-test",
    /** ワークスペースの検証とは無関係な新規フォルダーパス。 */
    createSessionFilesDirectory: () => "C:/session-files/launch-test",
    /** 紛失した作業場所を管理フォルダーの特例扱いにしない。 */
    isSessionFilesWorkspace: () => false,
    /** 検証されたパスを記録し、ディレクトリが存在しないことを返す。 */
    validateWorkspaceDirectory: async (targetPath) => {
      calls.push(`validate:${String(targetPath)}`);
      return { valid: false, reason: "missing" };
    },
  });

  await assert.rejects(
    facade.runSessionTurn("s-1", { userMessage: "hello" } as never),
    /Workspace is unavailable\. Path not found\./,
  );
  assert.deepEqual(calls, ["validate:C:/missing"]);
});
