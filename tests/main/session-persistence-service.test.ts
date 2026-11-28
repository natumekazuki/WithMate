import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  buildNewSession,
  projectSessionSummary,
} from "../../src-shared/session/session-state.js";
import type {
  CreateSessionInput,
  Session,
} from "../../src-shared/session/session-state.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type {
  ModelCatalogProvider,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { CurrentExecutionSelections } from "../../src-electron/session/current-execution-selections.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { createSessionPersistenceAssembly } from "../../src-electron/session/session-persistence-assembly.js";

/** 保存前後の差分だけを上書きできるよう、既定の作業場所と Character を持つ Session を組み立てる。 */
function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Persistence Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

/** 指定 Provider の既定モデルと、選択できる三段階の推論強度を備えたカタログ項目を作る。 */
function createProviderCatalog(
  id: string,
  enabled = true,
): ModelCatalogProvider {
  return {
    id,
    label: id,
    defaultModelId: enabled ? `${id}-default` : `${id}-disabled`,
    defaultReasoningEffort: "medium",
    models: [
      {
        id: enabled ? `${id}-default` : `${id}-disabled`,
        label: `${id} default`,
        reasoningEfforts: ["low", "medium", "high"],
      },
    ],
  };
}

/** Codex と Copilot の両方を解決できるモデルカタログを用意する。 */
function createSnapshot(): ModelCatalogSnapshot {
  return {
    providers: [
      createProviderCatalog("codex"),
      createProviderCatalog("copilot"),
    ],
  };
}

/** 作成・更新時に由来を区別できる、定義本文と識別情報を含む Character の保存用スナップショットを組み立てる。 */
function createCharacterRuntimeSnapshot(
  overrides?: Partial<CharacterRuntimeSnapshot>,
): CharacterRuntimeSnapshot {
  return {
    characterId: "char-a",
    name: "A",
    description: "保存済み Character",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    definitionMarkdown: [
      "---",
      "schema: withmate.character.v1",
      "name: A",
      "---",
      "# Character",
      "保存済み snapshot の character.md。",
    ].join("\n"),
    definitionSha256: "sha256-character-definition",
    definitionByteSize: 128,
    snapshotAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

/** Session の保存経路が履歴と最新設定を守り、永続化の成否と後続の投影・通知を区別することを検証する。 */
describe("SessionPersistenceService", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "MainごとのDirectory変更は並行追加を保持し、他Mainと実ファイルを変更せず、無効pathと旧incarnationや失効した実行元を拒否する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#bound-session-api; docs/design/database-schema.md#additional-directory" }
  // fault = "古い一覧で上書きする、他Sessionや実ファイルを削除する、無効pathまたは旧owner・失効実行元を保存する"
  // observable = "保存一覧、通知対象、実ファイルの存在と拒否結果"
  // observation_boundary = "component-behavior"
  // scope = "session-additional-directory-mutation"
  // lifecycle = "permanent"
  // impact = "同時操作が失われる、他Sessionの設定が変わる、または無効pathを後続Turnへ渡す"
  // distinction = "正規化helper単体では保存queueとSession identity、実directory検証を確認できない"
  // @end-test-value
  /** Directory の並行追加を Main ごとに保持し、登録解除で実ファイルや別の Main を変更しないことを確認する。不正なパス、旧 incarnation、失効した実行元の要求は拒否され、成功分だけが通知される。 */
  it("serializes directory updates per saved Main and only unregisters paths", async () => {
    const temp = await mkdtemp(
      path.join(os.tmpdir(), "withmate-directory-mutation-"),
    );
    const workspace = path.join(temp, "workspace"),
      first = path.join(temp, "first"),
      second = path.join(temp, "second");
    await Promise.all([mkdir(workspace), mkdir(first), mkdir(second)]);
    const file = path.join(first, "retained.txt");
    await writeFile(file, "retained");
    try {
      const parent = createSession({
        id: "directory-parent",
        incarnationId: "parent-v1",
        provider: "copilot",
        workspacePath: workspace,
        allowedAdditionalDirectories: [],
      });
      const child = createSession({
        id: "directory-child",
        incarnationId: "child-v1",
        provider: "claude",
        workspacePath: workspace,
        allowedAdditionalDirectories: [],
      });
      let cached = [parent, child];
      const stored = new Map(cached.map((session) => [session.id, session]));
      const broadcasts: string[] = [];
      const service = new SessionPersistenceService({
        /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
        getSessions: () => cached,
        /** 投影された Session 一覧でキャッシュを差し替える。 */
        setSessions: (next) => {
          cached = next;
        },
        /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
        getSession: (id) => cached.find((session) => session.id === id) ?? null,
        /** 永続化の代役である Map から、指定 ID の最新 Session を返す。 */
        getStoredSession: (id) => stored.get(id) ?? null,
        /** 当該 Session が実行中であるものとしてサービスに伝える。 */
        isSessionRunInFlight: () => true,
        /** 非同期の保存を模し、受け取った Session を ID ごとに保存先へ書き戻す。 */
        upsertStoredSession: async (session) => {
          await Promise.resolve();
          stored.set(session.id, session);
          return session;
        },
        /** 並行更新を再現するため非同期に Directory 一覧だけを書き換え、確定後の要約を返す。 */
        setStoredSessionAdditionalDirectories: async (
          id,
          _incarnation,
          directories,
        ) => {
          await Promise.resolve();
          const session = {
            ...stored.get(id)!,
            allowedAdditionalDirectories: directories,
          };
          stored.set(id, session);
          return projectSessionSummary(session);
        },
        /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
        replaceStoredSessions: () => undefined,
        /** Map に確定した各 Main の Session を列挙する。 */
        listStoredSessions: () => [...stored.values()],
        /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
        getAppSettings: () => normalizeAppSettings({}),
        getModelCatalogSnapshot: createSnapshot,
        /** 計測状態の消去要求では外部の計測状態に触れない。 */
        clearSessionContextTelemetry: () => undefined,
        /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
        invalidateProviderSessionThread: () => undefined,
        /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
        closeSessionWindow: () => undefined,
        /** Directory を変更した Main の ID を通知の検証用に記録する。 */
        broadcastSessions: (ids) => broadcasts.push(...(ids ?? [])),
      });
      /** 対象 Main と incarnation を指定し、実際の Directory 更新 API に登録・解除を依頼する。 */
      const change = (
        sessionId: string,
        incarnationId: string,
        operation: "add" | "remove",
        directoryPath: string,
      ) =>
        service.changeAdditionalDirectory({
          sessionId,
          incarnationId,
          operation,
          directoryPath,
        });
      await Promise.all([
        change(parent.id, "parent-v1", "add", first),
        change(parent.id, "parent-v1", "add", second),
        change(child.id, "child-v1", "add", second),
      ]);
      assert.deepEqual(
        stored.get(parent.id)?.allowedAdditionalDirectories,
        [first, second].sort((a, b) => a.localeCompare(b)),
      );
      assert.deepEqual(stored.get(child.id)?.allowedAdditionalDirectories, [
        second,
      ]);
      await change(parent.id, "parent-v1", "remove", first);
      assert.deepEqual(stored.get(parent.id)?.allowedAdditionalDirectories, [
        second,
      ]);
      assert.deepEqual(stored.get(child.id)?.allowedAdditionalDirectories, [
        second,
      ]);
      await access(file);
      await assert.rejects(
        change(parent.id, "old", "remove", second),
        /could not be found/i,
      );
      await assert.rejects(
        change(parent.id, "parent-v1", "add", file),
        /invalid/i,
      );
      await assert.rejects(
        change(parent.id, "parent-v1", "add", "relative"),
        /absolute/i,
      );
      await assert.rejects(
        service.changeAdditionalDirectory(
          {
            sessionId: parent.id,
            incarnationId: "parent-v1",
            operation: "remove",
            directoryPath: second,
          },
          () => {
            throw new Error("turn expired");
          },
        ),
        /turn expired/,
      );
      assert.deepEqual(stored.get(parent.id)?.allowedAdditionalDirectories, [
        second,
      ]);
      assert.deepEqual(
        broadcasts.toSorted(),
        [parent.id, parent.id, child.id, parent.id].toSorted(),
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  // @test-value v2
  // kind = "invariant"
  // claim = "metadataとturn内messageだけを持つruntimeのsteer/terminal保存は全履歴件数とturn identityをstorageへ渡し、確定ACKのtitle/pin/設定を投影する"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#sessionpersistenceservice; docs/design/session-run-lifecycle.md" }
  // fault = "turn内配列indexを履歴indexとして保存する、full保存へ渡す、または古いruntime metadataでACKの現行title/pin/設定を上書きする"
  // observable = "storage command入力のcount/turn/message、返却Session countとmessage、cacheと通知"
  // observation_boundary = "component-behavior"
  // scope = "runtime-incremental-persistence-projection"
  // lifecycle = "permanent"
  // impact = "長い会話でsteerやterminalが別履歴位置へ保存され、並行した整理操作や次turn設定が失われる"
  // distinction = "SQL単体checkでは検出できないservice入力組立てとACKからcacheへの投影を少量fixtureで検証する"
  // @end-test-value
  /** Turn 内の本文しか持たない実行状態から、全履歴の件数と Turn の識別情報を使って追記できることを確認する。全件保存を経由せず、保存応答の最新タイトル・ピン・モデルを採用する。 */
  it("runtimeの小さい保存入力と確定metadata投影を保持する", async () => {
    const runtime = createSession({
      id: "incremental",
      incarnationId: "owner-a",
      status: "running",
      runState: "running",
      messages: [{ role: "user", text: "start" }],
      messageCount: 501,
    });
    let cached = [runtime];
    const commands: unknown[] = [];
    const broadcasts: string[][] = [];
    /** 全履歴の件数と競合更新後のメタデータを含む、追記確定時の保存応答を作る。 */
    const ack = (count: number, next: Partial<Session> = {}) => ({
      summary: projectSessionSummary({
        ...runtime,
        ...next,
        taskTitle: "latest title",
        isPinned: true,
        model: "next model",
      }),
      characterRuntimeSnapshot: null,
      messageCount: count,
    });
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cached,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cached = next;
      },
      /** 増分保存の対象である唯一のキャッシュ項目を返す。 */
      getSession: () => cached[0] ?? null,
      /** 履歴全体の読出しが起きた場合は例外にして、狭い更新経路からの逸脱を検出する。 */
      getStoredSession: () => {
        throw new Error("Unexpected full read");
      },
      /** 当該 Session が実行中であるものとしてサービスに伝える。 */
      isSessionRunInFlight: () => true,
      /** 履歴全体の書込みが起きた場合は例外にし、部分更新だけで完結したかを検証する。 */
      upsertStoredSession: () => {
        throw new Error("Unexpected full write");
      },
      /** 追加の利用者入力を書き込むコマンドを記録し、全履歴が 502 件になった応答を返す。 */
      appendStoredSessionSteer: (input) => {
        commands.push(input);
        return ack(502);
      },
      /** 終了を確定する追記コマンドを記録し、終了時のメタデータと全履歴 503 件を応答に含める。 */
      appendStoredSessionTerminal: (input) => {
        commands.push(input);
        return ack(503, input.metadata);
      },
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** 履歴を列挙しない経路のため、保存一覧のスタブは空で応答する。 */
      listStoredSessions: () => [],
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions: (ids) => {
        broadcasts.push(Array.from(ids ?? []));
      },
    });
    const steered = await service.appendRunningInput(runtime, "input", 42);
    const completed: Session = {
      ...steered,
      status: "idle",
      runState: "idle",
      messageCount: 503,
      messages: [...steered.messages, { role: "assistant", text: "done" }],
    };
    const terminalCommit = {
      turnId: 42,
      sessionId: runtime.id,
      phase: "completed" as const,
      assistantMessageSeq: 502,
      threadId: "thread",
      errorMessage: "",
      completedAt: "2026-10-10T00:00:00.000Z",
    };
    const stored = await service.appendTerminalSession(
      completed,
      terminalCommit,
    );
    assert.deepEqual(commands, [
      {
        sessionId: runtime.id,
        incarnationId: "owner-a",
        expectedMessageCount: 501,
        turnId: 42,
        userMessage: { role: "user", text: "input" },
        updatedAt: runtime.updatedAt,
      },
      {
        sessionId: runtime.id,
        incarnationId: "owner-a",
        expectedMessageCount: 502,
        assistantMessage: { role: "assistant", text: "done" },
        metadata: {
          status: "idle",
          runState: "idle",
          threadId: completed.threadId,
          updatedAt: completed.updatedAt,
        },
        terminalCommit,
      },
    ]);
    assert.equal(stored.messageCount, 503);
    assert.deepEqual(
      stored.messages.map((message) => message.text),
      ["start", "input", "done"],
    );
    assert.equal(stored.taskTitle, "latest title");
    assert.equal(stored.isPinned, true);
    assert.equal(stored.model, "next model");
    assert.equal(cached[0]?.runState, "idle");
    assert.equal(cached[0]?.taskTitle, "latest title");
    assert.deepEqual(cached[0]?.messages, []);
    assert.deepEqual(broadcasts, [[runtime.id], [runtime.id]]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "title更新は実DB保存失敗をrejectし、commit後cache/通知/owner失効を保存済み結果として返して履歴を保持する"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send; Issue #738 STORAGE-1" }
  // fault = "commit後例外を保存失敗としてrejectする、保存失敗時にcacheを更新する、またはtitle復旧で履歴を上書きする"
  // observable = "serviceのcommit結果/拒否、V6 DB再読込titleとmessages、cache title、通知対象"
  // observation_boundary = "public-boundary"
  // scope = "main-title-commit-boundary"
  // lifecycle = "permanent"
  // impact = "保存済みtitleが失敗として見え、再送や古いSessionへのrollbackで確定状態が失われる"
  // distinction = "SQL個別更新testと異なり、実DB保存からserviceのcache/通知例外と呼出側結果までを結合して確認する"
  // @end-test-value
  /** 実 DB へのタイトル保存が失敗した場合だけ要求を拒否し、コミット後にキャッシュ・通知・所有権の確認で失敗しても保存済みと返すことを確認する。DB の履歴本文は全ケースで残る。 */
  it("title保存とcommit後投影失敗を実DBで区別する", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-title-commit-"),
    );
    try {
      for (const fault of [
        "none",
        "storage",
        "cache",
        "broadcast",
        "owner",
      ] as const) {
        const dbPath = path.join(directory, `${fault}.db`);
        const storage = new SessionStorageV6(dbPath);
        try {
          const session = storage.insertSession(
            createSession({
              id: `title-${fault}`,
              taskTitle: "Before",
              messages: [{ role: "user", text: "keep history" }],
            }),
          );
          if (fault === "storage") {
            const db = new DatabaseSync(dbPath);
            try {
              db.exec(
                "CREATE TRIGGER reject_title BEFORE UPDATE OF title ON sessions_v6 BEGIN SELECT RAISE(ABORT, 'title write rejected'); END;",
              );
            } finally {
              db.close();
            }
          }
          let cached = [session];
          let ownerActive = true;
          const broadcasts: string[][] = [];
          const service = createSessionPersistenceAssembly({
            owner: {
              /** コミットの前後で制御する保存所有権を確認し、失効後の利用を拒否する。 */
              assertActive: () => {
                if (!ownerActive) throw new Error("storage owner expired");
              },
            },
            storage: {
              /** 実 DB のタイトル列を更新し、所有権失効のケースでは保存直後に所有権を失わせる。 */
              setSessionTitle: (id: string, owner: string, title: string) => {
                storage.setSessionTitle(id, owner, title);
                if (fault === "owner") ownerActive = false;
              },
            } as never,
            pinStorage: {} as never,
            cache: {
              /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
              getSessions: () => cached,
              /** キャッシュへの投影失敗を注入し、失敗させないケースでは新しい一覧を保持する。 */
              setSessions: (next) => {
                if (fault === "cache") throw new Error("cache unavailable");
                cached = next;
              },
              /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
              getSession: (id) => cached.find((item) => item.id === id) ?? null,
            },
            runtime: {
              /** 親 Session 自体には進行中の実行がない条件を与える。 */
              isSessionRunInFlight: () => false,
            },
            auxiliary: {
              /** この保存対象には Auxiliary がないものとして空の一覧を返す。 */
              listAuxiliarySessionRuntimeIdentities: () => [],
            },
            settings: {
              /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
              getAppSettings: () => normalizeAppSettings({}),
              getModelCatalogSnapshot: createSnapshot,
            },
            character: {
              /** タイトルの更新経路には Character の定義を供給しない。 */
              createCharacterRuntimeSnapshot: () => null,
            },
            effects: {
              /** 計測状態の消去要求では外部の計測状態に触れない。 */
              clearSessionContextTelemetry: () => undefined,

              /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
              invalidateProviderSessionThread: () => undefined,
              /** 実行時の紐付け解除はこの投影失敗テストでは実行しない。 */
              revokeSessionAgentRuntimeBindings: () => undefined,
              /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
              closeSessionWindow: () => undefined,
              /** 既存ウィンドウを破棄する要求はテスト内で外部へ流さない。 */
              discardSessionWindow: () => undefined,
              /** 通知投影の呼出しを記録し、選んだ障害ケースでは通知側で例外を起こす。 */
              broadcastSessions: (ids) => {
                broadcasts.push(Array.from(ids ?? []));
                if (fault === "broadcast")
                  throw new Error("window send failed");
              },
            },
          });
          const pending = service.setSessionTitle(
            session.id,
            session.incarnationId!,
            "After",
          );
          if (fault === "storage") {
            await assert.rejects(pending, /title write rejected/);
          } else {
            assert.deepEqual(await pending, {
              status: "committed",
              projectionUpdated: fault === "none",
            });
          }
          assert.equal(
            storage.getSessionSummary(session.id)?.taskTitle,
            fault === "storage" ? "Before" : "After",
          );
          assert.deepEqual(
            storage
              .getSession(session.id)
              ?.messages.map((message) => message.text),
            ["keep history"],
          );
          assert.equal(
            cached[0]?.taskTitle,
            fault === "storage" || fault === "cache" || fault === "owner"
              ? "Before"
              : "After",
          );
          assert.deepEqual(
            broadcasts,
            fault === "storage" || fault === "owner" ? [] : [[session.id]],
          );
        } finally {
          storage.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "titleとbookmarkのservice更新は履歴を全体保存せず、running/開始中のtitle変更を拒否してcacheへ反映する"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md: Session metadataとmessage保存境界" }
  // fault = "titleまたはbookmark更新がfull read/writeを経由する、またはrunning/開始中のtitle変更を保存する"
  // observable = "狭いstorage呼出し、cache title、broadcast対象、running/開始中の拒否とfull read/write呼出し数"
  // observation_boundary = "component-behavior"
  // scope = "session-persistence-service-narrow-metadata"
  // lifecycle = "permanent"
  // impact = "長い履歴の操作が重くなり、並行するturnの本文を上書きする"
  // distinction = "V6 SQLテストとは異なり、serviceからfull read/writeへ戻らない接続経路を観測する"
  // @end-test-value
  /** タイトルとブックマークだけを更新する操作が履歴全体を読書きしないことを確認する。開始中と実行中のタイトル変更は拒否し、先に確定したタイトルを維持する。 */
  it("titleとbookmarkは狭いstorage呼出しだけを行う", async () => {
    const session = createSession({
      id: "narrow-service",
      incarnationId: "owner-a",
    });
    let cached = [session];
    let inFlight = false;
    const writes: string[] = [];
    const broadcasts: string[][] = [];
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cached,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cached = next;
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession: (id) => cached.find((item) => item.id === id) ?? null,
      /** 履歴全体の読出しが起きた場合は例外にして、狭い更新経路からの逸脱を検出する。 */
      getStoredSession: () => {
        throw new Error("full read");
      },
      /** タイトル更新が開始中かどうか、テストで切り替えるフラグを返す。 */
      isSessionRunInFlight: () => inFlight,
      /** 履歴全体の書込みが起きた場合は例外にし、部分更新だけで完結したかを検証する。 */
      upsertStoredSession: () => {
        throw new Error("full write");
      },
      /** タイトルだけの書込みが使われたことを、保存先の ID・所有権・値とともに記録する。 */
      setStoredSessionTitle: (id, owner, title) => {
        writes.push(`title:${id}:${owner}:${title}`);
      },
      /** ブックマークだけの書込みが使われたことを、対象メッセージ位置と値まで記録する。 */
      setStoredSessionMessageBookmark: (id, owner, index, bookmarked) => {
        writes.push(`bookmark:${id}:${owner}:${index}:${bookmarked}`);
      },
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** 履歴を列挙しない経路のため、保存一覧のスタブは空で応答する。 */
      listStoredSessions: () => [],
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions: (ids) => broadcasts.push(Array.from(ids ?? [])),
    });
    await service.setSessionTitle(session.id, "owner-a", "Updated");
    await service.setSessionMessageBookmark(session.id, "owner-a", 3, true);
    assert.deepEqual(writes, [
      "title:narrow-service:owner-a:Updated",
      "bookmark:narrow-service:owner-a:3:true",
    ]);
    assert.equal(cached[0]?.taskTitle, "Updated");
    assert.deepEqual(broadcasts, [[session.id]]);
    inFlight = true;
    await assert.rejects(
      service.setSessionTitle(session.id, "owner-a", "Starting title"),
      /running session cannot be updated/,
    );
    inFlight = false;
    cached = [{ ...cached[0]!, status: "running", runState: "running" }];
    await assert.rejects(
      service.setSessionTitle(session.id, "owner-a", "Running title"),
      /running session cannot be updated/,
    );
    assert.deepEqual(writes, [
      "title:narrow-service:owner-a:Updated",
      "bookmark:narrow-service:owner-a:3:true",
    ]);
    assert.equal(cached[0]?.taskTitle, "Updated");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "実行中の次設定とdirectory更新は旧captureを変えずcheckpoint失敗とstale保存で巻き戻らず並行steer本文を保持する"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send" }
  // fault = "running選択を拒否するか元captureを編集するかcheckpoint/古い保存で次選択を戻すかread-only/旧ownerを受理する"
  // observable = "旧captureと選択memory、directory更新後の並行steer本文/設定、read-only/旧owner拒否、retry/terminal保存引数と通知数"
  // observation_boundary = "component-behavior"
  // scope = "session-persistence-service-selection-overlay"
  // lifecycle = "permanent"
  // impact = "表示・後続保存に旧設定が残り、利用者の実行設定選択が失われる"
  // distinction = "SQL列更新テストでなく、同じmutation queue内の選択記憶と後続upsertの競合を確認する"
  // @end-test-value
  /** 実行中に受理した次回の設定はチェックポイント保存が失敗しても保持され、古い再試行・終了保存にも反映されることを確認する。実行中のスナップショットを変えず、Directory 更新と競合する追加入力も失わない。 */
  it("実行中も次送信用選択を保持しstale保存へoverlayする", async () => {
    const session = createSession({
      id: "selection-service",
      incarnationId: "owner-a",
      provider: "codex",
      catalogRevision: 2,
      model: "codex-default",
      reasoningEffort: "low",
      messages: [{ role: "user", text: "prompt" }],
      status: "running",
      runState: "running",
    });
    const runningCapture = captureSessionExecutionOptions(session);
    let cached = [session];
    let stored = session;
    const selections = new CurrentExecutionSelections();
    const broadcasts: string[][] = [];
    const storedModels: string[] = [];
    let directoryReads = 0;
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cached,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cached = next;
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession: (id) => cached.find((item) => item.id === id) ?? null,
      /** 初回だけ追加入力を並行起動し、Directory 更新が読み始めた時点の古い保存値を返す。 */
      getStoredSession: () => {
        const snapshot = stored;
        if (directoryReads++ === 0)
          void service.appendRunningInput(session, "concurrent input", 1);
        return snapshot;
      },
      /** 競合する追加入力を保存済み本文へ加え、最新の要約と件数を返す。 */
      appendStoredSessionSteer: () => {
        stored = {
          ...stored,
          messages: [
            ...stored.messages,
            { role: "user", text: "concurrent input" },
          ],
        };
        return {
          summary: projectSessionSummary(stored),
          characterRuntimeSnapshot: stored.characterRuntimeSnapshot,
          messageCount: stored.messages.length,
        };
      },
      /** 当該 Session が実行中であるものとしてサービスに伝える。 */
      isSessionRunInFlight: () => true,
      /** 書込みを受けたモデルと推論強度を観測できるよう記録してから、最新の保存状態に反映する。 */
      upsertStoredSession: (next) => {
        storedModels.push(`${next.model}:${next.reasoningEffort}`);
        stored = next;
        return next;
      },
      /** 書込みを受けたモデルと推論強度を観測できるよう記録してから、最新の保存状態に反映する。 */
      upsertStoredTerminalSession: (next) => {
        storedModels.push(`${next.model}:${next.reasoningEffort}`);
        stored = next;
        return next;
      },
      /** チェックポイントの永続化だけを失敗させ、受理した選択が失われない条件を作る。 */
      setStoredSessionExecutionOptions: () => {
        throw new Error("checkpoint unavailable");
      },
      /** 古い保存入力にメモリ上の最新の実行設定を重ねる。 */
      overlayCurrentExecutionOptions: (next) => selections.apply(next),
      /** 受理した次回用の実行設定を現在の Session に紐付けて記憶する。 */
      rememberExecutionOptions: (next, options) =>
        selections.remember(next, options),
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** 単一の最新保存 Session を一覧として返す。 */
      listStoredSessions: () => [stored],
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions: (ids) => broadcasts.push(Array.from(ids ?? [])),
    });
    const selected = {
      ...captureSessionExecutionOptions(session),
      reasoningEffort: "high" as const,
      approvalMode: "on-request" as const,
      codexSandboxMode: "danger-full-access" as const,
      codexSpeed: "fast" as const,
      codexReviewer: "auto-review" as const,
    };
    assert.deepEqual(
      await service.setSessionExecutionOptions(session.id, "owner-a", selected),
      {
        status: "accepted",
        checkpointSaved: false,
      },
    );
    assert.deepEqual(
      captureSessionExecutionOptions(selections.apply(session)),
      selected,
    );
    assert.deepEqual(captureSessionExecutionOptions(cached[0]!), selected);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(captureSessionExecutionOptions(session), runningCapture);
    const directories = await service.updateSession({
      ...cached[0]!,
      allowedAdditionalDirectories: ["C:/next-context"],
    });
    assert.deepEqual(directories.allowedAdditionalDirectories, [
      "C:\\next-context",
    ]);
    assert.deepEqual(directories.messages, [
      ...session.messages,
      { role: "user", text: "concurrent input" },
    ]);
    assert.deepEqual(captureSessionExecutionOptions(directories), selected);
    await assert.rejects(
      service.setSessionExecutionOptions(
        session.id,
        "obsolete-owner",
        selected,
      ),
      /could not be found/i,
    );
    cached = [{ ...cached[0]!, accessMode: "legacy_readonly" }];
    await assert.rejects(
      service.setSessionExecutionOptions(session.id, "owner-a", selected),
      /read-only/i,
    );
    cached = [{ ...cached[0]!, accessMode: "active" }];
    assert.deepEqual(broadcasts, [[session.id], [session.id]]);
    await service.upsertSessionPreservingPin({
      ...session,
      reasoningEffort: "medium",
    });
    await service.upsertTerminalSession(
      { ...session, status: "idle", reasoningEffort: "medium" },
      {
        turnId: 1,
        sessionId: session.id,
        phase: "completed",
        assistantMessageSeq: 0,
        threadId: "",
        errorMessage: "",
        completedAt: "2026-09-27T00:00:00.000Z",
      },
    );
    assert.deepEqual(storedModels, [
      "codex-default:high",
      "codex-default:high",
      "codex-default:high",
    ]);
    assert.deepEqual(captureSessionExecutionOptions(stored), selected);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "先行する実行オプションcheckpointが保留中でも新選択はメモリへ即時反映され、turn保存をglobal queueで塞がない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md: Session実行オプションとturn保存" }
  // fault = "selection受理をcheckpoint完了まで直列化し、次の選択またはturn保存を古いcheckpointで待たせる"
  // observable = "B checkpoint保留中のC memory/cache、turn保存到達、checkpoint順序と最終選択"
  // observation_boundary = "component-behavior"
  // scope = "session-persistence-service-selection-checkpoint-order"
  // lifecycle = "permanent"
  // impact = "UIを開き直すと古い選択が見え、送信が任意checkpointに妨げられる"
  // distinction = "storage成功後の値だけでなく、pending checkpoint中のメモリ正本とSend進行を観測する"
  // @end-test-value
  /** 先行設定のチェックポイントを保留したまま、後続設定がキャッシュとメモリに反映され、Turn 保存まで進むことを確認する。保留解除後のチェックポイントには選択順が残る。 */
  it("B checkpoint保留中にC選択を受理しturn保存を進める", async () => {
    const session = createSession({
      id: "selection-pending",
      incarnationId: "owner-a",
      provider: "codex",
      catalogRevision: 2,
      model: "codex-default",
      reasoningEffort: "low",
      messages: [{ role: "user", text: "prompt" }],
    });
    let cached = [session];
    const selections = new CurrentExecutionSelections();
    let releaseB!: () => void;
    let reachedB!: () => void;
    const bWait = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const bReached = new Promise<void>((resolve) => {
      reachedB = resolve;
    });
    const checkpoints: string[] = [];
    let turnSaved = false;
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cached,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cached = next;
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession: (id) => cached.find((item) => item.id === id) ?? null,
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight: () => false,
      /** Turn の保存が保留中のチェックポイントより先に到達したかを記録する。 */
      upsertStoredSession: (next) => {
        turnSaved = true;
        return next;
      },
      /** チェックポイントへの到達順を記録し、先行する medium の保存だけを明示解放まで保留する。 */
      setStoredSessionExecutionOptions: async (_id, _owner, options) => {
        checkpoints.push(options.reasoningEffort);
        if (options.reasoningEffort === "medium") {
          reachedB();
          await bWait;
        }
      },
      /** 古い保存入力にメモリ上の最新の実行設定を重ねる。 */
      overlayCurrentExecutionOptions: (next) => selections.apply(next),
      /** 受理した次回用の実行設定を現在の Session に紐付けて記憶する。 */
      rememberExecutionOptions: (next, options) =>
        selections.remember(next, options),
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** チェックポイント実体を持たせず、キャッシュの内容を保存一覧にも返す。 */
      listStoredSessions: () => cached,
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions: () => undefined,
    });
    const base = captureSessionExecutionOptions(session);
    const b = service.setSessionExecutionOptions(session.id, "owner-a", {
      ...base,
      reasoningEffort: "medium",
    });
    await bReached;
    const c = service.setSessionExecutionOptions(session.id, "owner-a", {
      ...base,
      reasoningEffort: "high",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(selections.apply(session).reasoningEffort, "high");
    assert.equal(cached[0]?.reasoningEffort, "high");
    const send = service.upsertSessionPreservingPin({
      ...session,
      reasoningEffort: "low",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(turnSaved, true);
    assert.equal((await send).reasoningEffort, "high");
    releaseB();
    await Promise.all([b, c]);
    assert.deepEqual(checkpoints, ["medium", "high"]);
    assert.equal(selections.apply(session).reasoningEffort, "high");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "古いcatalog取得が後から完了しても、後続の検証済み実行オプション選択を上書きしない"
  // oracle = { type = "contract", ref = "docs/design/database-schema.md: Session実行オプションとturn保存" }
  // fault = "先着Bの遅いcatalog応答が後着Cの受理後にBをremember/checkpointする"
  // observable = "B superseded拒否、C memory、checkpointされたeffort一覧"
  // observation_boundary = "component-behavior"
  // scope = "session-persistence-service-selection-validation-order"
  // lifecycle = "permanent"
  // impact = "後のユーザー選択が古い非同期応答に戻される"
  // distinction = "checkpointの直列順でなく、validation完了順が要求順と逆転する競合を固定する"
  // @end-test-value
  /** 先行要求のカタログ取得が後続要求の受理後に完了しても、先行要求は拒否され、メモリとチェックポイントは後続の選択だけを保持することを確認する。 */
  it("遅れたB catalog応答はC選択を戻さない", async () => {
    const session = createSession({
      id: "selection-catalog",
      incarnationId: "owner-a",
      provider: "codex",
      catalogRevision: 2,
      model: "codex-default",
    });
    let cached = [session];
    let releaseB!: (snapshot: ModelCatalogSnapshot) => void;
    let catalogCalls = 0;
    const bCatalog = new Promise<ModelCatalogSnapshot>((resolve) => {
      releaseB = resolve;
    });
    const selections = new CurrentExecutionSelections();
    const checkpoints: string[] = [];
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cached,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cached = next;
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession: (id) => cached.find((item) => item.id === id) ?? null,
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight: () => false,
      /** 保存コマンドを受けたときは、外部へ書かず入力 Session を応答として返す。 */
      upsertStoredSession: (next) => next,
      /** 受理された選択だけが保存へ届くか確認するため、チェックポイントの推論強度を記録する。 */
      setStoredSessionExecutionOptions: (_id, _owner, options) => {
        checkpoints.push(options.reasoningEffort);
      },
      /** 古い保存入力にメモリ上の最新の実行設定を重ねる。 */
      overlayCurrentExecutionOptions: (next) => selections.apply(next),
      /** 受理した次回用の実行設定を現在の Session に紐付けて記憶する。 */
      rememberExecutionOptions: (next, options) =>
        selections.remember(next, options),
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** チェックポイント実体を持たせず、キャッシュの内容を保存一覧にも返す。 */
      listStoredSessions: () => cached,
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** 初回に限ってカタログ取得を保留し、後続要求の選択を先に解決させる。 */
      getModelCatalogSnapshot: () =>
        ++catalogCalls === 1 ? bCatalog : createSnapshot(),

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions: () => undefined,
    });
    const base = captureSessionExecutionOptions(session);
    const b = service.setSessionExecutionOptions(session.id, "owner-a", {
      ...base,
      reasoningEffort: "medium",
    });
    await service.setSessionExecutionOptions(session.id, "owner-a", {
      ...base,
      reasoningEffort: "high",
    });
    releaseB(createSnapshot());
    await assert.rejects(b, /superseded/);
    assert.equal(selections.apply(session).reasoningEffort, "high");
    assert.deepEqual(checkpoints, ["high"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "catalog待ちでSessionが同ID再作成された時、古いownerの選択はメモリにもstorageにも記録しない"
  // oracle = { type = "contract", ref = "AGENTS.md: Session incarnationとデータ保護" }
  // fault = "非同期catalog取得前に読んだ古いSessionを検証し、再作成された行へ選択を適用する"
  // observable = "古いownerの拒否、remember/storage呼出しなし、新owner cache不変"
  // observation_boundary = "component-behavior"
  // scope = "session-persistence-service-selection-owner"
  // lifecycle = "permanent"
  // impact = "削除済みSessionの選択が新しい会話へ漏れて実行条件を変える"
  // distinction = "storageのincarnation SQL guardだけでなく、その前のin-memory selection記憶を防ぐ"
  // @end-test-value
  /** カタログ取得中に同じ ID の Session が別 incarnation で作り直された場合、旧要求が拒否され、記憶・保存ともに呼ばれず新しいキャッシュを変更しないことを確認する。 */
  it("catalog待ち中の同ID再作成では選択を記憶しない", async () => {
    const old = createSession({
      id: "owner-race",
      incarnationId: "old-owner",
      catalogRevision: 2,
      model: "codex-default",
    });
    const recreated = {
      ...old,
      incarnationId: "new-owner",
      taskTitle: "New session",
    };
    let cached = [old];
    let releaseCatalog!: (snapshot: ModelCatalogSnapshot) => void;
    let reachedCatalog!: () => void;
    const catalogReady = new Promise<void>((resolve) => {
      reachedCatalog = resolve;
    });
    const catalogWait = new Promise<ModelCatalogSnapshot>((resolve) => {
      releaseCatalog = resolve;
    });
    const calls: string[] = [];
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cached,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cached = next;
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession: (id) => cached.find((item) => item.id === id) ?? null,
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight: () => false,
      /** 保存コマンドを受けたときは、外部へ書かず入力 Session を応答として返す。 */
      upsertStoredSession: (next) => next,
      /** 失効した選択が誤ってチェックポイントに到達したかを記録する。 */
      setStoredSessionExecutionOptions: () => {
        calls.push("storage");
      },
      /** 失効した選択を誤ってメモリへ記憶しようとした場合に、その呼出しを記録する。 */
      rememberExecutionOptions: () => {
        calls.push("remember");
      },
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** チェックポイント実体を持たせず、キャッシュの内容を保存一覧にも返す。 */
      listStoredSessions: () => cached,
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** カタログ取得への到達を知らせ、Session 再作成後にテスト側がカタログを返せるよう待機する。 */
      getModelCatalogSnapshot: () => {
        reachedCatalog();
        return catalogWait;
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions: () => undefined,
    });
    const update = service.setSessionExecutionOptions(
      old.id,
      "old-owner",
      captureSessionExecutionOptions(old),
    );
    await catalogReady;
    cached = [recreated];
    releaseCatalog(createSnapshot());
    await assert.rejects(update, /could not be found/i);
    assert.deepEqual(calls, []);
    assert.equal(cached[0]?.taskTitle, "New session");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "実行中のpin変更は実行状態とupdatedAtを保ちcacheと通知へ反映する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts setSessionPinned" }
  // fault = "pin変更で実行状態やupdatedAtを上書きするかcache更新または通知を失う"
  // observable = "返却SessionのpinとupdatedAt、cacheのstatus/runState/pin、broadcast対象ID"
  // observation_boundary = "component-behavior"
  // scope = "session persistence pin update"
  // lifecycle = "permanent"
  // @end-test-value
  /** 旧形式の読み取り専用 Session が実行中でも、ピンの変更結果は更新時刻を維持し、キャッシュの実行状態を変えず対象 ID を通知することを確認する。 */
  it("setSessionPinnedは実行状態とupdatedAtを変えずにcacheとbroadcastを更新する", async () => {
    const session = createSession({
      id: "pin-target",
      status: "running",
      runState: "running",
      accessMode: "legacy_readonly",
      sourceSchemaVersion: 4,
      updatedAt: "2026-08-09T04:38:00.000Z",
      isPinned: false,
    });
    let cachedSessions = [session];
    const broadcasts: string[][] = [];
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cachedSessions,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cachedSessions = next;
      },
      /** ピン更新前の固定 Session を返し、投影結果とは分けて扱う。 */
      getSession: () => session,
      /** 当該 Session が実行中であるものとしてサービスに伝える。 */
      isSessionRunInFlight: () => true,
      /** 保存コマンドを受けたときは、外部へ書かず入力 Session を応答として返す。 */
      upsertStoredSession: (next) => next,
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** 保存側の応答として、実行状態と更新時刻を持つ要約に指定のピン値だけを反映する。 */
      setStoredSessionPinned: (sessionId, isPinned) => ({
        ...projectSessionSummary(session),
        id: sessionId,
        isPinned,
      }),
      /** 既存の 1 件だけを保存一覧の初期状態として返す。 */
      listStoredSessions: () => [session],
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions: (sessionIds) =>
        broadcasts.push(Array.from(sessionIds ?? [])),
    });

    const saved = await service.setSessionPinned(session.id, true);

    assert.equal(saved.isPinned, true);
    assert.equal(saved.updatedAt, session.updatedAt);
    assert.equal(cachedSessions[0]?.status, "running");
    assert.equal(cachedSessions[0]?.runState, "running");
    assert.equal(cachedSessions[0]?.isPinned, true);
    assert.deepEqual(broadcasts, [[session.id]]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "pinと共通Directory変更後のstaleなrunning/retry/terminal保存は最新の設定を保持し終端本文を保存する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts upsertSessionPreservingPin/upsertTerminalSession" }
  // fault = "並行したstale保存が最新のpinまたは共通Directoryを戻すかterminal本文を失う"
  // observable = "保存SessionのisPinned/Directory/runState/最終本文とcacheのisPinned/Directory"
  // observation_boundary = "public-boundary"
  // scope = "session persistence pin concurrency"
  // lifecycle = "permanent"
  // @end-test-value
  /** ピン変更と古い実行中・再試行・終了保存を並行させても、最新のピンと Directory が保存・キャッシュに残り、終了メッセージも確定することを確認する。 */
  it("pinとDirectory変更の後にstaleなrunning・retry・terminal保存が続いても最新の設定を維持する", async () => {
    const runningSession = createSession({
      id: "pin-during-run",
      status: "running",
      runState: "running",
      isPinned: false,
    });
    const directories = [path.resolve("C:/current-shared")];
    const selectedSession = {
      ...runningSession,
      allowedAdditionalDirectories: directories,
    };
    let cachedSessions = [selectedSession];
    let storedSession = selectedSession;
    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions: () => cachedSessions,
      /** 投影された Session 一覧でキャッシュを差し替える。 */
      setSessions: (next) => {
        cachedSessions = next;
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession: (sessionId) =>
        cachedSessions.find((session) => session.id === sessionId) ?? null,
      /** 当該 Session が実行中であるものとしてサービスに伝える。 */
      isSessionRunInFlight: () => true,
      /** 実行中の保存入力を受け取った内容で保存先の Session を置き換える。 */
      upsertStoredSession: (next) => {
        storedSession = next;
        return next;
      },
      /** 終了保存の入力を確定値として保存先に保持し、その Session を返す。 */
      upsertStoredTerminalSession: (next) => {
        storedSession = next;
        return next;
      },
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions: () => undefined,
      /** 最新の保存値のピンだけを変更し、その時点の要約を応答する。 */
      setStoredSessionPinned: (sessionId, isPinned) => {
        storedSession = { ...storedSession, isPinned };
        return {
          ...projectSessionSummary(storedSession),
          id: sessionId,
          isPinned,
        };
      },
      /** 単一の最新保存 Session を一覧として返す。 */
      listStoredSessions: () => [storedSession],
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry: () => undefined,

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread: () => undefined,
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow: () => undefined,
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions: () => undefined,
    });
    const staleCompletedSession = createSession({
      ...runningSession,
      status: "idle",
      runState: "idle",
      isPinned: false,
      messages: [
        ...runningSession.messages,
        { role: "assistant", text: "done" },
      ],
    });

    const pinWrite = service.setSessionPinned(runningSession.id, true);
    const staleRunningWrite = service.upsertSessionPreservingPin({
      ...runningSession,
      threadId: "thread-stale",
      isPinned: false,
    });
    const staleRetryWrite = service.upsertSessionPreservingPin({
      ...runningSession,
      threadId: "",
      isPinned: false,
    });
    const terminalWrite = service.upsertTerminalSession(staleCompletedSession, {
      turnId: 1,
      sessionId: staleCompletedSession.id,
      phase: "completed",
      assistantMessageSeq: staleCompletedSession.messages.length - 1,
      threadId: staleCompletedSession.threadId,
      errorMessage: "",
      completedAt: "2026-08-16T00:00:00.000Z",
    });
    await Promise.all([
      pinWrite,
      staleRunningWrite,
      staleRetryWrite,
      terminalWrite,
    ]);

    assert.equal(storedSession.isPinned, true);
    assert.deepEqual(storedSession.allowedAdditionalDirectories, directories);
    assert.equal(storedSession.runState, "idle");
    assert.equal(storedSession.messages.at(-1)?.text, "done");
    assert.equal(cachedSessions[0]?.isPinned, true);
    assert.deepEqual(
      cachedSessions[0]?.allowedAdditionalDirectories,
      directories,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "確定済みterminal保存はcache/broadcast投影の失敗で未保存扱いにならない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md terminal persistence and projection boundaries" }
  // fault = "永続化成功後のprojection例外を保存失敗として返すか後続projectionを省略する"
  // observable = "返却Sessionと保存Sessionの終端state/本文および各projectionの呼出記録"
  // observation_boundary = "public-boundary"
  // scope = "terminal persistence outcome"
  // lifecycle = "permanent"
  // @end-test-value
  /** 終了保存後にキャッシュまたは通知の投影が失敗しても、保存済みの終了状態と返却値が維持され、両方の投影が試行されることを確認する。 */
  it("terminal commit後のprojection failureを保存済み結果へ波及させない", async () => {
    for (const failingProjection of ["cache", "broadcast"] as const) {
      const runningSession = createSession({
        id: `terminal-projection-${failingProjection}`,
        status: "running",
        runState: "running",
      });
      const terminalSession = createSession({
        ...runningSession,
        status: "idle",
        runState: "idle",
        messages: [
          ...runningSession.messages,
          { role: "assistant", text: "done" },
        ],
      });
      let cachedSessions = [runningSession];
      let persistedSession = runningSession;
      const attemptedProjections: string[] = [];
      const service = new SessionPersistenceService({
        /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
        getSessions: () => cachedSessions,
        /** キャッシュへの投影失敗を注入し、失敗させないケースでは新しい一覧を保持する。 */
        setSessions(nextSessions) {
          attemptedProjections.push("cache");
          if (failingProjection === "cache") {
            throw new Error("cache projection failed");
          }
          cachedSessions = nextSessions;
        },
        /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
        getSession: (sessionId) =>
          cachedSessions.find((session) => session.id === sessionId) ?? null,
        /** 当該 Session が実行中であるものとしてサービスに伝える。 */
        isSessionRunInFlight: () => true,
        /** 実行中の保存入力を受け取った内容で保存先の Session を置き換える。 */
        upsertStoredSession(next) {
          persistedSession = next;
          return next;
        },
        /** 終了保存の入力を確定値として保存先に保持し、その Session を返す。 */
        upsertStoredTerminalSession(next) {
          persistedSession = next;
          return next;
        },
        /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
        replaceStoredSessions: () => undefined,
        /** 終了保存の代役にある値から、指定のピンを付けた応答を返す。 */
        setStoredSessionPinned: (_sessionId, isPinned) => ({
          ...persistedSession,
          isPinned,
        }),
        /** 単一の最新保存 Session を一覧として返す。 */
        listStoredSessions: () => [persistedSession],
        /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
        getAppSettings: () => normalizeAppSettings({}),
        getModelCatalogSnapshot: createSnapshot,

        /** 計測状態の消去要求では外部の計測状態に触れない。 */
        clearSessionContextTelemetry: () => undefined,

        /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
        invalidateProviderSessionThread: () => undefined,
        /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
        closeSessionWindow: () => undefined,
        /** 通知投影の呼出しを記録し、選んだ障害ケースでは通知側で例外を起こす。 */
        broadcastSessions() {
          attemptedProjections.push("broadcast");
          if (failingProjection === "broadcast") {
            throw new Error("broadcast projection failed");
          }
        },
      });

      const result = await service.upsertTerminalSession(terminalSession, {
        turnId: 1,
        sessionId: terminalSession.id,
        phase: "completed",
        assistantMessageSeq: terminalSession.messages.length - 1,
        threadId: terminalSession.threadId,
        errorMessage: "",
        completedAt: "2026-08-16T00:00:00.000Z",
      });

      assert.equal(result.runState, "idle");
      assert.equal(result.messages.at(-1)?.text, "done");
      assert.equal(persistedSession.runState, "idle");
      assert.deepEqual(attemptedProjections, ["cache", "broadcast"]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "createSessionのprovider解決は非同期catalog/settingsを待ち、無効providerを拒否する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#resolveCharacterAuthoringProvider" }
  // fault = "非同期provider解決を待たずPromiseをprovider値として扱う"
  // observable = "provider解決結果と無効providerの拒否"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-provider-resolution"
  // lifecycle = "permanent"
  // @end-test-value
  /** 非同期の設定とモデルカタログから有効な Provider を解決し、作成用の保存と通知まで行うことを確認する。無効または未登録の Provider は追加の保存なしに拒否する。 */
  it("createSession は有効な provider と model を解決して保存する", async () => {
    const storedSessions: Session[] = [];
    const broadcastedSessionIds: string[][] = [];
    const snapshot = createSnapshot();
    const characterRuntimeSnapshot = createCharacterRuntimeSnapshot();
    const snapshotCharacterIds: string[] = [];
    const storeOperations: string[] = [];
    let persistedSession: Session | null = null;

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** キャッシュに一致する Session がない条件を返す。 */
      getSession() {
        return null;
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 新規作成として保存されたかを操作名と保存入力で記録し、後続の要約投影と区別する。 */
      upsertStoredSession(session, operation) {
        storeOperations.push(operation);
        persistedSession = session;
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** 非同期に設定を返し、Codex を有効、Copilot を無効にした解決条件を作る。 */
      async getAppSettings() {
        return normalizeAppSettings({
          providers: {
            codex: { enabled: true },
            copilot: { enabled: false },
          },
        });
      },
      /** Provider を解決する際に待つべきモデルカタログを非同期に返す。 */
      async getModelCatalogSnapshot() {
        return snapshot;
      },
      /** 要求した Character ID を記録し、用意した保存用スナップショットを返す。 */
      createCharacterRuntimeSnapshot(characterId) {
        snapshotCharacterIds.push(characterId);
        return characterRuntimeSnapshot;
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    assert.equal(
      await service.resolveCharacterAuthoringProvider("codex"),
      "codex",
    );
    await assert.rejects(
      () => service.resolveCharacterAuthoringProvider("unknown-provider"),
      /Provider unknown-provider model discovery is unavailable/,
    );
    await assert.rejects(
      () => service.resolveCharacterAuthoringProvider("copilot"),
      /Provider copilot is disabled/,
    );

    const created = await service.createSession({
      taskTitle: "New Session",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      provider: "codex",
      model: "codex-default",
      reasoningEffort: "medium",
      customAgentName: "",
      allowedAdditionalDirectories: [
        "C:/workspace/..",
        "C:/workspace/external",
      ],
    } satisfies CreateSessionInput);

    assert.equal(created.provider, "codex");
    assert.equal(created.model, "codex-default");
    assert.equal(created.reasoningEffort, "medium");
    assert.equal(created.customAgentName, "");
    assert.equal(created.allowedAdditionalDirectories.length, 1);
    assert.deepEqual(snapshotCharacterIds, ["char-a"]);
    assert.deepEqual(
      created.characterRuntimeSnapshot,
      characterRuntimeSnapshot,
    );
    assert.notEqual(created.characterRuntimeSnapshot, characterRuntimeSnapshot);
    assert.deepEqual(
      persistedSession!.characterRuntimeSnapshot,
      characterRuntimeSnapshot,
    );
    assert.equal(storedSessions[0]?.characterRuntimeSnapshot, null);
    assert.deepEqual(broadcastedSessionIds, [[created.id]]);
    assert.deepEqual(storeOperations, ["create"]);

    await assert.rejects(
      () =>
        service.createSession({
          taskTitle: "Character authoring",
          workspaceLabel: "character authoring",
          workspacePath: "C:/characters/char-a",
          branch: "main",
          sessionKind: "character-authoring",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
          provider: "copilot",
          customAgentName: "",
          allowedAdditionalDirectories: [],
        }),
      /Provider copilot is disabled/,
    );
    assert.deepEqual(storeOperations, ["create"]);

    await assert.rejects(
      () =>
        service.createSession({
          taskTitle: "Character authoring",
          workspaceLabel: "character authoring",
          workspacePath: "C:/characters/char-a",
          branch: "main",
          sessionKind: "character-authoring",
          characterId: "char-a",
          character: "A",
          characterIconPath: "",
          characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
          approvalMode: DEFAULT_APPROVAL_MODE,
          provider: "unknown-provider",
          customAgentName: "",
          allowedAdditionalDirectories: [],
        }),
      /Provider unknown-provider model discovery is unavailable/,
    );
    assert.deepEqual(storeOperations, ["create"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "既存Session IDとの衝突時は新規入力で既存Sessionを上書きしない"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#createSession" }
  // fault = "衝突したIDの既存Sessionを破壊または置換する"
  // observable = "reject結果、upsert回数、既存Sessionの主要属性"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-create-collision"
  // lifecycle = "permanent"
  // @end-test-value
  /** 指定 ID が既存 Session と衝突した場合、キャッシュにある場合も保存先にしかない場合も新規作成を拒否し、保存処理に渡さないことを確認する。 */
  it("createSession は指定 ID が既存 Session と衝突する場合に上書きしない", async () => {
    const existing = createSession({
      id: "existing-session",
      status: "running",
      runState: "running",
      threadId: "thread-existing",
    });
    let upsertCount = 0;
    const service = new SessionPersistenceService({
      /** 衝突する ID の Session をあらかじめキャッシュに載せておく。 */
      getSessions: () => [existing],
      /** 衝突検査中のキャッシュ書戻しでは既存データに触れない。 */
      setSessions() {},
      /** 既存 Session の ID だけ、キャッシュの検索にヒットさせる。 */
      getSession: (sessionId) => (sessionId === existing.id ? existing : null),
      /** 衝突対象の保存済み Session を返す。 */
      getStoredSession: () => existing,
      /** 当該 Session が実行中であるものとしてサービスに伝える。 */
      isSessionRunInFlight: () => true,
      /** 拒否されるべき要求が永続化に到達した場合に回数を記録する。 */
      upsertStoredSession(session, _operation) {
        upsertCount += 1;
        return session;
      },
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions() {},
      /** 既存の 1 件だけを保存一覧の初期状態として返す。 */
      listStoredSessions: () => [existing],
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot: () => createSnapshot(),

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    await assert.rejects(
      service.createSession({
        id: existing.id,
        taskTitle: "forged replacement",
        workspaceLabel: "forged",
        workspacePath: "C:/forged",
        branch: "",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      /A Session with the same ID already exists/,
    );
    assert.equal(upsertCount, 0);
    assert.equal(existing.threadId, "thread-existing");
    assert.equal(existing.workspacePath, "C:/workspace");

    let storageOnlyUpsertCount = 0;
    const storageOnlyService = new SessionPersistenceService({
      /** 衝突判定を保存先にも行わせるため、空のキャッシュ一覧を返す。 */
      getSessions: () => [],
      /** 衝突検査中のキャッシュ書戻しでは既存データに触れない。 */
      setSessions() {},
      /** キャッシュに一致する Session がない条件を返す。 */
      getSession: () => null,
      /** キャッシュから見えない既存 Session を、ID が一致した場合だけ保存先から返す。 */
      getStoredSession: (sessionId) =>
        sessionId === existing.id ? existing : null,
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight: () => false,
      /** 拒否されるべき要求が永続化に到達した場合に回数を記録する。 */
      upsertStoredSession() {
        storageOnlyUpsertCount += 1;
        return existing;
      },
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions() {},
      /** 既存の 1 件だけを保存一覧の初期状態として返す。 */
      listStoredSessions: () => [existing],
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot: () => createSnapshot(),

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    await assert.rejects(
      storageOnlyService.createSession({
        id: existing.id,
        taskTitle: "storage-only forged replacement",
        workspaceLabel: "forged",
        workspacePath: "C:/forged",
        branch: "",
        characterId: "char-a",
        character: "A",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: DEFAULT_APPROVAL_MODE,
      }),
      /A Session with the same ID already exists/,
    );
    assert.equal(storageOnlyUpsertCount, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "createSessionへ渡されたCharacterRuntimeSnapshotをfallback生成結果より優先して保存する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#createSession" }
  // fault = "入力snapshotを破棄してfallback snapshotを保存する"
  // observable = "作成Sessionと永続化Sessionのsnapshot identityおよびfallback呼び出し回数"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-create-runtime-snapshot"
  // lifecycle = "permanent"
  // @end-test-value
  /** 作成入力に Character のスナップショットがある場合、既定の取得処理は呼ばず、入力に等しい複製を返却・永続化し、要約キャッシュには載せないことを確認する。 */
  it("createSession は input の CharacterRuntimeSnapshot を優先して保存する", async () => {
    const storedSessions: Session[] = [];
    const inputSnapshot = createCharacterRuntimeSnapshot({
      definitionMarkdown: "# Character\ninput snapshot",
      definitionSha256: "sha256-input",
    });
    let fallbackSnapshotCalls = 0;
    let persistedSession: Session | null = null;

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** キャッシュに一致する Session がない条件を返す。 */
      getSession() {
        return null;
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 永続化した完全な Session を、キャッシュに書き戻す要約とは別に記録する。 */
      upsertStoredSession(session, _operation) {
        persistedSession = session;
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },
      /** 入力のスナップショットがない場合にだけ使われる代替値を用意し、呼出しを記録する。 */
      createCharacterRuntimeSnapshot() {
        fallbackSnapshotCalls += 1;
        return createCharacterRuntimeSnapshot({
          definitionSha256: "sha256-fallback",
        });
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const created = await service.createSession({
      taskTitle: "New Session",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      characterRuntimeSnapshot: inputSnapshot,
      approvalMode: DEFAULT_APPROVAL_MODE,
    } satisfies CreateSessionInput);

    assert.equal(fallbackSnapshotCalls, 0);
    assert.deepEqual(created.characterRuntimeSnapshot, inputSnapshot);
    assert.notEqual(created.characterRuntimeSnapshot, inputSnapshot);
    assert.deepEqual(persistedSession!.characterRuntimeSnapshot, inputSnapshot);
    assert.equal(storedSessions[0]?.characterRuntimeSnapshot, null);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "summary-only更新で入力にない既存messagesを保持して保存する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#upsertSession" }
  // fault = "summary更新で既存messagesを空配列または入力値へ置換する"
  // observable = "永続化Sessionと返却Sessionのmessage本文"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-summary-message-preservation"
  // lifecycle = "permanent"
  // @end-test-value
  /** 履歴を持たない要約から更新しても保存済みの利用者・アシスタント本文が書込みと返却値に残り、要約キャッシュは履歴を持たないことを確認する。 */
  it("upsertSession は summary-only session 更新でも既存 messages を保持する", async () => {
    const fullSession = createSession({
      id: "session-with-messages",
      taskTitle: "Before",
      messages: [
        { role: "user", text: "残すメッセージ" },
        { role: "assistant", text: "残す返答" },
      ],
    });
    const summaryOnlySession: Session = {
      ...fullSession,
      taskTitle: "After",
      messages: [],
      stream: [],
    };
    let storedSession: Session | null = null;
    const inMemorySessions = [summaryOnlySession];

    const service = new SessionPersistenceService({
      /** 本文を省いた要約だけを載せたキャッシュ一覧を返す。 */
      getSessions() {
        return inMemorySessions;
      },
      /** 更新後のキャッシュを受け取り、観測用の配列に反映する。 */
      setSessions(nextSessions) {
        inMemorySessions.splice(0, inMemorySessions.length, ...nextSessions);
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession(sessionId) {
        return (
          inMemorySessions.find((session) => session.id === sessionId) ?? null
        );
      },
      /** 指定 ID が一致するときだけ、要約から省かれた履歴を持つ保存済み Session を返す。 */
      getStoredSession(sessionId) {
        return sessionId === fullSession.id ? fullSession : null;
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 要約と保存履歴を合成した結果が書込みに届くか、Session 全体を捕捉する。 */
      upsertStoredSession(session, _operation) {
        storedSession = session;
        return session;
      },
      /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
      replaceStoredSessions() {},
      /** 履歴を列挙しない経路のため、保存一覧のスタブは空で応答する。 */
      listStoredSessions() {
        return [];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const updated = await service.upsertSession(summaryOnlySession);

    assert.deepEqual(
      storedSession!.messages.map((message) => message.text),
      ["残すメッセージ", "残す返答"],
    );
    assert.deepEqual(
      updated.messages.map((message) => message.text),
      ["残すメッセージ", "残す返答"],
    );
    assert.deepEqual(inMemorySessions[0]?.messages, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "createSessionはmodelとcustomAgentNameの前後空白を除き、指定したreasoningEffortを保存する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#createSession" }
  // fault = "modelまたはcustomAgentNameの入力空白を未正規化のまま保存する"
  // observable = "作成Sessionのmodel、reasoningEffort、customAgentName"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-create-runtime-selection"
  // lifecycle = "permanent"
  // @end-test-value
  /** モデル ID とカスタムエージェント名の前後空白を除いたうえで、指定された推論強度とともに返却値と保存データへ反映することを確認する。 */
  it("createSession は model と customAgentName をtrimし指定したreasoningEffortを保存する", async () => {
    const storedSessions: Session[] = [];

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** キャッシュに一致する Session がない条件を返す。 */
      getSession() {
        return null;
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(session, _operation) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** 空白除去後のモデルを解決できるよう、両 Provider を有効にした設定を返す。 */
      getAppSettings() {
        return normalizeAppSettings({
          codingProviderSettings: {
            codex: { enabled: true },
            copilot: { enabled: true },
          },
        });
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const created = await service.createSession({
      taskTitle: "New Session",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      provider: "copilot",
      model: " copilot-default ",
      reasoningEffort: "high",
      customAgentName: " planner ",
    } satisfies CreateSessionInput);

    assert.equal(created.provider, "copilot");
    assert.equal(created.model, "copilot-default");
    assert.equal(created.reasoningEffort, "high");
    assert.equal(created.customAgentName, "planner");
    assert.equal(storedSessions.length, 1);
    assert.equal(storedSessions[0]?.model, "copilot-default");
    assert.equal(storedSessions[0]?.reasoningEffort, "high");
    assert.equal(storedSessions[0]?.customAgentName, "planner");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "provider変更時はtelemetryをclearし、thread reset時は旧provider thread cacheをinvalidateする"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#updateSession" }
  // fault = "provider変更またはthread reset後に旧provider状態を残す"
  // observable = "clear/invalidate呼び出し記録と保存Sessionのprovider/threadId"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-provider-thread-reset"
  // lifecycle = "permanent"
  // @end-test-value
  /** Provider 変更で現行スレッド ID と計測状態を破棄し、旧 Provider のキャッシュを無効化することを確認する。同一 Provider 内のスレッドの明示リセットも無効化の対象になる。 */
  it("updateSession は provider 変更時に telemetry をクリアし、thread reset 時は provider cache を invalidate する", async () => {
    const baseSession = createSession({
      provider: "codex",
      model: "codex-default",
      threadId: "thread-1",
    });
    const storedSessions: Session[] = [baseSession];
    const clearedTelemetry: string[] = [];
    const invalidatedThreads: Array<{
      providerId: string | null | undefined;
      sessionId: string;
    }> = [];
    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return (
          storedSessions.find((session) => session.id === sessionId) ?? null
        );
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(session, _operation) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態のクリアが要求された Session ID を検証用に収集する。 */
      clearSessionContextTelemetry(sessionId) {
        clearedTelemetry.push(sessionId);
      },

      /** 無効化を指示された Provider と Session の組を記録する。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const updated = await service.updateSession({
      ...baseSession,
      provider: "copilot",
      model: "copilot-default",
    });
    assert.equal(updated.provider, "copilot");
    assert.equal(updated.threadId, "");
    assert.deepEqual(clearedTelemetry, [baseSession.id]);
    assert.deepEqual(invalidatedThreads, [
      { providerId: "codex", sessionId: baseSession.id },
    ]);

    const sameProviderThreadReset = createSession({
      id: "same-provider-thread-reset",
      provider: "codex",
      model: "codex-default",
      threadId: "thread-to-delete",
    });
    storedSessions.splice(0, storedSessions.length, sameProviderThreadReset);
    await service.updateSession({ ...sameProviderThreadReset, threadId: "" });
    assert.deepEqual(invalidatedThreads, [
      { providerId: "codex", sessionId: baseSession.id },
      { providerId: "codex", sessionId: sameProviderThreadReset.id },
    ]);

    const withoutThread = createSession({
      id: "session-without-thread",
      provider: "codex",
      model: "codex-default",
      threadId: "",
    });
    storedSessions.splice(0, storedSessions.length, withoutThread);
    await service.updateSession({
      ...withoutThread,
      provider: "copilot",
      model: "copilot-default",
    });
    assert.deepEqual(invalidatedThreads, [
      { providerId: "codex", sessionId: baseSession.id },
      { providerId: "codex", sessionId: sameProviderThreadReset.id },
      { providerId: "codex", sessionId: withoutThread.id },
    ]);

    storedSessions.splice(
      0,
      storedSessions.length,
      createSession({
        id: baseSession.id,
        runState: "running",
        status: "running",
      }),
    );
    await assert.rejects(
      () =>
        service.updateSession({ ...storedSessions[0], taskTitle: "blocked" }),
      /A running session cannot be updated/,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Main Sessionのfull-session更新は保存済みApprovalがneverの間、他項目を更新しても現在のReviewerを保持する"
  // oracle = { type = "contract", ref = "CODEX-AUTO-REVIEW-AR-3" }
  // fault = "直接IPCまたはstale payloadがnever中のReviewerを変更し、後のinteractive復帰で意図しない値が有効になる"
  // scope = "session-persistence-service"
  // observable = "保存後のSession codexReviewer"
  // observation_boundary = "public-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  /** 保存済み承認モードが never の間は、タイトル変更に別の Reviewer が混ざっても、返却値と保存結果が現在のキャッシュの Reviewer を維持することを確認する。 */
  it("updateSession は保存済みApprovalがneverの間Reviewerを保持する", async () => {
    const storedSession = createSession({
      approvalMode: "never",
      codexReviewer: "user",
    });
    const cachedSession = createSession({
      ...storedSession,
      approvalMode: "never",
      codexReviewer: "auto-review",
    });
    const storedSessions: Session[] = [cachedSession];
    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions: () => storedSessions,
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession: (sessionId) =>
        storedSessions.find((session) => session.id === sessionId) ?? null,
      /** キャッシュとは別の保存済みデータを、指定 ID が一致する場合に返す。 */
      getStoredSession: (sessionId) =>
        sessionId === storedSession.id ? storedSession : null,
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight: () => false,
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(session, _operation) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions: () => [...storedSessions],
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings: () => normalizeAppSettings({}),
      getModelCatalogSnapshot: createSnapshot,

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const updated = await service.updateSession({
      ...cachedSession,
      taskTitle: "Renamed Session",
      codexReviewer: "user",
    });

    assert.equal(updated.taskTitle, "Renamed Session");
    assert.equal(updated.codexReviewer, "auto-review");
    assert.equal(storedSessions[0]?.codexReviewer, "auto-review");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "保存済みCharacter ownerまたはruntime snapshot identityの差し替えを永続化前に拒否する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#updateSession" }
  // fault = "既存Character identityと異なる更新を保存し、owner境界を破壊する"
  // observable = "reject結果と永続化呼び出しの不在"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-character-identity-guard"
  // lifecycle = "permanent"
  // @end-test-value
  /** 保存済み Character の所有者を単独またはスナップショットごと差し替える要求と、スナップショットを除去する要求を拒否し、一度も永続化へ渡さないことを確認する。 */
  it("updateSession は保存済み Character owner / runtime snapshot の差し替えを永続化前に拒否する", async () => {
    const characterRuntimeSnapshot = createCharacterRuntimeSnapshot();
    const storedSession = createSession({ characterRuntimeSnapshot });
    const cachedSession = createSession({
      id: storedSession.id,
      characterRuntimeSnapshot: null,
    });
    const invalidUpdates = [
      {
        ...storedSession,
        characterId: "char-b",
      },
      {
        ...storedSession,
        characterId: "char-b",
        characterRuntimeSnapshot: createCharacterRuntimeSnapshot({
          characterId: "char-b",
          name: "B",
        }),
      },
      {
        ...storedSession,
        characterRuntimeSnapshot: null,
      },
    ];

    for (const invalidUpdate of invalidUpdates) {
      let upsertCallCount = 0;
      const cachedSessions: Session[] = [cachedSession];
      const service = new SessionPersistenceService({
        /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
        getSessions() {
          return cachedSessions;
        },
        /** 更新後のキャッシュを受け取り、観測用の配列に反映する。 */
        setSessions(nextSessions) {
          cachedSessions.splice(0, cachedSessions.length, ...nextSessions);
        },
        /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
        getSession(sessionId) {
          return sessionId === cachedSession.id ? cachedSession : null;
        },
        /** キャッシュとは別の保存済みデータを、指定 ID が一致する場合に返す。 */
        getStoredSession(sessionId) {
          return sessionId === storedSession.id ? storedSession : null;
        },
        /** 親 Session 自体には進行中の実行がない条件を与える。 */
        isSessionRunInFlight() {
          return false;
        },
        /** 拒否されるべき要求が永続化に到達した場合に回数を記録する。 */
        upsertStoredSession(session, _operation) {
          upsertCallCount += 1;
          return session;
        },
        /** 保存先の一括置換はこのケースで扱わないため、状態を変更しない。 */
        replaceStoredSessions() {},
        /** 単一の最新保存 Session を一覧として返す。 */
        listStoredSessions() {
          return [storedSession];
        },
        /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
        deleteStoredSession() {},
        /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
        getAppSettings() {
          return normalizeAppSettings({});
        },
        /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
        getModelCatalogSnapshot() {
          return createSnapshot();
        },

        /** 計測状態の消去要求では外部の計測状態に触れない。 */
        clearSessionContextTelemetry() {},

        /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
        invalidateProviderSessionThread() {},
        /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
        closeSessionWindow() {},
        /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
        broadcastSessions() {},
      });

      await assert.rejects(
        () => service.updateSession(invalidUpdate),
        /Character owner and runtime snapshot cannot be updated/,
      );
      assert.equal(upsertCallCount, 0);
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "model/reasoning変更では既存threadIdを維持する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#updateSession" }
  // fault = "選択変更だけでprovider threadを破棄し、継続中会話を切断する"
  // observable = "更新後SessionのthreadIdとmodel/reasoning"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-model-selection-update"
  // lifecycle = "permanent"
  // @end-test-value
  /** 同じ Provider 内でモデルと推論強度を変えても、既存スレッド ID を保持し、Provider キャッシュを無効化しないことを確認する。 */
  it("updateSession は model / reasoning 変更時に threadId を維持する", async () => {
    const baseSession = createSession({
      provider: "copilot",
      model: "copilot-default",
      reasoningEffort: "medium",
      threadId: "thread-keep",
    });
    const storedSessions: Session[] = [baseSession];
    const invalidatedThreads: Array<{
      providerId: string | null | undefined;
      sessionId: string;
    }> = [];
    const snapshot = createSnapshot();
    const copilot = snapshot.providers.find(
      (provider) => provider.id === "copilot",
    );
    assert.ok(copilot);
    copilot.models.push({
      id: "copilot-alt",
      label: "copilot alternate",
      reasoningEfforts: ["low", "medium", "high"],
    });

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return (
          storedSessions.find((session) => session.id === sessionId) ?? null
        );
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(session, _operation) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** 同一 Provider 内での変更先を含む拡張済みモデルカタログを返す。 */
      getModelCatalogSnapshot() {
        return snapshot;
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** 無効化を指示された Provider と Session の組を記録する。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const updated = await service.updateSession({
      ...baseSession,
      model: "copilot-alt",
      reasoningEffort: "high",
      threadId: "thread-keep",
    });

    assert.equal(updated.model, "copilot-alt");
    assert.equal(updated.reasoningEffort, "high");
    assert.equal(updated.threadId, "thread-keep");
    assert.deepEqual(invalidatedThreads, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "runtime parameter変更では既存threadIdを維持する"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#updateSession" }
  // fault = "runtime parameter変更だけでprovider threadをresetする"
  // observable = "更新後SessionのthreadIdとruntime parameter"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-runtime-parameter-update"
  // lifecycle = "permanent"
  // @end-test-value
  /** 承認・サンドボックス・追加 Directory の変更要求があっても、既存スレッドを破棄しないことを確認する。Directory は正規化され、キャッシュの無効化は呼ばれない。 */
  it("updateSession は runtime parameter 変更時に threadId を維持する", async () => {
    const baseSession = createSession({
      provider: "codex",
      model: "codex-default",
      reasoningEffort: "medium",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      allowedAdditionalDirectories: ["C:/external-a"],
      threadId: "thread-keep",
    });
    const storedSessions: Session[] = [baseSession];
    const invalidatedThreads: Array<{
      providerId: string | null | undefined;
      sessionId: string;
    }> = [];

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return (
          storedSessions.find((session) => session.id === sessionId) ?? null
        );
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(session, _operation) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** 無効化を指示された Provider と Session の組を記録する。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const updated = await service.updateSession({
      ...baseSession,
      approvalMode: "never",
      codexSandboxMode: "danger-full-access",
      allowedAdditionalDirectories: ["C:/external-b"],
      threadId: "thread-keep",
    });

    assert.equal(updated.threadId, "thread-keep");
    assert.deepEqual(updated.allowedAdditionalDirectories, [
      path.resolve("C:/external-b"),
    ]);
    assert.deepEqual(invalidatedThreads, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "legacy read-only Sessionへのupdate/upsertを拒否する"
  // oracle = { type = "contract", ref = "src/session-state.ts#isReadOnlySession" }
  // fault = "read-onlyデータを通常Sessionとして更新し永続化する"
  // observable = "reject結果とstored sessionの不変性"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-legacy-readonly-guard"
  // lifecycle = "permanent"
  // @end-test-value
  /** 旧形式の読み取り専用 Session について、通常更新と upsert のどちらもタイトル変更を拒否し、保存済みタイトルが変わらないことを確認する。 */
  it("legacy read-only session は update/upsert できない", async () => {
    const legacySession = createSession({
      accessMode: "legacy_readonly",
      sourceSchemaVersion: 3,
      characterIconPath: "",
    });
    const storedSessions: Session[] = [legacySession];

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return (
          storedSessions.find((session) => session.id === sessionId) ?? null
        );
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(session, _operation) {
        storedSessions.splice(0, storedSessions.length, session);
        return session;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 削除機能の依存だけを満たし、テスト用の保存状態を変更しない。 */
      deleteStoredSession() {},
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    await assert.rejects(
      () =>
        service.updateSession({
          ...legacySession,
          taskTitle: "Blocked Update",
        }),
      /Read-only sessions cannot be updated/,
    );
    await assert.rejects(
      () =>
        service.upsertSession({
          ...legacySession,
          taskTitle: "Blocked Upsert",
        }),
      /Read-only sessions cannot be updated/,
    );
    assert.equal(storedSessions[0]?.taskTitle, legacySession.taskTitle);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "親Session削除時のDeleteSessionsResultはcascade削除対象のAuxiliary IDを返す"
  // oracle = { type = "adr", ref = "docs/adr/006-windows-session-turn-notifications.md" }
  // fault = "親Sessionに紐づくAuxiliaryのIDを削除結果へ含めず、Auxiliary通知の撤去対象を失う"
  // observable = "DeleteSessionsResult.deletedAuxiliarySessionIds"
  // observation_boundary = "component-behavior"
  // scope = "session-persistence-delete-notification-targets"
  // lifecycle = "permanent"
  // distinction = "Auxiliaryのruntime cleanupだけでは確認できない、削除結果から通知keyを上位へ渡す契約を検証する"
  // @end-test-value
  /** 親 Session の削除結果が従属 Auxiliary の ID を返し、親子のウィンドウ、実行時の紐付け、Provider キャッシュも片付けることを確認する。 */
  it("deleteSession は関連状態を片付けて window close を呼ぶ", async () => {
    const session = createSession();
    const storedSessions: Session[] = [session];
    const deleted: string[] = [];
    const closedWindows: string[] = [];
    const revokedBindings: string[] = [];
    const invalidatedThreads: Array<{
      providerId: string | null | undefined;
      sessionId: string;
    }> = [];
    const broadcastedSessionIds: string[][] = [];

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return storedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 削除対象の親 ID で実行時情報が照会されることを確認し、配下の Auxiliary を返す。 */
      listAuxiliarySessionRuntimeIdentities(parentSessionIds) {
        assert.deepEqual(parentSessionIds, [session.id]);
        return [
          {
            id: "auxiliary-a",
            parentSessionId: session.id,
            provider: "copilot",
          },
        ];
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(next) {
        storedSessions.splice(0, storedSessions.length, next);
        return next;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 指定 ID の削除要求を記録し、保存用配列から一致する Session を取り除く。 */
      deleteStoredSession(sessionId) {
        deleted.push(sessionId);
        const remaining = storedSessions.filter(
          (entry) => entry.id !== sessionId,
        );
        storedSessions.splice(0, storedSessions.length, ...remaining);
      },
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** 無効化を指示された Provider と Session の組を記録する。 */
      invalidateProviderSessionThread(providerId, sessionId) {
        invalidatedThreads.push({ providerId, sessionId });
      },
      /** 削除に伴い失効させた実行時の紐付けを Session ID で記録する。 */
      revokeSessionAgentRuntimeBindings(sessionId) {
        revokedBindings.push(sessionId);
      },
      /** 終了を指示されたウィンドウの Session ID を記録する。 */
      closeSessionWindow(sessionId) {
        closedWindows.push(sessionId);
      },
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    const result = await service.deleteSession(session.id);

    assert.deepEqual(result.deletedAuxiliarySessionIds, ["auxiliary-a"]);
    assert.deepEqual(deleted, [session.id]);
    assert.deepEqual(closedWindows, [session.id, "auxiliary-a"]);
    assert.deepEqual(revokedBindings, [session.id, "auxiliary-a"]);
    assert.deepEqual(invalidatedThreads, [
      { providerId: session.provider, sessionId: session.id },
      { providerId: "copilot", sessionId: "auxiliary-a" },
    ]);
    assert.deepEqual(broadcastedSessionIds, [[session.id]]);
    assert.equal(storedSessions.length, 0);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "active Auxiliaryが実行中の親SessionをdeleteSessionで削除できない"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#deleteSession" }
  // fault = "子turn実行中の親Sessionを削除し、継続中turnの保存対象を失う"
  // observable = "deleteの拒否とstored parent sessionの保持"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-delete-running-parent-guard"
  // lifecycle = "permanent"
  // @end-test-value
  /** 親自身が非実行中でも active Auxiliary が実行中なら、単体削除を拒否し、親を保存先に残すことを確認する。 */
  it("deleteSession は active Auxiliary が実行中の親 Session を削除しない", async () => {
    const parentSession = createSession({ id: "parent" });
    const storedSessions: Session[] = [parentSession];
    const deleted: string[] = [];

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return storedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 照会対象が親の ID であることを確かめ、その親に実行中の Auxiliary がいると返す。 */
      listRunningActiveAuxiliaryParentIds(sessionIds) {
        assert.deepEqual(sessionIds, [parentSession.id]);
        return new Set([parentSession.id]);
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(next) {
        storedSessions.splice(0, storedSessions.length, next);
        return next;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 指定 ID の削除要求を記録し、保存用配列から一致する Session を取り除く。 */
      deleteStoredSession(sessionId) {
        deleted.push(sessionId);
        const remaining = storedSessions.filter(
          (entry) => entry.id !== sessionId,
        );
        storedSessions.splice(0, storedSessions.length, ...remaining);
      },
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    await assert.rejects(
      () => service.deleteSession(parentSession.id),
      /A running Crew cannot be deleted/,
    );

    assert.deepEqual(deleted, []);
    assert.deepEqual(
      storedSessions.map((session) => session.id),
      [parentSession.id],
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "bulk削除はcutoff対象のidle Sessionだけを削除しrunning Sessionをskipする"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#deleteSessionsLastActiveBefore" }
  // fault = "running Sessionをbulk削除し、実行中状態を破壊する"
  // observable = "削除対象idsとstored sessions"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-bulk-delete-running-skip"
  // lifecycle = "permanent"
  // @end-test-value
  /** 期限より前の一括削除では非実行中の候補だけが削除・通知され、実行中の候補はスキップとして返り、期限以降の Session も残ることを確認する。 */
  it("deleteSessionsLastActiveBefore は対象だけ bulk 削除し running は skip する", async () => {
    const oldSession = createSession({
      id: "old",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const runningSession = createSession({
      id: "running",
      status: "running",
      runState: "running",
      updatedAt: "2026-06-01T01:00:00.000Z",
    });
    const recentSession = createSession({
      id: "recent",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const storedSessions: Session[] = [
      oldSession,
      runningSession,
      recentSession,
    ];
    const deletedBatches: string[][] = [];
    const clearedTelemetry: string[] = [];
    const closedWindows: string[] = [];
    const broadcastedSessionIds: string[][] = [];

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return storedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      /** 実行中に設定した Session の ID だけ、削除判定に実行中と応答する。 */
      isSessionRunInFlight(sessionId) {
        return sessionId === runningSession.id;
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(next) {
        storedSessions.splice(0, storedSessions.length, next);
        return next;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 期限より前の候補として、非実行中と実行中の両方の ID を保存先から返す。 */
      listStoredSessionIdsLastActiveBefore() {
        return [oldSession.id, runningSession.id];
      },
      /** サービスが選別した一括削除対象を記録し、その ID だけを保存用配列から除く。 */
      deleteStoredSessions(sessionIds) {
        deletedBatches.push([...sessionIds]);
        const deletedSessionIds = new Set(sessionIds);
        const remaining = storedSessions.filter(
          (entry) => !deletedSessionIds.has(entry.id),
        );
        storedSessions.splice(0, storedSessions.length, ...remaining);
      },
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態のクリアが要求された Session ID を検証用に収集する。 */
      clearSessionContextTelemetry(sessionId) {
        clearedTelemetry.push(sessionId);
      },

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** 終了を指示されたウィンドウの Session ID を記録する。 */
      closeSessionWindow(sessionId) {
        closedWindows.push(sessionId);
      },
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    const result = await service.deleteSessionsLastActiveBefore({
      cutoffDate: "2026-07-01",
      cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
      cutoffIso: "2026-07-01T00:00:00.000Z",
    });

    assert.deepEqual(result.deletedSessionIds, [oldSession.id]);
    assert.deepEqual(result.skippedRunningSessionIds, [runningSession.id]);
    assert.deepEqual(deletedBatches, [[oldSession.id]]);
    assert.deepEqual(clearedTelemetry, [oldSession.id]);
    assert.deepEqual(closedWindows, [oldSession.id]);
    assert.deepEqual(broadcastedSessionIds, [[oldSession.id]]);
    assert.deepEqual(
      storedSessions.map((session) => session.id),
      [runningSession.id, recentSession.id],
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "bulk削除はactive Auxiliary実行中の親Sessionをskipする"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#deleteSessionsLastActiveBefore" }
  // fault = "子turn実行中の親Sessionを削除する"
  // observable = "削除結果と親Sessionの存在"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-bulk-delete-running-parent-skip"
  // lifecycle = "permanent"
  // @end-test-value
  /** 期限より前の削除候補に active Auxiliary が実行中の親が含まれていても、その親をスキップして他の対象だけを削除することを確認する。 */
  it("deleteSessionsLastActiveBefore は active Auxiliary が実行中の親 Session を skip する", async () => {
    const parentSession = createSession({
      id: "parent",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const oldSession = createSession({
      id: "old",
      updatedAt: "2026-06-01T01:00:00.000Z",
    });
    const recentSession = createSession({
      id: "recent",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const storedSessions: Session[] = [
      parentSession,
      oldSession,
      recentSession,
    ];
    const deletedBatches: string[][] = [];

    const service = new SessionPersistenceService({
      /** このケースでキャッシュと保存先の両方を模す共有配列を返す。 */
      getSessions() {
        return storedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** ID が一致する Session をテスト用の共有配列から探す。 */
      getSession(sessionId) {
        return storedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      /** 親 Session 自体には進行中の実行がない条件を与える。 */
      isSessionRunInFlight() {
        return false;
      },
      /** 一括削除候補のうち親だけに実行中の Auxiliary がいることを返す。 */
      listRunningActiveAuxiliaryParentIds(sessionIds) {
        assert.deepEqual(sessionIds, [parentSession.id, oldSession.id]);
        return new Set([parentSession.id]);
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(next) {
        storedSessions.splice(0, storedSessions.length, next);
        return next;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        storedSessions.splice(0, storedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...storedSessions];
      },
      /** 期限より前の候補として、実行中の Auxiliary がいる親と非実行中の単独 Session を返す。 */
      listStoredSessionIdsLastActiveBefore() {
        return [parentSession.id, oldSession.id];
      },
      /** サービスが選別した一括削除対象を記録し、その ID だけを保存用配列から除く。 */
      deleteStoredSessions(sessionIds) {
        deletedBatches.push([...sessionIds]);
        const deletedSessionIds = new Set(sessionIds);
        const remaining = storedSessions.filter(
          (entry) => !deletedSessionIds.has(entry.id),
        );
        storedSessions.splice(0, storedSessions.length, ...remaining);
      },
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態の消去要求では外部の計測状態に触れない。 */
      clearSessionContextTelemetry() {},

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** ウィンドウを開かないテストのため、閉じる要求では何もしない。 */
      closeSessionWindow() {},
      /** 変更通知はこのケースの観測対象に含めず、配送しない。 */
      broadcastSessions() {},
    });

    const result = await service.deleteSessionsLastActiveBefore({
      cutoffDate: "2026-07-01",
      cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
      cutoffIso: "2026-07-01T00:00:00.000Z",
    });

    assert.deepEqual(result.deletedSessionIds, [oldSession.id]);
    assert.deepEqual(result.skippedRunningSessionIds, [parentSession.id]);
    assert.deepEqual(deletedBatches, [[oldSession.id]]);
    assert.deepEqual(
      storedSessions.map((session) => session.id),
      [parentSession.id, recentSession.id],
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "bulk削除はcache未読込でもstored Sessionを対象にする"
  // oracle = { type = "contract", ref = "src-electron/session/session-persistence-service.ts#deleteSessionsLastActiveBefore" }
  // fault = "cacheにない対象を見落としてstored Sessionを残す"
  // observable = "stored session削除結果と通知対象"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-bulk-delete-stored-cache-miss"
  // lifecycle = "permanent"
  // @end-test-value
  /** キャッシュに載っていない古い Session も保存先から見つけて削除し、その ID の通知と後片付けを行うことを確認する。 */
  it("deleteSessionsLastActiveBefore は cache 未読込の stored session も削除する", async () => {
    const uncachedOldSession = createSession({
      id: "uncached-old",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const runningSession = createSession({
      id: "running",
      status: "running",
      runState: "running",
      updatedAt: "2026-06-01T01:00:00.000Z",
    });
    const recentSession = createSession({
      id: "recent",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const cachedSessions: Session[] = [runningSession, recentSession];
    const persistedSessions: Session[] = [
      uncachedOldSession,
      runningSession,
      recentSession,
    ];
    const deletedBatches: string[][] = [];
    const clearedTelemetry: string[] = [];
    const closedWindows: string[] = [];
    const broadcastedSessionIds: string[][] = [];

    const service = new SessionPersistenceService({
      /** サービスが現在参照するキャッシュ内の Session 一覧を返す。 */
      getSessions() {
        return cachedSessions;
      },
      /** サービスから受け取った一覧を、テストが共有する配列へ反映する。 */
      setSessions(nextSessions) {
        cachedSessions.splice(0, cachedSessions.length, ...nextSessions);
      },
      /** キャッシュから指定 ID の Session を引き、未読込なら null を返す。 */
      getSession(sessionId) {
        return cachedSessions.find((entry) => entry.id === sessionId) ?? null;
      },
      /** 実行中に設定した Session の ID だけ、削除判定に実行中と応答する。 */
      isSessionRunInFlight(sessionId) {
        return sessionId === runningSession.id;
      },
      /** 渡された単一 Session を保存用配列へ書き戻し、確定した値として返す。 */
      upsertStoredSession(next) {
        persistedSessions.splice(0, persistedSessions.length, next);
        return next;
      },
      /** 一括置換の入力を保存用配列へ反映する。 */
      replaceStoredSessions(nextSessions) {
        persistedSessions.splice(0, persistedSessions.length, ...nextSessions);
      },
      /** 現在の保存内容を、元の配列を変更せずに列挙する。 */
      listStoredSessions() {
        return [...persistedSessions];
      },
      /** キャッシュ未読込の古い Session も、保存先から得た削除候補に含める。 */
      listStoredSessionIdsLastActiveBefore() {
        return [uncachedOldSession.id, runningSession.id];
      },
      /** サービスが選別した一括削除対象を記録し、その ID だけを保存用配列から除く。 */
      deleteStoredSessions(sessionIds) {
        deletedBatches.push([...sessionIds]);
        const deletedSessionIds = new Set(sessionIds);
        const remaining = persistedSessions.filter(
          (entry) => !deletedSessionIds.has(entry.id),
        );
        persistedSessions.splice(0, persistedSessions.length, ...remaining);
      },
      /** Provider の個別変更を加えない既定のアプリ設定を用意する。 */
      getAppSettings() {
        return normalizeAppSettings({});
      },
      /** このテスト用に用意した Codex と Copilot のカタログを返す。 */
      getModelCatalogSnapshot() {
        return createSnapshot();
      },

      /** 計測状態のクリアが要求された Session ID を検証用に収集する。 */
      clearSessionContextTelemetry(sessionId) {
        clearedTelemetry.push(sessionId);
      },

      /** Provider のスレッドキャッシュ操作をテスト外へ伝播させない。 */
      invalidateProviderSessionThread() {},
      /** 終了を指示されたウィンドウの Session ID を記録する。 */
      closeSessionWindow(sessionId) {
        closedWindows.push(sessionId);
      },
      /** 変更通知が届いた回ごとに対象 ID の一覧を複製して記録する。 */
      broadcastSessions(sessionIds) {
        broadcastedSessionIds.push(Array.from(sessionIds ?? []));
      },
    });

    const result = await service.deleteSessionsLastActiveBefore({
      cutoffDate: "2026-07-01",
      cutoffTimestampMs: Date.parse("2026-07-01T00:00:00.000Z"),
      cutoffIso: "2026-07-01T00:00:00.000Z",
    });

    assert.deepEqual(result.deletedSessionIds, [uncachedOldSession.id]);
    assert.deepEqual(result.skippedRunningSessionIds, [runningSession.id]);
    assert.deepEqual(deletedBatches, [[uncachedOldSession.id]]);
    assert.deepEqual(clearedTelemetry, [uncachedOldSession.id]);
    assert.deepEqual(closedWindows, [uncachedOldSession.id]);
    assert.deepEqual(broadcastedSessionIds, [[uncachedOldSession.id]]);
    assert.deepEqual(
      cachedSessions.map((session) => session.id),
      [runningSession.id, recentSession.id],
    );
    assert.deepEqual(
      persistedSessions.map((session) => session.id),
      [runningSession.id, recentSession.id],
    );
  });
});
