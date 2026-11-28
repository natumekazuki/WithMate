import {
  SessionPersistenceService,
  type SessionPersistenceServiceDeps,
} from "./session-persistence-service.js";
import { createSessionStorageCommandAdapter } from "./session-storage-command-adapter.js";
import type {
  SessionStorageWrite,
  SessionPinStorage,
} from "../storage/persistent-store-lifecycle-service.js";

/** 一つのストア世代に属する保存先、キャッシュ、ランタイム判定と表示・終了に関わる副作用。 */
export type SessionPersistenceAssemblyDeps = {
  owner: {
    /** 保存や副作用が参照しているストアが、引き続き現行の世代であるかを確認する。 */
    assertActive(operation: string): void;
  };
  storage: SessionStorageWrite;
  pinStorage: SessionPinStorage;
  cache: {
    /** 現行世代のキャッシュから Session 一覧を取り出す。 */
    getSessions(): Parameters<SessionPersistenceServiceDeps["setSessions"]>[0];
    /** 正本から更新された Session の一覧を、現行世代のキャッシュへ反映する。 */
    setSessions(
      nextSessions: Parameters<SessionPersistenceServiceDeps["setSessions"]>[0],
    ): void;
    getSession: SessionPersistenceServiceDeps["getSession"];
    overlayCurrentExecutionOptions?: NonNullable<
      SessionPersistenceServiceDeps["overlayCurrentExecutionOptions"]
    >;
    rememberExecutionOptions?: NonNullable<
      SessionPersistenceServiceDeps["rememberExecutionOptions"]
    >;
  };
  runtime: Pick<
    SessionPersistenceServiceDeps,
    | "isSessionRunInFlight"
    | "listRunningActiveAuxiliaryParentIds"
    | "runProviderRuntimeOperationExclusive"
  >;
  auxiliary: {
    /** 親の削除や終了で照合する、指定 Main に所属する Auxiliary のランタイム識別情報を取得する。 */
    listAuxiliarySessionRuntimeIdentities(
      parentSessionId: string,
    ): ReturnType<
      NonNullable<
        SessionPersistenceServiceDeps["listAuxiliarySessionRuntimeIdentities"]
      >
    >;
  };
  settings: Pick<
    SessionPersistenceServiceDeps,
    "getAppSettings" | "getModelCatalogSnapshot"
  >;
  character: {
    /** Session が使うキャラクター定義の実行時スナップショットを作る。 */
    createCharacterRuntimeSnapshot(
      characterId: string,
    ): ReturnType<
      NonNullable<
        SessionPersistenceServiceDeps["createCharacterRuntimeSnapshot"]
      >
    >;
  };
  effects: {
    clearSessionContextTelemetry: SessionPersistenceServiceDeps["clearSessionContextTelemetry"];
    invalidateProviderSessionThread: SessionPersistenceServiceDeps["invalidateProviderSessionThread"];
    /** 指定 Session に発行していた実行バインディングを失効させる。 */
    revokeSessionAgentRuntimeBindings(sessionId: string): void;
    closeSessionWindow: SessionPersistenceServiceDeps["closeSessionWindow"];
    discardSessionWindow: NonNullable<
      SessionPersistenceServiceDeps["discardSessionWindow"]
    >;
    broadcastSessions: SessionPersistenceServiceDeps["broadcastSessions"];
  };
};

/** ストア世代を照合する境界を組み合わせ、同じ所有者の保存先と副作用を使うサービスを作る。 */
export function createSessionPersistenceAssembly(
  deps: SessionPersistenceAssemblyDeps,
): SessionPersistenceService {
  /** 各操作の内容を付けてストア所有者を照合し、以前の世代からの作用を防ぐ。 */
  const assertOwner = (operation: string) =>
    deps.owner.assertActive(`Session persistence ${operation}`);
  const storageCommands = createSessionStorageCommandAdapter(() => {
    assertOwner("storage command");
    return deps.storage;
  });

  const assembled: SessionPersistenceServiceDeps = {
    runProviderRuntimeOperationExclusive: deps.runtime
      .runProviderRuntimeOperationExclusive
      ? (operation) =>
          deps.runtime.runProviderRuntimeOperationExclusive!(async () => {
            assertOwner("provider runtime operation");
            const result = await operation();
            assertOwner("provider runtime operation");
            return result;
          })
      : undefined,
    /** 所有者が変わっていない場合だけキャッシュ一覧を読む。 */
    getSessions: () => {
      assertOwner("cache read");
      return deps.cache.getSessions();
    },
    /** 現行世代に限ってキャッシュ一覧を更新する。 */
    setSessions: (nextSessions) => {
      assertOwner("cache write");
      deps.cache.setSessions(nextSessions);
    },
    /** 現行世代に限って指定 Session のキャッシュを取得する。 */
    getSession: (sessionId) => {
      assertOwner("session read");
      return deps.cache.getSession(sessionId);
    },
    /** 保存済み Session に現行選択を重ねる。選択の取得先がなければ元の値を使う。 */
    overlayCurrentExecutionOptions: (session) => {
      assertOwner("selection overlay");
      return deps.cache.overlayCurrentExecutionOptions?.(session) ?? session;
    },
    /** 現在の所有者の UI 選択を記録し、選択管理がない場合は何もしない。 */
    rememberExecutionOptions: (session, options) => {
      assertOwner("selection remember");
      deps.cache.rememberExecutionOptions?.(session, options);
    },
    /** 保存済み Session の履歴を含む正本を取得し、待機中にストアが交代した結果は返さない。 */
    getStoredSession: async (sessionId) => {
      assertOwner("stored session read");
      const stored = await deps.storage.getSession(sessionId);
      assertOwner("stored session read");
      return stored;
    },
    /** 対応するストアから保存済み要約だけを取得し、前後で所有者を確認する。 */
    getStoredSessionSummary: async (sessionId) => {
      assertOwner("stored Session summary read");
      if (!deps.storage.getSessionSummary)
        throw new Error("Session summary storage is unavailable.");
      const result = await deps.storage.getSessionSummary(sessionId);
      assertOwner("stored Session summary read");
      return result;
    },
    isSessionRunInFlight: deps.runtime.isSessionRunInFlight,
    listRunningActiveAuxiliaryParentIds:
      deps.runtime.listRunningActiveAuxiliaryParentIds,
    /** 対象 Main ごとの Auxiliary を取得し、同じストア世代から得た結果だけを一つにまとめる。 */
    listAuxiliarySessionRuntimeIdentities: async (parentSessionIds) =>
      (
        await Promise.all(
          parentSessionIds.map(async (parentSessionId) => {
            assertOwner("Auxiliary identity read");
            const identities =
              await deps.auxiliary.listAuxiliarySessionRuntimeIdentities(
                parentSessionId,
              );
            assertOwner("Auxiliary identity read");
            return identities;
          }),
        )
      ).flat(),
    upsertStoredSession: storageCommands.upsertStoredSession,
    /** 追加ディレクトリ列の更新を、指定の世代と対応する保存先に限って行う。 */
    setStoredSessionAdditionalDirectories: (
      sessionId,
      incarnationId,
      directories,
    ) => {
      assertOwner("additional directory update");
      if (!deps.storage.setSessionAdditionalDirectories)
        throw new Error("Session additional directory storage is unavailable.");
      return deps.storage.setSessionAdditionalDirectories(
        sessionId,
        incarnationId,
        directories,
      );
    },
    /** 追加入力を増分保存する。対応していない場合は全履歴の保存に代替しない。 */
    appendStoredSessionSteer: (input) => {
      assertOwner("Session steer append");
      if (!deps.storage.appendSessionSteer)
        throw new Error("Incremental Session input storage is unavailable.");
      return deps.storage.appendSessionSteer(input);
    },
    /** 指定 Turn の追加入力を未確定として永続化する入口を呼ぶ。 */
    beginStoredSessionSteer: (input) => {
      assertOwner("Session steer begin");
      if (!deps.storage.beginSessionSteer)
        throw new Error("Durable Session input storage is unavailable.");
      return deps.storage.beginSessionSteer(input);
    },
    /** 保存済み追加入力の配信結果を確定する入口を呼ぶ。 */
    settleStoredSessionSteer: (input) => {
      assertOwner("Session steer settle");
      if (!deps.storage.settleSessionSteer)
        throw new Error("Durable Session input storage is unavailable.");
      return deps.storage.settleSessionSteer(input);
    },
    /** 最終応答と Turn の終了を同時に確定できる増分書き込みだけを使う。 */
    appendStoredSessionTerminal: (input) => {
      assertOwner("Session terminal append");
      if (!deps.storage.appendSessionTerminal)
        throw new Error("Incremental terminal Session storage is unavailable.");
      return deps.storage.appendSessionTerminal(input);
    },
    /** 履歴を増やさずランタイム状態を保存するため、専用チェックポイントの対応を確認する。 */
    checkpointStoredSessionRunMetadata: (input) => {
      assertOwner("Session runtime checkpoint");
      if (!deps.storage.checkpointSessionRunMetadata)
        throw new Error("Session runtime checkpoint storage is unavailable.");
      return deps.storage.checkpointSessionRunMetadata(input);
    },
    /** 対象の世代を指定し、タイトルだけを更新する。 */
    setStoredSessionTitle: async (sessionId, incarnationId, title) => {
      assertOwner("title update");
      if (!deps.storage.setSessionTitle)
        throw new Error("Session title storage is unavailable.");
      await deps.storage.setSessionTitle(sessionId, incarnationId, title);
    },
    /** 指定世代のメタデータを部分更新し、別のストアへ切り替わっていないことを確認して返す。 */
    patchStoredSessionMetadata: async (sessionId, incarnationId, patch) => {
      assertOwner("metadata update");
      if (!deps.storage.patchSessionMetadata)
        throw new Error("Session metadata storage is unavailable.");
      const result = await deps.storage.patchSessionMetadata(
        sessionId,
        incarnationId,
        patch,
      );
      assertOwner("metadata update");
      return result;
    },
    /** 専用の昇格操作でのみ役割を変更し、現行ストアの結果を返す。 */
    promoteStoredSessionToOverallCoordinator: async (
      sessionId,
      incarnationId,
    ) => {
      assertOwner("Role update");
      if (!deps.storage.promoteSessionToOverallCoordinator)
        throw new Error("Session Role storage is unavailable.");
      const result = await deps.storage.promoteSessionToOverallCoordinator(
        sessionId,
        incarnationId,
      );
      assertOwner("Role update");
      return result;
    },
    /** 対象世代の履歴位置を指定してブックマークだけを更新する。 */
    setStoredSessionMessageBookmark: async (
      sessionId,
      incarnationId,
      messageIndex,
      isBookmarked,
    ) => {
      assertOwner("bookmark update");
      if (!deps.storage.setSessionMessageBookmark)
        throw new Error("Session bookmark storage is unavailable.");
      await deps.storage.setSessionMessageBookmark(
        sessionId,
        incarnationId,
        messageIndex,
        isBookmarked,
      );
      assertOwner("bookmark update");
    },
    /** 保存済み Session の実行設定だけを更新し、同じストア世代の操作として扱う。 */
    setStoredSessionExecutionOptions: async (
      sessionId,
      incarnationId,
      options,
    ) => {
      assertOwner("execution options update");
      if (!deps.storage.setSessionExecutionOptions)
        throw new Error("Session execution option storage is unavailable.");
      await deps.storage.setSessionExecutionOptions(
        sessionId,
        incarnationId,
        options,
      );
      assertOwner("execution options update");
    },
    /** 期待するスレッドの値に一致するときだけ置換する、専用の保存操作を使う。 */
    updateStoredSessionThreadIfMatches: async (input) => {
      assertOwner("thread update");
      if (!deps.storage.updateSessionThreadIfMatches)
        throw new Error(
          "Conditional Session thread update storage is unavailable.",
        );
      const stored = await deps.storage.updateSessionThreadIfMatches(input);
      assertOwner("thread update");
      return stored;
    },
    /** 読み取り時のランタイム情報に一致する場合だけ更新し、保存結果は現行世代から返す。 */
    updateStoredSessionRuntimeMetadataIfMatches: async (input) => {
      assertOwner("runtime metadata update");
      if (!deps.storage.updateSessionRuntimeMetadataIfMatches)
        throw new Error(
          "Conditional Session runtime metadata update storage is unavailable.",
        );
      const stored =
        await deps.storage.updateSessionRuntimeMetadataIfMatches(input);
      assertOwner("runtime metadata update");
      return stored;
    },
    /** 最初の入力と実行開始を増分保存できる形式に限定し、保存後にも所有者を確認する。 */
    appendStoredRunningTurnStart: async (input) => {
      assertOwner("running turn start");
      if (!deps.storage.appendRunningTurnStart)
        throw new Error(
          "Incremental storage for starting a running turn is unavailable.",
        );
      const result = await deps.storage.appendRunningTurnStart(input);
      assertOwner("running turn start");
      return result;
    },
    /** キャラクター作成用の実行状態だけを消す専用操作を使い、他の状態の全置換を避ける。 */
    clearStoredCharacterAuthoringRuntimeState: async (input) => {
      assertOwner("Character authoring runtime clear");
      if (!deps.storage.clearCharacterAuthoringRuntimeState)
        throw new Error(
          "Storage for clearing Character authoring runtime state is unavailable.",
        );
      const result =
        await deps.storage.clearCharacterAuthoringRuntimeState(input);
      assertOwner("Character authoring runtime clear");
      return result;
    },
    /** 同じ世代のストアに保存済み一覧を置き換え、待機後にも有効性を確認する。 */
    replaceStoredSessions: async (nextSessions) => {
      assertOwner("session replacement");
      await deps.storage.replaceSessions(nextSessions);
      assertOwner("session replacement");
    },
    /** ピン留めに対応するストアか確認し、更新後の結果を渡す。 */
    setStoredSessionPinned: async (sessionId, isPinned) => {
      assertOwner("session pin update");
      if (typeof deps.pinStorage.setSessionPinned !== "function")
        throw new Error(
          "Session pinning is unavailable for this storage format.",
        );
      const result = await deps.pinStorage.setSessionPinned(
        sessionId,
        isPinned,
      );
      assertOwner("session pin update");
      return result;
    },
    /** 対象のストアから詳細 Session 一覧を読み、ストア交換がない場合だけ採用する。 */
    listStoredSessions: async () => {
      assertOwner("session list");
      const result = await deps.storage.listSessions();
      assertOwner("session list");
      return result;
    },
    /** 現在のストアから履歴を含まない要約一覧を取得する。 */
    listStoredSessionSummaries: async () => {
      assertOwner("Session summaries");
      const result = await deps.storage.listSessionSummaries();
      assertOwner("Session summaries");
      return result;
    },
    /** 指定操作 ID で保存済みの作成・削除の進行状態を取得する。 */
    getSessionLifecycleOperation: async (operationId) => {
      assertOwner("lifecycle read");
      if (!deps.storage.getSessionLifecycleOperation)
        throw new Error("Session lifecycle storage is unavailable.");
      const result =
        await deps.storage.getSessionLifecycleOperation(operationId);
      assertOwner("lifecycle read");
      return result;
    },
    /** 現行世代でまだ回復が必要なライフサイクル操作を調べる。 */
    listPendingSessionLifecycleOperations: async () => {
      assertOwner("lifecycle list");
      if (!deps.storage.listPendingSessionLifecycleOperations)
        throw new Error("Session lifecycle storage is unavailable.");
      const result = await deps.storage.listPendingSessionLifecycleOperations();
      assertOwner("lifecycle list");
      return result;
    },
    /** 対応するストアで、指定の作成・削除操作を保存して開始する。 */
    beginSessionLifecycleOperation: async (input) => {
      assertOwner("lifecycle begin");
      if (!deps.storage.beginSessionLifecycleOperation)
        throw new Error("Session lifecycle storage is unavailable.");
      const result = await deps.storage.beginSessionLifecycleOperation(input);
      assertOwner("lifecycle begin");
      return result;
    },
    /** ライフサイクル操作の段階と、後片付けに用いる所有リソースを記録する。 */
    advanceSessionLifecycleOperation: async (operationId, phase, resources) => {
      assertOwner("lifecycle advance");
      if (!deps.storage.advanceSessionLifecycleOperation)
        throw new Error("Session lifecycle storage is unavailable.");
      const result = await deps.storage.advanceSessionLifecycleOperation(
        operationId,
        phase,
        resources,
      );
      assertOwner("lifecycle advance");
      return result;
    },
    /** 保存済みのライフサイクル操作を使い、指定された Crew の削除を適用する。 */
    deleteSessionCrewForLifecycle: async (operationId) => {
      assertOwner("Crew lifecycle deletion");
      if (!deps.storage.deleteSessionCrewForLifecycle)
        throw new Error("Crew lifecycle deletion storage is unavailable.");
      const result =
        await deps.storage.deleteSessionCrewForLifecycle(operationId);
      assertOwner("Crew lifecycle deletion");
      return result;
    },
    /** 最後の活動時刻が基準より前の保存済み Session ID を列挙する。 */
    listStoredSessionIdsLastActiveBefore: async (cutoff) => {
      assertOwner("session cutoff list");
      const result = await deps.storage.listSessionIdsLastActiveBefore(cutoff);
      assertOwner("session cutoff list");
      return result;
    },
    /** 指定された Session の保存レコードを削除し、完了時にも所有者を照合する。 */
    deleteStoredSessions: async (sessionIds) => {
      assertOwner("session deletion");
      await deps.storage.deleteSessions(sessionIds);
      assertOwner("session deletion");
    },
    /** 保存済みの最新の Crew 関係から、指定世代の削除可否を確認する。 */
    getStoredCrewDeletionStatus: async (sessionId, incarnationId) => {
      assertOwner("Crew deletion status");
      if (!deps.storage.getCrewDeletionStatus)
        throw new Error("Crew deletion status storage is unavailable.");
      const result = await deps.storage.getCrewDeletionStatus(
        sessionId,
        incarnationId,
      );
      assertOwner("Crew deletion status");
      return result;
    },
    /** 作成操作にひも付けた準備入力を保存し、現行世代で受理した結果を返す。 */
    prepareSessionLifecycleCreation: async (operationId, input) => {
      assertOwner("Session lifecycle preparation");
      if (!deps.storage.prepareSessionLifecycleCreation)
        throw new Error(
          "Session lifecycle preparation storage is unavailable.",
        );
      const result = await deps.storage.prepareSessionLifecycleCreation(
        operationId,
        input,
      );
      assertOwner("Session lifecycle preparation");
      return result;
    },
    /** 非同期取得の前後で所有者を照合して、現在のアプリ設定を取得する。 */
    getAppSettings: async () => {
      assertOwner("settings read");
      const result = await deps.settings.getAppSettings();
      assertOwner("settings read");
      return result;
    },
    /** 作業場所と任意の提供元に対応するカタログを、現在のストア世代の操作として取得する。 */
    getModelCatalogSnapshot: async (workspacePath, providerId) => {
      assertOwner("catalog read");
      const result = await deps.settings.getModelCatalogSnapshot(
        workspacePath,
        providerId,
      );
      assertOwner("catalog read");
      return result;
    },
    /** キャラクター定義を実行時用に取得し、待機中にストア世代が変わった結果は使わない。 */
    createCharacterRuntimeSnapshot: async (characterId) => {
      assertOwner("character snapshot");
      const result =
        await deps.character.createCharacterRuntimeSnapshot(characterId);
      assertOwner("character snapshot");
      return result;
    },
    /** 現在のストア世代に対応する Session のコンテキスト使用量を取り除く。 */
    clearSessionContextTelemetry: (sessionId) => {
      assertOwner("context telemetry clear");
      deps.effects.clearSessionContextTelemetry(sessionId);
    },
    /** 指定の提供元が管理している Session スレッドを無効化し、待機の前後で世代を照合する。 */
    invalidateProviderSessionThread: async (providerId, sessionId) => {
      assertOwner("provider thread invalidation");
      await deps.effects.invalidateProviderSessionThread(providerId, sessionId);
      assertOwner("provider thread invalidation");
    },
    /** 指定 Session に発行済みの認可を、現行ストアの副作用として失効させる。 */
    revokeSessionAgentRuntimeBindings: (sessionId) => {
      assertOwner("agent runtime revoke");
      deps.effects.revokeSessionAgentRuntimeBindings(sessionId);
    },
    /** 削除などの対象である Session の Window を閉じるよう要求する。 */
    closeSessionWindow: (sessionId) => {
      assertOwner("session window close");
      deps.effects.closeSessionWindow(sessionId);
    },
    /** 対象 Session の Window を破棄する。以前のストアからの要求は適用しない。 */
    discardSessionWindow: (sessionId) => {
      assertOwner("session window discard");
      deps.effects.discardSessionWindow(sessionId);
    },
    upsertStoredTerminalSession: storageCommands.upsertStoredTerminalSession,
    /** 変更対象と詳細の変化を表示側へ通知する。別ストアの更新は配信しない。 */
    broadcastSessions: (sessionIds, detailChanged) => {
      assertOwner("broadcast");
      deps.effects.broadcastSessions(sessionIds, detailChanged);
    },
  };
  return new SessionPersistenceService(assembled);
}
