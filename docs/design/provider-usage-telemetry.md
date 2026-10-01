# Provider Usage Telemetry

providerのquotaはapp全体、context usageはSessionごとの一時的な観測値として扱う。型の正本は`src-shared/session/runtime-state.ts`、Mainのcacheと通知は`src-electron/session/session-observability-service.ts`に置く。telemetry自体はSession DBへ保存しない。確定turnのtoken usageとtransport payloadは[Audit Log](audit-log.md)で別に保存する。

## Copilotの取得と更新

`CopilotAdapter`は`client.rpc.account.getQuota()`による初期取得と、実行中の`assistant.usage`に含まれるquota snapshotからprovider quotaを更新する。`session.usage_info`は対象Sessionのcontext telemetryとして受け取る。Mainはprovider単位のquota cacheとSession単位のcontext cacheを持ち、snapshot取得と購読をrendererへ公開する。quotaの更新をSessionごとのDB保存や監査結果の更新と混同しない。

Session WindowはCopilotの`Premium Requests`残量をcompactに示し、詳細でused／entitlement／resetを読めるようにする。`Context`は必要時に開き、token limit、current tokens、message数を確認する。まだ値がないときは利用不可として表示し、値を推測しない。表示の配置は[Desktop UI](desktop-ui.md)に従う。

## Codex・Claudeと境界

`CodexAdapter.getProviderQuotaTelemetry()`と`ClaudeAdapter.getProviderQuotaTelemetry()`は`null`を返す。quota残量やreset時刻をCopilotの値から推測せず、各providerのturn usageはprovider結果とAudit Logで扱う。Claude SDKのAPI換算額は本人契約の実請求額として表示しない。providerごとの取得・実行責務は[Provider Adapter](provider-adapter.md)を参照する。

ClaudeのMain・Auxiliaryはuser / project / local設定を読み込むが、Backgroundは副作用を隔離するため読み込まない。Backgroundの認証・接続先は親プロセスの環境変数とSDKが参照する既存CLIログインに依存する。Main・Auxiliaryも同じ経路で解決される場合は補助処理も同じ契約枠を消費するが、設定ファイルだけにある`apiKeyHelper`や認証・接続先の環境変数に依存する場合は、認証失敗や異なる利用先・消費枠となり得る。同一の認証・課金経路を無条件に保証せず、WithMateから認証情報をコピーしたり、失敗時に別の認証へ切り替えたりしない。

Claudeの新規sessionはSDKのmodel別usageを合計する。resumeではmodel別usageが過去turnを含む累積になるため、当該turnのmain loopに限った`result.usage`を使い、subagentや内部補助処理の消費は含めない。いずれも契約全体の消費量や残量の計測ではない。
