# ADR 035: 背景実行のbindingと履歴read scopeを分離する

## Status

Accepted

背景のfile／exportを許可しない従前の範囲は、[背景Memoryの添付と必要時復元](#背景memoryの添付と必要時復元)の後継判断で置き換える。Memory target認可と呼出ごとのfile認可は維持・分離する。

登録を一件の公開入力へ限定する範囲とAffectの候補件数上限は、[一括登録と件数上限](#一括登録と件数上限)の後継判断で置き換える。既存項目単位の保存・認可・原子性は維持する。

三用途に共通するcheckpointと保存確定・復旧の判断は、[適用範囲](#適用範囲)の後継判断で置き換える。#909のCharacter Memory・対象Memoryに固有の開始位置と保存停止の扱いは[#909後継判断](#909-memory記録の後継判断)に定める。共通binding／履歴read／admissionと既存データ保護の判断は維持する。

2026-11-03に、三用途の専用構造化finalとnative完了後の保存phaseを[背景実行内の直接登録](#背景実行内のmcpcli直接登録)へ置き換える判断を採用した。現在の適用範囲は末尾の[共通基盤への適用](#共通基盤への適用)に示す。以下の従前判断の本文は保持する。

同日の後継判断として、背景全体3件・用途×会話1件という同時上限の条項は[同時上限の撤廃](#同時上限の撤廃)で置き換える。直接登録、認可、実行寿命、データ保護の判断は維持する。

同日の[共通Provider実行とDepth](#共通provider実行とdepth)により、本番共通接続時点のClaude専用portと背景だけの機械的完全隔離は適用対象外とする。当時の本文は保持する。

2026-11-05の[登録内容と失敗診断](#登録内容と失敗診断)により、失敗を既知codeと定型の短い原因だけへ限定する方針は適用対象外とする。失敗専用ファイル・通常成功を記録しない運用と、認可・保存済みデータ保護は維持する。

2026-11-06の[背景native threadの継続](#背景native-threadの継続)により、呼出しごとのnative thread破棄、同source・用途の並行送信、生成・登録対象をprocessing区間で固定する条項は適用対象外とする。当時の本文を保持し、呼出しごとのbinding／認可／失効と保存済みデータ保護は維持する。

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

## 本番共通接続への適用

共通runtimeへ三用途のAppSettings・編集面、Claude専用単発Provider port、Main／Auxiliary共通のsource capture／read、保存成功後terminalと会話実行状態・設定変更・停止の購読接点を接続した。登録本文未設定時だけ用途presetを使い、空文字列を含む編集本文は単独で渡す。通常会話のthread・選択・出力は変更しない。

Providerの機械制限はSDK設定と同一bindingのmanaged MCPで行い、制限を保証できないProvider・構成へfallbackしない。共通source対応と用途保存対応は区別し、三用途の現行handlerはMainだけを有効にする。用途controllerの購読・自動発火・未開始位置管理、Auxiliaryの保存意味・store対応、実認証推論の確認はこの適用範囲へ含めない。現行APIと制限は[Background Execution](../design/background-execution.md#本番共通runtimeとprovider)を正本とする。

## 三用途の統合への適用

2026-11-03に#888の同時上限撤廃、#909のMemory二用途、#910のAffect直接登録を統合した。Main runtimeは三用途のhandlerと実WorkerのMain source readを共通登録portへ接続する。Affectは保存済み終端Turnのprocessing／履歴所属を検証し、保存時刻をそのTurnの完了時刻から決め、既存のappraiseへ渡す。旧構造化final・専用後段保存と、その専用fixtureを除去した。

三用途ともプリセットと編集本文を受け取る用途入力を持つ。共通基盤・Memory二用途の適用時点に記したAffect未接続・本文編集未適用という範囲は、この統合により置き換える。当時の記述は履歴として保持する。実Provider、本番発火・Memory未開始位置管理、設定の永続化・編集UI、通知、Auxiliary保存は未接続であり、本統合による実装完了とは扱わない。

## Memory二用途の本番発火とAuxiliaryへの適用

2026-11-03に、Memory二用途のcontrollerを既存本番イベント・prepare／runOnceへ接続した。会話owner×用途のインメモリ開始位置とone-shot idleを使い、実保存済み終端Turnの件数を既存頻度で判定する。位置は同期onAdmittedで進め、Agent完了を待たず新規範囲を並行開始する。初回・再開で過去を一括処理せず、最初の新規terminal通知は未開始対象として保持する。

Auxiliary登録は既存のMemory／episodeサービスとWorkerを利用する。Main専用の出典FKとepisode scope確認だけでは実Auxiliaryを扱えないため、ユーザー承認に基づき既存MemoryへnullableなAuxiliary出典FKを追加し、実bindingによるepisodeの会話確認を利用する。Mainの出典欄や親IDへ付け替えず、通常明示操作と既存保存データ・忘却を維持する。別DB・同等application・別toolは作らない。

この適用はMemory二用途に限り、共通接続時点のMemory controller／Auxiliary未接続という適用範囲を置き換える。Affect controller・Auxiliary保存、追加Provider、実認証による推論確認の完了は意味しない。現行の接続契約は[Background Execution](../design/background-execution.md#memoryの自動発火と開始位置)に示す。

## 共通Provider実行とDepth

2026-11-03に採用・適用。三用途とも既存Codex／Copilot／Claude／OpenCode adapterを共用する。通常会話のSessionはsource・認可・workspace・通常policyの文脈として維持し、共通層が背景binding IDと新規threadの独立実行先を渡す。元threadを再開・更新せず、出力・progressを元会話へ適用しない。偽の永続Session、用途別SDK engine、thread監視・比較・復元は追加しない。

用途別Provider／Model／任意のDepth（既存reasoningEffort型）と登録本文を開始準備で固定する。通常会話・別用途へfallbackせず、Depthは既存catalogとnative写像を使う。本文未設定時だけpresetを用い、空を含む編集本文へ隠れた登録方針を重ねない。

背景だけの絶対的機械隔離、独自env allowlist、全tool／skill／plugin／hook／native設定の無効化、managed／custom構成の一律拒否を廃止する。行動・tool使用方針は編集本文に集約し、自然言語を使用不能の技術保証とはしない。通常approval／sandbox／管理者policyは維持し、背景だけの自動承認を加えない。

WithMateの履歴範囲・owner／保存先・入力・用途operation grantは行動制限ではなく、trusted sourceからのアクセス認可とデータ保護として維持する。独立binding、失効後の未確定write拒否、確定済み保存保持、同用途並行、主Cancel／Window closeからの独立も維持する。

#909と#910の本番controller、Main／Auxiliary登録・contextを共存させた。Memory出典列追加とAffect owner schema再構成は既存行・ID・link・versionを保持する。通常Auxiliary手動Affect owner公開APIは拡張しない。実認証推論と統合先branchへの適用は、この担当branchの実装・fake transport検証とは区別する。現行契約は[Background Execution](../design/background-execution.md)に示す。

## 用途別権限・非対話終了・失敗ログ

2026-11-04に採用。背景のProvider固有実行設定は元Main／Auxiliaryから継承せず、用途別に選択したProviderの既存既定・候補・組合せ検証を使う。SettingsからApproval／Reviewer／Sandboxを対応する範囲で指定し、開始時に捕捉する。SpeedはStandard、custom agentは未指定で明示構築する。通常Providerの承認・sandbox・管理者policyは維持し、背景専用の全許可既定や実行中の権限拡大を行わない。

アプリへ人の承認・追加回答要求が届いた背景だけを非対話で終了し、native cleanup後に理由を区別した失敗を返す。Provider内の自動審査は通常の処理として扱う。通常取消と正常な保存対象なしは失敗へ置換しない。既知の読取・登録失敗は共通呼出しへ伝え、Agentが終了した事実だけで保存成功や正常な対象なしへ読み替えない。確定済み保存は維持する。

背景の失敗だけを`logs/background-failures.jsonl`へ追記し、回転・切詰め・自動削除は行わない。通常ログの5MiB・5ファイルは維持する。診断項目と安全な短い原因だけを残し、本文・credential・raw例外を保存しない。重複記録は既存呼出境界の責務で避け、台帳・DB・queue・viewerを追加しない。

共通Provider実行時点のsource権限継承とcallback省略による拒否の扱いは本判断で置き換える。当時の本文は保持する。独立binding・元thread非再開・認可・データ保護と直接登録は維持する。現行実装は[用途別権限と非対話終了](../design/background-execution.md#用途別権限と非対話終了)と[失敗ログ](../design/app-log-base.md#background-failure-log-policy)に示す。

## 登録内容と失敗診断

三用途の登録本文は自身の目的・材料・判断・登録・終了条件から構成し、自然言語の分量制限を設けない。Character Memoryには実Characterの定義を参照材料として渡し、観察事実と本人の解釈を区別した本人の語りを保存する。共通Provider systemでその語りを否定しない。編集本文によるプリセット置換と、保存済み編集本文の保護を維持する。

失敗の定型分類だけでは操作の拒否理由や、失敗と同じ実行で確認できた保存を追えないため、既存実行寿命に操作の要求・応答metadataと選別・秘匿化した原因を保持する。実行が失敗した時だけ既存の専用JSONLへ出し、正常な成功実行の恒久履歴や新規台帳・DB・再送queueは設けない。途中失敗後の保存成功は診断材料であり、全体の失敗を成功へ変えない。会話・prompt・tool引数や応答本文の無差別dumpは行わず、診断に必要な実code／message・検証箇所・期待条件・cause／stackと保存識別情報を選ぶ。認証情報を秘匿化し、原因情報を恣意的な短文化で落とさない。現行仕様は[Background Execution](../design/background-execution.md)と[App Log Base](../design/app-log-base.md#background-failure-log-policy)に示す。

## 背景native threadの継続

元会話Sessionの実identityと用途ごとに、現在のアプリruntime内だけでProvider native threadを継続する。同じthreadへの送信は直列化し、実行中の新しい発火を次回へ残す。別source・用途を全体で直列化せず、永続queueや全体同時上限を追加しない。Provider選択の変更は旧実行を取消し、新Providerの新threadへ切り替える。遅延した旧完了・旧設定snapshotで新状態を上書きしない。

native文脈と呼出ごとのbinding／credential／scopeの寿命を分ける。resumeには現在の接続情報を渡し、各呼出終了で認可を失効させる。native履歴は文脈として利用できるが、現在の保存状態・権限の正本とはしない。失敗しても利用可能なthreadは保持し、次の会話Turnによる用途発火へ失敗事実と新しい材料を渡す。即時の自動retryや、失敗を全件未保存とする補償は行わない。

発火頻度の位置はAIの処理済み範囲と分離し、生成・登録対象をアプリのprocessing区間へ固定しない。AIは認可された保存済みhistory内で必要な会話・操作結果・既存記録・過去Turnの再検討を選ぶ。実source・owner・Character・許可target・terminal Turn・履歴末尾windowと失効write拒否は維持する。再起動後は継続状態を復元せず、新しい会話Turnから新threadを開始する。既存Memory／Affectを削除・再生成せず、独自の完了台帳・hash・再送DBは設けない。現行仕様は[Background Execution](../design/background-execution.md#native文脈の継続と失敗情報)に示す。

## 背景Memoryの添付と必要時復元

2026-11-06、ユーザー承認により採用。背景target-memoryの既存append.filesと、三用途の許可されたMemory参照に必要な既存get_file／export_filesを接続する。従前のfile／export一律除外はこの範囲で適用対象外とし、当時の本文は保持する。新しいstore・復元API・台帳は設けず、既存Protected Objectの検証・暗号化・quota・原子保存・idempotencyを利用する。

Memory targetの許可だけではElectron側のfile I/O権限を証明しないため、毎呼出のbindingへfile scopeを捕捉する。取込はsource Workspace・許可Additional Directory・既存SessionFolder、復元はそのSessionFolder内memory-exportsだけに限定する。AuxiliaryのSessionFolderは既存の親Main共有を用いる。書込不可の用途設定では復元を拒否し、全FS設定でもtool上限は拡大しない。実体pathと現在admissionをI/O境界で確認し、root外のsymlink／junction、既存出力の上書きを拒否する。

添付選択・必要時復元はAIの判断とし、本文は添付なしでも主題・保持理由を理解できる形を保つ。継続threadの過去応答や失敗事実を機械的な再添付・再exportの根拠とせず、確定済み保存を維持する。復元の応答喪失を未実行扱いで自動retryしない。現行仕様は[Background Execution](../design/background-execution.md#背景memoryの添付と必要時復元)を正本とする。

## 一括登録と件数上限

2026-11-06の追加要求により採用。通常MemoryとCharacter Memoryは同じ既存公開操作へ非空のentry／episode配列を渡せるようにし、Affect候補の最大10件を撤廃する。登録件数・呼出回数に別の固定上限を設けず、記録の粒度と必要件数はAIが判断する。本文・添付等の項目単位制約と通信・Provider・認可の制限は維持する。

公開tagで成立している単件入力／応答は保持し、同じ操作の代替配列形式として追加する。項目入力を事前検証し、入力順に既存単件保存を利用する。失敗・結果不明・共通実行条件喪失で停止し、indexごとに確定済・失敗・未実行・結果不明を返す。既存item idempotencyとentry添付原子性を維持し、先行確定分を巻き戻さず、新batch DB・台帳・永続queue・全件transaction・即時全体再送を設けない。現行契約は[Background Execution](../design/background-execution.md#一括登録と項目別結果)を正本とする。

## 実行終了状態と操作診断の分離

2026-11-08に採用。入力拒否後に同じAgent実行内で登録できた呼出も、一度の操作失敗によって全体がfailedになる記録では、実行終了と操作成否を区別できない。このため「登録内容と失敗診断」の途中失敗後も全体失敗を維持する判断は、本項の適用対象では置き換える。当時の本文は履歴として保持する。

completed／failed／canceledはAgent呼出・開始処理・取消の終了状態とし、操作拒否を全体failedへ固定しない。既存の操作列と登録応答の選別済みreceiptを正本に、拒否・部分保存・後続成功を保持する。全拒否でAgentが正常終了しても保存成功や登録不要とは判定せず、後続成功だけで回復済みとも判定しない。Provider自体の実原因と取消を先行する操作拒否で上書きしない。

既存専用JSONLへ、実行自体の失敗または操作エラーがある呼出の終端診断だけを一度記録する。開始済みのkindをbackground.execution.diagnosticとし、実行自体の失敗はerror、操作エラーを含む正常終了・取消はwarnで終了状態と操作列を併記する。旧行・append-only・rotationなし・秘匿化を維持し、正常実行全履歴や新規DB・台帳・回復判定・再送queueは追加しない。

前回材料も実行終了状態と操作診断を分け、completedだけで操作エラーを捨てない。次回の正常終了かつ操作エラーなしで直近診断を解放する。既存のnative文脈・sourceとProviderの寿命、onAdmittedの発火位置、認可・失効・確定済み保存保持は変更しない。現行契約は[Background Execution](../design/background-execution.md#失敗の記録)と[App Log Base](../design/app-log-base.md#background-failure-log-policy)を正本とする。
