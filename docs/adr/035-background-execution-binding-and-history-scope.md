# ADR 035: 背景実行のbindingと履歴read scopeを分離する

## Status

Accepted

三用途に共通するcheckpointと保存確定・復旧の判断は、[適用範囲](#適用範囲)の後継判断で置き換える。#909のCharacter Memory・対象Memoryに固有の開始位置と保存停止の扱いは[#909後継判断](#909-memory記録の後継判断)に定める。共通binding／履歴read／admissionと既存データ保護の判断は維持する。

## Context

Issue #888の三用途を通常Sessionのactor／Providerキーで実行すると、通常turnのbinding再利用・置換と競合する。#908の履歴readは元会話を参照するが、生成purposeやMemory記録の処理位置は読取能力そのものの条件ではない。Auxiliaryの再作成はcreatedAtだけでは区別できず、既存のconversation ownerIdentityに含まれるdraft incarnationも必要になる。

## Decision

- 背景は呼出しごとの新規binding IDを実行identityとし、actorSessionIdは実Sessionを参照する。通常Session＋Providerの再利用indexへ背景を入れない。通常Session／Auxiliaryや永続queueを背景用に新設しない。
- 背景purpose・processing Turn範囲・Memory targetと、source identity・許可message seq範囲による履歴read scopeを分ける。履歴readの共通型は背景生成に依存せず、今回のgrant発行と公開だけを背景へ限定する。未実装のV7認可分岐は追加しない。
- sourceのownerIdentityは既存Storage Workerのconversation-query snapshotを正本とする。Auxiliaryではdraft incarnation・親identity・createdAtを含む既存値をそのままcaptureし、データの読取と同じstorage境界で照合する。通常のdraft編集を会話の再作成と扱わず、新しいhashを導入しない。
- `/mcp/session-history`、`withmate-session-history`、`session_history.*`を履歴専用入口とし、HTTP host・runtime認証・Storage Workerを共用する。具体的operationのgrantをruntimeで検証し、無効bindingをunboundへ降格しない。通常turnには履歴grantを自動付与しない。
- native終端ではtool接続だけを閉じ、アプリ側の論理実行admissionは保存の確定または失敗まで保持する。取消、source／親削除・再作成、runtime停止は失効する。主会話だけのCancelと背景取消を分け、通常Window closeは背景取消としない。
- 初期の同時上限は背景全体3件、同じ用途×会話1件とする。満杯を失敗・成功へ置換せず起動見送りとして返し、未処理範囲は呼出元が保持する。主会話へこの上限を適用せず、永続queue／汎用schedulerを設けない。
- 既存の秘匿化を維持し、一般secretの再探索・追加マスキングは新設しない。

既存owner保存境界で必要最小限の用途別checkpointを持つ方向は採用する。保存結果と処理位置の同一connection・transactionでの確定、応答消失・再起動後の正本照合は#909／#910の保存Applicationと具体化する。新bindingで既存idempotency keyを使うだけの復旧を保証せず、候補queue／独立execution台帳は作らない。

## 適用範囲

2026-11-01の精度要求変更により、上記Decision末尾の用途別checkpoint・atomic位置確定・応答消失／再起動照合を具体化する方針は適用対象外とする。後継判断は、取得時点の許可材料から一度生成し、既存storeで保存し、失敗・結果不明はその状態で終了する方式である。内容精度のための追随・再照合・専用復旧は不要とし、binding／read scope／admission／保存データ保護の判断は維持する。現在の呼出・保存結果の契約は[Background Execution](../design/background-execution.md#共通の単発呼出)を正本とする。

実装済みの共通基盤と寿命は[Background Execution](../design/background-execution.md)を正本とする。Providerの制限された単発推論、用途別設定、生成・保存の統合、checkpointの実装をこのADRの採用だけで完了扱いしない。

ADR028の「専用post-turn生成を設けない」という方針は今回の背景生成方針で置換する。ただし現在稼働する通常turn内のMemory／Affect操作は、生成担当の接続と現行説明の更新を同じ論理変更で行うまで維持する。保存済みevent／episode／一般Memory・version・idempotency情報を削除する判断ではない。ADR029のMCP／CLI同等契約と通常turnの認可は維持する。

## #909 Memory記録の後継判断

Character Memory・対象Memoryは、取得時点の許可された材料から一度生成し、final全体を検証して既存操作へ一候補ずつ保存する。順序・鮮度・重複・取りこぼしの厳密な調整は保証しない。この二用途では、Decision末尾の用途別checkpoint、保存結果と処理位置の同一connection・transaction確定、応答消失・再起動後の正本照合の判断を適用対象外とする。

未開始対象の末尾はowner×用途ごとにアプリ生存期間内だけ保持し、admissionを取得して開始したときに進める。失敗／unknownでも戻さず、開始見送りなら進めない。この位置は保存成功の証明ではない。保存の失敗／unknown／取消では残りの候補を呼ばず、確認できた保存だけを成功として扱う。永続checkpoint、候補queue、新batchによる一括確定、read-reconcile、自動再送や失敗範囲の完全回収を後続の必須課題にしない。

認可・正しいowner／target・失効拒否・入力検証・既存privacy忘却とデータ保護は維持する。共通binding／履歴read／admissionおよび#910の方針は変更しない。現在の実装済み範囲は[Memory生成の純粋な用途契約](../design/background-execution.md#memory生成の純粋な用途契約)を正本とし、後継判断の採用をProvider・read・保存接続の実装完了とは扱わない。
