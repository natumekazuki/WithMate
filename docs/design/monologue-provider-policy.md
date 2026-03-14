# Monologue Provider Policy

- 作成日: 2026-03-12
- 対象: Character Stream / 独り言機能の実行方式
- 関連 Issue:
  - `#1 定期実行はサブスクリプションだと規約違反の可能性がある`
  - `#3 LangGraphを使ってMemoryの永続化と共有`
  - `#5 独り言システムはペンディング`

## Goal

`Character Stream` / 独り言機能を、coding agent 本体とは分離した安全で説明しやすい実行方式として定義する。
特に、認証方式、発火条件、モデル固定、Memory との関係を明文化し、後続実装の判断基準にする。

## Decision Summary

1. coding agent 本体は `Codex CLI / SDK` を使い、CLI ログイン前提で動かす
2. `Character Stream` / 独り言は OpenAI API を使う
3. 独り言機能は consumer / subscription 側の自動多重実行では実装しない
4. MVP の独り言モデルは `gpt-5-mini` 固定にする
5. 独り言の実行契機はユーザー操作に連動するイベントに限定し、定期実行は行わない
6. 独り言の文脈は Memory から抽出した軽量コンテキストに限定する

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

- Provider: `Codex CLI / SDK`
- Auth: CLI login
- Main UI:
  - `Work Chat`
  - `Artifact Summary`
  - `Diff Viewer`
- Responsibility:
  - coding task execution
  - file changes
  - run state / approval state

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

## Trigger Policy

MVP では次の方針を採用する。

- 定期実行はしない
- バックグラウンド常時実行はしない
- ユーザーが coding agent 本体へ prompt を送信したとき、またはそのターンが完了したときに連動して独り言生成を行う

実装上は、`本体ターンと独り言生成は別リクエスト` として扱う。
同じ UI ターンに紐づいていても、同一 provider 呼び出しとして混ぜない。

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

### 2. Session Memory

- いまの作業目的
- 決定事項
- unresolved な論点
- 最近の変更の要約

### 3. Monologue Context

- 独り言生成専用に圧縮した短い入力
- 直近ターンと現在の mood / run state を含む

MVP では、独り言生成にフル履歴を渡さない。

## UI Policy

Issue `#5` により、MVP の現段階では `Character Stream` の本適用を pending 扱いにする。
つまり、独り言の provider / memory / trigger の土台設計は進めるが、Session UI には独り言面を出さない。

### API Key Available

- backend / context 連携の土台実装は許容する
- ただし UI 適用は pending とし、Session UI には表示しない

### API Key Missing

- current milestone では UI 自体を出さないため、個別の縮退表示は持たない
- API キー設定 UI は独り言本実装の再開時に合わせて設計する

## Non Goals

- subscription / consumer 側だけで独り言を運用すること
- 完全自動の定期独り言
- 独り言と coding agent 本体の実行ログを同じ面で混ぜること
- モデル選択を MVP でユーザーへ細かく開放すること

## Impact

### Product Direction

- `Character Stream` は WithMate の価値だが、認証とコスト管理は独立させる
- ただし Issue `#5` により、しばらくは UI へ出さずに土台実装を優先する

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
- pending 解除の条件をどこで固定するか
