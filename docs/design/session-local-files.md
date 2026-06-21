# Session Local Files

- 作成日: 2026-05-17
- 対象: Session ごとの repo 外ファイル置き場と composer 連携

## Goal

WithMate の Session ごとに、repo へ入れない一時資料を置ける managed directory を用意する。
ユーザーは composer への paste や picker から画像・ファイルを追加し、保存された path をそのまま prompt reference として使える。

## Position

- この機能は provider 内部の session-state や log directory を使わない
- 保存先は WithMate app data 配下の managed directory とする
- session local files は user-managed additional directories ではなく、runtime が常に暗黙許可する directory として扱う
- prompt 本文には保存済み file path の reference だけを入れ、file 内容の常設 inline 展開はしない
- V5 preview では legacy MateTalk runtime / window を current runtime として提供しない。本文中の MateTalk 記述は stale `mate-talk-*` directory cleanup などの legacy compatibility として扱う

## Directory Layout

通常 Session、Companion Session、legacy MateTalk は同じ layout で保存する。

```text
session-files/{sessionId}/
```

`sessionId` は path segment として安全な文字だけへ正規化する。既存 ID は UUID 形式だが、将来の prefix 付き ID でも directory traversal を起こさないことを優先する。

## Access Contract

Session local files directory は次の経路で常に effective allowed directory に含める。

- composer preview の `@path` 解決
- provider prompt composition の `additionalDirectories`
- Codex thread options
- Copilot session config / attachment roots
- Companion runtime の composer preview と provider runtime
- legacy MateTalk の picker / paste 由来 attachment と provider runtime

DB の `allowedAdditionalDirectories` へは保存しない。
これはユーザーが明示追加した external directory と、WithMate が管理する session-local directory を分けるためである。
UI の `Dirs {N}` はユーザー追加分だけを数え、session local files は数に含めない。

## Composer UI

既存の `File`、`Folder`、`Image` ボタンは「元の path をそのまま参照する」操作として維持する。

新しく `Attach Copy` action を追加する。

- picker で選んだ file を session local files directory へコピーする
- 複数 file を選んだ場合は選択順にまとめてコピーする
- コピー先 path を composer の caret 位置へ `@path` として挿入する
- 複数 file を選んだ場合は複数 reference を挿入する
- repo 内 file でも `Session` action ではコピーする

`Session File` action は session local files directory を初期位置にして picker を開く。
選択された file はコピーせず、その path を composer の caret 位置へ `@path` として挿入する。
選択結果は session local files directory 配下に限定し、dialog から外部 directory へ移動して選んだ file は参照として採用しない。

composer textarea の paste は次のように扱う。

- text only: 通常 paste
- image: PNG として保存し、保存先 reference を挿入する
- file: session local files directory へコピーし、保存先 reference を挿入する
- mixed: browser / Electron が提供する file item を優先し、保存できた reference を挿入する

保存時の basename 衝突は `name-2.ext` のように採番する。
paste image は `pasted-YYYYMMDD-HHMMSS.png` を基本名にする。

## IPC

renderer は file path と paste bytes を直接 provider に渡さない。
main process が managed directory を作成し、copy / write を担当する。

必要な API は次の通り。

- `copyFilesToSessionFiles(sessionId, sourcePaths)`
- `pickSessionFiles(sessionId)`
- `savePastedSessionFile(sessionId, fileName, bytes)`
- `openSessionFilesDirectory(sessionId)`
- `openSessionFilesTerminal(sessionId)`

戻り値は保存済み absolute path の配列とする。
composer は戻り値を既存の `@path` reference 挿入処理へ渡す。

## Cleanup

Session 削除時の cleanup は session ID 単位で directory を削除する。
削除に失敗しても session 削除自体は失敗させず、best-effort cleanup として扱う。
legacy MateTalk は永続 session record を持たないため、window ごとの一時 session ID を使っていた。
`mate-talk-*` の session files directory は使い捨て扱いとし、次回起動時に stale directory を削除する。

## Validation

- paste image が session local files directory に保存され、composer に reference が挿入される
- `Session` action で選んだ file がコピーされ、コピー先 reference が挿入される
- preview で session local files が outside workspace attachment として認識される
- Codex / Copilot runtime に session local files directory が additional directory として渡る
- `Dirs {N}` は session local files を数えない
