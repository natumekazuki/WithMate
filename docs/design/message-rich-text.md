# Message Rich Text

- 作成日: 2026-03-14
- 対象: Session Window の assistant / user message 表示

## Goal

Codex の返答を生テキストの塊として出すのではなく、読みやすい最小限の rich text として表示する。

対象は readability 改善であり、完全な Markdown renderer を作ることではない。

## Supported Syntax

現行実装で表示を整える対象:

- 段落
- 改行
- `#` / `##` / `###` 見出し
- `- item` / `* item` の箇条書き
- `1. item` の番号付きリスト
- インラインコード `` `code` ``
- コードフェンス ````` ``` `````
- Markdown link `[label](target)`

## Link Handling

- `http://` / `https://` は外部ブラウザで開く
- ローカル絶対パスは OS に関連付けられた既定動作で開く
- 開けない場合でも chat 表示自体は壊さない

## Non Goals

- CommonMark 完全互換
- テーブル構文
- ネストした list の厳密再現
- HTML 埋め込み
- 数式

## Rendering Policy

- まず block を切り分ける
- block 内では inline token を解釈する
- 改行は視認性優先で保持する
- インラインコードは pill 風に表示する
- コードフェンスは dark panel で表示する
- Markdown link は chip 風に表示し、クリックで開けるようにする

## Safety

- `dangerouslySetInnerHTML` は使わない
- 文字列をアプリ側で限定的に parse して React element へ変換する

## Related Documents

- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
