# WindowsのCopy File

## 概要

Windowsでは、ユーザーが指定した実在するregular fileをfile objectとしてclipboardへコピーできます。貼り付け先がfile dropを受け付ける場合、path文字列ではなく元のfileとして貼り付けられます。

## 操作できる場所

`Copy File`は次の入口に表示します。

- File Explorerのfile row
- File Previewのheader
- チャット（送信待ちを含む）とFile Preview内のMarkdown local-file link

directory、存在しないfile、外部URLには表示しません。Markdown linkと通常File Previewの明示的なコピーはSessionの作業root外も対象にし、Additional Directoryやエージェント権限を追加しません。File Explorerの表示範囲はSessionの作業rootを維持します。

## Copy Imageとの違い

画像fileでは、次の二つを別操作として扱います。

- `Copy File`: 元のfile objectをコピーする
- `Copy Image`: 表示中のbitmapをコピーする

貼り付け先で元fileとして扱う場合は`Copy File`、画像編集や文書へ画像内容を貼り付ける場合は`Copy Image`を使用します。

## Windows helper

Electronのclipboard APIだけではfile objectを表現できないため、Windows helperを使用してfile drop形式を書き込みます。日本語を含むfile名はUnicode形式で渡します。

helperの起動はコピーごとのWorkerで行い、OSのprocess起動待ちでMain processを停滞させません。書き込み用と検証用helperの起動・初期化は並行しますが、検証用helperがclipboardを読むのは書き込み用helperの終了後です。別processによるfile-drop path、copy用drop effect、操作markerの一致と対象fileの現在性を確認してから成功を通知します。

helperには認可済みの絶対path一件だけを渡します。shell command文字列を組み立てず、directoryや複数fileへ暗黙に拡張しません。

## 失敗時の扱い

clipboardへの書き込みに失敗した場合、path文字列へfallbackせず、成功通知も表示しません。元のclipboard内容を意図的に別形式へ置き換えません。

## Copy結果の通知

File Previewの`Copy File`成功・失敗は、headerの操作群の直下に重なる通知として表示します。通知は操作群のレイアウト領域に参加しないため、既存の`Find`、`Reload`、`Open`などの位置を動かしません。

成功はsuccess tone、失敗はerror toneで表示し、成功をエラー表示と誤認しないようにします。通知は共通の`AppNotification` primitiveを使いますが、現在の適用先はFile Previewだけです。preview本文の読み込み・表示エラーに使う下端のfeedbackとは別の表示領域です。

この機能はWindows限定です。他のOSでは`Copy File`を表示しません。

## 関連文書

- [ADR 013: Explicit Local Path Open Policy](../adr/013-explicit-local-path-open-policy.md)
- [メッセージ画像のlightbox](message-image-lightbox.md)
