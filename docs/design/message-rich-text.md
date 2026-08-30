# Message Rich Text

- 作成日: 2026-03-14
- 対象: Session Window の message と Markdown file preview

## Goal

Session message と Markdown file preview に同じ rich text renderer を使い、構文、link、image の挙動が表示面によって分岐しないようにする。構文と表示の executable contract は `src/MessageRichText.tsx` と `scripts/tests/message-rich-text.test.ts` を正本とする。

## Link Handling

- `http://` / `https://` は外部ブラウザで開く
- Session message のローカル絶対 path と workspace 相対 path は detached file preview で開く。外部 URL と directory は既存の OS 導線を維持する
- ローカル path link に `#L10` などの fragment が付いている場合は、少なくとも path 本体を開けるように fragment を無視して扱う。`:10` または `:10:4` 形式は、指定された path が存在しない場合だけ行番号または行番号と列番号として扱う
- Markdown file preview の相対 link と相対 image は、その file の親 directory と同じ認可済み root の中で解決する
- OS の既定アプリで file を開けない場合は理由を表示し、通常の Open から Explorer 表示へ自動で切り替えない
- render 済み link の context menu は「リンクをコピー」を提供する。protocol-relativeを含む外部 URL は表示 label ではなく `href` target を保ち、local / `file:` / Windows absolute path は通常の Open と同じ Main process の path 解決境界で decode・filesystem path 変換して clipboard へ渡す。最終的な copy target に制御文字を含む場合は clipboard を更新せず失敗として通知する
- HTTP / HTTPS、`mailto:`、workspace 相対 path、`file:`、Windows absolute pathをcopy対象とし、unsafe schemeで除去されたlinkと同一pageの`#` anchorは対象にしない
- context menuはmouseの右clickに加え、focusしたlinkからShift+F10またはContext Menu keyで到達できるnative menuとする。dismissはcopy成功として通知しない
- detached preview の navigation と root authorization は `docs/adr/020-file-preview-window-navigation.md` を正本とする

## Image Handling

- absolute local path、`file:`、HTTP、HTTPS、data、blob image を既定表示する。protocol-relative URL は HTTPS に正規化する。Markdown file preview の local image は相対・絶対とも登録済み root へ対応付け、file の親 directory または対応する root から認可済み read を行う
- external image の自動通信と CSP の判断は `docs/adr/012-markdown-resource-loading-policy.md` を正本とする
- SVG は `<img>` の resource として描画し、inline DOM へ挿入しない
- file preview の local image 読込は Main process の root authorization と chunk read を経由し、preview 単位の固定同時数キューで実行する。file、reload、表示 mode、encoding の切替または unmount 後に待機処理を開始せず、実行中の stale read も次の chunk へ進めない。表示を継続する切替では resolver identity を current generation へ更新し、同じ source も再解決する
- resolving、loading、error を visible state として表示する

## Non Goals

- CommonMark 完全互換
- HTML 埋め込み

## Rendering Policy

- message と file preview は同じ component mapping を使う
- 呼び出し元は path open と local image resolution の context だけを注入する
- Quote を提供する共通 chat window は Preview を既定とし、ActionDock の表示切替で message column 全体を Source にできる。Source は元 Markdown を plain text として表示し、選択、Quote、検索は表示中の source text を対象にする
- assistant response の選択 action は Session chat root が overlay と stacking context を所有し、message surface や ActionDock の局所 stacking context から分離する。位置と lifecycle の executable contract は `src/chat/selection-action-overlay.ts` と `scripts/tests/session-message-column.test.ts` を正本とする
- message の表示 mode は window mount 中だけ保持し、永続化しない。切替時は既存の selection を解除する
- Markdown file preview は Preview を既定とし、Source は file preview 側が切り替える
- YAML frontmatter at the start of a document is rendered in Preview as a two-column metadata table when it is a non-empty top-level scalar mapping. The left column is the YAML key and the right column is its scalar value; complex values, multiline scalars, parse failures, and empty frontmatter fall back to a YAML code-like block that preserves its `---` delimiters and line breaks. Long values wrap within the preview surface. Unclosed frontmatter and thematic breaks outside the document-start frontmatter remain ordinary Markdown; Source always keeps the original Markdown.

## Repository Glossary Annotation

- Session messageのPreviewだけが、current valid glossaryからannotationをrender時に導出する。file previewとSource表示へは適用しない。
- raw Markdownを再解釈せず、Markdown parse後の通常text nodeをrehype段階で置換する。link、URL、inline code、code block、数式projectionは対象外とする。
- annotation wrapperは元の表示文字列だけを保持する。tooltipはmessage DOM外へportalし、selection、copy、rendered message findのtextを変えない。
- matcher、Unicode offset、hard limit、keyboard、tooltip、activationの契約はADR 022と`src/glossary/`以下を正本とする。

## Safety

- user-provided SVG や未 sanitization の HTML へ `dangerouslySetInnerHTML` を使わない。Mermaid は strict mode で生成した projection に限り、既存の専用 renderer 境界で挿入する
- user-provided SVG を inline render しない

## Related Documents

- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
