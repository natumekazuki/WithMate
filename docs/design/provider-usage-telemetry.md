# Provider Usage Telemetry

providerのquotaはapp全体、context usageはSessionごとの一時的な観測値として扱う。型の正本は`src-shared/session/runtime-state.ts`、Mainのcacheと通知は`src-electron/session/session-observability-service.ts`に置く。telemetry自体はSession DBへ保存しない。確定turnのtoken usageとtransport payloadは[Audit Log](audit-log.md)で別に保存する。

## Copilotの取得と更新

`CopilotAdapter`は`client.rpc.account.getQuota()`による初期取得と、実行中の`assistant.usage`に含まれるquota snapshotからprovider quotaを更新する。`session.usage_info`は対象Sessionのcontext telemetryとして受け取る。Mainはprovider単位のquota cacheとSession単位のcontext cacheを持ち、snapshot取得と購読をrendererへ公開する。quotaの更新をSessionごとのDB保存や監査結果の更新と混同しない。

Session WindowはCopilotの`Premium Requests`残量をcompactに示し、詳細でused／entitlement／resetを読めるようにする。`Context`は必要時に開き、token limit、current tokens、message数を確認する。まだ値がないときは利用不可として表示し、値を推測しない。表示の配置は[Desktop UI](desktop-ui.md)に従う。

## Codexと境界

現行`CodexAdapter.getProviderQuotaTelemetry()`は`null`を返す。quota残量やreset時刻をCopilotの値から推測せず、Codexのturn usageはprovider結果とAudit Logで扱う。providerごとの取得・実行責務は[Provider Adapter](provider-adapter.md)を参照する。
