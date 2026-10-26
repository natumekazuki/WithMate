# Session Local Files

WithMateはSessionごとにrepository外のmanaged directory `session-files/{sessionId}/`を用意する。provider内部のsession stateやlog directoryとは分け、画像やfileをcomposerへ添付するときの保存先とする。`sessionId`は安全なpath segmentへ正規化し、directory traversalを許さない。

Main Sessionの新規作成では、`New Session`のworkspace選択やCharacter authoringにかかわらず、新しいSession IDのdirectoryを排他的に作成してからSessionを保存する。既存の同名directoryやSession recordを上書き・再利用しない。directoryの準備はprovider operation coordinator外で行い、保存時にstorage identityと起動設定を再検証する。`New Session`で`Session Folder`を選んだ場合は、作成したdirectoryをSessionのworkspaceとする。未作成の既存Sessionでは、turnでproviderへpathを渡す前にdirectoryを作成する。

## Access Contract

Session Local Filesはcomposerの`@path` preview、Markdown local image、providerのattachment／additional directory解決で許可対象に含める。ユーザーが明示追加する`allowedAdditionalDirectories`とは別のmanaged directoryであり、DBのその一覧やUIの`Dirs {N}`に数えない。`Session Folder`自体をworkspaceにした場合は同じdirectoryを二重に追加しない。promptへfile本文を常設inline展開せず、参照とprovider固有の画像入力に分ける。

## Composerと保存

`Attach`の`File`／`Folder`／`Image`は元pathを参照する。`Session Files`の`Copy`は選択fileをmanaged directoryへコピーし、その保存先をcaret位置へ`@path`として挿入する。`File`はmanaged directoryを起点にpickerを開き、その配下で選択したfileだけを参照する。外部directoryへ移動して選んだfileを、managed directory内のfileとして受け入れない。

textareaへの画像pasteはPNG、JPEG、GIF、WebP、BMP、SVGを保存してMarkdown image参照を挿入する。一般のfile pasteはmanaged directoryへコピーして`@path`を挿入する。basenameが重なれば採番する。Rendererはpaste bytesやsource pathを直接providerへ送らず、Mainのcopy／write APIを使う。

会話内の質問の自由回答も同じ添付メニュー・保存・参照挿入を使い、質問を所有するSession IDのmanaged directoryを保存先とする。回答の送信形式と操作条件は[Question Forms](desktop-ui.md#question-forms)に従う。

## 削除時の扱い

外部workspaceを使うSessionの削除では、そのSession IDのmanaged directoryをbest-effortで片付ける。managed directory自身をworkspaceとするSessionは、recordを削除してもdirectoryと内容を保持する。期間指定の一括削除でも、未読込Sessionのworkspace種別をstorage summaryで判定する。実装上のAPIとcleanupは`src-electron/files/session-files.ts`を正本とする。

## Sessionを残すファイル掃除

Settingsの`Clean Session Files`は保存済みSessionのmanaged folder内だけを対象とし、Session本体・会話履歴・Pinを更新しない。Sessionの最終利用日とファイルサイズで容量を計算し、最終確認後に対象ファイルを完全削除する。容量は通常ファイルの論理サイズの合計であり、ボリュームの空き容量増加量とは区別する。

実行中のMain／Auxiliaryを持つSession、いずれかのSessionのWorkspaceと重なるfolder、孤立folder、シンボリックリンク・junctionとそのリンク先は掃除対象にしない。Mainが解決したmanaged pathだけを使い、rendererから削除pathや全ファイル一覧を受け取らない。

計算時の対象はMainの最新一件の一時snapshotに保持する。実行ではSession incarnation、最終利用日時、storage owner、実行状態、Workspace、directoryとfileのmetadataを再確認し、計算後に増えたfileを追加せず、変更・消失したfileは除外する。新しい計算と実行で前のsnapshotを失効させる。永続的な削除台帳やhashは持たない。

削除はfileごとに成功・失敗・除外を返す。SessionFolderルートは必ず残し、計算した下位directoryは空の場合だけ削除する。非同期filesystem I/Oを使い、通常fileが残るdirectoryや計算後に追加されたdirectoryを再帰削除しない。実装は`src-electron/files/session-folder-cleanup-service.ts`、UIは[Settings UI](settings-ui.md#session-folder-cleanup)を正本とする。
