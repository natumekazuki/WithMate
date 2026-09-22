# ADR 032: Role付きSessionの非同期協同に責務を絞る

## Status

Accepted — 2026-09-22。`feat/v6.4.0`への実装適用は未完了。

[Issue #734](https://github.com/natumekazuki/WithMate/issues/734)のユーザー決定を記録する。コード、公開schema、配布Skill、保存構造が変更済みであることを意味しない。衝突する旧v6.4.0の設計・plan・配布説明より、この判断を優先する。実装の作業範囲・受入条件は同Issueで追跡する。

## Context

完了結果通知の検討から、専用の結果登録・通知不要状態・自動配送・登録漏れ補完をWithMateが持つ必要はないと判断した。Session間のTurn送信と保存結果の取得があれば、AI自身が分担・相談・報告を行い、必要時にはユーザーが介入できる。

従来のv6.4.0では、Session作成・送信・削除等へWorkItem、集約、Delegation、予算、grantが結合していた。これらを維持すること自体を製品要件にせず、WithMateは役割を持つSession同士が協同するための操作と情報を提供する。仕事の分け方・進め方・報告・結果の採否はAIとユーザーが決める。

## Decision

### 撤去する機能

- WorkItem／RootWorkItemの作業契約・進捗・状態・引継ぎ・専用結果登録、集約・採否・訂正・再確定。
- Session・WorkItem・Turnを束ねる独立の複合Delegationオブジェクトと、そのprepare／dispatch／retry／compensate管理。
- Coordinationの業務報告台帳。ユーザーへの質問・確認・承認や実行状態の観測・会話への移動は分離して残す。
- WithMate独自の協同予算管理全体。root／子の口座、配分、上限・期限、予約・消費・精算、予算による受付・dispatch停止を含む。
- grant管理全体。発行・再委譲・親grant・上限・期限・失効・consultationと、grantを引数や必須条件にする結合を含む。

UI非表示、任意化、全許可stub、固定grant、Roleからの権限表再生成、「軽量WorkItem」等による温存はしない。削除対象専用のAPI、型、保存、UI、テスト、配布説明と依存も整理する。複合Delegationを残したまま途中失敗の安全処理だけを削る方法は採らない。

### Role、作成関係、相手の発見

- 協同の作成経路は「全体統括 → 個別統括 → Worker」と「全体統括 → Worker」。Roleは選んだ作成経路から自動決定する。汎用Role編集やWorker配下への追加階層を設けない。
- 既存の`overall-coordinator`／`task-coordinator`／`executor`識別子を必要な限り使う。呼称のためだけのrenameや、通常会話・`standalone`の一律撤去は行わない。
- WithMateが注入するRole関連情報はロール名のみ。役割説明・分担・報告方針はユーザーが管理するCodexのグローバル`AGENTS.md`に置く。WithMateによる解析・複製・同期・自動編集は追加しない。
- Character、Workspace／SessionFolder、Memory／Affect、runtime接続情報、ツール入力契約の説明は、Role説明とは区別して維持する。
- 同じ全体統括を起点とする作成tree全体をWorkerからも検索でき、「関連Session全体」「直接作成した子」「直接の作成元」で絞り込めるようにする。保存済み作成関係を正本とし、callerの申告、画面選択、同じcwdから推測しない。
- 一覧は選択に必要な情報を返し、応答・成果物・詳細設定は必要時に取得する。毎Turnへの全件注入や、検索scopeをgrant代替ACLへ拡張することはしない。

### 通常Turnによる非同期協同

1. AはBへのTurn送信の受付結果とexecution IDを確認する。相手の仕事の完了までMCP呼び出しやProvider Turnを保持する必要はない。
2. Aに独立した仕事がなければ現在のTurnを終了する。受付済みのBのexecutionは、Aの通常Turn終了を理由に取消・破棄しない。Session削除・archive・アプリ終了とは別で、WithMateは起動している前提とする。
3. Bは報告が必要な段階でMCPからAへ通常のTurnを明示送信する。Bが自分の最終応答を保存しただけでは、Aへの送信済みと扱わない。
4. WithMateは既存の共通queueで受け付け、ユーザーの追加SendなしでAの次Turnを開始する。Aの実行中・終了処理中も順序と直列実行を守り、取りこぼし・二重起動を防ぐ。
5. Bが報告しなかった場合、ユーザーがAへ結果確認を指示すると、Aが保存済みexecution・応答・成果物を取得して続行できる。保存結果で足りればBの仕事や報告専用AIを再実行せず、不足時だけ追加質問する。

依頼・相談・追加指示・報告は同じ送信基盤を使う。送信元、明示した宛先、execution参照を保持し、受信内容を新しいユーザー命令や上位指示へ偽装しない。報告の必要性・内容・時期は依頼文とグローバル`AGENTS.md`の運用方針で扱い、無条件の毎Turn報告や確認応答の往復を強制しない。

成功結果専用の登録、通知policy／通知不要状態、自動代理配送、最終応答fallback、報告漏れ補完AI、定期回収AI、全件完了待ち・JoinGroupは追加しない。アプリ内部のqueue処理は、モデルを定期的に起こすポーリングとは異なる。

### 維持する境界

- Sessionの作成・参照・設定変更・整理・削除、Turn受付・状態取得・取消、会話・成果物の回収。
- runtime bindingによる実際のactor確認、対象の存在・種別・所有関係、IPC／filesystem境界、ユーザー専用承認、Provider自身のapproval／sandbox。
- 個別操作の冪等性・永続化・直列実行・取消・必要な再起動時の収束。受付失敗、適用済み結果、副作用不明を区別する。
- Characterと会話の継続性、Memory／Affect、手動Main／Auxiliary、実行状態の観測・介入・停止。
- 既存の失敗・中断通知。Provider使用量・quotaの観測、Memory固有の保存契約、通信入力サイズの検証は協同予算とは別である。

残すのは必要な能力とデータ・実行契約であり、旧内部構造そのものではない。Session削除・移管に、撤去するWorkItemの未完了・未回収、集約stale、業務報告、grant・予算の状態を要求し続けない。一方、実行中処理と保存対象データの保護は維持する。

### 既存の採用判断との接続

- 通常SessionのGUI・MCP・CLI作成を共通化し、必須の初期Auxiliaryが揃って成功とする方針は維持する。RootWorkItem・grant・予算の同時作成要求は撤回する。作成・commit・取消・失敗処理の細部は、#726の変更がmaster経由で統合された実装を確認してから再検討する。
- Session移管・削除のAuxiliary対象は所属全件とし、選択中・表示中だけに限定しない。通常Sessionのdescendantを含む操作では各Mainに所属する全件を扱う。非表示実行、作成／実行開始との競合、遅延callbackを扱い、stable ID・会話・provider thread・Character snapshotと親Mainへの紐づきを維持する。既存の実行中拒否を全件化のために強制停止へ変えず、停止を伴う既存経路では停止と所有resourceのcleanupを全件へ適用する。共有Workspaceの削除へ範囲を広げない。
- Agentの自己宛direct `turn.run / turn.enqueue`禁止と、外部要因を待つスケジュールの分離は維持する。GUIの追加入力、他Sessionからの受付、失敗通知まで禁止しない。旧grant・予算に依存した実装案は撤回し、GUI操作へAgentを偽装しない具体的なactor／対象境界として扱う。Agent向けschedule APIやAuxiliaryへの接続は実装済みとしない。
- Main／Auxiliaryの共有ActionDock、schedule対象会話IDの固定、通常draftとの分離、非表示発火、同一会話queue、削除済み対象への非振替という採用方針は維持する。grant・予算を復活させる根拠にはしない。

## 関連判断の置換範囲

| 対象 | 今回の扱い |
| --- | --- |
| ADR 026 | 保存済みRole・作成関係・actor identityは維持し、Role関連注入はロール名のみとする。作成経路の整合性を汎用Role権限管理へ広げない |
| ADR 027 | 業務報告管理を撤去する判断へ置換。ユーザーだけが回答する質問・確認・承認は維持 |
| ADR 028・031 | WorkItem／RootWorkItemと結果集約を機能ごと撤去する判断へ置換 |
| ADR 029 | grantと撤去機能専用の履歴管理を置換。actor確認、個別操作の保存・冪等性・副作用の区別まで一括撤去しない |
| ADR 030 | ユーザー指定由来の旧初期policyを含め、協同予算管理を全撤去する判断へ置換 |
| #724 | 専用成功結果通知は不採用としてClose。実装完了ではない |
| #716 | 指定コメントと#734が旧本文の成功通知・grant／budget・Role説明要求を置換。Subagent自体は別Issueとして維持 |

WithMate管理Subagentは通常のRole付きSessionのWorkerと同一視しない。Main／手動Auxiliaryから依頼できること、Subagentの再委譲禁止、親会話・要約の自動継承なし・プロンプトと明示添付、Provider・Model等の明示指定、独立したCharacter／会話／execution、作成＋初回依頼の入口、所属Mainごとに一つの専用Window・共通chat、表示やWindow closeに依存しない実行、手動介入・取消を維持する。手動Auxiliaryを任意の仕事先へ転用せず、実際に依頼したAuxiliaryへその結果を返す経路を接続する。親Mainのidentityへ読み替えず、この返送要件をAuxiliaryへの任意の作業送信許可へ広げない。#716全体をv6.4.0の必須条件へ追加しない。

#715のOSコマンドジョブや#721のProvider接続・注入方式の変更は別件であり、この判断で廃止・必須依存化しない。#725／#726／#728〜#733の別branch対応を、v6.4.0へ反映済みとみなさない。

## 適用とデータ保護

機能撤去は利用環境のDB再作成や会話・成果物の破棄許可ではない。着手時に統合後の規約と互換性・実データの維持境界を確認する。旧管理オブジェクト内にしかない本文等の扱いが未定義なら、その変更前に対象を限定して確認する。#729のCompanion専有データ削除承認を転用しない。未リリース途中状態だけのためのmigration・常設互換層も自動的に要求しない。

公開API・配布Skillは、実装と同じ論理変更で不要な引数・操作・仕事手順を除去する。本ADRの採用だけを理由に、未変更のruntimeが新契約に対応済みと案内しない。現在の説明は各branchの実装に対応させる。

旧plan等の作業資料は#728／#734の保存方針に沿って整理し、Archive・移転stub・ADRへの丸ごと転載で温存しない。このADRは採否と置換理由の記録であり、作業計画・検証ログの保管先ではない。統合時は#730の最新配置・symbolと実際のownerを確認し、旧pathの復活や別の保存・queue基盤の二重化を避ける。

## Alternatives and consequences

- WorkItemやgrantを任意機能として残す案は、不要な管理対象・手順・依存を維持するため採用しない。
- 最終応答の代理配送や報告漏れ補完は、報告内容と運用判断をアプリが再び所有するため採用しない。
- AIが必ず報告する保証は置かない。AIが実際に送ったTurnの消失・誤配送・受付後に実行へつながらないことは、基盤の不具合として区別する。
- Characterの存在感、複数の相手を観測・介入できる体験は維持し、CLIの薄いGUIへ戻すことを目的としない。

## References

- [#734: v6.4.0の非同期協同基盤への整理](https://github.com/natumekazuki/WithMate/issues/734)
- [#724: 専用完了通知を採用しない結論](https://github.com/natumekazuki/WithMate/issues/724#issuecomment-5772973699)
- [#716: 維持するSubagent要求と置換範囲](https://github.com/natumekazuki/WithMate/issues/716#issuecomment-5772984362)
