# Window Architecture

WithMateはHome、Session、Character Editor、Settings、Session Monitor、Diff、File Previewの各Windowを用途ごとに分ける。Windowの生成・再利用・配置はMain Processが所有し、rendererはpreloadの公開APIを通して必要な状態と操作を受け取る。実装境界は[Electron Window Runtime](electron-window-runtime.md)、画面ごとの表示は[Desktop UI](desktop-ui.md)を参照する。

| Window | 責務 |
| --- | --- |
| Home | Sessionの検索・再開・新規作成、Character catalog、Session別File Preview一覧とWindow操作、SettingsとSession Monitorへの入口 |
| Session | Main／Auxiliaryの共通chat shell、承認・実行設定、file／Git preview、artifact Details、会話操作、Window所有の組み込みTerminal |
| Character Editor | Character profile、icon、theme、`character.md`、`character-notes.md`の編集 |
| Settings | app共通設定、provider設定、model catalog、診断 |
| Session Monitor | 開いているSessionと、実行後に保持したSessionの状態をcompactに監視 |
| Diff | 広い面でGit差分を比較 |
| File Preview | 対象fileを独立Windowで表示 |

Homeは作業中のchatを抱えず、Sessionはcatalogやapp共通設定の編集面を持たない。Auxiliaryは専用Windowを作らず、親Session Windowの同じchat shell内でMainと切り替える。親配下の複数Auxiliaryはstable IDで保存し、表示中でないrunも継続・terminal保存する。詳細は[Auxiliary Session](auxiliary-session.md)を参照する。

## Home rendererの実装方針

Home関連の追加・修正では、`HomeApp`への責務集中を抑えるため、変更対象の責務を独立して保守できるまとまりで分離する。`HomeApp`は画面の組立てと機能間の接続を中心とする。

機能固有の状態・取得・購読・副作用は専用hook、表示はcomponent、純粋処理はhelperなど、責務に適した単位へまとめる。既存の仕組みを利用し、状態の所有とlifecycleを明確にして、既存の動作契約を維持する。

分離は変更対象と、その責務を成立させるために必要な既存の結線に限定する。軽微な修正ごとの分割を必須にせず、行数だけによる細分化、汎用基盤や無関係な全面整理を増やさない。

## Sessionの起動と継続

HomeのNew Sessionでtitle、workspace、provider、Characterを選び、保存済みSessionを作成してSession Windowを開く。Recent Sessionsからの再開では、同じSessionのWindowが開いていれば再利用・focusする。通常Sessionはstable Character ownerと表示metadataを維持し、active Characterの定義変更だけを送信開始時に反映する。詳細は[Character Storage](character-storage.md#runtime-snapshot)を参照する。Character authoringでは専用のSession種別とworkspaceを使い、Windowの基本lifecycleは通常Sessionと共有する。

Sessionの実行状態はMainが所有する。Windowを閉じてもSession recordは残り、実行中のcloseでは確認を経て継続または中止を選ぶ。close時のAuxiliary draft flush、アプリ終了、取消の詳細は[Session Run Lifecycle](session-run-lifecycle.md)に従う。

組み込みTerminalはWindowの生存期間に属し、会話のrunとは独立する。通常のWindow closeでは個別タブと同じ入力待ち判定を使い、実行中・起動中・判別不能な端末があれば非同期で一括確認する。入力待ち・終了済み端末だけなら端末理由の確認を省略するが、会話のrunに対する確認と下書き保存は維持する。実際の破棄、Session削除、アプリ終了ではそのownerのPTYを解放する。dockの折りたたみ、タブ切り替え、最小化では終了しない。再起動やWindow再作成でシェルを復元しない。

## Windowの再利用と配置

Homeはapp起動時の管理Windowとして扱う。Sessionは同じSession IDの二重Windowを作らない。SettingsとSession Monitor、Character Editorの同じ編集対象は既存Windowを再利用する。新規の補助WindowはcursorがあるdisplayのworkArea内へ配置し、既存Windowをfocusするときは位置を変えない。Session Monitorを閉じてもrunは止まらない。

共有するSession metadata、Character catalogとWindow registryはMain側の正本から投影し、各Windowの入力途中状態はそのWindowが保持する。Character metadataと定義file、runtime snapshotの境界は[Character Storage](character-storage.md)を参照する。

HomeのPreviewsはMainのSession Window mapとFile Preview Window registryを親Session単位に投影し、Main／Auxiliaryから開いたpreviewを同じ親へまとめる。開いているSessionをWindow map順に表示し、previewが0件でも残す。その後ろへSession Windowが閉じていてpreviewが残る親を加える。Recent Sessionsの取得範囲では一覧を制限しない。Homeからの前面化は既存Windowの表示内容を変更せず、個別Closeと親単位Closeはpreviewだけを閉じる。通常のCloseでSessionを終了済みにせず、後から同じresourceを再度開ける。Session削除等によるpreviewの終了・再open拒否とは区別する。
