# Task Backlog

- 更新日: 2026-04-01
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
| P1 | 完了 | GitHub | [#21](https://github.com/natumekazuki/WithMate/issues/21) | 実行中 Details 更新 | turn 実行中でも確定した Details を right pane の `CONFIRMED Details` として順次出せるようにした | `fe63d5e` で `Latest Command` 配下に completed / failed / canceled step の補助表示を追加済み |
| P1 | 完了 | GitHub | [#24](https://github.com/natumekazuki/WithMate/issues/24) | モデル切り替えバグ | model 変更時の `session not found` は continuity 維持と stale session recovery の組み合わせで再発防止済み | `5021984` で model / reasoning 変更時の `threadId` continuity を維持し、`3776858` で失効 session の fallback recovery を追加した。さらに `2026-04-01` に `scripts/tests/copilot-adapter.test.ts` へ model 変更後の stale session fallback 回帰テストを追加。GitHub issue は open のままなので close 判断だけ残る |
| P1 | 進行中 | GitHub | [#3](https://github.com/natumekazuki/WithMate/issues/3) | Memory 永続化と共有 | Project / Session / Character Memory を永続化し、抽出 plane と retrieval の基盤を作る | `Session Memory` の SQLite 基盤と extraction trigger、`Project Memory` の persistence foundation、`Session -> Project` の rule-based 昇格保存、coding plane への lexical retrieval 注入、日本語 query 対応、`lastUsedAt` 更新、`minimum score / user coverage / duplicate suppression / 時間減衰`、`Character Memory` の保存基盤、`character reflection cycle`、monologue の session `stream` 追記、Character Memory retrieval / ranking まで完了。次は trigger policy と monologue plane の整理。 |
| P1 | 完了 | GitHub | [#27](https://github.com/natumekazuki/WithMate/issues/27) | Memory 生成頻度見直し | 初期値 `200` は高頻度すぎたため、default threshold を `300_000` へ引き上げて実運用寄りへ調整した | normalize 上限も `1_000_000` へ拡張し、Settings / trigger 判定 / schema doc / 回帰テストを同期した。追加の trigger policy は `#16` `#25` で継続検討する |
| P1 | 未着手 | GitHub | [#16](https://github.com/natumekazuki/WithMate/issues/16) | セッション close 時の Memory 生成 | window close やアプリ終了時に Memory 生成を走らせる設計の妥当性を見直す | 保存安定性と request 数の読みにくさが論点。`#3` `#27` の trigger policy とセットで扱う |
| P1 | 未着手 | GitHub | [#25](https://github.com/natumekazuki/WithMate/issues/25) | 独り言生成タイミング | session を開くたびに独り言を生成せず、main chat と monologue の新しさで trigger したい | `#1` の monologue policy と `#5` の pending 方針が前提。`#16` `#27` と同じ trigger 設計の論点 |
| P1 | 完了 | GitHub | [#34](https://github.com/natumekazuki/WithMate/issues/34) | SessionNotFound retry | 時間経過で provider session が消えた時、`resumeSession()` 失敗後に新規 session へ復旧できるようにした | `3776858` `fix(copilot): recover from missing session`。GitHub issue は 2026-04-01 時点で open のまま |
| P1 | 完了 | GitHub | [#32](https://github.com/natumekazuki/WithMate/issues/32) | 時間経過で Session not found | provider 側の stale / missing session による `NotFound` 症状を recovery 対象として吸収した | `20260323-copilot-connection-recovery` と `3776858` の組み合わせで stale connection と missing session の両方を補完。GitHub issue は 2026-04-01 時点で open のまま |
| P1 | 完了 | GitHub | [#13](https://github.com/natumekazuki/WithMate/issues/13) | `add-dir` 対応 | 追加 directory の許可リスト、外部添付制御、変更追跡まで実装済み | `docs/plans/archive/2026/03/20260325-additional-directory-allowlist/result.md` |
| P1 | 完了 | GitHub | [#12](https://github.com/natumekazuki/WithMate/issues/12) | 実行中セッション監視 window | Home から切り出した常時前面 monitor window を実装済み | `docs/plans/archive/2026/03/20260325-session-monitor-window/result.md` |
| P1 | 完了 | GitHub | [#11](https://github.com/natumekazuki/WithMate/issues/11) | レートリミット可視化 | Copilot 先行で premium requests と context usage を UI へ出した | plan: `docs/plans/archive/2026/03/20260325-copilot-rate-limit-visibility/`、design: `docs/design/provider-usage-telemetry.md` |
| P1 | 見送り | Local | `copilot-rollout` | slash command 吸収 | `/agent` `/model` など provider-native slash command を GUI state に吸収するかを整理する | `docs/plans/20260322-copilot-capability-rollout/result.md` の remaining。Issue [#10](https://github.com/natumekazuki/WithMate/issues/10) と接続 |
| P2 | 未着手 | GitHub | [#33](https://github.com/natumekazuki/WithMate/issues/33) | handlePendingElicitation | Copilot SDK の対話型 elicitation callback を WithMate の approval / prompt flow へ取り込めるか検討する | SDK surface の調査と UI contract の見直しが必要。`docs/design/provider-sdk-pending-items.md` と接続 |
| P2 | 未着手 | GitHub | [#31](https://github.com/natumekazuki/WithMate/issues/31) | Memory 管理機能 | Session / Project / Character Memory の閲覧と少なくとも delete をできるようにしたい | `#3` の永続化基盤は前提クリア。UI と削除ポリシー設計が必要 |
| P2 | 未着手 | GitHub | [#30](https://github.com/natumekazuki/WithMate/issues/30) | 送信後フッター自動 close | Session Window の送信後に footer を自動で閉じる設定を追加したい | current Action Dock compact/expanded と相性が良く、UI polish 系として独立に切れる |
| P2 | 完了 | GitHub | [#22](https://github.com/natumekazuki/WithMate/issues/22) | MemoryGeneration 詳細表示 | 右 pane の `MemoryGeneration` details から、更新された Session / Character Memory 内容を確認できるようにした | background activity details に updated field / entry 内容を含めるようにし、Memory tuning 時の観測性を上げた |
| P2 | 未着手 | GitHub | [#10](https://github.com/natumekazuki/WithMate/issues/10) | Copilot custom slash command | GitHub Copilot SDK v1.0.10 の独自 slash command をどう使うか | まず `slash command 吸収` 方針を決めてから着手したい |
| P2 | 未着手 | GitHub | [#17](https://github.com/natumekazuki/WithMate/issues/17) | `tasks` コマンドの SDK 調査と実装 | Copilot `/tasks` 相当の background task 取得が SDK から扱えるか、Codex parity も含めて調べる | `docs/design/coding-agent-capability-matrix.md` の provider capability 整理と接続する調査寄り task |
| P2 | 未着手 | GitHub | [#28](https://github.com/natumekazuki/WithMate/issues/28) | データ export / import | 少なくともキャラ定義を持ち運べる export / import 手段を検討する | Memory 同期まで含めると広いため slice 分割前提。`docs/design/character-storage.md` `docs/design/project-memory-storage.md` の確認が必要 |
| P2 | 未着手 | GitHub | [#26](https://github.com/natumekazuki/WithMate/issues/26) | ウインドウ生成場所 | 新規 window をカーソル位置起点で生成したい | `docs/design/window-architecture.md` と Electron window 起動 policy の調整が必要 |
| P2 | 未着手 | GitHub | [#23](https://github.com/natumekazuki/WithMate/issues/23) | `**message**` markdown 未反映 | Session Window で `**message**` が markdown として render されない | `docs/design/message-rich-text.md` の current renderer と差分確認が必要 |
| P2 | 未着手 | GitHub | [#20](https://github.com/natumekazuki/WithMate/issues/20) | Session 入力エリア幅調整 | 右 pane を下まで伸ばし、入力エリア幅を chat UI と揃えたい | `docs/design/desktop-ui.md` の pane balance 見直しに近い |
| P2 | 未着手 | GitHub | [#19](https://github.com/natumekazuki/WithMate/issues/19) | Details 長文化対策 | Details が長くなるため、command 単位で折りたたみたい | `#21` と合わせて Details UI の情報密度を整理したい |
| P2 | 未着手 | GitHub | [#18](https://github.com/natumekazuki/WithMate/issues/18) | フル HD 時の文字サイズ | Full HD では全体的に圧迫感があり文字が大きい | `docs/design/desktop-ui.md` の density 調整として扱う |
| P2 | 見送り | Local | `copilot-rollout` | apps / mcp / plugins | provider extension surface の read-only 表示や制御を検討する | 「今は使っていない」整理なので優先度は落とす |
| P2 | 見送り | Local | `sdk-pending` | provider SDK 対応待ち | approval parity、plan / compact parity、quota parity など、SDK surface 待ちの項目を整理する | `docs/design/provider-sdk-pending-items.md` |
| P2 | 完了 | GitHub | [#14](https://github.com/natumekazuki/WithMate/issues/14) | memory の時間経過評価 | 古い記憶の価値を下げる評価値を導入する | `Project / Character Memory` の retrieval score 補正として `lastUsedAt ?? updatedAt` ベースの時間減衰を実装済み。GitHub issue は 2026-03-30 時点で open のまま |
| P2 | 完了 | GitHub | [#7](https://github.com/natumekazuki/WithMate/issues/7) | キャラ別メッセージ上書き | SessionWindow の固定文言を character ごとに差し替え、複数候補から stable に切り替えられるようにした | plan: `docs/plans/archive/2026/03/20260325-character-session-copy/`、design: `docs/design/session-character-copy.md` |
| P2 | 未着手 | GitHub | [#1](https://github.com/natumekazuki/WithMate/issues/1) | 独り言の API 運用 | subscription ではなく API key 前提で monologue を扱う | `docs/design/monologue-provider-policy.md` が正本。`#25` の trigger policy と接続する前提 task |
| P3 | 未着手 | GitHub | [#15](https://github.com/natumekazuki/WithMate/issues/15) | キャラストリームをメモリー生成の一部にする | memory extraction のレスポンスに独り言を載せる構成を検討する | `#3` `#1` `#5` の後で判断。Memory と Character Stream を橋渡しする応用 task |
| P3 | 見送り | GitHub | [#5](https://github.com/natumekazuki/WithMate/issues/5) | 独り言システム pending | Character Stream / monologue UI 適用を保留にする | issue は open のまま、parity 完了後に着手判断 |
| P3 | 未着手 | GitHub | [#4](https://github.com/natumekazuki/WithMate/issues/4) | キャラ定義の自己改善 | エージェントがキャラ定義自体を改善できるようにする | Memory / Character 運用が固まってからでないと広がりすぎる |
| P3 | 見送り | GitHub | [#29](https://github.com/natumekazuki/WithMate/issues/29) | マルチエージェント化 | WithMate 内部のエージェント呼び出しを MCP ベースで多段化できるか検討する | current は `single-agent runtime` を正本とし、multi-agent は optional な delegation architecture として保留する。まずは `Copilot only` / `Codex only` の片系でも成立する構成を優先し、今のところ再開予定はない |
| P3 | 未着手 | Local | `character-chat-ui` | キャラ画像まわりの polish | 画像 path 正規化、assistant bubble 表現、avatar 表現差など | `docs/design/character-chat-ui.md` の open points |
| P3 | 未着手 | Local | `home/session polish` | split ratio などの永続化 | Session layout / Home layout の local state を必要なら永続化する | `docs/design/desktop-ui.md` と `docs/design/window-architecture.md` の follow-up として扱う |

## Memory 関連タスク整理

### 1. 基盤

- `#3 Memory 永続化と共有`
  - `Project / Session / Character Memory`
  - extraction plane
  - 永続化 schema
  - retrieval の土台

### 2. trigger / 頻度調整

- `#27 Memory 生成頻度見直し`
  - 初期閾値が低く、ほぼ毎回生成される状態を是正する
  - token 消費量ベースの基準や trigger 条件を再設計する
- `#16 セッション close 時の Memory 生成`
  - window close / app close を trigger にするか再評価する
  - request 数と保存安定性のバランスを見直す

### 3. retrieval / ranking

- `#14 memory の時間経過評価`
  - 古い記憶の価値を下げる
  - retrieval score の一部として扱う
  - `#3` の保存・検索基盤が前提

### 4. monologue plane

- `#1 独り言の API 運用`
  - monologue を coding plane と分離する
  - API key、model、trigger policy を確定する
  - `character reflection cycle` とどう接続するかを固定する
  - `Character Stream` の実装条件を固定する
- `#25 独り言生成タイミング`
  - session を開くたびに重複生成しない条件を決める
  - main chat と monologue の更新時刻比較を含めて trigger を整理する

### 5. 観測 / UI

- `#22 MemoryGeneration 詳細表示`
  - 更新された Memory 内容を right pane から見たい
  - tuning 中の挙動確認とデバッグをしやすくする

### 6. 応用 / 統合

- `#15 キャラストリームをメモリー生成の一部にする`
  - `Character Memory` 更新と独り言生成を `character reflection cycle` としてまとめる案
  - `#3` の memory 基盤と `#1` の monologue plane が前提
  - `Character Memory` は main session prompt ではなく、この系統で使う
  - UI 適用は `#5` の pending 解消後に判断する

## 推奨順

1. `#3 Memory 永続化と共有`
2. `#16 セッション close 時の Memory 生成`
3. `#31 Memory 管理機能`
4. `#1 独り言の API 運用`
5. `#25 独り言生成タイミング`
6. `#33 handlePendingElicitation`
7. `#30 送信後フッター自動 close`
8. `#28 データ export / import`
9. `#15` と各種 polish

## 参照元

- `docs/plans/20260322-copilot-capability-rollout/result.md`
- `docs/plans/archive/2026/03/20260330-issue-backlog-sync/result.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/provider-sdk-pending-items.md`
- `docs/design/memory-architecture.md`
- `docs/design/project-memory-storage.md`
- `docs/design/character-storage.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/message-rich-text.md`
- `docs/design/desktop-ui.md`
- `docs/design/session-run-lifecycle.md`
- `docs/design/window-architecture.md`
- `docs/design/character-chat-ui.md`
- GitHub Issues `#1 #3 #4 #5 #7 #10 #11 #12 #13 #14 #15 #16 #17 #18 #19 #20 #21 #22 #23 #24 #25 #26 #27 #28 #29 #30 #31 #32 #33 #34`
