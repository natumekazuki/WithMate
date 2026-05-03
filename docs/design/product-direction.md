# Product Direction

- 作成日: 2026-03-11
- 更新日: 2026-05-03
- 対象: WithMate 全体の体験設計方針

## Goal

WithMate を「キャラ付きチャットアプリ」や「複数 character catalog」ではなく、`Codex CLI / GitHub Copilot CLI` 相当の coding agent 体験をベースに、
1 つの環境に 1 人の Mate が定着して育つ coding companion として定義する。

この文書は、current milestone で何を主役にし、何をまだ主役にしないかを判断するための上位方針とする。

## Position

- プロダクト全体の優先順位と Mate / Growth / Memory / Monologue の位置づけの正本はこの文書とする
- WithMate 4.0.0 の SingleMate 詳細は `docs/design/single-mate-architecture.md` を参照する
- provider instruction sync の詳細は `docs/design/provider-instruction-sync.md` を参照する
- current UI の具体仕様は `docs/design/desktop-ui.md` を参照する
- monologue / reflection backend の詳細は `docs/design/monologue-provider-policy.md` を参照する

## 4.0.0 SingleMate Decision

WithMate 4.0.0 は完全 SingleMate とする。

- 1 つの環境に存在する Mate は 1 人だけとする
- 既存 character catalog からの migration は行わない
- 初回起動または初回 4.0.0 利用時は、必ず新しい Mate 作成から開始する
- Mate が未作成の間は、Mate 作成と Settings 以外の全機能を block する
- 初回 Mate 作成の必須入力は `name` のみにする
- 初回作成時は必要な Mate Profile Markdown files をすべて作成するが、中身は空でよい
- Mate avatar / icon は任意であり、未設定は Mate name と theme color の placeholder で表現する
- Mate Profile storage / API は完全に単一化し、character catalog API の内部互換は維持しない
- Mate Profile の metadata は SQLite に保存し、`profile.json` は作らない
- Home / Session / Companion は常に現在の Mate を使う
- session 起動時の character picker は廃止する
- 実行時の Mate 定義注入は毎 turn prompt 合成ではなく provider instruction sync を主経路にする
- provider instruction sync の MVP 対象は current 実装でサポートしている provider に限定する
- Growth Candidate は 4.0.0 から実装し、毎回のユーザー承認ではなく Mate Profile の自律更新と revision として扱う

詳細は `docs/design/single-mate-architecture.md` を正本にする。

## Product Thesis

WithMate で実現したい体験は次の三層で構成される。

1. `CLI parity`
- coding agent としての基本体験は `Codex CLI` や `GitHub Copilot CLI` とほぼ同等であること
- workspace、session resume、run state、approval、変更ファイル、diff などの主要操作で違和感がないこと

2. `characterized work experience`
- Mate Profile や UI copy によって、作業面が「同じ Mate と作業している」ことを感じられること
- ただし作業面の可読性や判断性を壊さないこと

3. `parallel character stream`
- 作業本体とは別枠で、Mate の独り言や内心が流れ続けること
- 作業の合間に眺めて楽しめるが、本体の coding agent 体験を邪魔しないこと

ただし current milestone では主役を 1 層目に置く。
2 層目は「作業体験を強めるための上乗せ」として扱い、3 層目は価値仮説として維持しつつ実装優先度を下げる。

## Current Product Stance

今の WithMate は次の前提で判断する。

1. 主役は `coding agent として成立していること`
2. Mate は `1 人の相棒として作業支援に定着する体験`
3. Growth / Memory は `継続性を出すための基盤`
4. Monologue / Character Stream は `将来価値だが current milestone の主役ではない`

つまり current milestone では、Mate や Growth / Memory を「キャラアプリのため」だけに先行させない。
まず coding plane を成立させ、その上で Mate と Growth を「継続性」と「体験の濃さ」を上げるために使う。

## Priority Order

主従関係は次の順序で固定する。

1. coding agent として成立している
2. Mate が作業体験を壊さずに効いている
3. Growth / Memory が継続性に寄与している
4. Character Stream が楽しい

`Character Stream` は WithMate の固有価値だが、coding agent としての可読性や操作性を壊してまで優先しない。
Memory 更新は Character Stream とは別の裏処理 plane として扱い、まずは session 継続性の基盤として成立させる。

## CLI Parity Requirements

WithMate が最低限維持すべき体験は次のとおり。

- どの workspace で動くかが明確
- どの session を再開しているかが明確
- `runState` と `approvalMode` が明確
- model と reasoning depth が明確
- そのターンで何が変わったかを把握できる
- diff を必要時に GitHub Desktop ライクな split viewer で深掘りできる
- 実行の流れが追える

### UI への落とし込み

- `Home Window`
  - `codex resume` picker と新規起動前判断を担う管理面
- `Recent Sessions`
  - `Home Window` 内で workspace と task の再開判断を担う
- `New Session Launch`
  - `Home Window` 内の dialog として `cd -> codex` を置き換える
- `Session Window`
  - TUI に相当する本体作業面
- `Session Header`
  - `Session Window` で approval 変更など最小限の操作だけを置く細いバー
- `Work Chat`
  - `Session Window` の主面
  - composer 下で model / depth を調整できる
- `Artifact Summary`
  - turn 単位で起きた変更と実行結果を要約する
- `Diff Viewer`
  - `Session Window` で必要時に開く深掘り面

## WithMate Specific Extension

CLI parity の上に、WithMate 固有の層として次を追加する。

- `Mate Profile management`
- `Mate-oriented session copy`
- `Growth / Memory architecture`
- provider instruction sync

これらは coding agent の基本操作を置き換えるのではなく、上から重ねる。

### Current Interpretation

current milestone では WithMate 固有拡張を次のように読む。

- `Mate Profile management`
  - 初回 Mate 作成、Mate Profile 編集、Growth 承認
- `Mate-oriented session copy`
  - SessionWindow の固定文言や見た目で同じ Mate と作業している体験を出す
- `provider instruction sync`
  - Mate projection を provider native instruction file へ同期する
- `Growth / Memory architecture`
  - 旧 Memory runtime の復活ではなく、Mate Profile の自律更新と revision として再設計する

provider prompt 側の毎 turn 定義全文注入や Character Stream は、この層の future 側に置く。

## Provider Split

WithMate は provider を 1 つに統一しない。

- coding agent 本体
  - **current 実装**: `Codex` 中心
  - **target scope**: `Codex` と `CopilotCLI`
  - CLI / SDK で使える共通機能の網羅を先に進める
  - current Settings は coding plane 専用で、provider enable / disable と実行挙動をここで扱う
- 将来的な独立 `Character Stream`
  - OpenAI API
  - API キー前提
  - Settings 上も coding plane とは別責務で扱う
  - current milestone では未着手
  - 着手は coding plane 側の parity 完了後

この分離により、本体の CLI parity を保ったまま、独り言機能のコスト管理と利用条件を独立して扱う。
詳細は `docs/design/monologue-provider-policy.md` を参照する。

## Mate Responsibility

current milestone における Mate の責務は次のとおり。

- session に「同じ Mate と作業している」感覚を与える
- UI copy、theme、icon、assistant 表現で体験を揃える
- Growth / Memory / provider instruction sync と接続できる単位になる

逆に、まだ Mate の責務にしないものは次のとおり。

- provider ごとの複雑な prompt 制御を毎 turn WithMate 側で抱えること
- 自律的な会話継続
- coding plane と分離した独立 Character Stream 本体

## Memory Responsibility

Memory は current milestone では「キャラ性を盛るための魔法」ではなく、継続性を扱う基盤として考える。

coding plane において、Memory が解くべき問いは次の 2 つだけに絞る。

1. 同じ project をまたいでも持ち越したいものは何か
2. 同じ session を再開した時に忘れてほしくないものは何か

このため、coding plane ではまず `Project Memory` と `Session Memory` の 2 軸で考える。  
`Character Memory` は 4.0.0 では旧概念として扱い、SingleMate では `Growth Event`、`Bond Profile`、`Work Style` へ再設計する。
main の session prompt へ旧 Memory を注入しない方針は維持する。

2026-04-27 時点では、`Session Memory` / `Project Memory` の coding plane prompt 注入と、`Character Memory` の background reflection は runtime から外している。再導入する場合は、token 効率と prompt 有用性を評価できる新設計として扱う。

## Monologue / Character Stream Position

Character Stream は「WithMate の固有価値」ではあるが、current milestone の中心には置かない。

理由:

- coding plane の完成度を先に上げたい
- Character Stream を入れると UI / provider / memory / cost の論点が一気に増える
- 今は「作業支援にキャラが乗る体験」を先に固めたほうが判断がぶれにくい

したがって current milestone では次の扱いにする。

- 構想は維持する
- docs では責務を整理する
- 実装優先度は下げ、旧 v1 の runtime は削除する
- Session UI への適用は行わない

## VTuber Character UI Direction

現在の主対象が VTuber キャラクターである以上、UI もその前提に合わせる。

ただし、`VTuber っぽい見た目` を増やすことが目的ではなく、
`VTuber キャラがそこで生きているように感じるが、作業はちゃんとしやすい` ことを目的にする。

### 必要な方向

- Mate の存在感はセッション単位の識別と assistant 側の発話表現で出す
- Mate のアイコン、名前、トーン、ムードが継続して感じられる UI にする
- アイコン未設定を空白やエラーにせず、placeholder も正式な表現として扱う
- 無機質な業務ツール感には寄せすぎない
- ただし、作業面は読みやすさと情報密度を優先する

### 避けるべき方向

- 画面全体をキャラクター装飾で埋める
- 作業ログと独り言を同じ面に混ぜる
- 会話アプリのような甘い見た目に寄りすぎて、coding agent の強さが消える
- 毎ターン過剰な演出を入れて作業のテンポを落とす

## UI Principles

### 1. 作業面とキャラ面を分離する

- `Home Window` は resume / new session / Your Mate を担う管理面
- `Session Window` は作業面
- `Work Chat` は作業結果を読む面
- `独り言` は current UI では表示しない
- 将来再実装する場合も、本体作業面の主面には混ぜない

### 2. キャラ性は構造で出す

- セッションに Mate snapshot が紐づいている
- Session copy や theme が同じ Mate を感じさせる
- current 実装では `Session Window` 右ペインに `Monologue` host を置かない

色や装飾だけで VTuber 感を作ろうとしない。

### 3. 情報の深さを段階化する

- 普段見る: chat, status
- 必要時に開く: artifact summary
- 深掘り時だけ開く: diff viewer
- future では Character Stream を独立 plane として再設計しうるが、current milestone では runtime から外す
- 役割が自明な面では、見出しや名前ラベルは原則出さない
- 表示を正当化できるのは、ユーザー操作か直近判断に必要な情報だけ

### 4. TUI と違う導線を増やしすぎない

- session resume の判断は `Home Window` に寄せる
- approval は `Session Window` の header で変更できるようにする
- 変更結果は message 単位 summary に寄せる

## What To Remove

今後の UI 調整で削りやすいものは次のとおり。

- 押しても意味のないラベルやダミーチップ
- 役割を説明するためだけの見出しや補助文
- 常設しなくてよい詳細ログパネル
- 会話一覧としてしか機能しない session card 情報
- coding agent 体験に寄与しない飾り

## What To Protect

今後も守るべきものは次のとおり。

- `Home Window` の resume 導線としての分かりやすさ
- Home 側でも要素名ラベルを増やしすぎないこと
- `Work Chat` の読みやすさ
- `Artifact Summary` の実務的な有用性
- Mate projection の安定注入前提
- 独り言 UI を current runtime へ戻さないこと
- 非互換変更時の回復導線として Settings の DB reset を維持すること

## What We Are Not Deciding Yet

次の論点は、今すぐ 1 つに決めない。

- Growth Candidate の生成 timing
- Growth / Memory を再設計する場合の評価指標
- Monologue を再設計する場合の発火契機
- Character Stream をどの window / pane に出すか
- Mate projection を provider instruction sync へどこまで反映するか

これらは current milestone で「必要になるまで確定しない」。

## Impact On Current Milestone

現在の desktop UI では、次の方向で継続調整する。

- `Recent Sessions` は `Home Window` の resume picker として再設計する
- `Session Window` の `Work Chat` は TUI 本体寄りに保つ
- Mate は `Session Copy`、theme、icon、assistant 表現で効かせる
- 独り言 UI は current runtime では表示しない
- Settings は coding plane 用 provider / credential と DB reset を持つ管理面として扱う
- 見た目はキャラクターに合わせていくが、構造は coding agent 優先で崩さない

## Next Questions

この doc を起点に、次は次の順で詰める。

1. `Mate Profile` をどう保存するか
2. provider instruction sync をどの provider から実装するか
3. `Growth Candidate` をいつ生成し、どう profile へ安全に反映するか

関連:

- `docs/design/single-mate-architecture.md`
- `docs/design/provider-instruction-sync.md`
- `docs/design/memory-architecture.md`
- `docs/design/monologue-provider-policy.md`
