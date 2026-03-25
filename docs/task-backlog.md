# Task Backlog

- 更新日: 2026-03-25
- 対象: GitHub issue と repo 内の残タスクの統合管理

## 方針

- `GitHub issue` は外部の要求源として扱う
- `Local` は active plan や design doc に残っている repo 内 backlog を表す
- 優先度は次の 3 段階で扱う
  - `P1`: 次に着手してよい
  - `P2`: P1 の後に着手候補
  - `P3`: 保留または前提待ち

## 実装状況

- `完了`: 現在の想定 scope まで実装済み
- `進行中`: 着手済みだが残作業あり
- `未着手`: まだ実装していない
- `見送り`: 調査または判断の結果、当面は着手しない

## 管理表

| Priority | 実装状況 | Source | ID | テーマ | 概要 | 依存 / メモ |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 完了 | GitHub | [#13](https://github.com/natumekazuki/WithMate/issues/13) | `add-dir` 対応 | 追加 directory の許可リスト、外部添付制御、変更追跡まで実装済み | `docs/plans/archive/2026/03/20260325-additional-directory-allowlist/result.md` |
| P1 | 完了 | GitHub | [#12](https://github.com/natumekazuki/WithMate/issues/12) | 実行中セッション監視 window | Home から切り出した常時前面 monitor window を実装済み | `docs/plans/20260325-session-monitor-window/result.md` |
| P1 | 完了 | GitHub | [#11](https://github.com/natumekazuki/WithMate/issues/11) | レートリミット可視化 | Copilot 先行で premium requests と context usage を UI へ出した | plan: `docs/plans/archive/2026/03/20260325-copilot-rate-limit-visibility/`、design: `docs/design/provider-usage-telemetry.md` |
| P1 | 見送り | Local | `copilot-rollout` | slash command 吸収 | `/agent` `/model` など provider-native slash command を GUI state に吸収するかを整理する | `docs/plans/20260322-copilot-capability-rollout/result.md` の remaining。Issue [#10](https://github.com/natumekazuki/WithMate/issues/10) と接続 |
| P2 | 未着手 | GitHub | [#10](https://github.com/natumekazuki/WithMate/issues/10) | Copilot custom slash command | GitHub Copilot SDK v1.0.10 の独自 slash command をどう使うか | まず `slash command 吸収` 方針を決めてから着手したい |
| P2 | 見送り | Local | `copilot-rollout` | apps / mcp / plugins | provider extension surface の read-only 表示や制御を検討する | 「今は使っていない」整理なので優先度は落とす |
| P2 | 進行中 | GitHub | [#7](https://github.com/natumekazuki/WithMate/issues/7) | キャラ別メッセージ上書き | SessionWindow の固定文言を character ごとに差し替えられるようにした。provider prompt 側の拡張は別 slice で継続する | plan: `docs/plans/archive/2026/03/20260325-character-session-copy/`、design: `docs/design/session-character-copy.md` |
| P2 | 未着手 | GitHub | [#3](https://github.com/natumekazuki/WithMate/issues/3) | Memory 永続化と共有 | Character / Session Memory を永続化し、独り言や継続文脈へ使う | `docs/design/memory-architecture.md` が正本。Character Stream 再開の前提 |
| P2 | 未着手 | GitHub | [#1](https://github.com/natumekazuki/WithMate/issues/1) | 独り言の API 運用 | subscription ではなく API key 前提で monologue を扱う | `docs/design/monologue-provider-policy.md` とセットで扱う |
| P3 | 見送り | GitHub | [#5](https://github.com/natumekazuki/WithMate/issues/5) | 独り言システム pending | Character Stream / monologue UI 適用を保留にする | parity 完了後に reopen 前提 |
| P3 | 未着手 | GitHub | [#4](https://github.com/natumekazuki/WithMate/issues/4) | キャラ定義の自己改善 | エージェントがキャラ定義自体を改善できるようにする | Memory / Character 運用が固まってからでないと広がりすぎる |
| P3 | 未着手 | Local | `character-chat-ui` | キャラ画像まわりの polish | 画像 path 正規化、assistant bubble 表現、avatar 表現差など | `docs/design/character-chat-ui.md` の open points |
| P3 | 未着手 | Local | `home/session polish` | split ratio などの永続化 | Session layout / Home layout の local state を必要なら永続化する | `docs/design/session-window-layout-redesign.md` では follow-up 扱い |

## 推奨順

1. `#7` を起点にしたキャラ別メッセージ上書き
2. `#3` と `#1` をまとめた Character / Memory 系
3. `#10 custom slash command`
4. `#4` と各種 polish

## 参照元

- `docs/plans/20260322-copilot-capability-rollout/result.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/memory-architecture.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/character-chat-ui.md`
- GitHub Issues `#1 #3 #4 #5 #7 #10 #11 #12 #13`
