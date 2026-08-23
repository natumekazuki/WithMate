# ADR 022: Repository Glossaryはcheckout fileを正本にSession境界へ投影する

## Status

Accepted

## Context

リポジトリ固有の語をSession message内で説明するには、手編集できる正本、provider Sessionに限定した変更権限、外部編集への追従、Markdown構造を壊さない表示投影が必要になる。用語集内容をWithMate DB、Session data、Memory、managed Skillへ複製すると、外部編集後にどれが現在値か判定できない。rendererやCLIがpathを自己申告する方式では、別checkoutへauthorityを広げられる。

## Decision

### `GLOSSARY-SOURCE-OF-TRUTH`

- 各Git checkout rootの`.withmate/glossary.yaml`だけを用語集内容の永続正本とする。schema v1のentryは`term`、省略可能な`aliases`、plain textの`definition`で構成し、YAML順を保持する。
- 正規化値、検索順位、revision、annotation range、hover previewはread-time projectionとする。WithMate DB、Memory、Session data、provider prompt、managed Skillへ用語集内容を保存または自動注入しない。
- schema parse、file全体の正規化後一意性、lookup、検索、revision、mutation、checkout再検証は`GlossaryApplicationService`をcanonical ownerとする。readは`.withmate`やfileを作成しない。

### `GLOSSARY-CHECKOUT-AUTHORITY`

- actor Sessionのruntime bindingが所有するprimary `workspacePath`から、Git rootとfilesystem identityをbinding generationごとに固定する。inventoryはこの1件だけを返し、additional directory、別worktree、後から列挙したworktreeを含めない。
- `{ kind: "primary" }`とgeneration-boundなopaque `checkoutId`は同じtargetを指す。Session終了、binding失効、generation更新で`checkoutId`を無効にする。path、branch、repository名は表示専用である。
- MCP、CLI、renderer IPCはcaller提供のSession IDやpathをauthorityへ使わず、同じruntime binding、operation schema、application service、result contractへ収束する。

### `GLOSSARY-ATOMIC-MUTATION`

- mutationは同一directoryの排他的temporary fileへ完全なYAMLを書き、flushとclose後にbinding、Git root、directory、target identity、expected revisionを再検証してから`fs.rename`で置換する。targetを先に削除しない。
- `effect: applied`はrename後のidentity-bound read-backがschemaと要求postconditionへ完全一致した場合だけ返す。操作前のraw hashとidentityを安全に確認できた場合は`none`、一意に分類できない場合は`unknown`とする。`unknown`を自動retryしない。
- response loss retryは永続ledgerを作らず、create、batch、update、deleteごとの完全なpostcondition tupleで`converged`を判定する。`converged`は現在値の一致であり、その試行がwriteしたことの監査証明ではない。

### `GLOSSARY-ANNOTATION-PROJECTION`

- 保存済みmessageへannotation metadataを書かず、current valid snapshotからrender時に導出する。`MessageRichText`のMarkdown parse後に得た通常text nodeだけを対象とし、link、URL、inline code、code block、数式projectionを除外する。
- lookupはNFKCとlowercaseと空白正規化を共有し、候補の重なりは最長一致、同長はYAML順とする。grapheme単位の正規化を元UTF-16 offsetへ対応付け、安全な非重複rangeへ戻せない候補は装飾しない。
- identifier境界は、文字をLatin、Greek、Cyrillic、Han、Hiragana、Katakana、Hangulなどのclassへ分ける。同じclass、数字、connector、結合markが隣接する候補はidentifier内部として除外し、異なるscriptの隣接は日本語文中の`APIを`のような表記を妨げない。
- matcher候補数、message文字数、比較回数、annotation数にhard limitを置く。上限到達後は残りのtext nodeを変更せず、message本文を欠落させない。
- annotationはmessageごとのroving `tabIndex`を使う。左右、Home、Endで移動し、EnterまたはSpaceでcanonical entryを開く。Escapeはtooltipだけを閉じる。IME composition、Dead key、AltGraph、修飾key、処理済みevent、Tabを奪わず、component内へglobal shortcutを追加しない。

### `GLOSSARY-READ-ONLY-UI`

- main processのglossary application boundaryがcheckout watcherと再読込を所有する。filesystem eventは再読込の契機に限り、rendererへpathやraw eventを渡さない。rendererは`valid`、`missing`、`invalid`、`unsupported`、`watch-error`とrevisionを持つbounded projectionだけを受け取る。
- 既存Session right paneのtab ownerへGlossary面を追加する。検索、flat list、詳細、checkoutの短い表示だけを提供し、CRUDとfile初期化UIは置かない。invalid化、削除、binding generation変更ではstale entryとannotationを表示しない。
- hoverまたはfocusのtooltipはviewport内に収め、最大360×240px、非interactive、非scrollableとする。clickまたはaccepted keyboard activationだけがright paneを表示してcanonical detailを選ぶ。

### `GLOSSARY-PLAIN-TEXT-DEFINITION`

- `definition`はtooltipとright paneのどちらでもtext nodeとして描画し、MarkdownまたはHTMLとして解釈しない。tooltipはmessage DOM外へportalし、messageのselection、copy、find対象へ説明文を混入させない。

## Consequences

- repositoryの手編集とSession UIは単一fileのrevisionへ収束し、invalid fileを最後のvalid snapshotで隠さない。
- 1 Sessionから複数worktreeを操作できない。別worktreeには、そのworktreeをprimary workspaceとする別Sessionが必要になる。
- annotationは有効な用語集が大きすぎる場合にfail openし、本文だけを表示する。用語集のread、right pane、MCP、CLIはannotation matcherの上限に依存しない。
- process crashや電源断に対するdurabilityは、可視上のatomic replaceと同じ保証には含めない。

## Executable contract

- source、schema、atomic mutation: `src/glossary-contract.ts`、`src-electron/glossary-application-service.ts`、`scripts/tests/glossary-application-service.test.ts`
- runtime authority、MCP、CLI: `src-electron/glossary-runtime-service.ts`、`src/glossary-operation-schema.ts`、`scripts/tests/glossary-runtime-service.test.ts`、`scripts/tests/withmate-glossary-cli-mcp.test.ts`
- external update、renderer projection: `src-electron/glossary-session-projection-service.ts`、`scripts/tests/glossary-session-projection-service.test.ts`、`scripts/tests/session-glossary-pane.test.tsx`
- annotation、keyboard、tooltip: `src/glossary/glossary-annotation-projection.ts`、`src/glossary/MessageGlossaryAnnotations.tsx`、`scripts/tests/glossary-annotation-projection.test.ts`、`scripts/tests/message-glossary-annotation.test.tsx`
- managed distribution: `src-electron/managed-memory-skill-service.ts`の`ManagedSkillDistributionService`、`scripts/tests/managed-memory-skill-service.test.ts`、`scripts/tests/managed-glossary-skill-service.test.ts`

## Alternatives

### WithMate DBまたはSession dataへentryを複製する

外部編集後の正本が分岐し、削除やinvalid化でもstale表示が残るため採用しない。

### rendererまたはCLIにabsolute pathを指定させる

runtime bindingのcheckout scopeをcaller入力で拡張できるため採用しない。

### raw Markdownを別parserで走査する

表示構造とoffsetが分岐し、codeとlinkの除外、selection、findを壊すため採用しない。

### annotationごとに通常のTab stopを置く

長いmessageでdocumentのTab順を占有するため採用しない。
