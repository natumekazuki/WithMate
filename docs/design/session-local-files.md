# Session Local Files

WithMateはSessionごとにrepository外のmanaged directory `session-files/{sessionId}/`を用意する。provider内部のsession stateやlog directoryとは分け、画像やfileをcomposerへ添付するときの保存先とする。`sessionId`は安全なpath segmentへ正規化し、directory traversalを許さない。

`New Session`で`Session Folder`を選んだ場合、このdirectoryをSessionのworkspaceとする。選択時には作成せず、開始時に新しいSession IDへ排他的に作成してから保存する。既存の同名directoryやSession recordを上書き・再利用しない。

## Access Contract

Session Local Filesはcomposerの`@path` preview、Markdown local image、providerのattachment／additional directory解決で許可対象に含める。ユーザーが明示追加する`allowedAdditionalDirectories`とは別のmanaged directoryであり、DBのその一覧やUIの`Dirs {N}`に数えない。`Session Folder`自体をworkspaceにした場合は同じdirectoryを二重に追加しない。promptへfile本文を常設inline展開せず、参照とprovider固有の画像入力に分ける。

## Composerと保存

`Attach`の`File`／`Folder`／`Image`は元pathを参照する。`Session Files`の`Copy`は選択fileをmanaged directoryへコピーし、その保存先をcaret位置へ`@path`として挿入する。`File`はmanaged directoryを起点にpickerを開き、その配下で選択したfileだけを参照する。外部directoryへ移動して選んだfileを、managed directory内のfileとして受け入れない。

textareaへの画像pasteはPNG、JPEG、GIF、WebP、BMP、SVGを保存してMarkdown image参照を挿入する。一般のfile pasteはmanaged directoryへコピーして`@path`を挿入する。basenameが重なれば採番する。Rendererはpaste bytesやsource pathを直接providerへ送らず、Mainのcopy／write APIを使う。

## 削除時の扱い

外部workspaceを使うSessionの削除では、そのSession IDのmanaged directoryをbest-effortで片付ける。managed directory自身をworkspaceとするSessionは、recordを削除してもdirectoryと内容を保持する。期間指定の一括削除でも、未読込Sessionのworkspace種別をstorage summaryで判定する。実装上のAPIとcleanupは`src-electron/files/session-files.ts`を正本とする。
