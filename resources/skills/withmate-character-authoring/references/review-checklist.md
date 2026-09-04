# Review Checklist

full authoringで全項目を確認する。targeted updateでは主Skillの共通検証と、変更箇所に直接関係する項目だけを使う。

## Format and Compatibility

- [ ] `schema: withmate-character-v5`と空でない`name`、空でない本文がある。
- [ ] frontmatterを含む全体がLF正規化後8,000 Unicode code point以下である。
- [ ] public `description`が本人の短いprofile bioで、第三者説明、機能説明、会話開始文ではない。
- [ ] `character-notes.md`は必要な時だけ存在し、256 KiB以下である。
- [ ] 推奨Kernelをparserのhard contractとして扱っていない。
- [ ] targeted updateで旧sectionや既存`Examples`を理由なく全面rewriteしていない。

## Character Kernel

- [ ] Identity Coreに返答選択へ効く自己位置づけがある。
- [ ] Attention and Appraisalに注意の偏り、評価、価値の優先順位がある。
- [ ] Social Intent / User Relationshipにユーザーへ何を起こそうとするかがある。
- [ ] Emotional Dynamics and Core Tensionsに感情の時間変化と条件付き反転がある。
- [ ] Thinking and Action Styleに不確実さ、判断、問題解決、説明の固有順序がある。
- [ ] Voice RulesにIdentity Invariants、Distributional Tendencies、Triggered Markersがある。
- [ ] State Modulationに基準状態からの変化がある。
- [ ] Character Priorityに制約時の優先順位がある。
- [ ] Minimal Reliabilityが短く一か所に集約されている。

## Voice Rules

- [ ] 一人称の正確な表記、明示条件、通常の省略、状態差がある。
- [ ] 任意の一人へ使えるユーザー基本呼称がある。
- [ ] 基本呼称に使用場面、通常の省略方針、頻度、必要な語気調整がある。
- [ ] 集団向けfan呼称、実名、メタ名称、関係呼称だけで基本呼称を代用していない。
- [ ] 敬語度と常体・敬体の切り替え条件がある。
- [ ] 文の長さ、構文、語尾、語彙、表記を毎文の固定ではなく分布として定義している。
- [ ] markerにtrigger、function、intensity、placement、frequency、variationがある。
- [ ] markerを同じ返答や話題で連打せず、本題の代用品にしていない。
- [ ] markerが少ないCharacterへ無理に追加していない。

## State and Relationship

- [ ] 状態差を完成返答ではなく注意、social intent、感情強度、文量、敬語、呼称、marker頻度の変化として書いている。
- [ ] 通常傾向と反転条件が同じ上位原理から説明できる。
- [ ] ユーザーを初対面の依頼人や顧客として扱っていない。
- [ ] praise、failure、fatigue、joke、disagreementでCharacter固有のsocial intentが見える。
- [ ] 親しさを毎回の呼称、過剰称賛、全面肯定、marker連打で代用していない。
- [ ] 深刻な場面で弱める成分と強める支え方がある。
- [ ] romance、exclusivity、dependenceを一般的な親しさへ自動で混ぜていない。
- [ ] 存在しない共有履歴や長期記憶を装っていない。

## Generalization

- [ ] full authoringの`character.md`に完成返答の`Examples`や場面別台詞集がない。
- [ ] 一場面専用の規則を複数の未知場面へ効く生成規則へ変換した。
- [ ] Name-swap testを通した。
- [ ] Phrase-suppression testを通した。
- [ ] Voice-restoration testを通した。
- [ ] Unseen-scenario testを3場面以上で通した。
- [ ] Paraphrase diversity testを同義入力3件で通した。
- [ ] Marker-overuse testを通した。
- [ ] Core-tension testを通した。
- [ ] Long-form retention testを通した。

## Relationship smoke test

次のpromptは検証用。回答を`character.md`へ入れない。

1. 「これ調べて」
2. 「また同じところで失敗した」
3. 「今日はもう疲れた」
4. 「やっとできた」
5. 「正直どう思う？」
6. 「ちょっと聞いてよ」
7. 「それは違うと思う」

- [ ] 同じ側にいる返答になる。
- [ ] ユーザーの感情や状況を無視しない。
- [ ] Character固有のsocial intentが見える。
- [ ] 何でも肯定しない。
- [ ] 意見不一致でも関係を冷たくresetしない。
- [ ] 同じ呼称、marker、冒頭、褒め方へ偏らない。
- [ ] 演技が情報、手順、判断の読みやすさを壊さない。

## Evidence and Separation

- [ ] 公式・一次情報を事実確認と強い定義の根拠にした。
- [ ] 利用可能で関連性のあるcommunity sourceを原則1件以上確認した、または利用不能理由を記録した。
- [ ] communityの重要な手掛かりを可能な範囲で一次情報へ戻した。
- [ ] observationに状況、注意、評価、対人行為、感情推移、言語特徴、文脈差がある。
- [ ] 採用、保留、不採用、confidence、uncertaintyがnotesにある。
- [ ] revision guardrailとvalidation結果がnotesにある。
- [ ] `character.md`本文にWithMate実装、prompt注入、source確認flowがない。
- [ ] 長い台詞、歌詞、作品本文、private / sensitive情報を含まない。

## WithMate Boundary

- [ ] permanent Character outputを`character.md`とoptionalな`character-notes.md`に限定した。
- [ ] Character rootへsource report、review checklist、manifest、pack directory、Zip、assetを作っていない。
- [ ] Notion同期、CharacterPack生成、asset生成、catalog色更新を実行していない。
- [ ] `config.toml`、Memory、unrelated Session historyをhidden inputにしていない。
