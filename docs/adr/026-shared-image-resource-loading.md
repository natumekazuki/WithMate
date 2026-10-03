# ADR 026: 共通の画像リソース読み込み

- 状態: Accepted
- 日付: 2026-10-03
- 置換対象: ADR 012・013・020の画像自動読込を登録root内へ制限する判断とchat画像の解決範囲

## 背景

登録ディレクトリ外に置かれた画像を、chat、中央File Preview、独立File Previewで表示する用途がある。利用者は私的画像の自動表示、画像のメモリー負荷、ネットワーク共有への接続リスクを許容し、画像読込ルールの共通化を依頼した。

## 判断

- `.mmd`、Markdown内のMermaid、通常Markdown画像に共通のresolverを使用する。ローカル画像は登録root内外とも自動読込し、相対pathはchatではWorkspace、File Previewでは元fileの親directory基準とする。絶対path、file URL、UNCも扱い、OSのアクセス権は迂回しない。
- Git commit previewを基準とする相対ローカル画像は解決しない。絶対pathと外部画像は利用でき、commit内容を現在のworking tree画像へ暗黙に置き換えない。
- Mainの画像専用inspect/chunk APIで、呼出元SessionとPreviewのbase resource所有関係、通常file、実path、file identity、revision、画像headerを確認する。汎用file read・directory listing、Additional Directories、Provider権限は変更しない。
- PNG、JPEG、GIF、WebP、BMP、ICO、AVIF、SVGを対象とし、拡張子だけで画像と認定しない。最終decodeはブラウザーが行う。SVGはpassive image resourceとし、inline DOMへ挿入しない。Mermaidのstrictとsanitizationは維持する。
- HTTP、HTTPS、data image、blobは共通分類し、protocol-relative URLはHTTPSに正規化する。他のURL schemeは拒否する。外部画像の自動通信方針はADR 012を維持する。
- ローカル画像は表示hostごとに4並列、1MiB chunkで読み込む。host・画像の破棄、source変更、reload、表示mode・encoding変更で古い読込を次のchunkへ進めず、所有するblob URLを解放する。
- 容量・画素数・総枚数の新しい上限、画像ごとの確認dialog、network共有専用の制限は追加しない。同時数と分割readは総メモリー容量の保証ではない。

## 代案と結果

画像表示のためのAdditional Directory登録や汎用readの認可解除は、必要以上に権限を広げるため採用しない。chatだけfile URLを直接表示する方式も、形式判定と取消の境界を共通にできないため採用しない。

画像専用経路への依存は増えるが、queueとchunk処理を共有し、表示以外の権限を維持できる。私的画像の画面への混入、大きな画像や多数画像による負荷、UNC読込に伴う通信・認証のリスクは残る。
