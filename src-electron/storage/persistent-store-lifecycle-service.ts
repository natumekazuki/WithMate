import { basename, dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type {
  Session,
  SessionCharacterUsage,
  SessionSummary,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
} from "../../src-shared/session/session-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CharacterRuntimeSnapshot,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../../src-shared/character/character-catalog.js";
import {
  APP_DATABASE_V2_FILENAME,
  CREATE_V2_SCHEMA_SQL,
  isValidV2Database,
} from "./database-schema-v2.js";
import {
  APP_DATABASE_V3_FILENAME,
  CREATE_V3_SCHEMA_SQL,
  isValidV3Database,
} from "./database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME } from "./database-schema-v4.js";
import {
  APP_DATABASE_V6_FILENAME,
  ensureV6Schema,
} from "./database-schema-v6.js";
import { AppSettingsStorage } from "../app/app-settings-storage.js";
import { AuxiliarySessionStorage } from "../auxiliary/auxiliary-session-storage.js";
import { CharacterStorage } from "../character/character-storage.js";
import {
  MateStorage,
  type MateProfileFileMismatch,
} from "../mate/mate-storage.js";
import { ModelCatalogStorage } from "../settings/model-catalog-storage.js";
import { SessionStorage } from "../session/session-storage.js";
import { SessionStorageV2 } from "../session/session-storage-v2.js";
import { SessionStorageV3 } from "../session/session-storage-v3.js";
import { SessionStorageV6 } from "../session/session-storage-v6.js";
import { sessionSummariesToSessions } from "../session/session-summary-adapter.js";
import {
  openAppDatabase,
  truncateAppDatabaseWal,
} from "./sqlite-connection.js";
import {
  createV6StorageWorkerBundle,
  type V6StorageWorkerBundle,
  type ConversationQueryStore,
} from "./storage-worker-bundle.js";
import type { SessionTurnStorageV6 } from "../session/session-turn-storage-v6.js";
import type { SessionTurnTerminalCommit } from "../session/session-turn-terminal-commit.js";
import type {
  SessionCharacterAuthoringRuntimeClearInput,
  SessionCharacterAuthoringRuntimeClearResult,
  SessionRunningTurnStartInput,
  SessionRunningTurnStartResult,
} from "../session/session-running-turn-start.js";

/** Worker を介さないストアの終了に必要な最小の契約。 */
type ClosableStore = {
  /** ストアの接続や、そのストアが所有する資源を解放する。 */
  close(): void;
};

/** 同期実装と Worker 経由の非同期実装を、同じ呼び出し側で扱うための戻り値。 */
export type Awaitable<T> = T | Promise<T>;

/** 選んだストアメソッドの引数を保ち、戻り値を同期・非同期どちらでも扱えるようにする。 */
type AwaitableStorageMethods<TStorage, TKeys extends keyof TStorage> = {
  [TKey in TKeys]: TStorage[TKey] extends (
    ...args: infer TArgs
  ) => infer TReturn
    ? (...args: TArgs) => Awaitable<Awaited<TReturn>>
    : never;
};

/** セッションの読取契約。世代によって利用できない読取機能は任意とする。 */
export type SessionStorageRead = AwaitableStorageMethods<
  SessionStorage,
  | "listSessions"
  | "listSessionSummaries"
  | "getLatestSessionSummaryForProvider"
  | "getSession"
  | "getSessionMessageArtifact"
  | "listSessionIdsLastActiveBefore"
> &
  Pick<SessionStorage, "close"> & {
    getSessionView?: AwaitableStorageMethods<
      SessionStorageV6,
      "getSessionView"
    >["getSessionView"];
    getConversationPage?: AwaitableStorageMethods<
      SessionStorageV6,
      "getConversationPage"
    >["getConversationPage"];
    searchConversation?: ConversationQueryStore["searchConversation"];
    listConversationNavigator?: ConversationQueryStore["listConversationNavigator"];
    cancelConversationQuery?: ConversationQueryStore["cancelConversationQuery"];
    /** Home に表示するセッション要約のページを取得する。 */
    listSessionSummaryPage?(
      request?: SessionSummaryPageRequest | null,
    ): Awaitable<HomeSessionSummaryPageResult>;
    listHomeCrewMembersPage?: AwaitableStorageMethods<
      SessionStorageV6,
      "listHomeCrewMembersPage"
    >["listHomeCrewMembersPage"];
    /** ID に対応する保存済みのセッション要約を取得し、存在しなければ null を返す。 */
    getSessionSummary?(
      sessionId: string,
    ): Awaitable<
      import("../../src-shared/session/session-state.js").SessionSummary | null
    >;
    getSessionMetadata?: AwaitableStorageMethods<
      SessionStorageV6,
      "getSessionMetadata"
    >["getSessionMetadata"];
    getSessionMessageIdentity?: AwaitableStorageMethods<
      SessionStorageV6,
      "getSessionMessageIdentity"
    >["getSessionMessageIdentity"];
    /** セッションごとの Character 利用情報を取得する。 */
    listSessionCharacterUsage?(): Awaitable<SessionCharacterUsage[]>;
    /** 認証情報に関係する、保存済みのセッションスレッド情報を列挙する。 */
    listSessionCredentialThreads?(): Awaitable<
      import("../session/session-storage-v6.js").SessionCredentialThreadInfo[]
    >;
    getSessionLifecycleOperation?: AwaitableStorageMethods<
      SessionStorageV6,
      "getSessionLifecycleOperation"
    >["getSessionLifecycleOperation"];
    listPendingSessionLifecycleOperations?: AwaitableStorageMethods<
      SessionStorageV6,
      "listPendingSessionLifecycleOperations"
    >["listPendingSessionLifecycleOperations"];
    getCrewDeletionStatus?: AwaitableStorageMethods<
      SessionStorageV6,
      "getCrewDeletionStatus"
    >["getCrewDeletionStatus"];
  };
/** セッションの作成・更新・削除と、対応世代での個別更新を公開する契約。 */
export type SessionStorageWrite = AwaitableStorageMethods<
  SessionStorage,
  | "insertSession"
  | "upsertSession"
  | "replaceSessions"
  | "deleteSession"
  | "deleteSessions"
  | "clearSessions"
> &
  SessionStorageRead & {
    listSessionFilePins?: SessionFilePinStorage["listSessionFilePins"];
    pinSessionFile?: SessionFilePinStorage["pinSessionFile"];
    unpinSessionFile?: SessionFilePinStorage["unpinSessionFile"];
    /** 既存のセッションを更新し、保存結果を返す。 */
    updateSession?(session: Session): Awaitable<Session>;
    /** 対象世代などの更新条件が一致したセッションだけ、スレッド情報を差し替える。 */
    updateSessionThreadIfMatches?(
      input: import("../session/session-storage-v6.js").SessionThreadPatchInput,
    ): Awaitable<
      import("../session/session-storage-v6.js").SessionThreadPatchResult | null
    >;
    /** 保存済みの実行状態が入力の条件と一致する場合に、実行メタデータを更新する。 */
    updateSessionRuntimeMetadataIfMatches?(
      input: import("../session/session-storage-v6.js").SessionRuntimeMetadataPatchInput,
    ): Awaitable<
      | import("../session/session-storage-v6.js").SessionRuntimeMetadataPatchResult
      | null
    >;
    /** 指定したセッションの世代に対してタイトルを保存する。 */
    setSessionTitle?(
      sessionId: string,
      incarnationId: string,
      title: string,
    ): Awaitable<void>;
    /** 指定したセッション世代のメッセージのブックマーク状態を更新する。 */
    setSessionMessageBookmark?(
      sessionId: string,
      incarnationId: string,
      messageIndex: number,
      isBookmarked: boolean,
    ): Awaitable<void>;
    /** 指定したセッション世代に実行オプションを保存する。 */
    setSessionExecutionOptions?(
      sessionId: string,
      incarnationId: string,
      options: import("../../src-shared/session/session-execution-options.js").SessionExecutionOptions,
    ): Awaitable<void>;
    setSessionAdditionalDirectories?: AwaitableStorageMethods<
      SessionStorageV6,
      "setSessionAdditionalDirectories"
    >["setSessionAdditionalDirectories"];
    /** セッション更新とターンの終端確定をまとめて保存する。 */
    updateTerminalSession?(
      session: Session,
      terminalCommit: SessionTurnTerminalCommit,
    ): Awaitable<Session>;
    /** ターン終端を確定する際、セッションを挿入または更新する。 */
    upsertTerminalSession?(
      session: Session,
      terminalCommit: SessionTurnTerminalCommit,
    ): Awaitable<Session>;
    /** 実行開始に必要なターンと会話の変更を保存し、開始記録の結果を返す。 */
    appendRunningTurnStart?(
      input: SessionRunningTurnStartInput,
    ): Awaitable<SessionRunningTurnStartResult>;
    appendSessionSteer?: AwaitableStorageMethods<
      SessionStorageV6,
      "appendSessionSteer"
    >["appendSessionSteer"];
    beginSessionSteer?: AwaitableStorageMethods<
      SessionStorageV6,
      "beginSessionSteer"
    >["beginSessionSteer"];
    settleSessionSteer?: AwaitableStorageMethods<
      SessionStorageV6,
      "settleSessionSteer"
    >["settleSessionSteer"];
    patchSessionMetadata?: AwaitableStorageMethods<
      SessionStorageV6,
      "patchSessionMetadata"
    >["patchSessionMetadata"];
    promoteSessionToOverallCoordinator?: AwaitableStorageMethods<
      SessionStorageV6,
      "promoteSessionToOverallCoordinator"
    >["promoteSessionToOverallCoordinator"];
    beginSessionLifecycleOperation?: AwaitableStorageMethods<
      SessionStorageV6,
      "beginSessionLifecycleOperation"
    >["beginSessionLifecycleOperation"];
    prepareSessionLifecycleCreation?: AwaitableStorageMethods<
      SessionStorageV6,
      "prepareSessionLifecycleCreation"
    >["prepareSessionLifecycleCreation"];
    advanceSessionLifecycleOperation?: AwaitableStorageMethods<
      SessionStorageV6,
      "advanceSessionLifecycleOperation"
    >["advanceSessionLifecycleOperation"];
    deleteSessionCrewForLifecycle?: AwaitableStorageMethods<
      SessionStorageV6,
      "deleteSessionCrewForLifecycle"
    >["deleteSessionCrewForLifecycle"];
    appendSessionTerminal?: AwaitableStorageMethods<
      SessionStorageV6,
      "appendSessionTerminal"
    >["appendSessionTerminal"];
    checkpointSessionRunMetadata?: AwaitableStorageMethods<
      SessionStorageV6,
      "checkpointSessionRunMetadata"
    >["checkpointSessionRunMetadata"];
    /** Character 作成作業で使ったセッション実行状態を、入力に指定された条件に従って消去する。 */
    clearCharacterAuthoringRuntimeState?(
      input: SessionCharacterAuthoringRuntimeClearInput,
    ): Awaitable<SessionCharacterAuthoringRuntimeClearResult>;
  };
/** セッション一覧で使うピン留め状態の更新契約。 */
export type SessionPinStorage = {
  /** ピン留めの有無を保存し、更新後のセッション要約を返す。 */
  setSessionPinned(
    sessionId: string,
    isPinned: boolean,
  ): Awaitable<SessionSummary>;
};

/** セッションに紐づくファイルのピン留めを列挙・追加・解除する契約。 */
export type SessionFilePinStorage = AwaitableStorageMethods<
  SessionStorageV6,
  "listSessionFilePins" | "pinSessionFile" | "unpinSessionFile"
>;

/**
 * 公開するストレージ境界では、現在の同期 SQLite 実装をそのまま記述せず、
 * 意図的に await できるメソッドを定義する。
 * これにより、呼び出し側を具体的なデータベースクラスに依存させず、
 * ライフサイクルのバンドルを Worker で実装できる。
 */
export type AuxiliarySessionStorageAsyncAccess = AwaitableStorageMethods<
  AuxiliarySessionStorage,
  | "listAllAuxiliarySessions"
  | "listAuxiliarySessions"
  | "listAuxiliarySessionSummaries"
  | "listRunningAuxiliarySessions"
  | "getLatestAuxiliarySession"
  | "getAuxiliarySession"
  | "getAuxiliarySessionMetadata"
  | "appendAuxiliaryRunningTurnStart"
  | "appendAuxiliarySteer"
  | "beginAuxiliarySteer"
  | "settleAuxiliarySteer"
  | "patchAuxiliarySessionMetadata"
  | "appendAuxiliaryTerminal"
  | "checkpointAuxiliaryRuntimeMetadata"
  | "getAuxiliarySessionView"
  | "getLatestAuxiliarySessionView"
  | "getConversationPage"
  | "upsertAuxiliarySession"
  | "updateAuxiliarySessionIfMatches"
  | "updateTerminalAuxiliarySessionIfMatches"
  | "deleteAuxiliarySessionsForParent"
  | "deleteAuxiliarySessionsExceptParents"
  | "getAuxiliaryDraft"
  | "saveAuxiliaryDraft"
  | "consumeAuxiliaryDraft"
  | "getAuxiliarySessionStatus"
  | "getAuxiliarySessionSummary"
  | "listAuxiliaryCredentialThreads"
  | "getAuxiliaryMessageArtifactDetail"
  | "updateAuxiliaryTitleIfMatches"
  | "updateAuxiliaryMessageBookmarkIfMatches"
  | "updateAuxiliaryExecutionOptionsIfMatches"
  | "updateAuxiliaryDisplayAnchorIfMatches"
> &
  Pick<AuxiliarySessionStorage, "close"> &
  Partial<ConversationQueryStore> & {
    /** 対象と一致条件を満たす補助セッションのスレッド情報を更新する。 */
    updateAuxiliarySessionThreadIfMatches?(
      input: import("../auxiliary/auxiliary-session-storage.js").AuxiliarySessionThreadPatchInput,
    ): Awaitable<
      Awaited<
        ReturnType<
          AuxiliarySessionStorage["updateAuxiliarySessionThreadIfMatches"]
        >
      >
    >;
    /** 保存済みの実行状態が条件に一致する補助セッションの実行メタデータを更新する。 */
    updateAuxiliarySessionRuntimeMetadataIfMatches?(
      input: import("../auxiliary/auxiliary-session-storage.js").AuxiliarySessionRuntimeMetadataPatchInput,
    ): Awaitable<
      Awaited<
        ReturnType<
          AuxiliarySessionStorage["updateAuxiliarySessionRuntimeMetadataIfMatches"]
        >
      >
    >;
  };
/** ローカル実装と Worker の双方で使える Character カタログと関連ファイルの操作契約。 */
export type CharacterStorageAsyncAccess = AwaitableStorageMethods<
  CharacterStorage,
  Exclude<keyof CharacterStorage, "close">
> &
  Pick<CharacterStorage, "close">;
/** ローカル実装と Worker の双方で使えるアプリ設定の保存・取得契約。 */
export type AppSettingsStorageAsyncAccess = AwaitableStorageMethods<
  AppSettingsStorage,
  Exclude<keyof AppSettingsStorage, "close">
> &
  Pick<AppSettingsStorage, "close">;
/** ローカル実装と Worker の双方で使える保存済みモデルカタログの操作契約。 */
export type ModelCatalogStorageAsyncAccess = AwaitableStorageMethods<
  ModelCatalogStorage,
  Exclude<keyof ModelCatalogStorage, "close">
> &
  Pick<ModelCatalogStorage, "close">;
/** ローカル実装と Worker の双方で使える Mate の設定・状態・ファイルの操作契約。 */
export type MateStorageAsyncAccess = AwaitableStorageMethods<
  MateStorage,
  Exclude<keyof MateStorage, "close">
> &
  Pick<MateStorage, "close">;

/** セッションターンを作成・更新し、直近のターンを参照できるストアの契約。 */
export type SessionTurnStorageAccess = AwaitableStorageMethods<
  SessionTurnStorageV6,
  "createSessionTurn" | "updateSessionTurn" | "getLatestSessionTurn"
> &
  Pick<SessionTurnStorageV6, "close">;
/** 永続ストアが利用側へ公開する補助セッションの操作契約。 */
export type AuxiliarySessionStorageAccess = AuxiliarySessionStorageAsyncAccess;
/** 永続ストアが利用側へ公開する Character の操作契約。 */
export type CharacterStorageAccess = CharacterStorageAsyncAccess;

/** 起動した各ストア、所有する Worker、および起動時に読み出した初期値をまとめた結果。 */
export type PersistentStoreBundle = {
  modelCatalogStorage: ModelCatalogStorageAsyncAccess;
  characterStorage: CharacterStorageAccess;
  sessionStorage: SessionStorageRead;
  sessionTurnStorage: SessionTurnStorageAccess | null;
  auxiliarySessionStorage: AuxiliarySessionStorageAccess;
  appSettingsStorage: AppSettingsStorageAsyncAccess;
  mateStorage: MateStorageAsyncAccess;
  activeModelCatalog: ModelCatalogSnapshot;
  sessions: Session[];
  storageWorker?: V6StorageWorkerBundle;
};

/** 終了処理に渡せる、初期化途中や一部のストアだけを含むバンドル。 */
export type PersistentStoreBundleLike = {
  [K in keyof Omit<PersistentStoreBundle, "activeModelCatalog" | "sessions">]?:
    Omit<PersistentStoreBundle, "activeModelCatalog" | "sessions">[K] | null;
};

/** DB 世代ごとのストア生成・保守と、再作成時のファイル操作を差し替える依存。 */
type PersistentStoreLifecycleDeps = {
  /** Worker を使わない DB にモデルカタログの保存先を開く。 */
  createModelCatalogStorage(dbPath: string): ModelCatalogStorage;
  /** 対応世代の DB とユーザーデータを使って Character ストアを開く。 */
  createCharacterStorage?(
    dbPath: string,
    userDataPath: string,
  ): CharacterStorageAccess;
  /** V2・V3・V6 と判定されなかった DB でセッションストアを開く。 */
  createSessionStorage(dbPath: string): SessionStorage;
  /** DB から補助セッションストアを生成するための依存。 */
  createAuxiliarySessionStorage?(dbPath: string): AuxiliarySessionStorageAccess;
  /** Worker を使わない DB にアプリ設定の保存先を開く。 */
  createAppSettingsStorage(dbPath: string): AppSettingsStorage;
  /** Worker を使わない DB とユーザーデータから Mate ストアを開く。 */
  createMateStorage(dbPath: string, userDataPath: string): MateStorage;
  /** V2 スキーマの必要な構造を用意する。 */
  ensureV2Schema?(dbPath: string): void;
  /** V3 スキーマの必要な構造を用意する。 */
  ensureV3Schema?(dbPath: string): void;
  /** V6 スキーマを用意するための依存。V6 の通常の起動時は Worker 内で準備する。 */
  ensureV6Schema?(dbPath: string): void;
  /** ストアを閉じる前に呼ぶフック。 */
  onBeforeClose(): void;
  /** Worker を使わない DB の WAL に、終了時の保守処理を行う。 */
  truncateWal(dbPath: string): void;
  /** DB の再作成時に指定された DB または付随ファイルを取り除く。 */
  removeFile(filePath: string): Promise<void>;
  /** DB に対応する外部保存ディレクトリを取り除く。 */
  removeDirectory?(directoryPath: string): Promise<void>;
  /** 対象 DB とユーザーデータを担う V6 Worker のバンドルを生成する。 */
  createV6StorageWorker?(input: {
    dbPath: string;
    userDataPath: string;
  }): V6StorageWorkerBundle;
};

/** 永続ストアを DB 世代に応じて初期化し、所有境界を守って終了・再作成する。 */
export class PersistentStoreLifecycleService {
  /** ストアや Worker の生成、およびファイル保守を担う依存を受け取る。 */
  constructor(private readonly deps: PersistentStoreLifecycleDeps) {}

  /** V6 は Worker に任せ、旧世代は対応する実装を開き、必要な起動時データを返す。 */
  async initialize(
    dbPath: string,
    userDataPath?: string,
  ): Promise<PersistentStoreBundle> {
    // V6 の所有者は既定のファイル名で判定する。
    // スキーマの検証と初期化はストレージ Worker 内で行うため、
    // Main は所有者の判定だけを目的とする同期 V6 接続を開かない。
    const isV6Database = basename(dbPath) === APP_DATABASE_V6_FILENAME;
    const isV3Database = !isV6Database && isValidV3Database(dbPath);
    const isV2Database = !isV6Database && isValidV2Database(dbPath);
    const resolvedUserDataPath = userDataPath ?? dirname(dbPath);
    if (isV3Database) {
      this.deps.ensureV3Schema?.(dbPath);
    } else if (isV2Database) {
      this.deps.ensureV2Schema?.(dbPath);
    }

    const storageWorker = isV6Database
      ? (this.deps.createV6StorageWorker?.({
          dbPath,
          userDataPath: resolvedUserDataPath,
        }) ??
        createV6StorageWorkerBundle({
          dbPath,
          userDataPath: resolvedUserDataPath,
        }))
      : undefined;
    let workerInitial: {
      activeModelCatalog: ModelCatalogSnapshot;
      sessions: Session[];
    } | null = null;
    if (storageWorker) {
      try {
        workerInitial = (await storageWorker.initialize()) as {
          activeModelCatalog: ModelCatalogSnapshot;
          sessions: Session[];
        };
      } catch (error) {
        await storageWorker.client.close().catch(() => undefined);
        throw error;
      }
    }
    const modelCatalogStorage = storageWorker
      ? storageWorker.stores.catalog
      : this.deps.createModelCatalogStorage(dbPath);
    const activeModelCatalog =
      workerInitial?.activeModelCatalog ??
      (await modelCatalogStorage.getCatalog());
    const sessionStorage = storageWorker
      ? storageWorker.stores.session
      : isV3Database
        ? new SessionStorageV3(dbPath, this.v3BlobRootPath(dbPath))
        : isV2Database
          ? new SessionStorageV2(dbPath)
          : this.deps.createSessionStorage(dbPath);
    const sessionTurnStorage = storageWorker ? storageWorker.stores.turn : null;
    const auxiliarySessionStorage = storageWorker
      ? storageWorker.stores.auxiliary
      : new LegacyAuxiliarySessionStorage();
    const characterStorage = storageWorker
      ? storageWorker.stores.character
      : isV3Database ||
          isV2Database ||
          (basename(dbPath) !== APP_DATABASE_V4_FILENAME &&
            basename(dbPath) !== APP_DATABASE_V6_FILENAME)
        ? new LegacyCharacterStorage()
        : (this.deps.createCharacterStorage?.(dbPath, resolvedUserDataPath) ??
          new CharacterStorage(dbPath, resolvedUserDataPath));
    const appSettingsStorage = storageWorker
      ? storageWorker.stores.settings
      : this.deps.createAppSettingsStorage(dbPath);
    const mateStorage = storageWorker
      ? storageWorker.stores.mate
      : this.deps.createMateStorage(dbPath, resolvedUserDataPath);
    await this.recoverActiveMateProfileProjection(mateStorage);
    const sessions =
      workerInitial?.sessions ??
      sessionSummariesToSessions(await sessionStorage.listSessionSummaries());

    return {
      modelCatalogStorage,
      characterStorage,
      sessionStorage,
      sessionTurnStorage,
      auxiliarySessionStorage,
      appSettingsStorage,
      mateStorage,
      activeModelCatalog,
      sessions,
      ...(storageWorker ? { storageWorker } : {}),
    };
  }

  /** 所有者に応じた経路でストアを閉じる。終了時の WAL 保守に失敗しても警告に留める。 */
  async close(
    bundle: PersistentStoreBundleLike,
    dbPath?: string | null,
  ): Promise<void> {
    this.deps.onBeforeClose();

    const stores: Array<ClosableStore | null | undefined> = [
      bundle.modelCatalogStorage,
      bundle.characterStorage,
      bundle.sessionStorage,
      bundle.sessionTurnStorage,
      bundle.auxiliarySessionStorage,
      bundle.appSettingsStorage,
      bundle.mateStorage,
    ];

    if (!bundle.storageWorker) {
      for (const store of stores) {
        store?.close();
      }
    }

    if (bundle.storageWorker) {
      try {
        await bundle.storageWorker.truncateWal();
      } catch (error) {
        console.warn("SQLite WAL truncate failed", error);
      }
      await bundle.storageWorker.client.close();
    } else if (dbPath && basename(dbPath) !== APP_DATABASE_V6_FILENAME) {
      try {
        this.deps.truncateWal(dbPath);
      } catch (error) {
        console.warn("SQLite WAL truncate failed", error);
      }
    }
  }

  /** 既存ストアを閉じ、対象世代の DB・付随ファイルを削除して新しいストアを初期化する。 */
  async recreate(
    dbPath: string,
    bundle: PersistentStoreBundleLike,
    userDataPath?: string,
  ): Promise<PersistentStoreBundle> {
    await this.close(bundle, dbPath);

    await Promise.all([
      this.deps.removeFile(`${dbPath}-wal`),
      this.deps.removeFile(`${dbPath}-shm`),
      this.deps.removeFile(dbPath),
      this.isBlobBackedDatabasePath(dbPath)
        ? this.removeBlobRoot(dbPath)
        : Promise.resolve(),
      this.isCharacterBackedDatabasePath(dbPath)
        ? this.removeCharacterRoot(userDataPath ?? dirname(dbPath))
        : Promise.resolve(),
    ]);

    if (this.isV3DatabasePath(dbPath)) {
      this.deps.ensureV3Schema?.(dbPath);
    } else if (this.isV2DatabasePath(dbPath)) {
      this.deps.ensureV2Schema?.(dbPath);
    }

    return this.initialize(dbPath, userDataPath);
  }

  /** 再作成先のファイル名が V2 用か判定する。スキーマは調べない。 */
  private isV2DatabasePath(dbPath: string): boolean {
    return basename(dbPath) === APP_DATABASE_V2_FILENAME;
  }

  /** 再作成先のファイル名が V3 用か判定する。スキーマは調べない。 */
  private isV3DatabasePath(dbPath: string): boolean {
    return basename(dbPath) === APP_DATABASE_V3_FILENAME;
  }

  /** DB のファイル名から、再作成時に共有の V3 Blob 保存先も消す世代か判定する。 */
  private isBlobBackedDatabasePath(dbPath: string): boolean {
    const databaseFilename = basename(dbPath);
    return (
      databaseFilename === APP_DATABASE_V3_FILENAME ||
      databaseFilename === APP_DATABASE_V4_FILENAME
    );
  }

  /** DB のファイル名から、再作成時に Character ファイルも消す世代か判定する。 */
  private isCharacterBackedDatabasePath(dbPath: string): boolean {
    const databaseFilename = basename(dbPath);
    return (
      databaseFilename === APP_DATABASE_V4_FILENAME ||
      databaseFilename === APP_DATABASE_V6_FILENAME
    );
  }

  /** DB に対応する Blob 保存先を削除する。削除処理が未設定なら再作成を拒否する。 */
  private removeBlobRoot(dbPath: string): Promise<void> {
    if (!this.deps.removeDirectory) {
      throw new Error(
        "Database reset requires access to remove the blob files.",
      );
    }

    return this.deps.removeDirectory(this.v3BlobRootPath(dbPath));
  }

  /** ユーザーデータ側の Character 保存先を削除する。削除処理が未設定なら再作成を拒否する。 */
  private removeCharacterRoot(userDataPath: string): Promise<void> {
    if (!this.deps.removeDirectory) {
      throw new Error(
        "Database reset requires access to remove Character files.",
      );
    }

    return this.deps.removeDirectory(join(userDataPath, "characters"));
  }

  /** DB の隣に置かれる V3 形式の Blob 保存ルートを求める。 */
  private v3BlobRootPath(dbPath: string): string {
    return join(dirname(dbPath), "blobs", "v3");
  }

  /** 対応ストアで有効な Mate プロフィールのファイルを復元し、残存不一致や失敗は警告する。 */
  private async recoverActiveMateProfileProjection(
    mateStorage: MateStorageAsyncAccess,
  ): Promise<void> {
    const recoverFunc = (
      mateStorage as {
        recoverMateProfileFilesFromActiveRevision?: () => Promise<
          MateProfileFileMismatch[]
        >;
      }
    ).recoverMateProfileFilesFromActiveRevision;

    if (typeof recoverFunc !== "function") {
      return;
    }

    try {
      const mismatches = await recoverFunc.call(mateStorage);
      if (mismatches.length > 0) {
        console.warn(
          "Mate profile projection recovery has remaining mismatches",
          {
            count: mismatches.length,
            mismatches,
          },
        );
      }
    } catch (error) {
      console.warn(
        "Mate profile projection recovery failed during initialization",
        error,
      );
    }
  }
}

/** 補助セッションを持たない旧 DB 用の実装。読取では未登録を返し、対応できない保存は拒否する。 */
class LegacyAuxiliarySessionStorage implements AuxiliarySessionStorageAccess {
  /** 旧 DB には補助セッションの実行メタデータがないため null を返す。 */
  getAuxiliarySessionMetadata(): null {
    return null;
  }
  /** V6 が必要な補助ターンの実行開始記録を拒否する。 */
  appendAuxiliaryRunningTurnStart(): never {
    throw new Error("Auxiliary runtime storage requires V6.");
  }
  /** V6 が必要な補助ターンへの追加入力の記録を拒否する。 */
  appendAuxiliarySteer(): never {
    throw new Error("Auxiliary runtime storage requires V6.");
  }
  /** V6 が必要な補助ターンへの追加指示の受付登録を拒否する。 */
  beginAuxiliarySteer(): never {
    throw new Error("Auxiliary runtime storage requires V6.");
  }
  /** V6 が必要な補助ターンへの追加指示の結果保存を拒否する。 */
  settleAuxiliarySteer(): never {
    throw new Error("Auxiliary runtime storage requires V6.");
  }
  /** V6 が必要な補助セッションのメタデータ更新を拒否する。 */
  patchAuxiliarySessionMetadata(): never {
    throw new Error("Auxiliary runtime storage requires V6.");
  }
  /** V6 が必要な補助ターンの終端結果の記録を拒否する。 */
  appendAuxiliaryTerminal(): never {
    throw new Error("Auxiliary runtime storage requires V6.");
  }
  /** V6 が必要な補助セッションの実行メタデータのチェックポイント保存を拒否する。 */
  checkpointAuxiliaryRuntimeMetadata(): never {
    throw new Error("Auxiliary runtime storage requires V6.");
  }
  /** 指定の補助セッションについて、旧 DB では表示データなしとして扱う。 */
  getAuxiliarySessionView(): null {
    return null;
  }
  /** 旧 DB には直近の補助セッションの表示データがないため null を返す。 */
  getLatestAuxiliarySessionView(): null {
    return null;
  }
  /** 旧 DB に補助セッションの会話ページがないことを null で返す。 */
  getConversationPage(): null {
    return null;
  }
  /** 補助セッション本体は旧 DB に存在しないので、空の一覧を返す。 */
  listAllAuxiliarySessions(): AuxiliarySession[] {
    return [];
  }

  /** 対象となる親に紐づいた補助セッションがないことを空の一覧で返す。 */
  listAuxiliarySessions(): AuxiliarySessionSummary[] {
    return [];
  }

  /** 補助セッションの要約は旧 DB に存在しないので、空の一覧を返す。 */
  listAuxiliarySessionSummaries(): AuxiliarySessionSummary[] {
    return [];
  }

  /** 旧 DB からは実行中の補助セッションを読み出せないため、空の一覧を返す。 */
  listRunningAuxiliarySessions(): AuxiliarySessionSummary[] {
    return [];
  }

  /** 旧 DB には直近の補助セッションが存在しないため null を返す。 */
  getLatestAuxiliarySession(): AuxiliarySession | null {
    return null;
  }

  /** 旧 DB では個別の補助セッションも未登録として扱う。 */
  getAuxiliarySession(): AuxiliarySession | null {
    return null;
  }

  /** 旧 DB は補助セッションの下書きを持たないため null を返す。 */
  getAuxiliaryDraft(): null {
    return null;
  }

  /** 旧 DB に補助セッションの状態が保存されていないことを null で返す。 */
  getAuxiliarySessionStatus(): null {
    return null;
  }

  /** 旧 DB に個別の補助セッション要約がないことを null で返す。 */
  getAuxiliarySessionSummary(): null {
    return null;
  }

  /** 旧 DB に補助セッションの認証情報に関わるスレッドがないことを空の一覧で返す。 */
  listAuxiliaryCredentialThreads(): [] {
    return [];
  }

  /** 旧 DB に補助セッションのメッセージ成果物の詳細がないことを null で返す。 */
  getAuxiliaryMessageArtifactDetail(): null {
    return null;
  }

  /** 旧 DB は補助セッションを持たないため、タイトルの条件付き更新を拒否する。 */
  updateAuxiliaryTitleIfMatches(): never {
    throw new Error(
      "Auxiliary Sessions are not available in legacy databases.",
    );
  }

  /** 旧 DB は補助セッションを持たないため、ブックマークの条件付き更新を拒否する。 */
  updateAuxiliaryMessageBookmarkIfMatches(): never {
    throw new Error(
      "Auxiliary Sessions are not available in legacy databases.",
    );
  }

  /** 旧 DB は補助セッションを持たないため、実行オプションの条件付き更新を拒否する。 */
  updateAuxiliaryExecutionOptionsIfMatches(): never {
    throw new Error(
      "Auxiliary Sessions are not available in legacy databases.",
    );
  }

  /** 旧 DB は補助セッションを持たないため、表示位置の条件付き更新を拒否する。 */
  updateAuxiliaryDisplayAnchorIfMatches(): never {
    throw new Error(
      "Auxiliary Sessions are not available in legacy databases.",
    );
  }

  /** 補助セッションの下書きを扱えない旧 DB では保存を拒否する。 */
  saveAuxiliaryDraft(): never {
    throw new Error("Auxiliary drafts are not available in legacy databases.");
  }

  /** 補助セッションの下書きを扱えない旧 DB では取り出しと消去を拒否する。 */
  consumeAuxiliaryDraft(): never {
    throw new Error("Auxiliary drafts are not available in legacy databases.");
  }

  /** 補助セッションを持たない旧 DB では挿入も上書きも拒否する。 */
  upsertAuxiliarySession(): AuxiliarySession {
    throw new Error(
      "Auxiliary Sessions are not available in legacy databases.",
    );
  }

  /** 条件付き更新の対象となる補助セッションが存在しないので、更新せず null を返す。 */
  updateAuxiliarySessionIfMatches(): AuxiliarySession | null {
    return null;
  }

  /** ターン終端を反映できる補助セッションが存在しないので、更新せず null を返す。 */
  updateTerminalAuxiliarySessionIfMatches(): AuxiliarySession | null {
    return null;
  }

  /** 親に紐づく補助セッションは旧 DB にないため、削除するものはない。 */
  deleteAuxiliarySessionsForParent(): void {}

  /** 残す親の指定にかかわらず、旧 DB には孤立した補助セッションはないので何もしない。 */
  deleteAuxiliarySessionsExceptParents(): void {}

  /** 旧 DB 用の補助ストアは接続を持たないため、解放処理は不要。 */
  close(): void {}
}

/** Character カタログのない旧 DB 用の実装。参照は未登録を返し、作成や更新を拒否する。 */
class LegacyCharacterStorage implements CharacterStorageAccess {
  /** 旧 DB には Character カタログがないため空の一覧を返す。 */
  listCharacters(): CharacterCatalogEntry[] {
    return [];
  }

  /** 旧 DB に個別の Character カタログ項目がないことを null で返す。 */
  getCharacterCatalogEntry(): CharacterCatalogEntry | null {
    return null;
  }

  /** 旧 DB では Character の詳細を取得できないため null を返す。 */
  getCharacter(): CharacterDetail | null {
    return null;
  }

  /** Character カタログを持たない旧 DB での新規登録を拒否する。 */
  createCharacter(): CharacterDetail {
    throw new Error(
      "The Character catalog is not available in legacy databases.",
    );
  }

  /** Character カタログを持たない旧 DB でのメタデータ更新を拒否する。 */
  updateCharacterMetadata(): CharacterDetail {
    throw new Error(
      "The Character catalog is not available in legacy databases.",
    );
  }

  /** Character カタログを持たない旧 DB での定義更新を拒否する。 */
  updateCharacterDefinition(): CharacterDetail {
    throw new Error(
      "The Character catalog is not available in legacy databases.",
    );
  }

  /** Character カタログを持たない旧 DB でのアーカイブを拒否する。 */
  archiveCharacter(): CharacterCatalogEntry {
    throw new Error(
      "The Character catalog is not available in legacy databases.",
    );
  }

  /** 旧 DB では起動用の Character を選べないため null を返す。 */
  resolveLaunchCharacter(): CharacterDetail | null {
    return null;
  }

  /** 実行時スナップショットの元になる Character がないため null を返す。 */
  createRuntimeSnapshot(): CharacterRuntimeSnapshot | null {
    return null;
  }

  /** Character 定義が利用できない旧 DB での実行時スナップショット更新を拒否する。 */
  refreshRuntimeSnapshot(): never {
    throw new Error(
      "The Character catalog is not available in legacy databases.",
    );
  }

  /** 旧 DB 用の実装には Character 保存先がないため、パス取得を例外にする。 */
  getCharacterDirectory(): string {
    throw new Error(
      "The Character catalog is not available in legacy databases.",
    );
  }

  /** 旧 DB 用の実装が管理する Character 保存先はないので、ファイルを削除しない。 */
  async deleteCharacterRootDirectory(): Promise<void> {}

  /** 旧 DB 用の Character ストアは解放する接続を持たない。 */
  close(): void {}
}

/** 実際の SQLite ストアとファイル操作を使う永続ストアのライフサイクルサービスを作る。 */
export function createPersistentStoreLifecycleService(): PersistentStoreLifecycleService {
  return new PersistentStoreLifecycleService({
    /** 指定 DB にモデルカタログストアを開く。 */
    createModelCatalogStorage: (dbPath) => new ModelCatalogStorage(dbPath),
    /** DB とユーザーデータの保存先から Character ストアを開く。 */
    createCharacterStorage: (dbPath, userDataPath) =>
      new CharacterStorage(dbPath, userDataPath),
    /** 指定 DB の旧世代向けセッションストアを開く。 */
    createSessionStorage: (dbPath) => new SessionStorage(dbPath),
    /** 指定 DB に補助セッションストアを開く。 */
    createAuxiliarySessionStorage: (dbPath) =>
      new AuxiliarySessionStorage(dbPath),
    /** 指定 DB にアプリ設定ストアを開く。 */
    createAppSettingsStorage: (dbPath) => new AppSettingsStorage(dbPath),
    /** DB とユーザーデータから Mate の設定・ファイルを扱うストアを開く。 */
    createMateStorage: (dbPath, userDataPath) =>
      new MateStorage(dbPath, userDataPath),
    /** V2 のスキーマ文を実行し、結果にかかわらず準備用接続を閉じる。 */
    ensureV2Schema: (dbPath) => {
      const db = openAppDatabase(dbPath);
      try {
        for (const statement of CREATE_V2_SCHEMA_SQL) {
          db.exec(statement);
        }
      } finally {
        db.close();
      }
    },
    /** V3 のスキーマ文を実行し、結果にかかわらず準備用接続を閉じる。 */
    ensureV3Schema: (dbPath) => {
      const db = openAppDatabase(dbPath);
      try {
        for (const statement of CREATE_V3_SCHEMA_SQL) {
          db.exec(statement);
        }
      } finally {
        db.close();
      }
    },
    /** V6 のスキーマ準備用接続を開き、スキーマの適用後または失敗時に閉じる。 */
    ensureV6Schema: (dbPath) => {
      const db = openAppDatabase(dbPath);
      try {
        ensureV6Schema(db);
      } finally {
        db.close();
      }
    },
    /** 既定の構成ではストア終了前の追加処理は行わない。 */
    onBeforeClose: () => {},
    truncateWal: truncateAppDatabaseWal,
    /** DB または付随ファイルを削除する。既になければ処理を続ける。 */
    removeFile: async (filePath) => {
      await rm(filePath, { force: true });
    },
    /** DB に付随する保存先とその内容を削除する。既になければ処理を続ける。 */
    removeDirectory: async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true });
    },
  });
}
