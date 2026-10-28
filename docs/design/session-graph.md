# Session Graph

Session Graphは要求、制約、判断、活動、観測、未解決事項とその関係を、会話本文とは独立して保持する。AIは必要範囲を取得・更新し、人は同じ正本から生成された図を閲覧する。会話の自動要約や、既存SessionFolderのmmdの自動取込みは行わない。

## 所有と保存

正本は既存Storage Workerが所有するV6 SQLiteの`session_graphs_v6`、`session_graph_topics_v6`、`session_graph_records_v6`、`session_graph_relations_v6`である。schemaの定義は`src-electron/storage/database-schema-v6.ts`、操作の型と入力schemaは`src-shared/session-graph/`を参照する。

親Main SessionのIDとincarnationが所有境界で、MainとそのAuxiliaryは同じGraphを共有する。WorkspaceやCharacter名の一致では共有しない。親Mainの削除はforeign keyのcascadeでGraph全体を削除する。AuxiliaryのClose、表示切替、WindowのCloseでは削除しない。SessionFolder内の既存fileの保持・cleanupは[Session Local Files](session-local-files.md)に従う別の境界である。

## 記録

Topicはstable IDと表示名を持つ。Recordは親Graph内で一意のstable ID、topic ID、kind、短いtitle、Markdownのdetail、適用範囲scope、内容上の主体actorを持つ。titleは図の要点であり、重要な限定を落とした自動要約には置き換えない。

| kind | 状態 |
| --- | --- |
| `requirement` | 要求本文。完了状態を判断・活動と共有しない |
| `constraint` | 制約本文 |
| `decision` | adoption: `proposed` / `accepted` / `declined` |
| `activity` | progress: `planned` / `in_progress` / `completed` / `paused` / `canceled`。必要ならresultも保持 |
| `observation` | result: `reported` / `checked` / `passed` / `failed` / `not_run` / `unknown` |
| `issue` | resolution: `open` / `resolved` |

状態は省略できる。context選択ではissueの省略をopen、activityの省略をplannedとして扱うが、UIで確認済みの状態を創作しない。全kindに任意のvalidity `superseded` / `withdrawn`を持たせ、未指定を現行とする。活動の完了、結果の成功、論点の解消、判断の採用は別々の情報である。

actorは同じ親Graphに属するMain/AuxiliaryのSession ID、またはユーザー等を示すlabelで指定する。`User`等のlabelは要求者・判断者といった内容上の主体であり、その人がGraphへ直接書き込んだことを示さない。ユーザー向けの書込UIは設けず、agentがMCPから記録する。記録者`recordedBy`とCharacter snapshotはWithMateが信頼済みSessionから付与し、入力では受け付けない。初回の記録者・作成時刻と、同じactorのsnapshotは更新でも保持する。他Auxiliaryによる更新やCharacterの後の変更で初回帰属を付け替えない。snapshotのiconは既存Character資産への参照であり、画像fileの複製・永久保存はしない。

任意のtargetは対象revision、実施条件、観測日時をまとめて保持する。これはサーバーが付ける作成・更新日時と区別する。referencesは`evidence` / `artifact` / `handoff`の役割、表示名、参照先を持ち、全recordへ一律のSource欄を要求しない。

自由項目`fields`にはJSON objectを許可する。入れ子、配列、文字列、有限数、boolean、nullを保持し、定型項目・状態・帰属・認可を上書きしない。自由項目は詳細でそのまま読み、任意pathのqueryや自動状態判定には使用しない。

Relationはstable ID、from/to record ID、kind、任意の表示labelを持つ。両端は同じ親Graph内で解決し、Topicをまたげる。依存と実行順を混同しない。

| kind | 向きと意味 |
| --- | --- |
| `fulfills` | 活動 → 満たす要求 |
| `constrains` | 制約 → 制約を受ける対象 |
| `supports` | 根拠 → 支持する判断・対象 |
| `checks` | 観測 → 確認した対象 |
| `depends_on` | 依存する側 → 必要な側 |
| `supersedes` | 後継 → 置換前 |
| `related` | その他の関連 |

Relationだけで状態を自動変更しない。置換では後継との関係と、旧recordのvalidityを同じbatchで更新する。元の判断本文を削除して後継だけへ置き換えない。

## MCPと更新

`withmate-session-graph`はMemory・Glossaryと同じmanaged HTTP MCP hostを利用する。Codex、Copilot、Claudeのprovider turnへ専用endpointを渡し、既存binding・turn capabilityから呼出元と親scopeを解決する。入力で親Session、記録者、Character、権限を選ばせない。書込みは有効なturnに限り、Workerのtransactionでownerのincarnation・actorの所属・turn失効を再確認してcommitする。

| tool | 用途 |
| --- | --- |
| `session_graph.list_topics` | 話題を列挙する |
| `session_graph.recent` | 検索語なしで最近作成・更新されたrecordを読む。`limit: 1`は最新1件 |
| `session_graph.context` | 現行の要求・制約・採用判断・未解決issue・未完了activityと、必要な依存・根拠を読む |
| `session_graph.get` | 既知IDの詳細と関係を読む |
| `session_graph.search` | title/detailを文字列検索する |
| `session_graph.apply` | expectedRevision付きの原子的batch更新 |

recent/context/searchはtopic、actorSessionId、recordedBySessionId、kind、種別ごとの状態で任意に絞れる。これらは認可済み親scope内の読取条件であり、共有権限を増やさない。SQL、独自query言語、自由項目の任意path条件は提供しない。

contextは絞り込みに一致する現行recordを起点に、outgoing `depends_on`の必要先とincoming `supports` / `checks`の根拠を再帰取得する。循環で停止しなくならないよう重複を除く。必要先は別Topicでも保持する。絞り込まれたcontextやrecent N件を、親Graph全体の有効条件と同一視しない。

読取はrevision、total、offset、hasMore、incompleteを返す。recordはサーバー更新日時の降順で返し、観測日時の新旧では並べない。関係は返却recordに接続するものと表示外endpointの要点を返し、record読取の`relationsTruncated`はそのpageの関係を取得上限で切り詰めた場合だけtrueになる。UIはpage間でこのflagを保持し、累積関係数ではなく実際の欠落に基づいて警告と集約可否を決める。record pageと関係の取得上限を区別し、部分取得を完全なGraphに見せない。続きの取得には同じexpectedRevisionを渡し、途中更新はconflictとして再取得する。

applyはtopic/record/relationのupsertとrelation解除を1transactionで処理し、1batchにつきrevisionを1増やす。recordの更新は指定IDの内容全体を置き換えるため、更新前に必要なIDをgetする。expectedRevision不一致では保存せず、現在revisionを返す。影響するIDを再取得してから再試行し、古いGraph全体で他者の変更を上書きしない。任意record/topic削除toolは設けず、撤回・置換と親削除を使う。通信やcommit後の応答に失敗した場合、結果不明を成功・未保存のどちらにも決めつけず、再取得して確認する。

## 閲覧UI

展開したSession headerの`Graph`で中央previewを開き、`Back To Chat`で会話へ戻る。再度Graphを押しても閉じない。Graphを開いた後にヘッダーを折り畳んだ場合、会話へ戻るとヘッダーの展開操作へfocusする。隣の`Open Graph In New Window`またはCtrl/Cmd付きのGraph操作は、元の表示を変えずに独立Windowを追加する。Graphは閲覧専用で、作成・編集・位置調整を人へ要求しない。

中央と独立Windowは同じ図componentを使う。各ビューの話題、選択記録、倍率、scrollは独立し、別窓作成時だけ初期値を引き継ぐ。同じ親・話題の複数Windowも許可し、新規作成と既存Windowのfocusを区別する。展開区間の履歴は各ビュー内に保持し、新しいWindowは選択記録の近傍または話題の俯瞰から開く。中央の会話復帰では入力、最後のGraph位置と展開区間を保持し、file/Templateとの切替は既存の離脱確認を通す。Main/Auxiliaryの選択や送信先は変えない。

関連記録を辿った場合だけ、詳細内の`Back To <記録名>`から元の話題・記録・倍率・scrollへ戻れる。直接の話題・記録選択と詳細dismissでこの戻り先をリセットする。詳細の×と詳細内のEscapeは選択を解除し、元のnodeへfocusを戻す。狭幅では詳細を図の作業面に重ね、その間は背面の図を操作対象から外す。ComposerやSession全体をmodalにはしない。

独立Graph WindowはHomeの既存`Previews`へ親Main単位で集約し、Graphの種別と話題・選択記録で識別する。既存Windowのfocus、個別Close、親単位Closeは同じ一覧から操作する。独立Windowを閉じても会話やGraphデータは変更しない。親Session Windowの通常CloseやAuxiliaryのCloseでは残し、Main削除・reset・app終了で関連Windowとtokenを失効させる。再起動後の閲覧Window復元や閲覧位置の永続化は行わない。

中央のreadはowning parent Windowを認可し、独立WindowはMainが発行したtokenにWindow、親Main ID/incarnation、storage generationを結び付けて認可する。独立Windowから親IDを自己申告してGraphを読むことや、apply・provider権限への拡張は許さない。非同期read完了時にも失効を確認する。明示した参照リンクだけ既存のfile/link resolverへ親Sessionの認可で渡す。保存成功の通知は同じownerの中央と独立ビューへ届け、pollingや表示のたびのAI呼出しは使わない。

話題を選び、図のnodeからrecordを選択して近傍図と関連recordを読む。recordの重複した選択一覧は置かず、nodeへのTab/Enterと詳細の関連リンクでも移動できる。recordと関連リンクはkeyboardでも開ける対象menuから別窓にも開ける。配置は取得した任意のrecord/関係から計算し、サンプル固有のIDや座標を持たない。

大量recordは40件ずつ追加pageで取得する。footerは左にzoom群、右に取得済record数/総数の`Records Loaded`と、次に取得する件数を示す`Load 15 More`等をまとめる。件数は集約後の表示node数とは区別する。狭幅では群単位で折り返し、追加取得中はbuttonと同じ寸法内のspinner・busyで示して取得済図とzoom操作を維持する。完了後も件数と操作の占有寸法を保持して図領域を動かさず、最後の追加取得buttonにあったfocusは件数へ戻す。取得失敗はbutton近くのalertに理由を示し、同じbuttonから再試行できる。関係取得上限に達した部分Graphは`Some Relations May Be Missing`として件数とは別に影響を伝える。未取得範囲と取得失敗は正常な空と区別する。

図領域のCtrl＋左dragでpanし、Ctrl＋wheelで対象だけを拡縮する。画像・mmd previewと共通の処理を使い、wheelはSettingsの`Preview Wheel Zoom Step`（既定5ポイント）、buttonは10ポイント刻み、倍率範囲は10%〜800%とする。設定変更は次のwheel操作へ反映し、現在倍率と位置を変えない。通常wheelとkeyboardのnative scrollを保ち、Ctrl操作をWindow全体のzoomへ渡さず、pan後のclickでrecord選択や別窓を誤発火させない。

通常表示は話題の俯瞰図とする。図の幅・高さから可読cardが収まる目安を計算し、取得済みrecordがそれを超える場合、同じ種類・label・方向が続く直列区間を件数付きの`Expand Path`へ集約する。入辺・出辺が各1本で、両端のrecordを取得済みの区間だけを対象とし、分岐・合流、関係の種類・label・向きの変更、循環、未取得の接続先に接するrecordは個別表示を保つ。関係取得上限に達した部分Graphでは接続の完全性を確定できないため集約しない。recordの任意切捨てや文字を潰す自動Fitは行わない。

集約nodeは実recordではなく、件数と区間の先頭・末尾titleを表示する。接続は破線で描き、区間の両端を直接のrelationで結ばない。開くとその区間と取得済みの境界recordを表示し、長い場合はより短い区間へ段階的に分ける。各recordへ必ず到達でき、上部toolbarの全体へ戻るツリー型icon（`Back To Overview`）／可視label付き`Back To Previous Range`で元の範囲・倍率・位置と展開元のfocusへ戻る。全体へ戻るツリー型iconにはhoverのtitleとaccessible nameを持たせる。深い区間では隣の`Overview`から俯瞰へ直接戻れる。会話復帰の`Back To Chat`と区別し、展開区間の先頭・末尾titleを別の見出し行へ重ねない。狭幅ではtoolbar操作を折り返す。record選択時の近傍図・詳細、関連記録の往復を維持する。分岐や循環が多い図は集約だけで画面内に収まるとは限らず、native scrollとCtrl操作を残す。

配置は無向の幅優先順で接続recordを近づけ、利用可能な幅へ詰めて複数段に置く。表示幅の変更でもcardの文字・54pxのCharacter iconを縮小せず再配置し、拡縮操作は配置を変えず表示倍率だけを変える。card1列に必要な幅を下回る領域と拡大時はnative横scrollを残す。行・列は時系列や依存方向を表さず、意味と方向は関係のlabelと矢印で示す。複数段を跨ぐ辺はcard間の余白へ通す。

図は要点・意味の異なる状態・主体icon・関係を中心にし、本文、適用範囲、target、自由項目、具体的な参照は選択後に表示する。Main/Auxiliaryの区分・会話名はiconのhover/focusで読め、記録者が内容上の主体と違う場合だけ記録者を補足する。任意labelの主体は人型と名前を常設表示し、`User`を頭文字だけに短縮しない。長いlabelはnode内の表示範囲を制限し、hover/focusと詳細で全文を読める。labelから利用者本人の画像へ自動紐付けはしない。関係・区間展開はkeyboardからも辿れる。Markdown内の埋込み画像や図を自動取得・実行せず、参照は利用者の明示操作から既存の認可済みlink/file経路へ渡す。
