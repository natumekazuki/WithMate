# Product Direction

- 作成日: 2026-03-11
- 対象: WithMate 全体の体験設計方針

## Goal

WithMate を「キャラ付きチャットアプリ」ではなく、`Codex CLI / GitHub Copilot CLI` 相当の coding agent 体験をベースに、  
安定したキャラクターロールプレイと `Character Stream` を追加したアプリとして定義する。

## Product Thesis

WithMate で実現したい体験は次の三層で構成される。

1. `CLI parity`
- coding agent としての基本体験は `Codex CLI` や `GitHub Copilot CLI` とほぼ同等であること
- workspace、session resume、run state、approval、変更ファイル、diff などの主要操作で違和感がないこと

2. `stable roleplay injection`
- system prompt へキャラクター定義を安定して注入し、ターンをまたいでも人格が崩れにくいこと
- ユーザーが「このキャラで Codex を動かしている」と自然に感じられること

3. `parallel character stream`
- 作業本体とは別枠で、キャラクターの独り言や内心が流れ続けること
- 作業の合間に眺めて楽しめるが、本体の coding agent 体験を邪魔しないこと

## Priority Order

主従関係は次の順序で固定する。

1. coding agent として成立している
2. キャラクターロールプレイが安定している
3. Character Stream が楽しい

`Character Stream` は WithMate の固有価値だが、coding agent としての可読性や操作性を壊してまで優先しない。

## CLI Parity Requirements

WithMate が最低限維持すべき体験は次のとおり。

- どの workspace で動くかが明確
- どの session を再開しているかが明確
- `runState` と `approvalMode` が明確
- そのターンで何が変わったかを把握できる
- diff を必要時に深掘りできる
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
- `Current Session Header`
  - `Session Window` で現在の workspace、provider、run state、approval を示す
- `Work Chat`
  - `Session Window` の主面
- `Artifact Summary`
  - turn 単位で起きた変更と実行結果を要約する
- `Diff Viewer`
  - `Session Window` で必要時に開く深掘り面

## WithMate Specific Extension

CLI parity の上に、WithMate 固有の層として次を追加する。

- `character definition management`
- `stable prompt composition`
- `memory architecture`
- `Character Stream`
- 将来的なキャラクター切り替えや固定

これらは coding agent の基本操作を置き換えるのではなく、上から重ねる。

## Provider Split

WithMate は provider を 1 つに統一しない。

- coding agent 本体
  - `Codex CLI / SDK`
  - CLI ログイン前提
- `Character Stream`
  - OpenAI API
  - API キー前提

この分離により、本体の CLI parity を保ったまま、独り言機能のコスト管理と利用条件を独立して扱う。
詳細は `docs/design/monologue-provider-policy.md` を参照する。

## VTuber Character UI Direction

現在の主対象が VTuber キャラクターである以上、UI もその前提に合わせる。

ただし、`VTuber っぽい見た目` を増やすことが目的ではなく、  
`VTuber キャラがそこで生きているように感じるが、作業はちゃんとしやすい` ことを目的にする。

### 必要な方向

- キャラクターの存在感は `Character Stream` とセッション単位の識別で出す
- キャラクターアイコン、名前、トーン、ムードが継続して感じられる UI にする
- 無機質な業務ツール感には寄せすぎない
- ただし、作業面は読みやすさと情報密度を優先する

### 避けるべき方向

- 画面全体をキャラクター装飾で埋める
- 作業ログと独り言を同じ面に混ぜる
- 会話アプリのような甘い見た目に寄りすぎて、coding agent の強さが消える
- 毎ターン過剰な演出を入れて作業のテンポを落とす

## UI Principles

### 1. 作業面とキャラ面を分離する

- `Home Window` は管理面
- `Session Window` は作業面
- `Work Chat` は作業結果を読む面
- `Character Stream` は気配や感情を感じる面
- この2つの責務は混ぜない

### 2. キャラ性は構造で出す

- セッションにキャラクターが紐づいている
- `Session Window` 右面で独り言が流れる
- ヘッダーやカードで現在のキャラが分かる

色や装飾だけで VTuber 感を作ろうとしない。

### 3. 情報の深さを段階化する

- 普段見る: chat, status, stream
- 必要時に開く: artifact summary
- 深掘り時だけ開く: diff viewer

### 4. TUI と違う導線を増やしすぎない

- session resume の判断は `Home Window` に寄せる
- run 状態や approval は `Session Window` の header に寄せる
- 変更結果は message 単位 summary に寄せる

## What To Remove

今後の UI 調整で削りやすいものは次のとおり。

- 押しても意味のないラベルやダミーチップ
- 常設しなくてよい詳細ログパネル
- 会話一覧としてしか機能しない session card 情報
- coding agent 体験に寄与しない飾り

## What To Protect

今後も守るべきものは次のとおり。

- `Home Window` の resume 導線としての分かりやすさ
- `Work Chat` の読みやすさ
- `Artifact Summary` の実務的な有用性
- `Character Stream` の存在感
- キャラクター定義の安定注入前提

## Impact On Current Mock

現在の React モックでは、次の方向で継続調整する。

- 単一 window mock は暫定状態とし、最終的には `Home Window` と `Session Window` に分離する
- `Recent Sessions` は `Home Window` の resume picker として再設計する
- `Session Window` の `Work Chat` は TUI 本体寄りに保つ
- `Character Stream` は `Session Window` 内で VTuber キャラの存在感を出す主面として磨く
- 見た目はキャラクターに合わせていくが、構造は coding agent 優先で崩さない

## Next Step

- `Home Window` と `Session Window` のモック分離を行う
- `Recent Sessions` のカード構造を Home 前提で詰める
- `Character Stream` を VTuber キャラ前提の面としてさらに詰める
- 実イベント接続時も `CLI parity` と `WithMate 固有拡張` を分離して実装する
