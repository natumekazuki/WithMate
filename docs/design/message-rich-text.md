# Message Rich Text

## Goal

Session message と Markdown file preview に同じ rich text renderer を使い、構文、link、image の挙動が表示面によって分岐しないようにする。構文と表示の executable contract は `src/ui/markdown/MessageRichText.tsx` と `tests/renderer/message-rich-text.test.ts` を正本とする。

## Link Handling

- Mermaidのstrict rendererが生成したSVG linkも同じ明示open経路を使う。図のanchorはrawなhref／xlink:hrefを渡し、Mermaid file previewの相対linkはそのfileの親directory、会話内の相対linkはWorkspaceを基準にする。図内でElectron document自体を遷移させず、auxiliary clickとpan後のclickではopenしない。同一page fragmentはdocument navigationを行わない
- Mermaidのstrict設定とsanitizationは維持する。sanitizerが除去したdestination（file URLやWindows drive表記を含む）は原文から復元せず、図を保持して開けない理由を表示する。対応する相対link等での不存在・認可失敗は既存の操作元feedbackへ返す

- リンク表示はSession会話と中央／独立Markdown file previewで共通化する。通常・訪問済みとも周囲の本文色を継承し、常時実線の下線で本文と区別する。hover／keyboard focusでは下線を太くし、focusには同色の輪郭も表示する
- リンク内のinline codeはリンク色と下線を保ち、長いURL／pathも表示幅内で折り返す。表示の調整は共通CSSで行い、利用者向け設定や保存項目は持たない
- `http://` / `https://` は外部ブラウザで開く
- Session message のローカル絶対 path と workspace 相対 path は、regular fileならroot内外ともdetached file previewで開く。directoryならroot内外とも明示的なlink操作でOSのfile managerへ渡す。表示やlink解決だけでは自動openしない
- ローカル path link に `#L10` などの fragment が付いている場合は、少なくとも path 本体を開けるように fragment を無視して扱う。`:10` または `:10:4` 形式は、指定された path が存在しない場合だけ行番号または行番号と列番号として扱う
- Markdown file previewの相対linkはそのfileの親directoryを基準に解決し、root外のfile／directoryにも明示的に移動できる。画像の自動読込は下記の共通画像経路を使用する
- directory linkはMainでcanonical real pathへ解決し、symlink／junctionも解決先を使う。OS open前にdirectoryのkindとcanonical path、送信元Windowの同一性とSession所有／Preview baseを再確認する。既解決pathはURLや行番号suffixとして再解釈しない
- macOSでは通常folderもapp bundle／packageもFinderで対象を選択表示する。`/usr/bin/open -R`へcanonical pathを独立した引数で渡し、既定appの起動へ委譲しない。commandの終了を待ち、失敗を成功扱いや既定openへのfallbackにしない。Windows／Linuxでは既存のdirectory openを使う
- directoryを開いてもAdditional DirectoryやProviderのアクセス権限を追加せず、アプリ内directory列挙のroot制限は維持する。不正path、消失、file／special objectへの差替、canonical path変更、所有関係の不一致、OS open失敗は操作元のfeedbackへ返す。成功時は既存の操作元errorを消す
- OS の既定アプリで file を開けない場合は理由を表示し、通常の Open から Explorer 表示へ自動で切り替えない
- render 済み link の context menu は`Copy link`を提供する。protocol-relativeを含む外部 URL は表示 label ではなく `href` target を保ち、local / `file:` / Windows absolute path は通常の Open と同じ Main process の path 解決境界で decode・filesystem path 変換して clipboard へ渡す。最終的な copy target に制御文字を含む場合は clipboard を更新せず失敗として通知する
- HTTP / HTTPS、`mailto:`、workspace 相対 path、`file:`、Windows absolute pathをcopy対象とし、unsafe schemeで除去されたlinkと同一pageの`#` anchorは対象にしない
- context menuはmouseの右clickに加え、focusしたlinkからShift+F10またはContext Menu keyで到達できるnative menuとする。dismissはcopy成功として通知しない
- detached previewのnavigationとroot authorizationの判断は[ADR 020](../adr/020-file-preview-window-navigation.md)、明示directory openの判断は[ADR 025](../adr/025-explicit-directory-link-open.md)を参照する

## Image Handling

- chatと中央／独立File Previewは、通常Markdown画像とMermaid画像に同じ画像resolverを使用する。local画像は登録root内外とも既定表示し、相対pathはchatではWorkspace、file previewでは元fileの親directory基準とする。絶対path、file URL、UNCを扱い、Additional DirectoriesやProvider権限を変更しない。Git commit previewの相対local画像は解決せず、絶対pathと外部画像のみを扱う
- HTTP、HTTPS、data image、blobを許可し、protocol-relative URLはHTTPSへ正規化する。他のURL schemeは拒否する。外部通信の判断は[ADR 012](../adr/012-markdown-resource-loading-policy.md)、local画像の共通認可境界は[ADR 026](../adr/026-shared-image-resource-loading.md)を正本とする
- SVG は `<img>` の resource として描画し、inline DOM へ挿入しない
- local画像はchat column／file previewごとに4並列、1MiB chunkで読み込む。file、reload、mode、encoding、画像sourceの切替またはunmountで待機中の旧処理を破棄し、実行中のstale readを次のchunkへ進めない。表示継続時もresolverを更新して再解決する。容量・画素・総枚数・timeoutの上限は設けず、全量保持のメモリー負荷は残る。画像表示による通信・私的画像の表示は自動的に起こり得る。
- local画像はMainの画像専用inspect/chunk APIでSessionとbase resourceの所有関係、通常file、実path・identity・revision、画像headerを確認する。拡張子だけで認定せず、ブラウザーがdecodeできる画像を表示する。汎用file read・directory列挙のroot認可は維持する
- 画像の resolving/loading はresourceの待機状態として保持し、表示開始から1,000ms未満は補助UIを表示しない。閾値を超えて未完了の場合だけ、画像領域内へ小さなspinnerを重ねて表示し、完了またはerrorで除去する。resolvingからloadingへ進む同一resourceの待機では表示タイマーをリセットしない。spinnerは`role="status"`相当の読み上げ名を持つが、本文の検索対象へ補助文字列を追加しない。errorは対象resourceを識別できる既存の失敗表示を維持する
- Markdownの`img`、`a`、`pre` component typeはrenderごとに再生成せず、動的な操作callback、resource resolver、render modeだけを現在のcontextとして渡す。これによりcallback更新、本文末尾への追記、light/full切替では同じ位置の画像DOM・読み込みstate・lightbox stateを保持し、sourceまたはresource世代の変更では既存のresolver lifecycleに従って再読み込みする

## Mermaid Images

- `.mmd`、Markdown file内と会話内のMermaid flowchartは、標準のimage node記法とlabel内のHTML `img`で画像を表示する。HTML画像はnode、edge、subgraph見出しで使用できる。

```mermaid
flowchart LR
  A@{ img: "./画像 サンプル.png", label: "入力画像", h: 160, constraint: "on" }
  B@{ img: "./result.svg", label: "処理結果", w: 240, h: 160, pos: "t" }
  A --> B
```

- HTML画像は `A["<img src='file:///C:/work/icon.png' width='64' height='64' alt='画像'>"]` のように記述する。`src`は標準画像と同じresolverを使い、`alt`をaccessible name、省略時は所属node／edge／subgraphのIDを用いる。`width`、`height`とstrictが許可するstyleでサイズを指定でき、CSSサイズ指定がなければ不足する寸法を画像の縦横比から補う。node内の画像配置・幅調整はMermaidのHTML label処理に従い、`object-fit`未指定時は`contain`で画像内容の縦横比を保つ。`srcset`は使用せず、画像選択で共通resolverを迂回しない。
- `img`もImage Handlingの共通解決規則に従う。Windowsの絶対pathは`C:/work/images/sample.png`、file URLは`file:///C:/work/images/sample.png`と記述できる。空白・日本語を含むpathは引用符で囲む。登録root外の画像と、root外absolute previewからの相対画像もMainの画像専用経路で読み込む。
- local画像は既存File Previewと同じPNG、JPEG、GIF、WebP、BMP、ICO、AVIF、SVGを対象とし、ブラウザーがdecodeできるものを表示する。SVGは常にpassive image resourceとして扱い、画像内容をinline DOMへ入れない。
- サイズ・label位置はMermaid標準の`w`、`h`、`constraint`、`pos`に従う。縦横比を保つ場合は`h`と`constraint: "on"`を指定する。`label`を可視の説明と画像のaccessible nameに使用し、省略時のaccessible nameはnode IDとする。図のZoom／Fit／scroll／Ctrl＋dragをそのまま利用できる。
- 不存在・読込不可・未対応・decode失敗は画像ごとのplaceholderとnode ID・対象path・理由を表示し、残りの図を保持する。修正後はFile PreviewのReloadで再読込する。source変更・unmount時はstale resultを表示せず、所有するobject URLを解放する。
- 共有rendererは呼出元の画像resolverを利用し、会話内も通常Markdown画像と同じlocal／外部画像を扱う。画像resolverのない表示面ではlocalを直接file URLで描画せず、解決できない理由を示す。
- strictとsanitizationは維持する。標準parserから画像nodeを読み、認可・decode後に自然寸法だけを持つアプリ生成placeholderへ標準metadataで差し替えて通常renderする。HTML `img`のsrcはparse前に識別用placeholderへ置換し、parse済みlabelに残る画像だけを解決する。subgraphの配置前にも寸法を確保し、strictで生成したSVGのexact placeholderに一致する`image`／`img`だけへ検証済みresource URIとaccessible nameを設定する。sanitizerが除去したevent属性・link destination・任意HTMLは復元しない。画像bytesをMermaid sourceへ埋め込まず、文字数上限も変更しない。

## Non Goals

- CommonMark 完全互換
- 通常Markdown本文の任意HTML埋め込み（Mermaid label内のHTML画像とは別）

## Rendering Policy

- message と file preview は同じ component mapping を使う
- 呼び出し元は path open と local image resolution の context だけを注入する
- Quote を提供する共通 chat window は Preview を既定とし、ActionDock の表示切替で message column 全体を Source にできる。Source は元 Markdown を plain text として表示し、選択、Quote、検索は表示中の source text を対象にする
- assistant response の選択 action は Session chat root が overlay と stacking context を所有し、message surface や ActionDock の局所 stacking context から分離する。位置と lifecycle の executable contract は `src/chat/selection-action-overlay.ts` と `tests/renderer/session-message-column.test.ts` を正本とする
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
