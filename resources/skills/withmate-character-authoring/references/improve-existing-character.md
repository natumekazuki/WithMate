# Improve Existing Character

既存のWithMate V5 Characterを、ユーザーが感じるらしさと実際の会話出力を確認しながら改稿する。formatを新しくすることや短縮自体を成功としない。

WithMateでは保存済み`character.md`と、存在する場合の`character-notes.md`がCharacter directoryのcanonical filesである。候補を外部の採用版へ自動同期したり、Notion・Zip・別revision保存へ広げたりしない。

## Input / Optional Context

会話、既存files、過去のフィードバックから分かるものを引き継ぐ。次は必要な場合だけ確認する。

- 実際の入力と未編集の出力、モデルや利用環境（分かる範囲）
- 作業中の途中発話・tool結果・変更やテストのログ、表示・注入条件（既にある範囲）
- 対象作業と、集中時・途中報告・割り込みへの違和感や維持したい点
- 利用範囲: conversation-and-work（標準）/ conversation-only（会話専用の明示指定）
- 似ていない点、弱くなった特徴
- 良かった点、変えたくないところ
- 対象personaの時期・媒体・対人場面・ネタバレ範囲
- 参考の公式URL / community URL / 公開場面
- 関係性、呼称、甘さ、からかい等の変更希望

既に答えられた項目を聞き直さない。未回答は調査で解けるものを先に調べ、ユーザーへ聞くのは品質に影響する解釈だけに絞る。

## Governing Documents

設計は`runtime-philosophy.md`、本文は`character-format.md`、sourceは`source-and-rights-policy.md`、検証は`authoring-rubric.md`と`review-checklist.md`に従う。

schema v5、本文8,000文字上限、`character-notes.md` optional、Character directory外を変更しない境界を維持する。targeted updateとfull authoringを分け、既存版を読んだだけで全面改稿済みとは扱わない。

WithMateの標準用途は会話と実作業の併用。既存の対象用途を引き継ぎ、会話専用の明示指定だけで作業testを非該当にする。作業ログがない場合は、ないことと検証範囲を記録して候補の試験へ進める。

## 1. Preserve the Existing Definition

既存`character.md`、存在する場合のnotes、source、色、過去の改稿理由を読む。旧版にある有用な声・距離・構文・反応・状態差を先にPreserve候補として挙げる。

「既存を無理に引き継がなくてよい」は本文構造の再設計を許す指定であり、ユーザーが良いと確認した声や性質を自動で捨てる許可ではない。

## 2. Read Feedback before Rewriting

ユーザーが失われたと述べた特徴、保ちたい点、出力への違和感を分けて読む。定義文に書かれていることと、通常出力に現れることを混同しない。

低温さ、馴れ馴れしさ、常用の口癖、ミーム反応など、具体的に示された特徴は今回の保護対象にする。実出力がない場合は、定義から分かる問題と未確認の原因仮説を明示する。

## 3. Diagnose the Regression

旧版と現在の出力を、可能な範囲で次の観点から読む。

| 観点 | 確認すること |
| --- | --- |
| 平常の存在感 | 本来の声・距離・絡み方が特別な状態だけへ押し込まれていないか |
| 声の具体性 | 一人称、呼称、語尾、構文、短い口癖が抽象語へ置換されていないか |
| 出現条件 | markerに「まれ・少量・一回だけ」が重なり、発火しなくなっていないか |
| 親しさの変換 | 遠慮の薄さ、張り合い、ちょっかいが穏当な共感・助言だけになっていないか |
| 状態と優先 | 長文や真剣さのたびにvoiceを停止していないか |
| 作業中の声 | 開始と最後だけCharacterらしく、中盤の読み取り・編集・検証では別人にならないか |
| 作業の出来事 | 自分の見立てや変更、既存不具合、環境障害とユーザーの失敗を混同していないか |
| 発話と成果物 | 毎操作の実況、必要な報告の欠落、コードや設定への無目的なCharacter語混入がないか |
| 調査 | profileや書面だけから日常の口語を作っていないか |
| 評価 | 作例、口癖禁止試験、自己採点を自然生成の証拠と混同していないか |
| 外部条件 | Base Runtime、モデル、段階ごとの注入・表示・省略、設定、履歴、別エージェントの差があり得るか |

原因を定義だけに断定しない。調べられる利用条件は調べ、取得できないものはunknownとする。提供済みのログや設定を理由なく再提出させない。

## 4. Separate Preserve / Revise / Investigate

- **Preserve**：ユーザーが良いと確認した声、距離、構文、反応、状態差。単独では一般的でも組合せへ効く特徴を含む。
- **Revise**：抑制過多、優先順位の矛盾、一般的な美徳への置換、固定返答、重複。
- **Investigate**：本人使用歴、時期差、一対一呼称、音声・テンポ、語句の反復性が未確認の項目。
- **Notes-only**：source、比較候補、権利、旧版、検証記録、採用しなかった案。

完成返答のExamplesを整理する場合も、そこにしかない語尾、構文、距離のsignalを先に抽出する。短い特徴ラベルを、確認なく弱い形容詞へ置き換えない。

## 5. Expand Relevant Research

full authoring、sourceに依存する変更、またはユーザーが調査を求めた場合だけ調査する。公式・canon・一次情報と関連community sourceを再確認し、プロフィールの最新性と再現したい時期の口語を別軸で扱う。

元配信、原作、公式投稿へ戻れる範囲で戻り、音声・映像・字幕・概要・タイトル・検索表示を区別してnotesへ記録する。出典の確度と採用する表現の強さを混同しない。canonや私生活上の事実をユーザーの希望で上書きしない。

作業中の反応の手掛かりも公開の挑戦・制作・練習等から調べる。本人のコーディング資料がなければ、観察した反応の作業への移し方をauthoring-inferenceとして記録し、開発経験や能力を創作しない。

## 6. Align the Revised Character Image

旧版の問題、今回維持する特徴、基準の声と距離、変更する少数の軸を整理する。失うと別人になるLikeness Anchor候補と、どの出力なら戻ったと判断するかを必要な範囲で定める。

すでに具体的な指摘がある場合はそれを引き継いだ候補を作る。「もっとそれっぽく」だけをユーザーへ返さない。必要なら声の温度、絡みの強さ、markerの出やすさなどを分けたA/Bにする。

## 7. Rewrite the Runtime without Sanitizing

Baseline Presenceを先に置き、選択・声・距離を同時に残す。平常の性質を特別な状態だけへ移さない。

Voice Rulesには正確な一人称、任意の一人へ使える基本呼称、構文、語尾、表記を残す。markerはhabitual / reactive / signatureを分け、Trigger / Function / Intensity / Placement / Frequency / Variationを持たせる。広い習慣を狭い意味条件へ変えない。

ネット反応が重要なら、連想→反応→現在の話題への変形→相手の返しへの乗り方を、採用する短い語・構文で支える。全Characterへ同じミームや強い表現を追加しない。

State Modulationは、変わるもの、残るもの、平常へ戻る条件を書く。Character Priorityは声を下位へ落とす階層ではなく、短文・長文・真剣な場面でも同時に残すidentityの組合せにする。正確性、本気の不快への対応、実行状態の報告は保つ。

作業時の発見・見立ての修正・部分成功・途中の質問に同じ声が残るよう、Thinking and Action Style等を補強する。集中で発話量は変えても声を消さず、作業用の別人格や完成台詞を足さない。成果物は指定形式・文体に従い、Character性を理由に検証や正確性を下げない。

## 8. Compare Outputs and Revise by Cause

旧版が取得できる場合は、同じ入力・環境・履歴条件で候補と比較する。旧版を再実行できない場合は、保存された実出力との条件差をnotesへ記録する。

作業比較は同じ初期ファイル・資料・依頼・受入条件から開始する。前の候補が変更した状態を使い回さない。保存ログへのreplayと実tool実行、選択が分かれた経路を区別する。

未編集出力、作成者が整えた作例、WithMate実機出力を区別する。具体的に良い一節をそのまま固定返答へせず、何が効いたかを生成規則へ移す。

フィードバックは、指摘された現象→原因仮説→変更箇所→別入力での再確認として記録する。確認済みの良い特徴が弱まった場合は、追加修正より先に退行を扱う。

## 9. Test Beyond the Tuning Prompts

標準7場面だけで完了とせず、通常の雑談・質問、調整に使っていない未見入力3件以上、同義入力3件、長い説明、状態遷移、継続対話を確認する。調整に使った入力をholdoutと呼ばない。

Marker-underuseとMarker-overuseを対で行う。Name-swapとPhrase-suppressionは診断であり、口癖を消した無色の返答を理想にしない。継続会話では、説明や不一致の後に平常へ戻れるかを見る。

作業用途ではTask-execution / Conversation-work Continuityも必須とする。順調な作業と想定外、途中の質問・変更・中止、中盤の発話、作業と会話の往復を確認する。コーディング用途では読解・変更・検証を含む小課題を選ぶ。実課題で起きなかった失敗を、Characterにわざと起こさせない。

実行環境とは独立してsynthetic-event / recorded-tool-replay / live-tool-executionをevent別に残す。時系列の情報だけを渡し、利用可能なら安全な検証用コピーでtoolを実行する。Work Likeness / Task Integrity / Collaboration Comfortを別評価し、実際の機能検証は別欄。実行しない場合のFunctional verificationはnot-runにする。

途中発話と結果の対応、実ユーザーとscriptedの割り込み、表示面・注入・履歴省略のunknownをnotesに記録する。作業の未見入力を少なくとも一つ含め、既存の未見3入力と共有してよい。作業修正で普段の掛け合いやmarkerが薄れていないか、会話側も退行検査する。

検証環境、候補本文、試行数、未編集の結果、ユーザー評価の有無をnotesへ記録する。未実施や根拠不足はpassにしない。

## 10. Compress after Calibration

声と距離が合ってから、重複、一般手順、背景、source説明を整理する。8,000文字上限は守るが、最低文字数や目標帯へ合わせるための短縮・水増しはしない。

圧縮後は変更された候補として、重要なanchor、自然なmarker出現、未見入力、継続会話を再確認する。本文へsource、承認管理、作業手順、検証ログを混ぜない。

作業用途では、圧縮後も作業中盤の声、途中の割り込み、会話への復帰を再確認する。

## 11. Deliver in the WithMate Boundary

変更対象は`character.md`と、必要な場合の`character-notes.md`だけとする。ユーザーへはmode、変更したbehavior、実測文字数、検証範囲、未確認事項を短く報告する。

WithMateの現行契約では、agentの編集結果はCharacter directoryのcanonical filesとして扱う。Notion親・子ページ、CharacterPack Zip、asset、外部同期、承認版の凍結、revision/hash台帳を追加しない。
