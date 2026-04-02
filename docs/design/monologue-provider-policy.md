# Monologue Provider Policy

- 作成日: 2026-03-12
- 対象: 独り言機能と `character reflection cycle` の実行方式
- 関連 Issue:
  - `#1 定期実行はサブスクリプションだと規約違反の可能性がある`
  - `#3 LangGraphを使ってMemoryの永続化と共有`
  - `#5 独り言システムはペンディング`
  - `#15 キャラストリームをメモリー生成の一部にする`

## Goal

独り言機能と `character reflection cycle` を、coding plane とは責務を分けつつ current 実装に即して説明できる実行方式として定義する。  
特に、provider 境界、発火条件、モデル設定、Memory との関係、将来の独立 plane を明文化し、後続実装の判断基準にする。

## Position

- 独り言 / character reflection backend と trigger policy の正本はこの文書とする
- プロダクト上の優先順位は `docs/design/product-direction.md` を参照する
- Character Memory の保存構造は `docs/design/character-memory-storage.md` を参照する
- coding plane の provider 境界は `docs/design/provider-adapter.md` を参照する

## Decision Summary

1. coding plane と独り言 / reflection backend は責務を分ける
2. current v1 では reflection backend を current provider で流用し、model / reasoning depth / timeout は Settings から provider ごとに切り替える
3. long-term では独り言 backend を OpenAI API などの独立 plane へ分離できる構造を保つ
4. 独り言機能は consumer / subscription 側の定期自動多重実行では実装しない
5. 独り言の実行契機は `SessionStart` と文脈増加に限定し、定期実行は行わない
6. `Character Memory` 更新と独り言更新は共通の `character reflection cycle` で扱う
7. `Character Memory` は main の coding session prompt に戻さない
8. `Session Window` では `独り言` host に background state と recent monologue を表示する
9. 将来の独立 monologue plane は current 実装の外側にある future option として扱う

## Why

### 1. coding plane と独り言は責務が違う

- coding agent 本体は、workspace を読み、変更を作り、diff と実行状態を返す面
- 独り言 / reflection は、キャラの内心や関係性更新を扱って継続体験を作る面

この 2 つは価値もコスト構造も違うため、責務境界を明示して扱う。

### 2. current 実装では provider 流用だが、将来は独立 plane へ差し替えたい

- current v1 では current provider を流用したほうが設定と実装は単純
- ただし monologue / reflection の hidden call を coding plane の恒久仕様として固定したくはない
- このため、将来の API 分離へ差し替え可能な構造を維持する

これにより、current 実装を進めつつも `独立 monologue plane` への移行余地を失わない。

### 3. コストは Memory で抑える

独り言のコスト爆発要因は、頻度よりも毎回の長い入力コンテキストになりやすい。  
そのため、フル履歴を毎回渡すのではなく、Memory から独り言向けに必要最小限だけを取り出す。

## Provider Boundary

### Coding Agent Plane

- Auth: current provider の CLI / credential
- Main UI:
  - `Work Chat`
  - `Artifact Summary`
  - `Diff Viewer`
- Responsibility:
  - coding task execution
  - file changes
  - run state / approval state
- Settings:
  - current provider / credential 設定の正本
  - `Memory Extraction` と `Character Reflection` の provider ごとの model / reasoning 設定を持つ

### Monologue Plane

- Provider: current v1 は current provider を流用、future option として OpenAI API
- Auth: current v1 は coding plane credential を流用、future option として API key
- Model: current v1 は Settings の `Character Reflection`、future option として monologue 専用 model
- Main UI:
  - `Session Window` の `独り言`
- Responsibility:
  - monologue
  - inner voice
  - mood / reaction continuity
  - character relationship reflection
- Settings:
  - current v1 では coding plane credential を流用する
  - current v1 では `Character Reflection model / reasoning depth / timeout` を provider ごとに持つ
  - current v1 では `context-growth` の `cooldown / char delta / message delta` を app-wide settings として持つ
  - 将来 monologue plane を分離する場合だけ専用 credential / model 設定欄を追加する

## Current Implementation Note

current v1 では `character reflection cycle` を current coding provider の background plane で動かす。  
Settings に provider ごとの `Character Reflection model / reasoning depth / timeout` と、app-wide の `context-growth trigger settings` を保持し、`SessionStart` と文脈増加時の reflection で利用する。  
`Session Window` 右ペインの `独り言` host には background state と recent monologue を表示する。  
これは monologue plane の恒久仕様ではなく、将来 API 分離へ差し替え可能な暫定 backend として扱う。

## Trigger Policy

current v1 では次の方針を採用する。

- 定期実行はしない
- バックグラウンド常時実行はしない
- `独り言` 単体の trigger は持たない
- `Character Memory` 更新と共通の `character reflection cycle` を trigger にする

実装上は、`coding plane の本体ターン` と `character reflection cycle` は別 request として扱う。  
同じ UI ターンに紐づいていても、同一 provider 呼び出しとして混ぜない。

### v1 Trigger

1. `SessionStart`
- monologue only
- `Character Memory` は更新しない
- 前回 reflection 以降に user / assistant 会話が増えていない場合は skip する

2. `Context 増加ベース`
- `Character Memory` 更新と monologue 更新を同時に行う
- 条件:
  - `charDelta >= Settings.characterReflectionTriggerSettings.charDeltaThreshold`
  - または `messageDelta >= Settings.characterReflectionTriggerSettings.messageDeltaThreshold`
  - かつ `cooldown >= Settings.characterReflectionTriggerSettings.cooldownSeconds`
- default:
  - `charDelta >= 400`
  - または `messageDelta >= 2`
  - かつ `cooldown >= 120秒`

### Non Trigger

- `session close` は monologue trigger に使わない
- `SessionStart` でも、最新 monologue が main chat より新しい状態では重複生成しない

### Reflection Cycle

`character reflection cycle` の出力は 2 つに分ける。

- `CharacterMemoryDelta`
- `monologueText`

つまり、trigger は共通化するが、保存先と表示先は分ける。

## Model Policy

### Current v1

- 独り言 / reflection の model と reasoning depth は Settings の provider ごとの `Character Reflection` 設定を正本にする
- provider 実行境界の詳細は `docs/design/provider-adapter.md` を参照する

### Future Option

将来的には次の分離を許容する。

- `gpt-5-nano`: 要約、抽出、判定、前処理
- `gpt-5-mini`: 最終独り言生成

ただし current milestone では複雑性を避けるため採用しない。

## Memory Contract

Issue `#3` は、このポリシーを成立させるための基盤とする。

独り言の入力は、次の 3 層から構成する。

### 1. Character Memory

- キャラとして維持したい口調
- ユーザーとの距離感
- 継続する好みや反応傾向
- coding plane の main prompt には入れず、monologue / character update 側でのみ使う

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
- monologue / character update plane
  - `Character Memory`
  - 必要なら `Session Memory` の軽量 summary

つまり `Character Memory` は、main の coding session prompt ではなく monologue 側の文脈生成に使う。

### 3. Monologue Context

- 独り言生成専用に圧縮した短い入力
- 直近ターンと現在の mood / run state を含む

current v1 では、独り言生成にフル履歴を渡さない。

### Boundary

- coding task の決定事項や project 知識は `Character Memory` に混ぜない
- 作業知識は `Project Memory` / `Session Memory` に残す

## UI Policy

current v1 では `Character Stream` 専用画面は持たない。  
独り言は `Session Window` 右ペインの `独り言` host に限定して表示する。

### Credential Available

- current v1 では API キー分離はまだ入れず、reflection backend は current provider を流用する
- UI は `Session Window` の `独り言` host に限定して表示する
- Settings の coding credential 欄を current backend が利用し、専用 API キー導線は future の別欄で扱う

### Credential Missing

- current v1 では coding plane credential 不足として同じ実行不可状態を共有する
- 独立 monologue plane を入れた後にだけ、専用 API 未設定時の縮退表示を検討する

## Non Goals

- subscription / consumer 側だけで独り言を運用すること
- 完全自動の定期独り言
- 独り言と coding agent 本体の実行ログを同じ面で混ぜること
- 独立 monologue plane を current milestone で確定すること

## Impact

### Product Direction

- character 体験は WithMate の価値だが、current 実装では `独り言` と `Character Memory` を session 内の補助面に留める
- coding plane を壊さずに relationship continuity を足す現在路線を正本とする
- 独立 monologue plane は future option として保持する

### Agent Event UI

- 独り言は coding agent 本体の event stream ではなく、別 plane の生成物として扱う
- current UI では `Session Window` の `独り言` host に background state と recent monologue を表示する

### Memory Design

- `#3` の Memory は、独り言の継続性とコスト最適化の両方に責務を持つ
- 詳細は `docs/design/memory-architecture.md` と `docs/design/database-schema.md` を参照する

## Open Questions

- 独立 monologue plane へ移した後の API キー保存場所と暗号化方針
- monologue 専用 model を current provider catalog と分けて持つべきか
- 独立 monologue plane へ移した後の縮退 UI をどこで案内するか
- `#15` のように memory extraction と独り言生成を 1 つの裏処理に統合し続けるか、さらに分割するか
