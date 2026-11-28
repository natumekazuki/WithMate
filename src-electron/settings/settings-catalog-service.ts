import { currentTimestampLabel } from "../../src-shared/time-state.js";
import {
  getProviderAppSettings,
  normalizeAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import {
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
} from "../../src-shared/window/withmate-window-types.js";
import type {
  ResetAppDatabaseRequest,
  ResetAppDatabaseResult,
  ResetAppDatabaseTarget,
} from "../../src-shared/window/withmate-window-types.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";
import type { SessionThreadPatchInput } from "../session/session-storage-v6.js";
import type { AuxiliarySessionThreadPatchInput } from "../auxiliary/auxiliary-session-storage.js";
import {
  isChatLayoutPreferenceUpdate,
  type ChatLayoutPreference,
  type ChatLayoutPreferenceUpdate,
} from "../../src-shared/settings/chat-layout-preference.js";

/** 認証変更の対象判定と条件付きスレッド更新に必要な Main Session の保存情報。 */
export type SessionCredentialThreadInfo = {
  id: string;
  incarnationId: string;
  provider: string;
  threadId: string;
  status: string;
  runState: string;
};

/** 認証変更で照合する Auxiliary の所属・作成時刻・実行状態と現在のスレッド。 */
export type AuxiliaryCredentialThreadInfo = {
  id: string;
  parentSessionId: string;
  createdAt: string;
  provider: string;
  threadId: string;
  runState: string;
};

/** 設定の保存、プロバイダーの実行制御、リセットと各画面への通知をつなぐ操作。 */
export type SettingsCatalogServiceDeps = {
  /** 遅延実行する操作が使うストレージの所有者と世代を捕捉する。 */
  captureStorageIdentity?: () => unknown;
  /** ストレージの所有者または世代が置き換えられていれば false を返す。 */
  isStorageIdentityCurrent?: (identity: unknown) => boolean;
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  /** 現在進行中の Session 実行があるか調べ、データベースをリセットできるかの判定に使う。 */
  hasInFlightSessionRuns(): boolean;
  /** 認証情報を変更するプロバイダーの特定 Session が実行中か確認する。 */
  isSessionRunInFlight(sessionId: string): boolean;
  /** 保存されている Main Session がリセットを阻害する実行状態か判定する。 */
  isRunningSession(session: Session): boolean;
  /** リセットの前後で Main Session を列挙し、削除対象と更新後の結果を求める。 */
  listSessions(): Awaitable<Session[]>;
  /** Session リセットで閉じる必要がある Auxiliary の通知を特定するために一覧を読む。 */
  listAuxiliarySessions(): Awaitable<AuxiliarySession[]>;
  /** 認証が変わるプロバイダーの稼働確認とスレッド更新に必要な Main の項目だけを読む。 */
  listSessionCredentialThreads(): Awaitable<SessionCredentialThreadInfo[]>;
  /** 認証が変わるプロバイダーの稼働確認とスレッド更新に必要な Auxiliary の項目だけを読む。 */
  listAuxiliaryCredentialThreads(): Awaitable<AuxiliaryCredentialThreadInfo[]>;
  /** 保存されたアプリ設定を読み、通常設定の更新・ロールバックの比較にも使う。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** 通常のアプリ設定を保存する。最新のチャットレイアウトはこの一括更新で上書きしない。 */
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  /** チャットレイアウトで指定された単一項目を保存する。 */
  updateChatLayoutPreference(
    update: ChatLayoutPreferenceUpdate,
  ): Awaitable<void>;
  /** 非同期のレイアウト保存に失敗した場合に、対象項目とエラーを診断へ渡す。 */
  onChatLayoutPreferenceSaveError?(
    update: ChatLayoutPreferenceUpdate,
    error: unknown,
  ): void;
  /** 対象プロバイダーの後処理が終わり、新規 Turn を再開できることを知らせる。 */
  onProviderTurnAvailable?(providerId: string): void;
  /** 部分リセット後に返す現在のモデル一覧を取得する。 */
  getModelCatalog(): Awaitable<ModelCatalogSnapshot>;
  /** Session の保存集合を指定の内容で置き換える。リセットでは空にし、途中の一斉通知を抑える。 */
  replaceAllSessions(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Awaitable<Session[]>;
  /** Main の識別情報と期待する旧スレッドが一致した場合だけ、スレッド参照を更新する。 */
  updateSessionThreadIfMatches(
    input: SessionThreadPatchInput,
  ): Awaitable<Pick<Session, "id" | "threadId"> | null>;
  /** Auxiliary の識別情報・親・作成時刻と期待する旧スレッドを照合して参照を更新する。 */
  updateAuxiliarySessionThreadIfMatches(
    input: AuxiliarySessionThreadPatchInput,
  ): Awaitable<Pick<
    AuxiliarySession,
    "id" | "parentSessionId" | "threadId"
  > | null>;
  /** 認証が変わるプロバイダーの古い利用枠観測値を取り除く。 */
  clearProviderQuotaTelemetry(providerId: string): void;
  /** 対象 Session の古い会話コンテキストの観測値を取り除く。 */
  clearSessionContextTelemetry(sessionId: string): void;
  /** 保存済みスレッド参照を切り替えた後、対象プロバイダー側で保持するスレッドを無効化する。 */
  invalidateProviderSessionThread(
    providerId: string | null | undefined,
    sessionId: string,
  ): Awaitable<void>;
  /** アプリ設定だけを初期値へ戻し、保存した値を返す。 */
  resetAppSettings(): Awaitable<AppSettings>;
  /** Session を消去した後、ランタイムが保有する実行状態を初期化する。 */
  resetSessionRuntime(): void;
  /** 設定のリセットに伴い、全プロバイダーの利用枠観測値を取り除く。 */
  clearAllProviderQuotaTelemetry(): void;
  /** 全体リセットで、すべての Session の会話コンテキストの観測値を取り除く。 */
  clearAllSessionContextTelemetry(): void;
  /** Session またはデータベース全体のリセット後、すべてのプロバイダー側のスレッドを無効化する。 */
  invalidateAllProviderSessionThreads(): Awaitable<void>;
  /** Session データをリセットする場合に、対応する会話・関連ウィンドウを閉じる。 */
  closeResetTargetWindows(): void;
  /** 消去した Session に残っていた Turn 通知を取り消す。 */
  dismissSessionTurnNotification(sessionId: string): void;
  /** 全対象リセット時のデータベース再作成を永続ストアへ委譲し、新しいモデル一覧を受け取る。 */
  recreateDatabaseFile(): Promise<ModelCatalogSnapshot>;
  applyAppSettingsSideEffects?: (settings: AppSettings) => void;
  /** 保存した Session の変更範囲を、概要を再取得する画面へ通知する。 */
  broadcastSessions(sessionIds?: Iterable<string>): void;
  /** 設定保存、復旧、リセット後に表示へ反映する設定を通知する。 */
  broadcastAppSettings(settings?: AppSettings): Awaitable<void>;
  /** リセット後に有効なモデル一覧を購読側へ通知する。 */
  broadcastModelCatalog(
    snapshot?: ModelCatalogSnapshot | null,
  ): Awaitable<void>;
};

/** 新旧設定に現れるプロバイダーを集め、空白を除いた API キーが変わったものだけを返す。 */
function getProvidersWithApiKeyChange(
  previousSettings: AppSettings,
  nextSettings: AppSettings,
): string[] {
  const providerIds = new Set<string>([
    ...Object.keys(previousSettings.codingProviderSettings),
    ...Object.keys(nextSettings.codingProviderSettings),
  ]);

  return Array.from(providerIds).filter(
    (providerId) =>
      getProviderAppSettings(previousSettings, providerId).apiKey.trim() !==
      getProviderAppSettings(nextSettings, providerId).apiKey.trim(),
  );
}

/** 排他保存と、保存後に実行するプロバイダー側の後処理・失敗時の復旧を分けて保持する。 */
type DeferredProviderCleanup<T> = {
  value: T;
  /** プロバイダーの実行スレッドを無効化するなど、排他保存の外で待つ処理。 */
  cleanup(): Promise<void>;
  /** 後処理に失敗した場合に、他の更新を巻き戻さない条件付きで設定と参照を戻す。 */
  rollback(): Promise<void>;
  affectedProviders: readonly string[];
};

/** アプリ設定の保存、認証変更に伴う実行停止条件、非同期レイアウト保存、データリセットを調停する。 */
export class SettingsCatalogService {
  private readonly affectedProviders = new Map<string, number>();
  private chatLayoutCurrent: Partial<ChatLayoutPreference> = {};
  private chatLayoutWriteTail: Promise<void> = Promise.resolve();
  private rollbackEpoch = 0;

  /** 設定・Session の永続化、プロバイダー制御と UI 通知の接続を保持する。 */
  constructor(private readonly deps: SettingsCatalogServiceDeps) {}

  /** 遅延処理を開始した時点のストレージ世代を捕捉する。照合機能がない依存では未指定のまま扱う。 */
  private captureStorageIdentity(): unknown {
    return this.deps.captureStorageIdentity?.();
  }

  /** ストレージが置き換えられていれば、古い保存操作のロールバックを拒否する。 */
  private assertStorageIdentityCurrent(identity: unknown): void {
    if (
      this.deps.isStorageIdentityCurrent &&
      !this.deps.isStorageIdentityCurrent(identity)
    ) {
      throw new Error("Saved data changed, so deferred rollback was canceled.");
    }
  }

  /** 開始後にリセットが進んでいたら、同じストレージ世代でもロールバックを拒否する。 */
  private assertRollbackEpochCurrent(epoch: number): void {
    if (epoch !== this.rollbackEpoch) {
      throw new Error("Rollback was canceled because a reset started.");
    }
  }

  /** プロバイダーの後処理が一つ増えたことを記録し、新規 Turn の開始を止める。 */
  private acquireProvider(providerId: string): void {
    this.affectedProviders.set(
      providerId,
      (this.affectedProviders.get(providerId) ?? 0) + 1,
    );
  }

  /** プロバイダーの後処理を一つ解放し、最後の処理が終わったときだけ再開を通知する。 */
  private releaseProvider(providerId: string): void {
    const count = this.affectedProviders.get(providerId) ?? 0;
    if (count <= 1) {
      this.affectedProviders.delete(providerId);
      try {
        this.deps.onProviderTurnAvailable?.(providerId);
      } catch (error) {
        console.warn("Provider turn availability notification failed", error);
      }
    } else {
      this.affectedProviders.set(providerId, count - 1);
    }
  }

  /** 認証変更の後処理が続いているプロバイダーで、次の Turn を始めようとした要求を拒否する。 */
  assertProviderAvailableForTurn(providerId: string): void {
    if (!this.isProviderAvailableForTurn(providerId)) {
      throw new Error(
        "A provider settings update is in progress. Wait for it to finish before starting a new session.",
      );
    }
  }

  /** 対象プロバイダーに未完了の設定変更後処理がないか判定する。 */
  isProviderAvailableForTurn(providerId: string): boolean {
    return (this.affectedProviders.get(providerId) ?? 0) === 0;
  }

  /** 保存済み設定に、この世代で受け付けた最新のチャットレイアウトを重ねて返す。 */
  async getAppSettings(): Promise<AppSettings> {
    return this.withCurrentChatLayout(await this.deps.getAppSettings());
  }

  /** 設定の残りの項目はそのまま、レイアウト項目だけをメモリー上の最新値で補う。 */
  private withCurrentChatLayout(settings: AppSettings): AppSettings {
    return {
      ...settings,
      chatLayoutPreference: {
        ...settings.chatLayoutPreference,
        ...this.chatLayoutCurrent,
      },
    };
  }

  /** レイアウトの入力を検証して現在値へ即時反映し、世代とリセットを照合してから保存を直列実行する。 */
  updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): void {
    if (!isChatLayoutPreferenceUpdate(update)) {
      throw new TypeError("Invalid chat layout preference update.");
    }
    this.chatLayoutCurrent = {
      ...this.chatLayoutCurrent,
      [update.target]: update.value,
    };
    const epoch = this.rollbackEpoch;
    const storageIdentity = this.captureStorageIdentity();
    const write = this.chatLayoutWriteTail.then(() => {
      if (
        epoch !== this.rollbackEpoch ||
        (this.deps.isStorageIdentityCurrent &&
          !this.deps.isStorageIdentityCurrent(storageIdentity))
      )
        return;
      return this.deps.updateChatLayoutPreference(update);
    });
    this.chatLayoutWriteTail = write.then(
      () => {},
      (error: unknown) => {
        try {
          this.deps.onChatLayoutPreferenceSaveError?.(update, error);
        } catch {
          // 診断の失敗によって、後続の設定チェックポイントへの処理を妨げない。
        }
      },
    );
  }

  /** 通常設定を排他保存し、後処理を待つ。失敗時は条件付きで戻し、成否を問わず開始制限を解放する。 */
  async updateAppSettings(
    nextSettingsInput: AppSettings,
  ): Promise<AppSettings> {
    const operation = await this.deps.runProviderRuntimeOperationExclusive(() =>
      this.updateAppSettingsExclusive(nextSettingsInput),
    );
    try {
      await operation.cleanup();
      return operation.value;
    } catch (error) {
      try {
        await this.deps.runProviderRuntimeOperationExclusive(() =>
          operation.rollback(),
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "App settings cleanup rollback failed.",
        );
      }
      throw error;
    } finally {
      for (const providerId of operation.affectedProviders) {
        this.releaseProvider(providerId);
      }
    }
  }

  /** 認証変更先に実行中の Session がないことを確認し、設定と一致するスレッド参照を更新して後処理を組み立てる。 */
  private async updateAppSettingsExclusive(
    nextSettingsInput: AppSettings,
  ): Promise<DeferredProviderCleanup<AppSettings>> {
    const previousSettings = await this.deps.getAppSettings();
    const storageIdentity = this.captureStorageIdentity();
    const rollbackEpoch = this.rollbackEpoch;
    const nextSettings = normalizeAppSettings(nextSettingsInput);
    const providersWithApiKeyChange = getProvidersWithApiKeyChange(
      previousSettings,
      nextSettings,
    );
    const previousSessions =
      providersWithApiKeyChange.length > 0
        ? await this.deps.listSessionCredentialThreads()
        : [];
    const previousAuxiliarySessions =
      providersWithApiKeyChange.length > 0
        ? await this.deps.listAuxiliaryCredentialThreads()
        : [];

    if (providersWithApiKeyChange.length > 0) {
      const hasBlockedSession = previousSessions.some(
        (session) =>
          providersWithApiKeyChange.includes(session.provider) &&
          (this.deps.isSessionRunInFlight(session.id) ||
            session.status === "running" ||
            session.runState === "running"),
      );
      const hasBlockedAuxiliary = previousAuxiliarySessions.some(
        (session) =>
          providersWithApiKeyChange.includes(session.provider) &&
          (this.deps.isSessionRunInFlight(session.id) ||
            session.runState === "running"),
      );
      if (hasBlockedSession || hasBlockedAuxiliary) {
        throw new Error(
          "A session is using the provider whose Coding Agent credentials are changing. Wait for it to finish.",
        );
      }
    }

    const providersWithApiKeyChangeSet = new Set(providersWithApiKeyChange);
    const sessionThreadResetTargets = previousSessions.filter(
      (session) =>
        providersWithApiKeyChangeSet.has(session.provider) && session.threadId,
    );
    const auxiliaryThreadResetTargets = previousAuxiliarySessions.filter(
      (session) =>
        providersWithApiKeyChangeSet.has(session.provider) && session.threadId,
    );
    const appliedSessionPatches: Array<{
      previous: SessionCredentialThreadInfo;
      current: Pick<Session, "id" | "threadId">;
    }> = [];
    const appliedAuxiliaryPatches: Array<{
      previous: AuxiliaryCredentialThreadInfo;
      current: Pick<AuxiliarySession, "id" | "parentSessionId" | "threadId">;
    }> = [];
    const updateSessionThreadIfMatches = this.deps.updateSessionThreadIfMatches;
    const updateAuxiliarySessionThreadIfMatches =
      this.deps.updateAuxiliarySessionThreadIfMatches;

    let savedSettings: AppSettings | null = null;
    try {
      savedSettings = await this.deps.updateAppSettings(nextSettings);
      for (const providerId of providersWithApiKeyChange) {
        this.deps.clearProviderQuotaTelemetry(providerId);
      }
      for (const session of previousSessions) {
        if (providersWithApiKeyChangeSet.has(session.provider)) {
          this.deps.clearSessionContextTelemetry(session.id);
        }
      }
      for (const session of previousAuxiliarySessions) {
        if (providersWithApiKeyChangeSet.has(session.provider)) {
          this.deps.clearSessionContextTelemetry(session.id);
        }
      }
      for (const previous of sessionThreadResetTargets) {
        const current = await updateSessionThreadIfMatches({
          sessionId: previous.id,
          incarnationId: previous.incarnationId,
          provider: previous.provider,
          expectedThreadId: previous.threadId,
          nextThreadId: "",
          updatedAt: currentTimestampLabel(),
        });
        if (current) {
          appliedSessionPatches.push({ previous, current });
        }
      }
      for (const previous of auxiliaryThreadResetTargets) {
        const current = await updateAuxiliarySessionThreadIfMatches({
          auxiliarySessionId: previous.id,
          parentSessionId: previous.parentSessionId,
          provider: previous.provider,
          expectedThreadId: previous.threadId,
          nextThreadId: "",
          updatedAt: currentTimestampLabel(),
          createdAt: previous.createdAt,
        });
        if (current) {
          appliedAuxiliaryPatches.push({ previous, current });
        }
      }
      if (
        appliedSessionPatches.length > 0 ||
        appliedAuxiliaryPatches.length > 0
      ) {
        this.deps.broadcastSessions(
          new Set([
            ...appliedSessionPatches.map(({ current }) => current.id),
            ...appliedAuxiliaryPatches.map(
              ({ current }) => current.parentSessionId,
            ),
          ]),
        );
      }
      const currentSettings = await this.getAppSettings();
      await this.deps.broadcastAppSettings(currentSettings);
      const cleanupTargets = [
        ...previousSessions.filter((session) =>
          providersWithApiKeyChangeSet.has(session.provider),
        ),
        ...previousAuxiliarySessions.filter((session) =>
          providersWithApiKeyChangeSet.has(session.provider),
        ),
      ];
      const affectedProviders = Array.from(providersWithApiKeyChangeSet);
      for (const providerId of affectedProviders) {
        this.acquireProvider(providerId);
      }
      return {
        value: currentSettings,
        affectedProviders,
        /** 認証情報が変わったプロバイダーについて、対象 Session の既存スレッドを無効化する。 */
        cleanup: async () => {
          for (const session of cleanupTargets) {
            await this.deps.invalidateProviderSessionThread(
              session.provider,
              session.id,
            );
          }
        },
        /** 世代・リセット・保存済み設定の一致を確認し、今回保存した設定と一致するスレッド参照だけを元へ戻す。 */
        rollback: async () => {
          this.assertRollbackEpochCurrent(rollbackEpoch);
          this.assertStorageIdentityCurrent(storageIdentity);
          const current = await this.deps.getAppSettings();
          if (JSON.stringify(current) !== JSON.stringify(savedSettings)) {
            throw new Error(
              "App settings changed concurrently after cleanup, so rollback was canceled.",
            );
          }
          await this.deps.updateAppSettings(previousSettings);
          for (const { previous, current: applied } of appliedSessionPatches) {
            await updateSessionThreadIfMatches({
              sessionId: previous.id,
              incarnationId: previous.incarnationId,
              provider: previous.provider,
              expectedThreadId: applied.threadId,
              nextThreadId: previous.threadId,
              updatedAt: currentTimestampLabel(),
            });
          }
          for (const {
            previous,
            current: applied,
          } of appliedAuxiliaryPatches) {
            await updateAuxiliarySessionThreadIfMatches({
              auxiliarySessionId: previous.id,
              parentSessionId: previous.parentSessionId,
              provider: previous.provider,
              expectedThreadId: applied.threadId,
              nextThreadId: previous.threadId,
              updatedAt: currentTimestampLabel(),
              createdAt: previous.createdAt,
            });
          }
          this.deps.broadcastSessions(
            new Set([
              ...appliedSessionPatches.map(({ previous }) => previous.id),
              ...appliedAuxiliaryPatches.map(
                ({ previous }) => previous.parentSessionId,
              ),
            ]),
          );
          await this.deps.broadcastAppSettings(
            this.withCurrentChatLayout(previousSettings),
          );
        },
      };
    } catch (error) {
      if (!savedSettings) {
        throw error;
      }

      try {
        this.assertRollbackEpochCurrent(rollbackEpoch);
        this.assertStorageIdentityCurrent(storageIdentity);
        await this.deps.updateAppSettings(previousSettings);
        for (const { previous, current } of appliedSessionPatches) {
          await updateSessionThreadIfMatches({
            sessionId: previous.id,
            incarnationId: previous.incarnationId,
            provider: previous.provider,
            expectedThreadId: current.threadId,
            nextThreadId: previous.threadId,
            updatedAt: currentTimestampLabel(),
          });
        }
        for (const { previous, current } of appliedAuxiliaryPatches) {
          await updateAuxiliarySessionThreadIfMatches({
            auxiliarySessionId: previous.id,
            parentSessionId: previous.parentSessionId,
            provider: previous.provider,
            expectedThreadId: current.threadId,
            nextThreadId: previous.threadId,
            updatedAt: currentTimestampLabel(),
            createdAt: previous.createdAt,
          });
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "App settings rollback failed.",
        );
      }

      throw error;
    }
  }

  /** プロバイダーの実行設定変更と同じ排他経路で、指定されたデータのリセットを実行する。 */
  async resetAppDatabase(
    request?: ResetAppDatabaseRequest | null,
  ): Promise<ResetAppDatabaseResult> {
    return this.deps.runProviderRuntimeOperationExclusive(() =>
      this.resetAppDatabaseExclusive(request),
    );
  }

  /** 実行中はリセットを拒否し、対象に応じて一部のデータを消去するか DB を再作成して現在の状態を通知する。 */
  private async resetAppDatabaseExclusive(
    request?: ResetAppDatabaseRequest | null,
  ): Promise<ResetAppDatabaseResult> {
    const sessions = await this.deps.listSessions();
    if (
      this.deps.hasInFlightSessionRuns() ||
      sessions.some((session) => this.deps.isRunningSession(session))
    ) {
      throw new Error(
        "The database cannot be reset while a session is running. Complete or cancel it first.",
      );
    }

    const previousSessionIds = sessions.map((session) => session.id);
    const resetTargets = normalizeResetAppDatabaseTargets(request?.targets);
    if (resetTargets.length === 0) {
      throw new Error("Select at least one reset target.");
    }
    // リセットを検証した後、最初のリセット変更の直前にだけ、
    // 遅延ロールバックを無効化する。アプリ設定だけの ABA もこれで扱う。
    this.rollbackEpoch += 1;
    const previousAuxiliarySessionIds = resetTargets.includes("sessions")
      ? (await this.deps.listAuxiliarySessions()).map((session) => session.id)
      : [];
    const previousSessionNotificationIds = [
      ...previousSessionIds,
      ...previousAuxiliarySessionIds,
    ];

    if (resetTargets.includes("sessions")) {
      this.deps.closeResetTargetWindows();
    }

    let modelCatalog: ModelCatalogSnapshot;
    let appSettings: AppSettings;

    if (areAllResetAppDatabaseTargetsSelected(resetTargets)) {
      modelCatalog = await this.deps.recreateDatabaseFile();
      this.chatLayoutCurrent = {};
      this.dismissSessionTurnNotifications(previousSessionNotificationIds);
      this.deps.resetSessionRuntime();
      await this.deps.invalidateAllProviderSessionThreads();
      this.deps.clearAllProviderQuotaTelemetry();
      this.deps.clearAllSessionContextTelemetry();
      appSettings = await this.deps.getAppSettings();
    } else {
      const appliedTargets = new Set<ResetAppDatabaseTarget>(resetTargets);

      if (appliedTargets.has("sessions")) {
        await this.deps.replaceAllSessions([], { broadcast: false });
        this.dismissSessionTurnNotifications(previousSessionNotificationIds);
        this.deps.resetSessionRuntime();
        await this.deps.invalidateAllProviderSessionThreads();
      }
      if (appliedTargets.has("appSettings")) {
        const previousSettings = await this.deps.getAppSettings();
        const savedSettings = await this.deps.resetAppSettings();
        this.chatLayoutCurrent = {};
        this.deps.clearAllProviderQuotaTelemetry();
      }
      modelCatalog = await this.deps.getModelCatalog();
      appSettings = await this.deps.getAppSettings();
    }

    appSettings = this.withCurrentChatLayout(appSettings);
    this.deps.applyAppSettingsSideEffects?.(appSettings);
    this.deps.broadcastSessions(previousSessionIds);
    await this.deps.broadcastAppSettings(appSettings);
    await this.deps.broadcastModelCatalog(modelCatalog);

    return {
      resetTargets,
      sessions: await this.deps.listSessions(),
      appSettings,
      modelCatalog,
    };
  }

  /** リセット対象の Main・Auxiliary に残っている Turn の通知を対象ごとに閉じる。 */
  private dismissSessionTurnNotifications(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.deps.dismissSessionTurnNotification(sessionId);
    }
  }
}
