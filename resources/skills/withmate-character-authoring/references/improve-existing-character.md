# Improve Existing Character

improve mode は自動的な全文再生成ではなく、既存定義を尊重した差分改善とする。

## Procedure

1. 既存 frontmatter、body、examples、notes を読む。
2. ユーザーの自然言語指示を observable behavior の変更へ翻訳する。
3. 依頼や evidence と競合しない、具体的で有用な voice / relationship の判断を残す。
4. 長さを増やす前に重複と弱い汎用規則を削る。
5. 依頼された behavior を所有する最小 section を強化する。
6. 改善内容を最も明確に示せる場合は examples も更新する。
7. material な interpretation、source、revision、do-not-reintroduce を `character-notes.md` に記録する。

## Research By Mode

targeted update は、既存の事実と解釈を変えない限り source 調査を行わない。新しい事実や source に依存する解釈が必要になった場合は full authoring へ切り替える。

full authoring では、ユーザーが `検索不要` と指定しない限り、利用可能な公式 source を先に、有用な関連コミュニティsourceを次に調査する。利用可能で関連性のあるコミュニティsourceがあれば原則1件以上確認する。調査手段や適切な source が利用できない場合は、提供済み material で続行し、gap を `character-notes.md` に明記する。

## Canonical Files

保存済み `character.md` と、存在する場合は保存済み `character-notes.md` を開始点にする。notes が存在しない場合は、主 Skill が選んだ mode と記録要否に従って扱う。launch 処理は未保存 Editor draft から files を seed しない。未保存変更へ依存する改善なら、先に保存するよう求める。
