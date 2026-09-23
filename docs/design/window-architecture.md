# Window Architecture

WithMateはHome、Session、Character Editor、Settings、Session Monitor、Diff、File Previewの各Windowを用途ごとに分ける。Windowの生成・再利用・配置はMain Processが所有し、rendererはpreloadの公開APIを通して必要な状態と操作を受け取る。実装境界は[Electron Window Runtime](electron-window-runtime.md)、画面ごとの表示は[Desktop UI](desktop-ui.md)を参照する。

| Window | 責務 |
| --- | --- |
| Home | Sessionの検索・再開・新規作成、Character catalog、SettingsとSession Monitorへの入口 |
| Session | Main／Auxiliaryの共通chat shell、承認・実行設定、file／Git preview、Audit Log、会話操作 |
| Character Editor | Character profile、icon、theme、`character.md`、`character-notes.md`の編集 |
| Settings | app共通設定、provider設定、model catalog、診断 |
| Session Monitor | 開いているSessionの状態をcompactに監視 |
| Diff | 広い面でGit差分を比較 |
| File Preview | 対象fileを独立Windowで表示 |

Homeは作業中のchatを抱えず、Sessionはcatalogやapp共通設定の編集面を持たない。Auxiliaryは専用Windowを作らず、親Session Windowの同じchat shell内でMainと切り替える。親配下の複数Auxiliaryはstable IDで保存し、表示中でないrunも継続・terminal保存する。詳細は[Auxiliary Session](auxiliary-session.md)を参照する。

## Sessionの起動と継続

HomeのNew Sessionでtitle、workspace、provider、Characterを選び、保存済みSessionを作成してSession Windowを開く。Recent Sessionsからの再開では、同じSessionのWindowが開いていれば再利用・focusする。通常Sessionは作成時点のCharacter snapshotを保持し、catalog編集で暗黙に差し替えない。Character authoringでは専用のSession種別とworkspaceを使い、Windowの基本lifecycleは通常Sessionと共有する。

Sessionの実行状態はMainが所有する。Windowを閉じてもSession recordは残り、実行中のcloseでは確認を経て継続または中止を選ぶ。close時のAuxiliary draft flush、アプリ終了、取消の詳細は[Session Run Lifecycle](session-run-lifecycle.md)に従う。

## Windowの再利用と配置

Homeはapp起動時の管理Windowとして扱う。Sessionは同じSession IDの二重Windowを作らない。SettingsとSession Monitor、Character Editorの同じ編集対象は既存Windowを再利用する。新規の補助WindowはcursorがあるdisplayのworkArea内へ配置し、既存Windowをfocusするときは位置を変えない。Session Monitorを閉じてもrunは止まらない。

共有するSession metadata、Character catalogとWindow registryはMain側の正本から投影し、各Windowの入力途中状態はそのWindowが保持する。Character metadataと定義file、runtime snapshotの境界は[Character Storage](character-storage.md)を参照する。

Windowの責務やlifecycleを変えるときは、同じ変更で[Manual Test Checklist](../manual-test-checklist.md)の関連項目も現行化する。
