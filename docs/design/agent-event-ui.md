# Agent Event UI

## Position

- 状態: historical note / supporting draft
- current Session UI の正本は `docs/design/desktop-ui.md` と `docs/design/session-live-activity-monitor.md`
- 本書は event UI の検討経緯と背景メモとして扱う

- 作成日: 2026-03-11
- 対象: React モックと後続 Renderer 実装におけるエージェント実行可視化

> 注記: 本書にある `右主面: Character Stream` は historical draft / future option を含む。current milestone の正本は `product-direction.md` と `monologue-provider-policy.md` であり、現段階の Session UI には Character Stream を表示しない。

## Goal

`Codex` の TUI で感じられる「エージェントがいま何をしているか」を、WithMate の画面上で把握できるようにする。  
ただし GUI では常設パネルを増やしすぎず、会話ターンごとの `artifact summary` に実行結果を束ねて表示する。

## View Model

画面上では、生の SDK / CLI イベントを直接扱わず、Renderer が共通の `AgentEvent` を描画する。

### 最低限のイベント分類

- `session.started`
- `status.changed`
- `assistant.delta`
- `assistant.completed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `command.started`
- `command.output`
- `command.completed`
- `file.changed`
- `approval.requested`
- `approval.resolved`
- `error`

## UI Responsibilities

### Work Chat

- ユーザー指示とアシスタント返答を表示する
- 会話の文脈と最終結果を読む面として扱う
- ツールログやコマンド出力は混ぜすぎない

### Artifact Summary

- assistant message にぶら下がる補助情報として表示する
- 既定では折りたたみ、必要なときだけ開く
- `What Changed` `Run Summary` `Operation Timeline` の3ブロックを基本とする
- 常設の時系列ログではなく、「このターンで起きたこと」を要約して見せる
- `Open Diff` ボタンからアプリ内の split diff overlay を開く
- diff は `before / after` を左右に並べ、行番号つきで比較する
- 別ウインドウは後続候補とし、MVP では同一ウインドウ内で完結させる

### Character Stream

- 作業の精度ではなく、キャラクターが横で反応し続ける体験を担う
- `Activity` の代替にはしない
- 実行ログやファイル変更の説明責務を持たせない
- coding agent 本体の `AgentEvent` とは別 plane の生成結果として扱う
- MVP では OpenAI API による独立生成を前提にする

## Layout Direction

- 上部: `Session` と `Status`
- 左主面: `Work Chat`
- 左主面の assistant message 内: `Artifact Summary`
- 右主面: `Character Stream`

`Character Stream` は維持しつつ、作業可視化はチャットターン内で完結させる。  
これにより、WithMate 固有価値とエージェント実行可視性を両立しながら、画面のごちゃつきを抑える。

## Mock Scope

今回の React モックでは以下をダミーデータで表現する。

- assistant message ごとの `artifact`
- `artifact.changedFiles[]`
- `artifact.changedFiles[].diffRows`
- `artifact.runChecks[]`
- `artifact.activitySummary[]`
- `artifact.operationTimeline[]`
- `runState` と `approvalMode` のステータス表示

現時点では次を実装済み。

- 実際のストリーミング接続
- Copilot `provider-controlled` の approval card 表示
- Copilot approval に対する `approve / deny` の実処理
- 同一ウインドウ内の diff overlay

まだ実装しない、または provider 制約で未対応のもの。

- コマンド出力全文表示
- Codex 側の app-level approval callback

## Implementation Notes

- Main Process 側に `CodexAdapter` を置き、SDK / CLI の差異はそこで吸収する
- Renderer 側は `AgentEvent` からターン単位の `artifact summary` を生成して描画する
- モック段階でも、会話本文と artifact 情報は型として分けておく
- approval request を出せる provider では、pending assistant bubble 内に approval card を差し込み、会話面を切り替えずに `approve / deny` を返す
- `Character Stream` は `CodexAdapter` とは別の monologue provider 境界を持つ
- 認証、コスト、Memory 入力の方針は `docs/design/monologue-provider-policy.md` に従う

## Next Steps

- `docs/design/provider-adapter.md` で `AgentEvent` の生成元を整理する
- React モックに `artifact summary` と差分表示導線を追加する
- 後続で `runStreamed()` または CLI JSON 出力をターン単位 summary へ集約してこの UI へ接続する
