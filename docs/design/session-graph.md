# Session Graph

Session Graphは要求、制約、判断、活動、観測、未解決事項とその関係を、会話本文とは独立して保持する。AIは必要範囲を取得・更新し、人は同じ正本から生成された図を閲覧する。会話の自動要約や、既存SessionFolderのmmdの自動取込みは行わない。

## 所有と保存

正本は既存Storage Workerが所有するV6 SQLiteの`session_graphs_v6`、`session_graph_topics_v6`、`session_graph_records_v6`、`session_graph_relations_v6`である。schemaの定義は`src-electron/storage/database-schema-v6.ts`、操作の型と入力schemaは`src-shared/session-graph/`を参照する。

親Main SessionのIDとincarnationが所有境界で、MainとそのAuxiliaryは同じGraphを共有する。WorkspaceやCharacter名の一致では共有しない。親Mainの削除はforeign keyのcascadeでGraph全体を削除する。AuxiliaryのClose、表示切替、WindowのCloseでは削除しない。SessionFolder内の既存fileの保持・cleanupは[Session Local Files](session-local-files.md)に従う別の境界である。

## 記録

Topicはstable IDと表示名を持つ。Recordは親Graph内で一意のstable ID、topic ID、kind、短いtitle、Markdownのdetail、適用範囲scope、担当エージェントactor、内容の由来originを持つ。titleは図の要点であり、重要な限定を落とした自動要約には置き換えない。

| kind | 状態 |
| --- | --- |
| `requirement` | 要求本文。完了状態を判断・活動と共有しない |
| `constraint` | 制約本文 |
| `decision` | adoption: `proposed` / `accepted` / `declined` |
| `activity` | progress: `planned` / `in_progress` / `completed` / `paused` / `canceled`。必要ならresultも保持 |
| `observation` | result: `reported` / `checked` / `passed` / `failed` / `not_run` / `unknown` |
| `issue` | resolution: `open` / `resolved` |

状態は省略できる。context選択ではissueの省略をopen、activityの省略をplannedとして扱うが、UIで確認済みの状態を創作しない。全kindに任意のvalidity `superseded` / `withdrawn`を持たせ、未指定を現行とする。活動の完了、結果の成功、論点の解消、判断の採用は別々の情報である。

actorは同じ親Graphに属する担当Main/Auxiliaryの`{ sessionId }`である。新規recordでactorを省略すると信頼済み呼出元を担当にする。自分のSession ID、名前、画像の再入力やself取得は不要で、他担当の指定・担当変更はactorを明示する。同じCharacterを使うSessionもSession IDで区別する。`actorRole`は最大512文字の任意の作業役割であり、Character名やidentityのMain/Auxiliary区分とは別である。

`origin`は`{ type: "agent" | "user" | "external", label?: string }`で内容の由来を示す。新規recordでは必須で、担当や記録者から推測しない。labelは最大512文字の任意の補足（外部サービス名など）。decisionの`adoptionOrigin`は同じ形式でaccepted/declinedの判断の由来を別に保持する。agent提案をuserが採用する場合は元のactor/originを保持し、adoptionとadoptionOriginを変更する。acceptedだけでuser採用を推測しない。由来はagentが内容を記録する属性であり、本人の直接編集の証明や実行承認・権限ではない。

ユーザー向けの書込UIは設けず、agentがMCPまたはCLIから記録する。初回記録者`recordedBy`と担当`actorSnapshot`はWithMateが信頼済みSessionから付与し、入力では受け付けない。初回記録者・作成時刻と、同じ担当のsnapshotは更新でも保持する。他Auxiliaryによる更新やCharacterの後の変更で帰属を付け替えない。担当を明示変更した場合だけ新担当のsnapshotを取得する。snapshotのiconは既存Character資産への参照であり、画像fileの複製・永久保存はしない。

任意のtargetは対象revision、実施条件、観測日時をまとめて保持する。これはサーバーが付ける作成・更新日時と区別する。referencesは`evidence` / `artifact` / `handoff`の役割、表示名、参照先を持ち、全recordへ一律のSource欄を要求しない。

`references[].href`はWindows drive付き絶対path、バックスラッシュ形式UNC、POSIX絶対path、適切な絶対file URL、または完全なhttp/https/mailto/tel URLを指定する。相対・drive相対・protocol-relative・不完全URLは拒否し、新規・通常更新・未変更hrefの再保存で同じ形式検証を行う。保存時は存在や読取可否を確認せず、文字列のquery/fragment/encodingを保持する。明示クリック時に既存の共通openが存在・読取・open結果を確認し、失敗は既存feedbackへ返す。Workspace内・SessionFolder内・登録root外の明示fileを扱い、baseの推測や同名fileの探索は行わない。

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

recordの作成・更新時には何の要求・判断・活動・観測に関係するかを確認し、意味のあるrelationを同じapplyへ明示する。必要な既存IDだけをget等で確認し、毎回Graph全体を読み直さない。同じ関係の更新はstable IDを再利用し、解除はremoveRelationIdsで指定する。例えば実装活動`implement`と要求`requirement`を保存するbatchへ、`{ id: "implement-fulfills-requirement", fromId: "implement", toId: "requirement", kind: "fulfills" }`を含める。

孤立recordも正常であり、全recordへの接続を強制しない。title・Topic・担当・時刻・originから推測した線や、関係生成用の追加AI呼出しは設けない。Relationだけで状態を自動変更しない。置換では後継との関係と、旧recordのvalidityを同じbatchで更新する。元の判断本文を削除して後継だけへ置き換えない。

## MCPと更新

`withmate-session-graph`はMCPとCLIで同じ6操作を公開し、入力意味・結果・エラー・保存契約を共有する。MCPはMemory・Glossaryと同じmanaged HTTP MCP hostを利用し、Codex、Copilot、Claudeのprovider turnへ専用endpointを渡す。CLIも同じ起動中runtimeへの認証・instance/generation照合とextension exchangeを通り、application service／Storage Workerへ操作を送る。CLIがDBやSessionFolderを直接更新する経路はない。

両入口とも既存Session bindingから呼出元と親scopeを解決し、bindingなし・無効・失効を別Sessionや無bindingアクセスへ置き換えない。入力で親Session、呼出元、記録者、Character、権限を選ばせない。書込みは有効なturnに限り、同じturn capabilityを使用し、Workerのtransactionでownerのincarnation・actorの所属・turn失効を再確認してcommitする。

| MCP tool | CLI command | 用途 |
| --- | --- | --- |
| `session_graph.list_topics` | `list-topics` / `list_topics` | 話題を列挙する |
| `session_graph.recent` | `recent` | 検索語なしで最近作成・更新されたrecordを読む。`limit: 1`は最新1件 |
| `session_graph.context` | `context` | 現行の要求・制約・採用判断・未解決issue・未完了activityと、必要な依存・根拠を読む |
| `session_graph.get` | `get` | 既知IDの詳細と関係を読む |
| `session_graph.search` | `search` | title/detailを文字列検索する |
| `session_graph.apply` | `apply` | expectedRevision付きの原子的batch更新 |

CLIは`--json <json>`、`--file <path>`、`@file`、`--stdin`のいずれか1つから入力し、MCPと同じshared schemaで検証する。`help`は操作方法、`schema`は6操作のJSON入力schemaをruntime接続なしで返す。runtimeの接続先選択は親Graphの選択ではなく、選択後もSession bindingのscopeを維持する。

```sh
withmate-session-graph list-topics
withmate-session-graph recent --json '{"limit":1}'
withmate-session-graph get --json '{"ids":["known-record-id"]}'
withmate-session-graph apply --file graph-request.json
withmate-session-graph schema
```

CLIの入力不正とMCP SDKの入力検証エラーは、保存前の入力エラーとして扱う。runtimeからの失敗・revision conflictは両入口で同じ結果として返し、成功として扱わない。通信失敗は`SESSION_GRAPH_TRANSPORT_ERROR`となり、readまたは未dispatchのapplyは`effect: "none"`、dispatch済みapplyの応答喪失など保存を確定できない場合は`effect: "unknown"`を返す。結果不明を未保存へ置き換えて再送しない。

recent/context/searchはtopic、actorSessionId、recordedBySessionId、kind、種別ごとの状態で任意に絞れる。これらは認可済み親scope内の読取条件であり、共有権限を増やさない。SQL、独自query言語、自由項目の任意path条件は提供しない。

contextは絞り込みに一致する現行recordを起点に、outgoing `depends_on`の必要先とincoming `supports` / `checks`の根拠を再帰取得する。循環で停止しなくならないよう重複を除く。必要先は別Topicでも保持する。絞り込まれたcontextやrecent N件を、親Graph全体の有効条件と同一視しない。

読取はrevision、total、offset、hasMore、incompleteを返す。recordはサーバー更新日時の降順で返し、観測日時の新旧では並べない。関係は返却itemsのrecord IDに接続するものをID順で最大400件返し、表示外endpointはID・Topic・title・kind・validityの要約として返す。要約は完全なrecordではなく、本文・担当・状態を補完しない。内容由来のorigin=externalとは別の概念である。

関係のページングはrecordのoffsetとは独立した`relationOffset`と`relationsHasMore`を使う。`relationsTruncated`はその応答で後続関係を切り捨てた場合だけtrueになる。関係の続きは同じitems IDを指定したget（limitを対象件数以上にする）か同じrecord読取条件で、同じexpectedRevisionと次のrelationOffsetを渡す。offset 0から末尾まで連続して取得したときだけ、そのrecord ID範囲の関係を完全確認できる。累積関係数が400を超えたことや全recordを取得したことから、関係の不完全性・完全性を判断しない。

UIは初回・追加page・詳細get・live refreshを同じrevisionと確認済みrecord範囲で統合する。refreshは既知recordを最大200件ずつ再取得し、範囲内の全pageが同一revisionで成功してから反映する。部分関係応答では既知の線を未確認として保持し、完全確認した範囲のabsenceでのみ削除を反映する。同じrelation IDのendpoint変更は上書きする。追加関係は`Load More Relations`から明示取得し、未確認・失敗は正常な関係0件と区別する。途中更新のconflictや失敗では取得済み図を保ち、再取得を案内する。

applyはtopic/record/relationのupsertとrelation解除を1transactionで処理し、1batchにつきrevisionを1増やす。recordの必須本文（id、topicId、kind、title、detail、scope、references）は毎回指定する。actor/originと任意属性は省略時に既存値を保持する。target、fields、actorRole、adoptionOrigin、各状態はnullで明示解除でき、actor/originは解除できない。更新前に必要なIDをgetし、kind変更時も保持される状態が新kindと整合するよう明示解除する。既存adoptionOriginがあるdecisionのadoptionを変更・解除する場合は、adoptionOriginの新値またはnullも明示する。採否がaccepted/declinedでないrecordへadoptionOriginを保存しない。保持された担当も保存時の親Graph所属検証を受ける。

`actorSessionId`は担当、`recordedBySessionId`は初回記録者で絞り込む。担当が受け持つuser/external由来も含み、contextや関連取得から由来だけを理由に除外しない。expectedRevision不一致では保存せず、現在revisionを返す。影響するIDを再取得してから再試行し、古いGraph全体で他者の変更を上書きしない。任意record/topic削除toolは設けず、撤回・置換と親削除を使う。通信やcommit後の応答に失敗した場合、結果不明を成功・未保存のどちらにも決めつけず、再取得して確認する。

## 閲覧UI

UI専用readは`src-shared/session-graph/session-graph-ui-read-contract.ts`で公開MCP／CLI操作と区別する。`overview`はTopicのpageに、所属全recordの件数・最古/最新更新日時と、現行要求・制約・採用判断・活動・観測・未解決issueのカテゴリ集約を付ける。撤回・置換済みrecordは現行カテゴリから除外するが、時刻比較と全record件数には含める。活動は担当Session別にも集約し、進行・結果・採否・解消を同じ完了状態へ変換しない。状態省略は確認済み状態へ補完しない。各カテゴリの代表recordは更新順の最大3件であり、総件数や新しさの計算範囲ではない。`topic_records`でカテゴリ・担当を指定したthin summaryのpageから全対象recordへ辿れる。

全体の`recency`は全Topicの所属record最大更新日時どうしの最古/最新であり、空Topicを比較対象から除外する。UIの`get_topic_view`は表示pageやfilterによらない当該Topic全recordの比較範囲を返す。Topic名やrelationだけの更新はrecordの新しさを変えない。これらの集約は読取transaction内で計算し、別のsummaryを保存しない。全record本文・参照・自由項目をoverviewへ転送しない。

Topic間relationは保存済み端点のTopic・向き・kind別件数として全体集約し、`topic_relations`の同一条件のpageで実relation・labelと両端recordの要約を返す。一部record間の関係をTopic全体の依存へ変換しない。Topic page・集約・カテゴリpage・relation内訳は`expectedRevision`で揃え、競合・途中page・失敗を対象なしへ置き換えない。既存の親owner/incarnation・storage generation・Window sender/tokenの認可を共用する。

展開したSession headerの`Graph`で中央previewを開き、`Back To Chat`で会話へ戻る。再度Graphを押しても閉じない。Graphを開いた後にヘッダーを折り畳んだ場合、会話へ戻るとヘッダーの展開操作へfocusする。隣の`Open Graph In New Window`またはCtrl/Cmd付きのGraph操作は、元の表示を変えずに独立Windowを追加する。Graphは閲覧専用で、作成・編集・位置調整を人へ要求しない。

中央と独立Windowは同じ図componentを使う。各ビューの話題、選択記録、倍率、scrollは独立し、別窓作成時だけ初期値を引き継ぐ。同じ親・話題の複数Windowも許可し、新規作成と既存Windowのfocusを区別する。展開区間の履歴は各ビュー内に保持し、新しいWindowは選択記録の近傍または話題の俯瞰から開く。中央の会話復帰では入力、最後のGraph位置と展開区間を保持し、file/Templateとの切替は既存の離脱確認を通す。Main/Auxiliaryの選択や送信先は変えない。

関連記録を辿った場合だけ、詳細内の`Back To <記録名>`から元の話題・記録・倍率・scrollへ戻れる。通常のrecord選択と詳細dismissは詳細の選択履歴だけをリセットする。表示範囲外へ関連移動した場合は、詳細を閉じたり別のnodeを通常選択した後も、toolbarの`Back To Previous Range`から元の範囲・順序・倍率・scrollと移動元nodeのfocusへ戻れる。話題の直接選択は両方の戻り先をリセットする。復帰履歴は範囲のIDと閲覧状態を保持し、過去のrecord・relationを復元しない。同じ話題では元のID集合へ取得済みの最新payloadを対応付け、異なる話題へ戻る時は元の取得範囲を同一revisionで再検証してから表示する。再検証の失敗・競合は古いsnapshotの成功表示に置き換えず、戻り先を保持して再試行できる。詳細の×と詳細内のEscapeは選択を解除し、元のnodeへfocusを戻す。狭幅では詳細を図の作業面に重ね、その間は背面の図を操作対象から外す。ComposerやSession全体をmodalにはしない。

復帰したID集合が現在revisionの先頭からの取得範囲と一致しない場合、次の`Load More`で同じrevisionの先頭範囲を再検証し、元IDの最新内容と順序を保って未表示IDを最大40件追加する。表示件数をそのままサーバーのoffsetとせず、取得済み先頭範囲との一致を確認してから通常の追加pageへ戻す。IDの重複を除き、追加・並べ替え後も未表示recordと末尾へ到達できる。

独立Graph WindowはHomeの既存`Previews`へ親Main単位で集約し、Graphの種別と話題・選択記録で識別する。既存Windowのfocus、個別Close、親単位Closeは同じ一覧から操作する。独立Windowを閉じても会話やGraphデータは変更しない。親Session Windowの通常CloseやAuxiliaryのCloseでは残し、Main削除・reset・app終了で関連Windowとtokenを失効させる。再起動後の閲覧Window復元や閲覧位置の永続化は行わない。

中央のreadはowning parent Windowを認可し、独立WindowはMainが発行したtokenにWindow、親Main ID/incarnation、storage generationを結び付けて認可する。独立Windowから親IDを自己申告してGraphを読むことや、apply・provider権限への拡張は許さない。非同期read完了時にも失効を確認する。明示した参照リンクだけ既存のfile/link resolverへ親Sessionの認可で渡す。保存成功の通知は同じownerの中央と独立ビューへ届け、pollingや表示のたびのAI呼出しは使わない。

入口の`All Topics`は親Graphの全Topicを横断する。空・孤立Topicも残し、選択したTopicのsummaryで現行の要求・制約、採用済み判断、活動の進捗、観測結果、未解決事項、担当別の活動を分けて表示する。各分類の代表recordから本文へ進め、省略分は同じrevisionの追加取得で辿る。撤回・置換済みを現行条件に含めず、以前の判断や解消済み事項はTopic詳細に残す。Topic間の線は種類・方向別に保存済みrecord関係を数えた入口であり、Topic全体への依存を意味しない。内訳から元recordの両端へ移動できる。全体用の要約保存や追加AI実行は行わない。

`Open Topic`またはsummaryのrecordを明示選択してTopic詳細へ進む。`All Topics`で元の全体の選択・倍率・scrollへ戻る。全体/詳細の範囲と中央/独立Windowの表示場所は別の軸で、会話切替や中央Graphの開閉では範囲・閲覧状態を保持する。Topic詳細では図のnodeからrecordを選択して詳細と関連recordを読む。通常選択では現在の概要・展開範囲とnode位置を維持し、選択node・直接の隣接node・edgeを強調する。他のnodeと関係も残す。recordの重複した選択一覧は置かず、nodeへのTab/Enterと詳細の関連リンクでも移動できる。recordと関連リンクはkeyboardでも開ける対象menuから別窓にも開ける。配置は取得した任意のrecord/関係から計算し、サンプル固有のIDや座標を持たない。

新しさはrecordのサーバー保存日時`updatedAt`を使い、同内容の再保存でも進み、同一batchでは同時刻になり得る。Topic詳細は全所属recordの最小/最大日時、全体ビューは各Topicの全recordの最大日時を全Topicで比較する。表示page・選択・区間展開によって比較範囲を狭めない。空Topicは比較から除き、Topic自体やrelationだけの更新日時は代用しない。背景は古い`#1C212B`、中間`#263243`、新しい`#34465A`を時間幅の前半/後半で線形RGB補間し、同率最大のすべてへ`#D3DCE8`の内側上端帯を示す。record集約は構成recordの最大日時を使う。単一時刻は新しい背景と帯、対象が空なら帯なしとする。

Graph背景は`#12161E`、選択外枠と接続線は`#6FB8C7`、通常の枠・線・アイコン外縁は`#98A2B3`、本文は`#EDF2F7`、補助文字は`#C4CEDB`。hover・選択・focusで新しさの背景を上書きせず、古い項目の文字を薄くしない。担当の信頼済みsnapshotに保持するCharacter main/sub色はアイコン周囲の小さい縁だけに使い、その外側に中立色の縁を置く。未設定は中立色、複数担当の集約を一人の色で代表させない。具体日時は詳細と支援技術へ提供し、常設Latest文字や点滅に依存しない。色・帯の更新だけでは並べ替え・全体再配置・fit・pan・選択変更を行わない。

別Topic・未取得page・現在の範囲外へつながるnodeは、図中の件数付き接続表示で関係の存在を示す。hover・keyboard focusで種類・向き・行き先を確認でき、詳細の関連リンクから明示的に取得・移動する。全endpointを自動展開せず、追加pageで本体を取得した場合も同じIDのnodeを重複させない。

大量recordは40件ずつ追加pageで取得する。footerは左にzoom群、右に取得済record数/総数の`Records Loaded`と、次に取得する件数を示す`Load 15 More`等をまとめる。件数は集約後の表示node数とは区別する。狭幅では群単位で折り返し、追加取得中はbuttonと同じ寸法内のspinner・busyで示して取得済図とzoom操作を維持する。完了後も件数と操作の占有寸法を保持して図領域を動かさず、最後の追加取得buttonにあったfocusは件数へ戻す。取得失敗はbutton近くのalertに理由を示し、同じbuttonから再試行できる。関係が未確認の部分Graphは`Some Relations Are Unconfirmed`と追加取得操作を件数と別に示し、詳細側でも確認できる。未取得範囲と取得失敗は正常な空と区別する。

図領域のCtrl＋左dragでpanし、Ctrl＋wheelで対象だけを拡縮する。画像・mmd previewと共通の処理を使い、wheelはSettingsの`Preview Wheel Zoom Step`（既定5ポイント）、buttonは10ポイント刻み、倍率範囲は10%〜800%とする。設定変更は次のwheel操作へ反映し、現在倍率と位置を変えない。通常wheelとkeyboardのnative scrollを保ち、Ctrl操作をWindow全体のzoomへ渡さず、pan後のclickでrecord選択や別窓を誤発火させない。

通常表示は話題の俯瞰図とする。図の幅・高さから可読cardが収まる目安を計算し、取得済みrecordがそれを超える場合、同じ種類・label・方向が続く直列区間を件数付きの`Expand Path`へ集約する。入辺・出辺が各1本で、両端のrecordを取得済みの区間だけを対象とし、分岐・合流、関係の種類・label・向きの変更、循環、未取得の接続先に接するrecordは個別表示を保つ。関係取得上限に達した部分Graphでは接続の完全性を確定できないため集約しない。recordの任意切捨てや文字を潰す自動Fitは行わない。

集約nodeは実recordではなく、件数と区間の先頭・末尾titleを表示する。接続は破線で描き、区間の両端を直接のrelationで結ばない。開くとその区間と取得済みの境界recordを表示し、長い場合はより短い区間へ段階的に分ける。各recordへ必ず到達でき、上部toolbarの全体へ戻るツリー型icon（`Back To Overview`）／可視label付き`Back To Previous Range`で元の範囲・倍率・位置と展開元のfocusへ戻る。全体へ戻るツリー型iconにはhoverのtitleとaccessible nameを持たせる。深い区間では隣の`Overview`から俯瞰へ直接戻れる。会話復帰の`Back To Chat`と区別し、展開区間の先頭・末尾titleを別の見出し行へ重ねない。狭幅ではtoolbar操作を折り返す。展開後の通常選択でも範囲と位置を維持し、内部の関係を詳細から辿れる。分岐や循環が多い図は集約だけで画面内に収まるとは限らず、native scrollとCtrl操作を残す。

配置は無向の幅優先順で接続recordを近づけ、連結成分を分断せず矩形のまとまりとして幅・高さへ詰める。孤立nodeと小さな成分は同じ行も利用し、viewport内に収まる候補を優先する。幅と高さの比率を配置評価へ使うが、任意件数・任意長のlabelを1画面に収める保証はしない。行・列は時系列や依存方向を表さず、意味と方向は関係のlabelと矢印で示す。

関係labelは実描画と同じCSSの非拡縮DOMで幅・高さを測る。短いものは1行、長いものは最大280pxで全文を折り返し、文字の省略・自動要約・過度な縮小は行わない。障害物のない関係はcardの境界間を直線（斜めを含む）で結び、中央のlabel前後で線を切る。直線だけのgroupには上方迂回用の余白を確保しない。並行edge・自己辺・他cardやlabelに干渉する関係だけ上方の別経路と接続位置を使う。計測矩形と余白はcard間隔、行間、必要な迂回経路、canvas外周へ反映する。cardの文字・54pxのCharacter iconは縮小せず、必要なnative scrollを残す。

配置寸法は詳細paneを含む外側workspaceから取得する。通常選択・詳細の開閉では配置と倍率を変えず、keyboard focusの復帰もscrollを変更しない。外側viewportの幅・高さ変更や明示した範囲移動ではその寸法・範囲へ配置する。同じviewportのlive更新は既存成分の位置・列数・順序を優先し、追加やlabel寸法増大による衝突に必要な範囲だけ移す。拡縮は配置を変えず表示倍率だけを変える。

図は要点・意味の異なる状態・担当画像とCharacter名・関係を中心にし、内容由来と採否由来を小さな別labelで示す。nodeのkeyboard focusまたは担当画像・由来のhoverで、Main/Auxiliaryの区分、会話名、任意の担当役割と由来の補足labelを一つのtooltipに表示する。本文、適用範囲、target、自由項目、具体的参照、担当役割と各由来の全文は選択後に表示する。初回記録者が担当と違う場合だけRecorded Byを補足する。user/external由来やユーザー採用でも担当画像を切り替えず、画像未設定・読込失敗時は担当名を保つ既存avatar fallbackを使う。担当/画像が変われば新しい画像を再試行する。集約は件数と区間titleを示し、先頭recordの担当・由来を集約全体の属性として表示しない。関係・区間展開はkeyboardからも辿れる。Markdown内の埋込み画像や図を自動取得・実行せず、参照は利用者の明示操作から既存の認可済みlink/file経路へ渡す。
