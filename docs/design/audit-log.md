# Audit Log

Sessionの実行と失敗を後から確認するため、turnの監査情報はMain側で保存する。stream中の表示は永続化の正本ではない。

## 保存と所有

通常のMain／Auxiliary turnはV6 DBの`session_turns_v6`にphase（`running`、`completed`、`failed`、`canceled`）とprovider、model、実行設定、message位置、thread、時刻、error summaryを保存する。interimとprovider outputはそれぞれ`session_turn_interims_v6`、`session_turn_provider_outputs_v6`へ分ける。turnはMain SessionかAuxiliaryの一方に属し、対象Sessionの削除では従属する監査情報も除去する。既存V6の`audit_events_v6`を読む・移す経路はmigrationと読取互換に限る。

providerへ渡す論理promptとtransport payload、操作、raw items、usageなどのdetailは監査用に区別して保存し、一覧では重い本文を全件読まない。Session／Auxiliaryの監査一覧はbounded pageを取得し、対象を開いたときにdetail fragmentを遅延取得する。監査情報のstorage実装は`src-electron/session/audit-log-storage-v6.ts`、turn保存の順序と結果不明時の扱いは[Session Run Lifecycle](session-run-lifecycle.md)を参照する。

## 表示とデータ保護

Session WindowのAudit Logは保存済みの結果を表示し、実行中のlive stateと区別する。失敗を成功として表示したり、未保存のstreamを確定監査情報とみなしたりしない。Character Affectの評価ログと通常turnの監査情報も同一視しない。

prompt、provider応答、raw outputにはユーザーデータが含まれ得る。表示・export・診断で必要な範囲だけを扱い、app logへ本文やsecretを複製しない。一般のapp logとの責務境界は[App Log Base](app-log-base.md)、prompt sectionの意味は[Prompt Composition](prompt-composition.md)に記す。
