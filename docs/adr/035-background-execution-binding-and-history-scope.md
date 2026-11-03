# ADR 035: 背景実行のbindingと履歴read scopeを分離する

## Status

Accepted

三用途に共通するcheckpointと保存確定・復旧の判断は、[適用範囲](#適用範囲)の後継判断で置き換える。#909のCharacter Memory・対象Memoryに固有の開始位置と保存停止の扱いは[#909後継判断](#909-memory記録の後継判断)に定める。共通binding／履歴read／admissionと既存データ保護の判断は維持する。

2026-11-03に、三用途の専用構造化finalとnative完了後の保存phaseを[背景実行内の直接登録](#背景実行内のmcpcli直接登録)へ置き換える判断を採用した。現在の適用範囲は末尾の[共通基盤への適用](#共通基盤への適用)に示す。以下の従前判断の本文は保持する。

同日の後継判断として、背景全体3件・用途×会話1件という同時上限の条項は[同時上限の撤廃](#同時上限の撤廃)で置き換える。直接登録、認可、実行寿命、データ保護の判断は維持する。

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

## 背景実行内のMCP／CLI直接登録

### 判断と理由

Affect、Character Memory、対象Memoryは、背景Agentの一回の実行内で許可された材料を読み、必要な記録を既存MCP／CLIから登録する。登録用の構造化finalを返し、アプリが後段で保存する二段階方式は採用しない。構造化入力の検証と保存はtoolのapplication境界に集約し、同じ候補をfinalとして再解析・受渡しする責務を削減する。

| 用途 | 登録操作 |
| --- | --- |
| Affect | `character_affect.appraise` |
| Character Memory | `character_memory.append_episode` |
| 対象Memory | `memory.append` |

MCPとCLIは同じ用途別の操作・入力・認可・保存効果・エラー契約を使う。背景に通常turnのwrite権限全体やunbound fallbackを渡さない。Affect用途からのlinked episode生成、Memory用途からのAffect生成、移動・忘却・file／export・Graph／Glossary等への権限拡張は含まない。

### 維持する境界

- 実行identityは独立した背景binding、sourceは元の実会話とする。owner／Character／Session、許可read範囲、用途、保存先はtrusted contextから決め、Agentの自己申告で拡張しない。必要なsource参照の実在・範囲検証と入力検証をtool境界で行う。
- tool登録から既存application service／storeへ進み、同一背景実行のadmissionを保存境界まで伝える。取消・source／親の削除や再作成・runtime停止等による失効後の未確定writeを拒否する。確定済み保存は巻き戻さない。
- 主会話のCancelから独立し、通常Window closeでも継続する。背景全体3件、用途×会話1件、capacity時の起動見送り、永続queueなしを維持する。
- 生成指示は、何を根拠に何を記録するか、記録しない条件、使用する登録操作を定める。記録不要ならwriteしない。最終応答は保存用schemaを要求せず、自然文による完了宣言を保存成功の根拠にしない。
- 呼出単位で検証・保存し、後続の失敗・取消・結果不明があっても確認済みの先行保存を維持する。背景実行の終了と保存効果を区別し、不明を成功や全件未保存へ変換しない。
- 順序・鮮度・重複・取りこぼしの厳密な調停、補償、自動再送・読取再照合・専用復旧、checkpoint／receipt／独自台帳は導入しない。既存のデータ保護・保存契約を再利用する。

### 置換範囲と適用

上記Decisionの「native終端後も専用の保存phaseを行う」選択、および#909後継判断の「final全体を検証してから保存する」選択は、本判断の適用対象ではない。背景toolをread-onlyに限定する実装も、用途に必要な登録操作を許可する形へ変更する。既存の登録境界で必要な入力検証・認可を省略する判断ではなく、失敗時に先行保存を戻す全件atomic契約への変更でもない。

構造化finalのschema／parser、後段保存callback、用途別の専用保存applicationと結果変換は、直接登録へ接続した範囲から、不要な型・test・説明とともに整理する。必要な検証はtool境界へ移し、通常turnの公開操作や保存済みデータを削除しない。実Provider接続、自動起動・設定、Auxiliaryの保存対応を、この方式の採用だけで完了扱いしない。

現行説明は各branchの実装変更と同じ論理変更で更新する。本判断の採用時点では、[Background Execution](../design/background-execution.md)に記載された構造化final／後段保存方式が実装されている。

### 共通基盤への適用

共通runOnceは一回のAgent実行と実行終了の契約へ変更し、final schema／parser／後段save callbackと専用保存phaseを除去した。用途ごとのoperation上限、同一背景admissionとtrusted source／保存先を検証する登録port、未接続handlerのMCP非公開・直接runtime拒否を適用した。通常turnの公開操作と保存済みデータは維持する。

共通基盤取り込み時点では、三用途の入力検証と保存adapterは登録portへまだ接続していない。用途専用applicationは実行経路から外れており、検証移設と未使用コードの整理は用途担当が行う。実Provider・本番自動起動・設定・Auxiliary保存の適用完了を意味しない。現在の接続契約は[Background Execution](../design/background-execution.md#用途限定の登録接続)を正本とする。

2026-11-03に#909のMemory二用途へ直接登録を適用した。既存の公開入力とappend／episode validatorを利用し、実Mainの保存済み終端Turnのhistory／processing所属を用途handlerで確認する。個別の構造化根拠参照契約は新設せず、内容の意味判断はAgentへ委ねる。旧候補finalと専用後段保存を撤去し、Mainへ二handlerを接続した。Affect登録、実Provider・本番起動・設定・Auxiliary保存はこの適用に含まない。

## 登録指示のプリセットと本文編集

2026-11-03に採用。Memory二用途はプリセットと編集本文を受け取る用途入力へ適用済み。設定の永続化・編集UI、およびAffect側への適用完了を意味しない。

Character Memory、対象Memory、Affectの三用途は標準の自然言語登録指示を持ち、ユーザーはその本文を直接編集できる。未設定時はプリセット、設定時は編集済み本文をその用途の登録指示として使う。別の追加指示レイヤーやプリセットとの合成ルールは設けない。例えばサブエージェントを使用しない方針は、本文への記述で指定する。

何を根拠に何を記録するか、記録しない条件、登録操作の案内などの登録方針は編集対象に含める。編集内容と同じ方針を、隠れた固定登録指示として重ねて挿入しない。登録指示のカスタマイズ専用の実行経路や、自然言語の禁止指定を機械的な実行禁止へ変換する機構は追加しない。

実行ごとの用途・処理対象・許可履歴・参照材料と、既存のMCP tool schema／利用説明・CLI接続方法は、登録方針本文とは別の実行情報としてアプリが渡す。binding、owner、保存先、認可、入力検証、失効は既存のコード境界で制御し、本文の編集を権限変更として扱わない。接続credentialや内部admissionを編集本文へ埋め込まない。

用途担当はプリセットと編集本文を受け取る用途入力を整え、共通の単発呼出へ渡す。設定の永続化と編集面は共通設定側で接続する。これらの適用時に対応する現行説明を更新し、未接続の設定・実Provider・本番起動を完成扱いにしない。

## 同時上限の撤廃

2026-11-03に採用。採用時点では未適用であり、共通基盤の実装には同時上限が残っている。

背景全体3件および同じ用途×会話1件というアプリ独自の同時上限を撤廃する。これらの上限による起動見送りと、そのためだけの状態・結果分岐を除去し、待機queueや代替の同時数制限は設けない。固定上限を必要とする具体的な負荷条件が定まっていない現状では、上限を維持するために待機処理の責務を追加するより、既存の単発実行を簡素化する。

発火頻度と実行ごとの処理範囲は維持する。Memoryの未開始位置は実開始時に進める設計のままとし、保存成功の証明にはしない。独立binding、用途限定のMCP／CLI登録、owner／保存先／入力の検証、取消・失効、確定済みデータ保護も維持する。実行中の管理は寿命・権限管理に必要な範囲で残し、同時上限の撤廃を理由に一括削除しない。

処理が遅い場合の同時実行数増加や完了順の逆転を許容し、順序調停、自動再送、永続checkpoint、完全回収を追加しない。発火頻度によって同時実行数が制限されるとは保証しない。本判断は本番の発火・処理位置管理やProvider接続の実装完了を意味しない。

### 共通基盤への適用

`BackgroundExecutionService.begin()`の全体件数・用途×会話の実行中チェックと専用の`scopeKey`を除去した。開始した`BackgroundExecution`を直接返し、共通呼出の上限由来の起動見送り結果と利用側分岐も除去した。実行中mapは独立binding／handle／admissionの取消・失効・終了時cleanupに維持し、実開始時の`onAdmitted`通知、固定processing／履歴範囲、用途別認可と保存先は変更しない。

Decisionと直接登録の維持境界にある二つの同時上限・その起動見送りは適用対象外とする。当時の本文は保持する。本番発火・Memory未開始位置管理・実Provider・設定UI・Auxiliary保存の実装完了を意味しない。
