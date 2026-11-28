import {
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import { CurrentExecutionSelections } from "../session/current-execution-selections.js";
import type { AppDatabaseDiagnostics } from "../../src-shared/window/app-database-diagnostics-state.js";
import type { MateProfileItemStorage } from "../mate/mate-profile-item-storage.js";
import type { PromptTemplateStorage } from "../prompt-templates/prompt-template-storage.js";
import type { V6StorageWorkerBundle } from "../storage/storage-worker-bundle.js";
import type {
  SessionTurnStorageAccess,
  AuxiliarySessionStorageAccess,
  CharacterStorageAccess,
  PersistentStoreBundle,
  PersistentStoreBundleLike,
  SessionStorageRead,
} from "../storage/persistent-store-lifecycle-service.js";

/** 稼働中の永続ストアの世代と、そのライフサイクル状態を管理する。 */
export class MainStoreContext {
  readonly executionSelections = new CurrentExecutionSelections();
  private state: {
    sessions: Session[];
    owner: PersistentStoreBundle | null;
    sessionStorage: SessionStorageRead | null;
    modelCatalogStorage: PersistentStoreBundle["modelCatalogStorage"] | null;
    characterStorage: CharacterStorageAccess | null;
    sessionTurnStorage: SessionTurnStorageAccess | null;
    auxiliarySessionStorage: AuxiliarySessionStorageAccess | null;
    appSettingsStorage: PersistentStoreBundle["appSettingsStorage"] | null;
    storageWorker: V6StorageWorkerBundle | null;
    promptTemplateStorage:
      PromptTemplateStorage | V6StorageWorkerBundle["stores"]["prompt"] | null;
    mateStorage: PersistentStoreBundle["mateStorage"] | null;
    mateProfileItemStorage: MateProfileItemStorage | null;
    dbPath: string;
    diagnostics: AppDatabaseDiagnostics | null;
    walTimer: ReturnType<typeof setInterval> | null;
  } = {
    sessions: [],
    owner: null,
    sessionStorage: null,
    modelCatalogStorage: null,
    characterStorage: null,
    sessionTurnStorage: null,
    auxiliarySessionStorage: null,
    appSettingsStorage: null,
    storageWorker: null,
    promptTemplateStorage: null,
    mateStorage: null,
    mateProfileItemStorage: null,
    dbPath: "",
    diagnostics: null,
    walTimer: null,
  };

  /** 現在の実行時選択を反映した Session の一覧。 */
  public get sessions() {
    return this.state.sessions;
  }
  /** 有効な永続ストアの所有者。未稼働または終了処理中は null。 */
  public get activePersistentStoreOwner() {
    return this.state.owner;
  }
  /** 稼働中の Session 読み取り口。 */
  public get sessionStorage() {
    return this.state.sessionStorage;
  }
  /** 稼働中のモデルカタログの保存口。 */
  public get modelCatalogStorage() {
    return this.state.modelCatalogStorage;
  }
  /** 稼働中の Character の保存口。 */
  public get characterStorage() {
    return this.state.characterStorage;
  }
  /** 稼働中の Session Turn の保存口。 */
  public get sessionTurnStorage() {
    return this.state.sessionTurnStorage;
  }
  /** 稼働中の Auxiliary Session の保存口。 */
  public get auxiliarySessionStorage() {
    return this.state.auxiliarySessionStorage;
  }
  /** 稼働中のアプリ設定の保存口。 */
  public get appSettingsStorage() {
    return this.state.appSettingsStorage;
  }
  /** 現在のストアを担う Worker。Worker がなければ null。 */
  public get storageWorker() {
    return this.state.storageWorker;
  }
  /** 現在のプロンプトテンプレートの保存口。Worker 経由と直接アクセスの両方に対応する。 */
  public get promptTemplateStorage() {
    return this.state.promptTemplateStorage;
  }
  /** 稼働中の Mate の保存口。 */
  public get mateStorage() {
    return this.state.mateStorage;
  }
  /** Worker を介さない場合に別途管理する Mate プロフィール項目の保存口。 */
  public get mateProfileItemStorage() {
    return this.state.mateProfileItemStorage;
  }
  /** データベースの現在のパス。未設定の場合は空文字列。 */
  public get dbPath() {
    return this.state.dbPath;
  }
  /** 現在保持しているデータベースの診断情報。 */
  public get appDatabaseDiagnostics() {
    return this.state.diagnostics;
  }
  /** 予約中の WAL メンテナンスのタイマー。 */
  public get walMaintenanceTimer() {
    return this.state.walTimer;
  }

  /** WAL メンテナンスと終了処理が参照するデータベースパスを設定する。 */
  public setDbPath(value: string): void {
    this.state.dbPath = value;
  }
  /** 参照用のデータベース診断情報を差し替える。 */
  public setDatabaseDiagnostics(value: AppDatabaseDiagnostics | null): void {
    this.state.diagnostics = value;
  }
  /** 消えた Session や世代が変わった Session の実行時選択を破棄し、現行一覧に残る選択を反映する。 */
  public setSessions(value: Session[]): void {
    const nextById = new Map(value.map((session) => [session.id, session]));
    for (const previous of this.state.sessions) {
      const next = nextById.get(previous.id);
      if (
        !next ||
        getSessionIncarnationId(next) !== getSessionIncarnationId(previous)
      ) {
        this.executionSelections.forgetParent(previous.id);
      }
    }
    this.executionSelections.retainParents(value);
    this.state.sessions = value.map((session) =>
      this.executionSelections.apply(session),
    );
  }
  /** 有効な所有者への参照だけを差し替える。各ストアの接続は切り替えない。 */
  public setActivePersistentStoreOwner(
    value: PersistentStoreBundle | null,
  ): void {
    this.state.owner = value;
  }
  /** WAL メンテナンスのタイマー参照を記録する。 */
  public setWalMaintenanceTimer(
    value: ReturnType<typeof setInterval> | null,
  ): void {
    this.state.walTimer = value;
  }
  /** 既存のタイマーを止めて定期処理を設定し、パス未設定時と直前の処理が実行中のときは更新を見送る。 */
  public startWalMaintenance(
    truncate: (
      owner: V6StorageWorkerBundle | null,
      dbPath: string,
    ) => Promise<void>,
    intervalMs: number,
  ): void {
    this.stopWalMaintenance();
    let pending = false;
    this.state.walTimer = setInterval(() => {
      if (!this.state.dbPath || pending) return;
      pending = true;
      void truncate(this.state.storageWorker, this.state.dbPath)
        .catch((error) => {
          console.warn("SQLite WAL maintenance failed", error);
        })
        .finally(() => {
          pending = false;
        });
    }, intervalMs);
    this.state.walTimer.unref?.();
  }
  /** WAL メンテナンスの再実行を止め、タイマー参照を解除する。 */
  public stopWalMaintenance(): void {
    if (!this.state.walTimer) return;
    clearInterval(this.state.walTimer);
    this.state.walTimer = null;
  }
  /** 所有者とタイマーを先に無効化し、Worker の有無に応じてストアを閉じてから保持参照を解除する。 */
  public async close(
    lifecycleClose: (
      bundle: PersistentStoreBundleLike,
      dbPath: string,
    ) => Promise<void>,
  ): Promise<void> {
    const worker = this.state.storageWorker;
    this.state.owner = null;
    this.stopWalMaintenance();
    if (!worker) {
      await this.state.promptTemplateStorage?.close();
      await this.state.mateProfileItemStorage?.close();
    }
    await lifecycleClose(
      {
        storageWorker: worker,
        modelCatalogStorage: this.state.modelCatalogStorage,
        characterStorage: this.state.characterStorage,
        sessionStorage: this.state.sessionStorage,
        sessionTurnStorage: this.state.sessionTurnStorage,
        auxiliarySessionStorage: this.state.auxiliarySessionStorage,
        appSettingsStorage: this.state.appSettingsStorage,
        mateStorage: this.state.mateStorage,
      },
      this.state.dbPath,
    );
    this.clearReferences();
  }
  /** プロンプトテンプレートの保存口を差し替える。 */
  public setPromptTemplateStorage(
    value:
      PromptTemplateStorage | V6StorageWorkerBundle["stores"]["prompt"] | null,
  ): void {
    this.state.promptTemplateStorage = value;
  }
  /** 直接管理する Mate プロフィール項目の保存口を差し替える。 */
  public setMateProfileItemStorage(value: MateProfileItemStorage | null): void {
    this.state.mateProfileItemStorage = value;
  }
  /** Character の保存口を差し替える。 */
  public setCharacterStorage(value: CharacterStorageAccess | null): void {
    this.state.characterStorage = value;
  }

  /** 実行時選択を消去し、新しい所有者のストアと Session 一覧を有効にする。 */
  public activate(bundle: PersistentStoreBundle): void {
    this.executionSelections.clear();
    this.state.owner = bundle;
    this.state.storageWorker = bundle.storageWorker ?? null;
    this.state.promptTemplateStorage =
      this.state.storageWorker?.stores.prompt ?? null;
    this.state.mateProfileItemStorage = null;
    this.state.modelCatalogStorage = bundle.modelCatalogStorage;
    this.state.characterStorage = bundle.characterStorage;
    this.state.sessionStorage = bundle.sessionStorage;
    this.state.sessionTurnStorage = bundle.sessionTurnStorage;
    this.state.auxiliarySessionStorage = bundle.auxiliarySessionStorage;
    this.state.appSettingsStorage = bundle.appSettingsStorage;
    this.state.mateStorage = bundle.mateStorage;
    this.state.sessions = bundle.sessions;
  }

  /** パスと診断情報を残し、ストア・タイマー参照と Session 一覧、実行時選択を破棄する。 */
  public clearReferences(): void {
    this.executionSelections.clear();
    this.state = {
      ...this.state,
      sessions: [],
      owner: null,
      sessionStorage: null,
      modelCatalogStorage: null,
      characterStorage: null,
      sessionTurnStorage: null,
      auxiliarySessionStorage: null,
      appSettingsStorage: null,
      storageWorker: null,
      promptTemplateStorage: null,
      mateStorage: null,
      mateProfileItemStorage: null,
      walTimer: null,
    };
  }
}
