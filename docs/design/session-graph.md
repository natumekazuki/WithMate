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

読取はrevision、total、offset、hasMore、incompleteを返す。recordはサーバー更新日時の降順で返し、観測日時の新旧では並べない。関係は返却recordに接続するものと表示外endpointの要点を返す。record pageと関係の取得上限を区別し、部分取得を完全なGraphに見せない。続きの取得には同じexpectedRevisionを渡し、途中更新はconflictとして再取得する。

applyはtopic/record/relationのupsertとrelation解除を1transactionで処理し、1batchにつきrevisionを1増やす。recordの更新は指定IDの内容全体を置き換えるため、更新前に必要なIDをgetする。expectedRevision不一致では保存せず、現在revisionを返す。影響するIDを再取得してから再試行し、古いGraph全体で他者の変更を上書きしない。任意record/topic削除toolは設けず、撤回・置換と親削除を使う。通信やcommit後の応答に失敗した場合、結果不明を成功・未保存のどちらにも決めつけず、再取得して確認する。

## 閲覧UI

Session headerの`Graph`で中央previewを開き、`Back To Chat`で会話へ戻る。展開・折畳みのどちらでも入口を保ち、再度Graphを押しても閉じない。隣の`Open Graph In New Window`またはCtrl/Cmd付きのGraph操作は、元の表示を変えずに独立Windowを追加する。Graphは閲覧専用で、作成・編集・位置調整を人へ要求しない。

中央と独立Windowは同じ図componentを使う。各ビューの話題、選択記録、倍率、scrollは独立し、別窓作成時だけ初期値を引き継ぐ。同じ親・話題の複数Windowも許可し、新規作成と既存Windowのfocusを区別する。中央の会話復帰では入力と最後のGraph位置を保持し、file/Templateとの切替は既存の離脱確認を通す。Main/Auxiliaryの選択や送信先は変えない。

関連記録を辿った場合だけ、詳細内の`Back To <記録名>`から元の話題・記録・倍率・scrollへ戻れる。直接の話題・記録選択と詳細dismissでこの戻り先をリセットする。詳細の×と詳細内のEscapeは選択を解除し、元のnodeへfocusを戻す。狭幅では詳細を図の作業面に重ね、その間は背面の図を操作対象から外す。ComposerやSession全体をmodalにはしない。

独立Graph WindowはHomeの既存`Previews`へ親Main単位で集約し、Graphの種別と話題・選択記録で識別する。既存Windowのfocus、個別Close、親単位Closeは同じ一覧から操作する。独立Windowを閉じても会話やGraphデータは変更しない。親Session Windowの通常CloseやAuxiliaryのCloseでは残し、Main削除・reset・app終了で関連Windowとtokenを失効させる。再起動後の閲覧Window復元や閲覧位置の永続化は行わない。

中央のreadはowning parent Windowを認可し、独立WindowはMainが発行したtokenにWindow、親Main ID/incarnation、storage generationを結び付けて認可する。独立Windowから親IDを自己申告してGraphを読むことや、apply・provider権限への拡張は許さない。非同期read完了時にも失効を確認する。明示した参照リンクだけ既存のfile/link resolverへ親Sessionの認可で渡す。保存成功の通知は同じownerの中央と独立ビューへ届け、pollingや表示のたびのAI呼出しは使わない。

話題を選び、図のnodeからrecordを選択して近傍図と関連recordを読む。recordの重複した選択一覧は置かず、nodeへのTab/Enterと詳細の関連リンクでも移動できる。recordと関連リンクはkeyboardでも開ける対象menuから別窓にも開ける。配置は取得した任意のrecord/関係から計算し、サンプル固有のIDや座標を持たない。大量recordは追加pageで取得し、部分取得時だけ範囲とLoad Moreを示す。未取得範囲と取得失敗は正常な空と区別する。

図領域のCtrl＋左dragでpanし、Ctrl＋wheelで対象だけを拡縮する。画像・mmd previewと共通の処理を使い、wheelはSettingsの`Preview Wheel Zoom Step`（既定5ポイント）、buttonは10ポイント刻み、倍率範囲は10%〜800%とする。設定変更は次のwheel操作へ反映し、現在倍率と位置を変えない。通常wheelとkeyboardのnative scrollを保ち、Ctrl操作をWindow全体のzoomへ渡さず、pan後のclickでrecord選択や別窓を誤発火させない。

図は要点・意味の異なる状態・主体icon・関係を中心にし、本文、適用範囲、target、自由項目、具体的な参照は選択後に表示する。Main/Auxiliaryの区分・会話名はiconのhover/focusで読め、記録者が内容上の主体と違う場合だけ記録者を補足する。関係はkeyboardからも辿れる。Markdown内の埋込み画像や図を自動取得・実行せず、参照は利用者の明示操作から既存の認可済みlink/file経路へ渡す。
