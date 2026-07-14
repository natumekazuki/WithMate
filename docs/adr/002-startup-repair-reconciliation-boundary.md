# ADR 002: Startup repairとProvider照合の責務境界

- Status: Accepted
- Date: 2026-07-14

## Context

Persistence Workerの再起動時には、local transactionの途中状態、Provider requestの送信意図、応答消失後の外部副作用が同時に残り得る。SQLiteだけではProviderが会話作成や実行開始を受理したか証明できず、未確定状態を一律に再送すると外部会話や実行を重複作成する。一方、localに証明できる不整合まで診断だけに留めると、terminal Runが所有するopen Bindingなどが後続admissionを恒久的に妨げる。

復旧処理をWorkerからProviderへ直接接続する案は、永続化境界へProvider capability、認証、照合方式を持ち込み、Main processが所有するApplication Serviceとの責務を重複させる。

## Decision

`repository.startup.repair`はPersistence Worker内の単一write transactionとして実行し、local recordだけを反復可能かつ単調に収束させる。Provider I/Oを行わず、外部conversation ID、external execution ID、terminal outcomeを推測しない。

terminalまたはcanceling Runが所有する未解決のcreating Bindingは、Provider応答を関連付けられるlive ownerではないためinvalidatedへ進める。外部会話作成が未送信だったことを証明できない場合、Runのexternal side effectは`unknown`へ単調更新する。未送信を証明できるpending Dispatchだけをabortし、dispatchingまたはambiguous Dispatchは自動再送しない。

Provider照合が必要な状態はboundedなinspection結果として返す。Application Serviceはtyped recovery projectionで対象Run、Attempt、Binding、Dispatchを再取得し、Provider capabilityに応じた照会後、既存のBindingまたはDispatch resolution commandへ確定結果を渡す。ephemeral Bindingはprocess再起動後のresume対象にしない。

現在のprojection field、修復件数、診断条件はshared typeとrepository contract testを正本とする。

## Alternatives

- WorkerからProviderへ直接照会する: Provider依存と認証境界がPersistence Workerへ漏れるため採用しない。
- startup時に未確定requestを一律再送する: Provider native idempotencyを保証できない経路で外部副作用を重複させるため採用しない。
- local stateを変更せず診断だけ返す: open Bindingやpending local stateが後続処理を恒久的に妨げるため採用しない。
- 復旧対象をprocess memoryだけに保持する: crash後に状態を再構築できないため採用しない。

## Consequences

- localに証明できる修復は一つのtransactionで収束し、再実行で状態を後退させない。
- Provider受理が不明なrequestは自動再送されず、二重実行防止を優先する。
- Main/Application Serviceはinspection後の対象列挙、Provider照合、resolution command呼び出しを担当する。
- Provider側に相関不能なorphan conversationが残る可能性があり、Workerは推測相関や自動削除を行わない。
- boundedな件数だけでは診断対象IDを特定できないため、詳細調査はscope付きread projectionを通す。
