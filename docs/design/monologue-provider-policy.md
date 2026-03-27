# Monologue Provider Policy

- 作成日: 2026-03-12
- 対象: Character Stream / 独り言機能の実行方式
- 関連 Issue:
  - `#1 定期実行はサブスクリプションだと規約違反の可能性がある`
  - `#3 LangGraphを使ってMemoryの永続化と共有`
  - `#5 独り言システムはペンディング`
  - `#15 キャラストリームをメモリー生成の一部にする`

## Goal

`Character Stream` / 独り言機能を、coding agent 本体とは分離した安全で説明しやすい実行方式として定義する。
特に、認証方式、発火条件、モデル固定、Memory との関係を明文化し、後続実装の判断基準にする。

## Decision Summary

1. coding agent 本体は current 実装では `Codex` 中心だが、Character Stream 着手前に `Codex` と `CopilotCLI` の target scope を揃える
2. 上記の前提として、両 CLI / SDK 経由でも使える機能の網羅範囲を先に固める
3. `Character Stream` / 独り言は OpenAI API を使う
4. 独り言機能は consumer / subscription 側の自動多重実行では実装しない
5. MVP の独り言モデルは `gpt-5-mini` 固定にする
6. 独り言の実行契機はユーザー操作に連動するイベントに限定し、定期実行は行わない
7. 独り言は `Character Memory` 更新と共通の `character reflection cycle` で生成する
8. 独り言の文脈は Memory から抽出した軽量コンテキストに限定する
9. current milestone では Character Stream 実装には着手しない

## Why

### 1. 本体と独り言は責務が違う

- coding agent 本体は、workspace を読み、変更を作り、diff と実行状態を返す面
- `Character Stream` は、キャラの内心や独り言を流して継続体験を作る面

この2つは価値もコスト構造も違うため、同一の認証・実行系統に乗せない。

### 2. 独り言は API 側に寄せた方が説明しやすい

- 本体は `Codex CLI` の公式利用フローに乗せる
- 独り言は API の明示的な課金・利用制御に乗せる

これにより、`subscription / consumer 利用を裏で自動多重化している` という見え方を避けやすい。

### 3. コストは Memory で抑える

独り言のコスト爆発要因は、頻度よりも毎回の長い入力コンテキストになりやすい。
そのため、フル履歴を毎回渡すのではなく、Memory から独り言向けに必要最小限だけを取り出す。

## Provider Boundary

### Coding Agent Plane

- **current 実装**: `Codex`
- **target scope**: `Codex` + `CopilotCLI`
- Auth: CLI login
- Main UI:
  - `Work Chat`
  - `Artifact Summary`
  - `Diff Viewer`
- Responsibility:
  - coding task execution
  - file changes
  - run state / approval state
- Settings:
  - current provider / credential 設定は coding plane 専用
  - 初回リリース前は後方互換性を前提にせず、非互換変更時は Settings の DB reset で回復する

### Monologue Plane

- Provider: OpenAI API
- Auth: API key
- Model: `gpt-5-mini`
- Main UI:
  - `Character Stream`
- Responsibility:
  - monologue
  - inner voice
  - mood / reaction continuity
- Settings:
  - coding plane の provider / credential と混ぜない
  - current milestone では設定欄も追加しない

## Trigger Policy

MVP では次の方針を採用する。

- 定期実行はしない
- バックグラウンド常時実行はしない
- `独り言` 単体の trigger は持たない
- `Character Memory` 更新と共通の `character reflection cycle` を trigger にする

実装上は、`coding plane の本体ターン` と `character reflection cycle` は別リクエストとして扱う。  
同じ UI ターンに紐づいていても、同一 provider 呼び出しとして混ぜない。

### v1 Trigger

1. `SessionStart`
- monologue only
- `Character Memory` は更新しない

2. `Context 増加ベース`
- `Character Memory` 更新と monologue 更新を同時に行う
- 条件:
  - `charDelta >= 1200`
  - または `messageDelta >= 6`
  - かつ `cooldown >= 5分`

### Non Trigger

- `session close` は monologue trigger に使わない

### Reflection Cycle

`character reflection cycle` の出力は 2 つに分ける。

- `CharacterMemoryDelta`
- `monologueText`

つまり、trigger は共通化するが、保存先と表示先は分ける。

## Model Policy

### MVP

- 独り言本文生成は `gpt-5-mini`

理由:

- キャラ性の維持
- 文体の自然さ
- 独り言としての短い表現品質

をコストと両立しやすいため。

### Future Option

将来的には次の分離を許容する。

- `gpt-5-nano`: 要約、抽出、判定、前処理
- `gpt-5-mini`: 最終独り言生成

ただし MVP では複雑性を避けるため採用しない。

## Memory Contract

Issue `#3` は、このポリシーを成立させるための基盤とする。

独り言の入力は、次の 3 層から構成する。

### 1. Character Memory

- キャラとして維持したい口調
- ユーザーとの距離感
- 継続する好みや反応傾向
- coding plane の main prompt には入れず、monologue plane 側でのみ使う

### 2. Session Memory

- いまの作業目的
- 決定事項
- unresolved な論点
- 最近の変更の要約

### Boundary

- coding plane の main prompt
  - `character.md`
  - `Session Memory`
  - 必要時の `Project Memory`
- monologue plane / character update plane
  - `Character Memory`
  - 必要なら `Session Memory` の軽量 summary

つまり `Character Memory` は、main の coding session prompt ではなく monologue 側の文脈生成に使う。

### 3. Monologue Context

- 独り言生成専用に圧縮した短い入力
- 直近ターンと現在の mood / run state を含む

MVP では、独り言生成にフル履歴を渡さない。

### Boundary

- coding task の決定事項や project 知識は `Character Memory` に混ぜない
- 作業知識は `Project Memory` / `Session Memory` に残す

## UI Policy

Issue `#5` により、MVP の現段階では `Character Stream` の本適用を pending 扱いにする。
current milestone では `Character Stream` は **非着手** とし、provider / memory / trigger / backend / context 連携を含む実装作業は進めない。
さらに Character Stream の実装開始自体を `Codex 対応完了`、`CopilotCLI 対応完了`、`CLI / SDK parity 完了` の後へ置く。
独り言関連の実装検討を再開するのは、その parity 完了後に reopen したフェーズに限る。

### API Key Available

- current milestone では API キー有無にかかわらず Character Stream 実装は進めない
- backend / context 連携の土台実装も parity 完了後の reopen フェーズへ送る
- UI 適用は pending とし、Session UI には表示しない
- Settings の coding credential 欄は Character Stream 用ではなく、API キー入力導線は future の別欄で扱う

### API Key Missing

- current milestone では UI 自体を出さないため、個別の縮退表示は持たない
- API キー設定 UI は coding plane 設定と分離した future scope として扱う

## Non Goals

- subscription / consumer 側だけで独り言を運用すること
- 完全自動の定期独り言
- 独り言と coding agent 本体の実行ログを同じ面で混ぜること
- モデル選択を MVP でユーザーへ細かく開放すること

## Impact

### Product Direction

- `Character Stream` は WithMate の価値だが、認証とコスト管理は独立させる
- ただし Issue `#5` により、current milestone では UI へ出さず、土台実装も含めて非着手とする
- coding plane parity 完了後に reopen した段階で、provider / memory / UI の順を再判断する

### Agent Event UI

- `Character Stream` は coding agent 本体の event stream ではなく、別 plane の生成物として扱う
- current UI では独り言面そのものを表示しない

### Memory Design

- `#3` の Memory は、独り言の継続性とコスト最適化の両方に責務を持つ
- 詳細は `docs/design/memory-architecture.md` と `docs/design/session-persistence.md` を参照する

## Open Questions

- API キーの保存場所と暗号化方針
- 独り言生成の契機を `送信時` にするか `ターン完了時` にするか
- 1 ターンにつき独り言を 1 回固定にするか
- API 未設定時に独り言設定をどの画面で案内するか
- parity 完了後の Character Stream 実装順を provider / memory / UI のどこから切るか
- `#15` のように memory extraction と独り言生成を 1 つの裏処理に統合するか、別 request のまま保つか
