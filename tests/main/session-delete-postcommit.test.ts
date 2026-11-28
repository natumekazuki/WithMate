import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { createSessionStorageCommandAdapter } from "../../src-electron/session/session-storage-command-adapter.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";

/** 非同期処理の到達と続行をテスト側で制御する待機点を作る。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// @test-value v2
// kind = "invariant"
// claim = "単体・期間削除の同期的な削除後処理が失敗しても別Session削除が完了し、親子bindingを失効する。後処理は同じIDで再作成されたDB・cache・runtimeを壊さず、失敗を呼出元へ返す"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
// fault = "provider待機またはcloseSessionWindow／broadcastSessionsの同期例外が別削除を止める、binding失効や子の後処理を省く、後処理が新ownerのruntimeを無効化する、または失敗を隠す"
// observable = "barrier解放前の別削除結果と未settled状態、SQLite行・cache・binding失効・window close・broadcast、runtime detach先、再作成行の不変、削除結果または全失敗を含むAggregateError"
// observation_boundary = "public-boundary"
// scope = "SessionPersistenceServiceと実V6 DBによる削除commitとprovider後処理の境界"
// lifecycle = "permanent"
// impact = "遅いprovider処理が無関係な操作を停止させ、削除済みSessionの権限や表示を残す"
// distinction = "storage単体や型検査では観測できない待機中の別操作の進行と、失敗後の確定済みデータを実DBで確認する"
// @end-test-value
/** 削除確定後の通知やProvider後処理が失敗しても独立した削除を進め、再作成した同じIDの主体は保持する。 */
it(
  "deletion commits before provider cleanup and allows unrelated deletion",
  { timeout: 10_000 },
  async () => {
    for (const deletion of ["single", "cutoff"] as const) {
      for (const notificationFailure of [
        "none",
        "close",
        "broadcast",
      ] as const) {
        for (const failCleanup of [false, true]) {
          const directory = await mkdtemp(
            path.join(os.tmpdir(), "withmate-delete-postcommit-"),
          );
          const storage = new SessionStorageV6(path.join(directory, "app.db"));
          const release = deferred();
          try {
            /** 期間削除の対象を区別できるよう、指定した最終更新日時で会話を組み立てる。 */
            const makeSession = (id: string, updatedAt: string) => ({
              ...buildNewSession({
                id,
                taskTitle: id,
                workspaceLabel: "workspace",
                workspacePath: "C:/workspace",
                branch: "main",
                characterId: "char-a",
                character: "A",
                characterIconPath: "",
                characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
                approvalMode: "on-request",
              }),
              updatedAt,
            });
            const first = storage.insertSession(
              makeSession("first", "2026-09-01T00:00:00.000Z"),
            );
            const second = storage.insertSession(
              makeSession("second", "2026-09-19T00:00:00.000Z"),
            );
            let cached = [first, second];
            const coordinator = new ProviderRuntimeOperationCoordinator();
            const entered = deferred();
            const revoked: string[] = [];
            const closed: string[] = [];
            const broadcasts: string[][] = [];
            const invalidated: string[] = [];
            const runtimeOwners = new Map([
              [first.id, "old-parent"],
              ["first-child", "old-child"],
              [second.id, "other"],
            ]);
            const detachedOwners: string[] = [];
            const failure = new Error("provider cleanup failed");
            const closeFailure = new Error("session window close failed");
            const broadcastFailure = new Error("session broadcast failed");
            let firstBroadcast = true;
            const service = new SessionPersistenceService({
              /** 実コーディネーターを通し、Provider関連処理の排他区間を本番と同様にする。 */
              runProviderRuntimeOperationExclusive: (operation) =>
                coordinator.runExclusive(operation),
              ...createSessionStorageCommandAdapter(() => storage),
              /** 削除結果をメモリ上でも検査するため、現在の一覧を返す。 */
              getSessions: () => cached,
              /** サービスが更新した一覧を保持し、再作成時に旧要素と取り違えないか調べる。 */
              setSessions: (next) => {
                cached = next;
              },
              /** 指定IDを現在のキャッシュから照会する。 */
              getSession: (id) =>
                cached.find((session) => session.id === id) ?? null,
              /** 実行中による削除拒否を除き、確定後の挙動に絞る。 */
              isSessionRunInFlight: () => false,
              /** 初回削除に属する子を一件返し、親子の後処理対象を区別できるようにする。 */
              listAuxiliarySessionRuntimeIdentities: (ids) =>
                ids.includes(first.id)
                  ? [
                      {
                        id: "first-child",
                        parentSessionId: first.id,
                        provider: first.provider,
                      },
                    ]
                  : [],
              /** 指定IDの削除を実DBに適用する。 */
              deleteStoredSessions: (ids) => storage.deleteSessions(ids),
              /** 一覧置換の依存を同じ実DBへ接続する。 */
              replaceStoredSessions: (sessions) => {
                storage.replaceSessions(sessions);
              },
              /** 保存された会話の一覧をDBから直接返す。 */
              listStoredSessions: () => storage.listSessions(),
              /** 期間削除では実DBの最終利用時刻から対象を選ぶ。 */
              listStoredSessionIdsLastActiveBefore: (cutoff) =>
                storage.listSessionIdsLastActiveBefore(cutoff),
              /** Provider設定の差を持ち込まずに新規作成できるよう既定値を返す。 */
              getAppSettings: () => normalizeAppSettings({}),
              /** モデル候補が削除・再作成を左右しないよう空のカタログを返す。 */
              getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),

              /** テレメトリは作成しないため、その消去要求を受け流す。 */
              clearSessionContextTelemetry: () => undefined,

              /** 実レジストリの代わりに失効対象の親子IDを記録する。 */
              revokeSessionAgentRuntimeBindings: (id) => {
                revoked.push(id);
              },
              /** 閉じる対象を記録し、指定ケースでは最初の親の操作だけを失敗させる。 */
              closeSessionWindow: (id) => {
                closed.push(id);
                if (notificationFailure === "close" && id === first.id)
                  throw closeFailure;
              },
              /** 通知対象を記録し、指定ケースでは最初の親を含む通知で同期例外を起こす。 */
              broadcastSessions: (ids) => {
                broadcasts.push([...(ids ?? [])]);
                if (
                  notificationFailure === "broadcast" &&
                  firstBroadcast &&
                  [...(ids ?? [])].includes(first.id)
                ) {
                  firstBroadcast = false;
                  throw broadcastFailure;
                }
              },
              /** 無効化した世代を記録し、旧親の後処理を保留して別削除と同じIDの再作成を挟めるようにする。 */
              invalidateProviderSessionThread: async (_provider, id) => {
                invalidated.push(id);
                detachedOwners.push(runtimeOwners.get(id) ?? "missing");
                runtimeOwners.delete(id);
                if (id === first.id) {
                  entered.resolve();
                  await release.promise;
                  if (failCleanup) throw failure;
                }
              },
            });
            const deleting =
              deletion === "single"
                ? service.deleteSession(first.id)
                : service.deleteSessionsLastActiveBefore({
                    cutoffDate: "2026-09-10",
                    cutoffIso: "2026-09-10T00:00:00.000Z",
                    cutoffTimestampMs: Date.parse("2026-09-10T00:00:00.000Z"),
                  });
            let outcomeSettled = false;
            const outcome = deleting
              .then(
                (result) => ({ result, error: undefined }),
                (error: unknown) => ({ result: undefined, error }),
              )
              .finally(() => {
                outcomeSettled = true;
              });
            await entered.promise;
            await Promise.resolve();
            assert.equal(outcomeSettled, false);
            assert.equal(storage.getSession(first.id), null);
            assert.deepEqual(
              cached.map((session) => session.id),
              [second.id],
            );
            assert.deepEqual(revoked, [first.id, "first-child"]);
            assert.deepEqual(closed, [first.id, "first-child"]);
            assert.deepEqual(broadcasts, [[first.id]]);
            assert.deepEqual(
              (await service.deleteSession(second.id)).deletedSessionIds,
              [second.id],
            );
            assert.deepEqual(storage.listSessions(), []);
            const replacement = await service.upsertSession(
              makeSession(first.id, first.updatedAt),
              "create",
            );
            runtimeOwners.set(first.id, "new-parent");
            runtimeOwners.set("first-child", "new-child");
            assert.equal(outcomeSettled, false);
            release.resolve();
            const completed = await outcome;
            assert.deepEqual(
              [...invalidated].sort(),
              [first.id, second.id, "first-child"].sort(),
            );
            const expectedErrors = [
              ...(notificationFailure === "close" ? [closeFailure] : []),
              ...(notificationFailure === "broadcast"
                ? [broadcastFailure]
                : []),
              ...(failCleanup ? [failure] : []),
            ];
            if (expectedErrors.length > 0) {
              assert.ok(completed.error instanceof AggregateError);
              assert.equal(
                completed.error.errors.length,
                expectedErrors.length,
              );
              for (const expectedError of expectedErrors)
                assert.ok(completed.error.errors.includes(expectedError));
            } else {
              assert.equal(completed.error, undefined);
              assert.deepEqual(completed.result?.deletedSessionIds, [first.id]);
              assert.deepEqual(completed.result?.deletedAuxiliarySessionIds, [
                "first-child",
              ]);
            }
            assert.deepEqual(
              [...detachedOwners].sort(),
              ["old-parent", "old-child", "other"].sort(),
            );
            assert.deepEqual(
              [...runtimeOwners],
              [
                [first.id, "new-parent"],
                ["first-child", "new-child"],
              ],
            );
            assert.equal(cached[0]?.incarnationId, replacement.incarnationId);
            assert.deepEqual(storage.getSession(first.id), replacement);
          } finally {
            release.resolve();
            storage.close();
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  },
);

// @test-value v2
// kind = "invariant"
// claim = "単体・期間削除はAuxiliary作成commitと順序づけられ、親読取後に保留したchildも親とともに削除される"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
// fault = "Auxiliary commitの親読取後await中に親削除が完了し、削除済み親のchildが後から保存される"
// observable = "commit保留中の削除判定未開始、解放後の削除結果のchild ID、SQLiteの親子行不在"
// observation_boundary = "public-boundary"
// scope = "実AuxiliarySessionServiceとSessionPersistenceServiceの共有provider排他・V6 DB"
// lifecycle = "permanent"
// impact = "削除済み会話のactive Auxiliaryが残り、削除時のbinding失効対象から外れる"
// distinction = "単独storage testや型検査では検出できない親readとchild INSERT間の非同期競合を実serviceとbarrierで検証する"
// @end-test-value
/** 子の確定が親確認後に止まっている間は削除判定を始めず、再開後は新しい子も親と一緒に削除する。 */
it(
  "parent deletion serializes with an Auxiliary commit paused after its parent read",
  { timeout: 10_000 },
  async () => {
    for (const deletion of ["single", "cutoff"] as const) {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "withmate-delete-auxiliary-"),
      );
      const dbPath = path.join(directory, "app.db");
      const storage = new SessionStorageV6(dbPath);
      const auxiliaryStorage = new AuxiliarySessionStorage(dbPath);
      const release = deferred();
      const commitEntered = deferred();
      let creating:
        | ReturnType<AuxiliarySessionService["createAuxiliarySession"]>
        | undefined;
      let deleting:
        ReturnType<SessionPersistenceService["deleteSession"]> | undefined;
      try {
        const parent = storage.insertSession(
          buildNewSession({
            id: "parent",
            taskTitle: "parent",
            workspaceLabel: "workspace",
            workspacePath: "C:/workspace",
            branch: "main",
            characterId: "main",
            character: "Main",
            characterIconPath: "",
            characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
            approvalMode: "on-request",
          }),
        );
        let cached = [parent];
        const coordinator = new ProviderRuntimeOperationCoordinator();
        let characterReads = 0;
        let deletionChecks = 0;
        const auxiliary = new AuxiliarySessionService({
          /** Auxiliaryの作成時に、親の状態を実DBから取得する。 */
          getParentSession: (id) => storage.getSession(id),
          /** 作成と削除が同じファイルのAuxiliary行を参照するよう、実ストアを渡す。 */
          getStorage: () => auxiliaryStorage,
          /** 子を確定する区間で使う排他を、親削除と共有する。 */
          runProviderRuntimeOperationExclusive: (operation) =>
            coordinator.runExclusive(operation),
          /** 起動時の外部問い合わせを省き、対象のCodex実行設定を固定する。 */
          resolveSessionLaunchSelection: async () => ({
            provider: "codex",
            catalogRevision: 1,
            model: "gpt-5.4",
            reasoningEffort: "high",
            approvalMode: "on-request",
            codexSandboxMode: "workspace-write",
            codexSpeed: "standard",
            codexReviewer: "user",
            customAgentName: "",
          }),
          /** 確定中の二度目のキャラクター読取で停止し、親削除を並行して始められるようにする。 */
          listActiveCharacters: async () => {
            characterReads += 1;
            if (characterReads === 2) {
              commitEntered.resolve();
              await release.promise;
            }
            return [
              {
                id: "aux",
                name: "Aux",
                description: "",
                iconFilePath: "",
                theme: { main: "#6f8cff", sub: "#6fb8c7" },
                state: "active",
                createdAt: parent.updatedAt,
                updatedAt: parent.updatedAt,
                archivedAt: null,
              },
            ];
          },
          /** 選択されたAuxiliaryキャラクターの保存に必要なスナップショットを返す。 */
          createCharacterRuntimeSnapshot: () => ({
            characterId: "aux",
            name: "Aux",
            description: "",
            iconFilePath: "",
            theme: { main: "#6f8cff", sub: "#6fb8c7" },
            definitionMarkdown: "# Aux",
            definitionSha256: "test",
            definitionByteSize: 5,
            snapshotAt: parent.updatedAt,
          }),
        });
        const persistence = new SessionPersistenceService({
          ...createSessionStorageCommandAdapter(() => storage),
          /** 親削除の開始を、Auxiliary確定処理が使う同じコーディネーターで順序づける。 */
          runProviderRuntimeOperationExclusive: (operation) =>
            coordinator.runExclusive(operation),
          /** 親削除で更新される前のキャッシュをサービスに渡す。 */
          getSessions: () => cached,
          /** 親削除サービスが投影した一覧を保持する。 */
          setSessions: (sessions) => {
            cached = sessions;
          },
          /** 削除候補の親をキャッシュから取得する。 */
          getSession: (id) =>
            cached.find((session) => session.id === id) ?? null,
          /** 排他中に削除判定まで進んでいないことを呼出回数で調べる。 */
          isSessionRunInFlight: () => {
            deletionChecks += 1;
            return false;
          },
          /** 親に対応する子を作成時と同じDBから読み、削除結果の対象にする。 */
          listAuxiliarySessionRuntimeIdentities: () =>
            auxiliaryStorage.listAuxiliarySessions(parent.id),
          /** 選ばれた親の行を実DBで削除する。 */
          deleteStoredSessions: (ids) => storage.deleteSessions(ids),
          /** 一覧置換を同じMainセッションストアへ渡す。 */
          replaceStoredSessions: (sessions) => {
            storage.replaceSessions(sessions);
          },
          /** 永続化済みのMainセッション一覧を実DBから返す。 */
          listStoredSessions: () => storage.listSessions(),
          /** 期間削除を選んだ場合にも単体削除と同じ親を対象にする。 */
          listStoredSessionIdsLastActiveBefore: () => [parent.id],
          /** 既定の設定で作成と削除の競合を検証する。 */
          getAppSettings: () => normalizeAppSettings({}),
          /** 外部のモデル取得なしで依存を満たす。 */
          getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),
          /** 削除順序の検証ではテレメトリを収集・消去しない。 */
          clearSessionContextTelemetry() {},
          /** 対象のProviderプロセスは起動していないため無効化を省く。 */ invalidateProviderSessionThread() {},
          /** 対象のウィンドウを作らないため終了要求を受け流す。 */ closeSessionWindow() {},
          /** 外部の画面通知を発行せず、SQLiteの親子行を直接検査する。 */ broadcastSessions() {},
        });
        creating = auxiliary.createAuxiliarySession({
          parentSessionId: parent.id,
          provider: "codex",
          runtimeSelection: "latest-session",
          clientRequestId: "create",
        });
        await commitEntered.promise;
        deleting =
          deletion === "single"
            ? persistence.deleteSession(parent.id)
            : persistence.deleteSessionsLastActiveBefore({
                cutoffDate: "2099-01-01",
                cutoffIso: "2099-01-01T00:00:00.000Z",
                cutoffTimestampMs: Date.parse("2099-01-01T00:00:00.000Z"),
              });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(deletionChecks, 0);
        release.resolve();
        const child = await creating;
        const result = await deleting;
        assert.deepEqual(result.deletedAuxiliarySessionIds, [child.id]);
        assert.equal(storage.getSession(parent.id), null);
        assert.deepEqual(auxiliaryStorage.listAuxiliarySessions(parent.id), []);
      } finally {
        release.resolve();
        await Promise.allSettled([creating, deleting]);
        auxiliaryStorage.close();
        storage.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);
