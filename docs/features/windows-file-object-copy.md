# WindowsのCopy File

## 概要

Windowsでは、認可済みのregular fileをfile objectとしてclipboardへコピーできます。貼り付け先がfile dropを受け付ける場合、path文字列ではなく元のfileとして貼り付けられます。

## 操作できる場所

`Copy File`は次の入口に表示します。

- File Explorerのfile row
- File Previewのheader
- Workspace、Session Folder、Additional Directory内を指すMarkdown local-file link

directory、存在しないfile、認可root外のMarkdown linkには表示しません。

## Copy Imageとの違い

画像fileでは、次の二つを別操作として扱います。

- `Copy File`: 元のfile objectをコピーする
- `Copy Image`: 表示中のbitmapをコピーする

貼り付け先で元fileとして扱う場合は`Copy File`、画像編集や文書へ画像内容を貼り付ける場合は`Copy Image`を使用します。

## Windows helper

Electronのclipboard APIだけではfile objectを表現できないため、Windows helperを使用してfile drop形式を書き込みます。日本語を含むfile名はUnicode形式で渡します。

helperには認可済みの絶対path一件だけを渡します。shell command文字列を組み立てず、directoryや複数fileへ暗黙に拡張しません。

## 失敗時の扱い

clipboardへの書き込みに失敗した場合、path文字列へfallbackせず、成功通知も表示しません。元のclipboard内容を意図的に別形式へ置き換えません。

この機能はWindows限定です。他のOSでは`Copy File`を表示しません。

## 関連文書

- [ADR 013: Explicit Local Path Open Policy](../adr/013-explicit-local-path-open-policy.md)
- [メッセージ画像のlightbox](message-image-lightbox.md)
