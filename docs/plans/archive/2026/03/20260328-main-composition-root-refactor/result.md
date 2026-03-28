# Result

- 状態: completed
- 進捗:
  - `AppLifecycleService` を `main.ts` から分離
  - `MainBootstrapService` と `main-ipc-deps` を導入
  - lifecycle/bootstrap の deps 組み立てを helper 化
  - provider catalog / adapter / quota fetch helper を `main.ts` から分離
  - infrastructure singleton の registry 化で `main.ts` の service 変数を縮小
  - session/character query と discovery/search helper を `MainQueryService` に分離
  - コミット: `ea55957` `refactor(main): improve composition root boundaries`
  - provider quota / session context / background activity / live run を `MainObservabilityFacade` に分離
  - コミット: `baef8aa` `refactor(main): extract observability facade`
  - sessions / characters / model catalog / app settings / open session windows の broadcast payload を `MainBroadcastFacade` に分離
  - コミット: `999d5f9` `refactor(main): extract broadcast facade`
  - session create/update/delete/run/cancel の forwarding と Copilot quota refresh 前処理を `MainSessionCommandFacade` に分離
  - `upsertSession / replaceAllSessions / recoverInterruptedSessions` を `MainSessionPersistenceFacade` に分離
  - コミット: `72e1610` `refactor(main): extract session command facades`
  - model catalog / provider adapter / thread invalidation を `MainProviderFacade` に分離
  - character query/runtime の束ねを `MainCharacterFacade` に分離
  - window 操作の thin wrapper を `MainWindowFacade` に分離
  - コミット: `4ed691a` `refactor(main): extract provider character and window facades`
- 残り:
  - なし

## メモ

- `main.ts` の composition root を整理する
- first slice として app lifecycle を `AppLifecycleService` に切り出した
- second slice として `whenReady()` の IPC deps 組み立てを `main-ipc-deps.ts` に、起動シーケンスを `MainBootstrapService` に切り出した
- third slice として lifecycle/bootstrap deps の helper 化と provider support helper の切り出しを行った
- fourth slice として infrastructure singleton を `MainInfrastructureRegistry` にまとめた
- fifth slice として query 系 helper を `MainQueryService` にまとめた
- sixth slice として observability forwarding を `MainObservabilityFacade` にまとめた
- seventh slice として broadcast payload の組み立てを `MainBroadcastFacade` にまとめた
- eighth slice として session create/update/delete/run/cancel の forwarding を `MainSessionCommandFacade` にまとめた
- ninth slice として `upsertSession / replaceAllSessions / recoverInterruptedSessions` を `MainSessionPersistenceFacade` にまとめた
- tenth slice として model catalog / provider adapter / thread invalidation を `MainProviderFacade` にまとめた
- eleventh slice として character query/runtime を `MainCharacterFacade` にまとめた
- twelfth slice として window 操作を `MainWindowFacade` にまとめた
- 残りの thin wrapper は composition root として許容し、この plan を完了とする
