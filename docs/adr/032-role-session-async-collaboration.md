# ADR 032: Role付きSessionの非同期協同に責務を絞る

## Status

Accepted — 2026-09-22。`feat/v6.4.0`への実装適用は未完了。

[Issue #734](https://github.com/natumekazuki/WithMate/issues/734)のユーザー決定を記録する。同日の本文更新によるCoordination維持、GUI限定のRole変更、関連一覧の範囲、v6.4.0／v6.5.0のリリース分離を反映する。コード、公開schema、配布Skill、保存構造が変更済みであることを意味しない。衝突する旧v6.4.0の設計・plan・配布説明より、この判断を優先する。実装の作業範囲・受入条件は同Issueで追跡する。

## Context

完了結果通知の検討から、専用の結果登録・通知不要状態・自動配送・登録漏れ補完をWithMateが持つ必要はないと判断した。Session間のTurn送信と保存結果の取得があれば、AI自身が分担・相談・報告を行い、必要時にはユーザーが介入できる。

従来のv6.4.0では、Session作成・送信・削除等へWorkItem、集約、Delegation、予算、grantが結合していた。これらを維持すること自体を製品要件にせず、WithMateは役割を持つSession同士が協同するための操作と情報を提供する。仕事の分け方・進め方・報告・結果の採否はAIとユーザーが決める。

## Decision

### 撤去する機能

- WorkItem／RootWorkItemの作業契約・進捗・状態・引継ぎ・専用結果登録、集約・採否・訂正・再確定。RootWorkItemの専用編集・進捗参照UIも含む。
- Session・WorkItem・Turnを束ねる独立の複合Delegationオブジェクトと、そのprepare／dispatch／retry／compensate管理。
- WithMate独自の協同予算管理全体。root／子の口座、配分、上限・期限、予約・消費・精算、予算による受付・dispatch停止を含む。
- grant管理全体。発行・再委譲・親grant・上限・期限・失効・consultationと、grantを引数や必須条件にする結合を含む。

UI非表示、任意化、全許可stub、固定grant、Roleからの権限表再生成、「軽量WorkItem」や代替の専用メモ管理による温存はしない。専用UIがあることだけをRootWorkItemの維持・再判断理由にしない。削除対象専用のAPI、型、保存、UI、テスト、配布説明と依存も整理する。複合Delegationを残したまま途中失敗の安全処理だけを削る方法は採らない。

### Coordinationはユーザー向け報告・相談・介入として維持する

複数Sessionの報告を読み、相談に答え、判断を作業へ反映するユーザー体験を維持する。通常会話にも書けることを撤去理由にせず、WorkItemの正式な結果確定・集約やSession間Turnの配送とは責務を分ける。

- `progress`・`decision`・`escalation`・`user_decision_required`・`blocker`・`result`・`correction`の記録・参照と、種別に対応する解決・取消・訂正を維持する。既存のagent間相談・解決も一括削除しない。
- Coordination Windowの全Session横断閲覧、filter、詳細、元Sessionへの移動、ユーザーの選択肢・自由回答と回答変更を維持する。agent向け関連一覧のscopeへGUI閲覧を縮小しない。
- 質問・発信Session・execution・回答revision・訂正元の対応を保持し、未反映回答を通常Turnの入力文脈へ渡す。作業への反映後のconsume、古いrevision拒否、二重消費防止を維持し、blockerへの回答とblocker自体の解決を混同しない。
- agentがユーザー回答を代行・捏造できない境界を守る。回答をsystem instructionへ昇格させず、Role関連注入をロール名だけにする判断を理由に回答文脈を消さない。
- 結果eventの保存は相手への報告Turn送信ではない。event記録から自動配送・自動再開・報告漏れ補完を追加せず、全報告の解決や重複報告をTurn終了の条件にしない。

不要なWorkItem・grant・予算への依存を外しても、上記の操作・回答履歴・未回答／未反映回答と、その保存・競合処理は残す。Coordinationを代替WorkItemや新しい仕事管理へ拡張しない。

### リリース範囲

v6.4.0の#734は、5種類のRole、通常Session間の非同期協同、通常SessionとAuxiliaryの関連一覧、Coordination維持と不要管理の撤去を扱う。WithMate管理Subagentはv6.5.0の[#716](https://github.com/natumekazuki/WithMate/issues/716)へ分離し、6つ目のRoleとして作成・実行・返送・専用Window・保存・lifecycle・共通関連一覧への接続をまとめて追加する。

#716の完了をv6.4.0の条件にせず、通常Session間の非同期協同をSubagentと一緒に延期しない。v6.5.0のためだけの未使用公開操作・仮実装・空の一覧・専用保存構造を先行追加しない。Provider内蔵subagentとその既存表示は、このリリース分離の対象ではない。

### Role、作成関係、相手の発見

- v6.4.0のRoleはStandalone・全体統括・個別統括・Worker・Auxiliaryの5種類。起点の通常Sessionはユーザーが作成時にStandalone／全体統括を選ぶ。
- 通常Sessionの子作成経路は「全体統括 → 個別統括 → Worker」と「全体統括 → Worker」。子Roleは選んだ作成経路から決め、Worker配下への追加階層を設けない。
- 既存の`standalone`／`overall-coordinator`／`task-coordinator`／`executor`識別子を必要な限り使い、呼称のためだけのrenameは行わない。Auxiliaryは自身のRoleを識別するが、全Roleの物理保存形式を統一する要求ではない。
- Auxiliaryはユーザー側の作成経路に限定した補助会話であり、AIが作成したり任意の仕事先へ転用したりしない。所属Mainと実際の作成主体を区別する。
- WithMateが注入するRole関連情報はロール名のみ。役割説明・分担・報告方針はユーザーが管理するCodexのグローバル`AGENTS.md`に置く。WithMateによる解析・複製・同期・自動編集は追加しない。
- Character、Workspace／SessionFolder、Memory／Affect、runtime接続情報、ツール入力契約の説明は、Role説明とは区別して維持する。
- 同じStandalone／全体統括を起点とする通常Sessionと各MainのAuxiliaryを関連一覧に含め、Workerから別枝も発見できる。「関連Session全体」「Role」「直接作成したSession」「直接の作成元」で絞り込めるようにする。
- 起点、所属Main、作成主体・作成元、Role・会話種別を区別する。ユーザー作成の起点やAuxiliaryは作成元Sessionなしとして扱い、Auxiliaryの所属MainのAIを作成者と捏造しない。保存関係を正本とし、callerの申告、画面選択、同じcwdから推測しない。
- 一覧は選択に必要な情報を返し、応答・成果物・詳細設定は必要時に取得する。毎Turnへの全件注入や、検索scopeをgrant代替ACLへ拡張することはしない。
- 共通関連一覧への包含は、手動Auxiliaryへの任意送信許可でもWindow内の一覧統合でもない。Auxiliary切替にはAuxiliaryだけを表示し、Subagentの一覧接続はv6.5.0で行う。

### Standaloneから全体統括への変更はGUIのユーザー操作に限定する

最初は直接作業を任せ、後から分担が必要になっても同じSessionを継続できるようにする。一方、通常Sessionを作成できる委任範囲の拡大はユーザーが判断し、AIは必要性の提案までとする。

- 対象Session自身の非実行時にGUIで明示変更する。Main側で実際のIPC送信元・対象・現在Role・実行状態を検証し、開始／終了との競合を扱う。UIのdisabledや`userInitiated`等の自己申告だけに依存しない。
- MCP・CLI・HTTPには公開せず、dispatch／application boundaryでも拒否する。汎用更新・置換、別root作成・複製、親・所属変更等の到達可能な経路でも自己拡張を迂回させない。operator権限やGUI専用経路をAIへ渡さない。
- チャット本文の同意、Session数、返送結果から自動変更しない。変更の予約、申請・承認管理、汎用Role権限表は追加しない。
- Session ID・起点・会話／Provider thread・Character・snapshot・Workspace／SessionFolder・Auxiliaryの関係とexecutionを維持する。保存済みRoleを次Turnの入力と子作成へ反映し、過去の入力を変更済みとは扱わない。
- 変更だけでTurnや子Sessionを開始せず、Auxiliaryや無関係なSessionの全件終了待ち・停止を要求しない。拒否・競合・保存失敗を成功にせず、未確定Roleで後続操作を行わない。
- 逆変更、全Role相互変換、Auxiliaryの通常Session化は必須範囲に含めない。v6.5.0でSubagentを追加する際も既存Subagentの関係・実行・返送先を維持し、v6.4.0の検証には未実装Subagentを要求しない。

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
- Coordinationの報告・相談・訂正・ユーザー回答と反映確認。Providerのinteraction・承認・質問は別責務として維持し、汎用モデルへ強制統合しない。
- 既存の失敗・中断通知。Provider使用量・quotaの観測、Memory固有の保存契約、通信入力サイズの検証は協同予算とは別である。

残すのは必要な能力とデータ・実行契約であり、旧内部構造そのものではない。Session削除・移管に、撤去するWorkItemの未完了・未回収、集約stale、grant・予算の状態を要求し続けない。一方、実行中処理と保存対象データの保護は維持する。`open_coordination_events`等を同じmanifestにあるだけで削らず、保持する回答・履歴の保全目的と既存の拒否・取消・削除契約を確認する。

### 既存の採用判断との接続

- 通常SessionのGUI・MCP・CLI作成を共通化し、必須の初期Auxiliaryが揃って成功とする方針は維持する。RootWorkItem・grant・予算の同時作成要求は撤回する。作成・commit・取消・失敗処理の細部は、#726の変更がmaster経由で統合された実装を確認してから再検討する。
- Session移管・削除のAuxiliary対象は所属全件とし、選択中・表示中だけに限定しない。通常Sessionのdescendantを含む操作では各Mainに所属する全件を扱う。非表示実行、作成／実行開始との競合、遅延callbackを扱い、stable ID・会話・provider thread・Character snapshotと親Mainへの紐づきを維持する。既存の実行中拒否を全件化のために強制停止へ変えず、停止を伴う既存経路では停止と所有resourceのcleanupを全件へ適用する。共有Workspaceの削除へ範囲を広げない。
- Agentの自己宛direct `turn.run / turn.enqueue`禁止と、外部要因を待つスケジュールの分離は維持する。GUIの追加入力、他Sessionからの受付、失敗通知まで禁止しない。旧grant・予算に依存した実装案は撤回し、GUI操作へAgentを偽装しない具体的なactor／対象境界として扱う。Agent向けschedule APIやAuxiliaryへの接続は実装済みとしない。
- Main／Auxiliaryの共有ActionDock、schedule対象会話IDの固定、通常draftとの分離、非表示発火、同一会話queue、削除済み対象への非振替という採用方針は維持する。grant・予算を復活させる根拠にはしない。

## 関連判断の置換範囲

| 対象 | 今回の扱い |
| --- | --- |
| ADR 026 | 保存関係・actor identityを維持し、5種類のRoleとロール名のみの注入、GUI限定のStandalone→全体統括変更を採用。Roleの全面immutable扱いをこの明示変更に限って置換し、汎用Role権限管理へ広げない |
| ADR 027 | Coordinationの報告・相談・解決・訂正・横断閲覧・回答反映は維持。旧業務報告撤去判断を撤回し、不要なWorkItem・grant・予算への依存だけを外す。ユーザー専用回答と保存・競合境界は維持 |
| ADR 028・031 | WorkItem／RootWorkItemと結果集約を機能ごと撤去する判断へ置換 |
| ADR 029 | grantと撤去機能専用の履歴管理を置換。actor確認、個別操作の保存・冪等性・副作用の区別まで一括撤去しない |
| ADR 030 | ユーザー指定由来の旧初期policyを含め、協同予算管理を全撤去する判断へ置換 |
| #724 | 専用成功結果通知は不採用としてClose。実装完了ではない |
| #716 | 更新済み本文を正本とし、WithMate管理Subagent関連はv6.5.0へ分離。過去コメントによる旧本文の読み替えは不要 |

WithMate管理Subagentは通常のRole付きSessionのWorkerと同一視しない。v6.5.0ではStandaloneを含むMainの4Role／手動Auxiliaryから依頼でき、Subagent利用だけのための全体統括への変更は要求しない。再委譲禁止、親会話・要約の自動継承なし・プロンプトと明示添付、Provider・Model等の明示指定、独立したCharacter／会話／execution、作成＋初回依頼の入口、所属Mainごとに一つの専用Window・共通chat、表示やWindow closeに依存しない実行、手動介入・取消を維持する。

Subagentは同じ起点配下の共通関連一覧・状態／結果参照へ接続し、実際の作成元／依頼元MainまたはAuxiliaryを保持する。手動Auxiliaryを任意の仕事先へ転用せず、実際に依頼したAuxiliaryへその結果を返す経路を接続する。所属Mainのidentityへ読み替えず、この返送要件をAuxiliaryへの任意の作業送信許可へ広げない。これらの追加・検証は#716で扱い、v6.4.0の必須条件へ追加しない。

#715のOSコマンドジョブや#721のProvider接続・注入方式の変更は別件であり、この判断で廃止・必須依存化しない。#725／#726／#728〜#733の別branch対応を、v6.4.0へ反映済みとみなさない。

## 適用とデータ保護

機能撤去は利用環境のDB再作成や会話・成果物の破棄許可ではない。着手時に統合後の規約と互換性・実データの維持境界を確認する。旧管理オブジェクト内にしかない本文等の扱いが未定義なら、その変更前に対象を限定して確認し、機能自体の温存・再判断へ置き換えない。Coordinationの報告・訂正・回答履歴、未回答・未反映回答は維持する。#729のCompanion専有データ削除承認を転用しない。未リリース途中状態だけのためのmigration・常設互換層も自動的に要求しない。AuxiliaryのSubagentへの再分類や、全Standaloneの自動変更は行わない。

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
- [#716: v6.5.0のWithMate管理Subagent](https://github.com/natumekazuki/WithMate/issues/716)
