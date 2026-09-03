# Improve Existing Character

improve modeは自動的な全文再生成ではなく、既存定義を尊重した差分改善とする。

## Preserve Before Editing

変更前に既存定義を次へ分類する。短縮やsection移動を先に行わない。

### Preserve as identity signal

- 一人称と正確な表記
- ユーザー呼称と使用条件
- 常体・敬体の切り替え
- 文の長さ、構文、テンポ、語尾、語彙、表記習慣
- 繰り返し性があり、使用場面が明確なmarker
- Character固有の注意、評価、social intent、core tension

### Convert during full authoring

- `Natural Reactions`と`Situation Styles`
- 作業、失敗、成功、疲労、冗談、意見不一致の場面別規則
- 完成返答の`Examples`
- 性格形容詞や設定をそのまま返答指示にした記述

これらから有用なsignalを取り出し、Identity Core、Attention and Appraisal、Social Intent、Emotional Dynamics、Thinking and Action Style、Voice Rules、State Modulationへ一般化する。

### Move to notes or remove

- source、rights、uncertainty、改稿理由、比較候補、rejected ideaはnotesへ移す。
- すべてのCharacterに共通する正確性、読みやすさ、一般的配慮はBase Runtimeへ任せる。
- Character名を別人へ置換して成立する汎用行や同義反復は削除または固有化する。

## Targeted Update

1. ユーザー指示をobservable behaviorの変更へ翻訳する。
2. 変更を所有する最小sectionを特定する。
3. 依頼と競合しないidentity signalとrelationship boundaryを保持する。
4. 必要な箇所だけを編集し、旧sectionや既存`Examples`を理由なく再構成しない。
5. 既存事実と解釈を変えない限りsource調査を行わない。必要になればfull authoringへ切り替える。
6. 変更箇所と直接影響するbehavior、hard format、8,000 code point上限を確認する。

targeted updateでnotesが存在しない場合、source、materialな解釈、再導入防止のguardrailを残す必要がある時だけtemplateから作成する。

## Full Authoring

1. 既存定義の有用なidentity signalを先に抽出する。
2. source policyに従い、現在利用できる公式・一次情報と関連community sourceを確認する。
3. 既存主張と公開例を、状況、最初の着眼点、評価、対人行為、感情推移、言語特徴、相手・媒体・時期差へ分解する。
4. Characterらしさを「選択の核 × 言語アイデンティティ × 状態変調」として再構成する。
5. 一人称、基本呼称、敬語、構文、markerを、表記、使用条件、頻度、状態差を持つVoice Rulesへ整理する。
6. 通常傾向、反転条件、反転後の選択、一貫する上位原理をCore Tensionsへ統合する。
7. 場面別の完成返答を削り、複数の未知場面へ効くState Modulationへ変換する。
8. observation、採否、uncertainty、revision guardrail、validation結果をnotesへ記録する。
9. rubricとchecklistで必須検証を行う。

## Canonical Files

保存済み`character.md`と、存在する場合は保存済み`character-notes.md`を開始点にする。launch処理は未保存Editor draftからfilesをseedせず、既存filesをrewriteしない。未保存変更へ依存する改善なら、先に保存するよう求める。

Character Kernelは新規作成とfull authoringの推奨構造であり、legacy Characterのload contractではない。既存Characterへ自動migrationや一括rewriteを要求しない。
