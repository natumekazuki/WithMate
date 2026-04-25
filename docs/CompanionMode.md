# Companion Mode

- 作成日: 2026-04-24
- 対象: WithMate における human-led / proposal-first な Companion モードの体験設計

## Goal

WithMate に、IDE 主体の作業を崩さずに使える `Companion` モードを追加する。  
Companion は AI がユーザー作業ディレクトリを直接触る体験ではなく、`小さい会話窓で相談し、Diff / Apply 面で提案を確認して反映する` 体験を主役にする。

この文書は、runtime だけでも UI だけでもなく、Companion モード全体の設計意図と境界を 1 枚で定義する。

## Position

- Companion モードの上位方針と体験原則の正本はこの文書とする
- coding agent 全体の上位方針は `docs/design/product-direction.md` を参照する
- window の役割分離は `docs/design/window-architecture.md` を参照する
- desktop UI の current 基調は `docs/design/desktop-ui.md` を参照する
- 既存 session 実行 lifecycle は `docs/design/session-run-lifecycle.md` を参照する
- provider 実行境界の基本方針は `docs/design/provider-adapter.md` を参照する
- 新規 session 起動導線の考え方は `docs/design/session-launch-ui.md` を参照する

## Boundary

この文書が決めるもの:

- Companion モードが解く課題
- Agent モードとの役割分離
- Git-only 制約
- shadow worktree を使う理由と lifecycle の概略
- snapshot-based sync の考え方
- auto approval の境界
- review / apply を approval 面として扱う方針

この文書がまだ決めないもの:

- 細かい git コマンド列
- DB schema や内部テーブル詳細
- 実装手順や migration 手順
- hunk UI の最終形
- Companion を独立アプリにするかどうか

## Decision

- Companion は `human-led / proposal-first` とする
- 既存の direct session / agent 実行系 WithMate は残す
- 同一アプリ内で `Companion モード` と `Agent モード` を分離する
- Companion の主画面は `Companion Window` と `Diff / Apply Window` の 2 面を基本にする
- Companion の対象は `Git 管理ディレクトリ` のみとする
- AI 実行はユーザー作業ディレクトリではなく `shadow worktree` で行う
- 同期方式は `snapshot-based sync` とする
- dirty な作業ツリーは内部 snapshot として固定してから shadow を合わせる
- `shadow` 内では auto approval を許可する
- ユーザー作業ディレクトリへの apply が実質の approval となる
- apply の最小単位は `file` とし、将来的に `hunk` も視野に入れる
- Companion は `直接編集する AI` より `提案して apply する AI` を優先する

## Companion Mode Summary

Companion は、IDE を主役にしたまま AI を横に置くためのモードである。

- ユーザーは IDE やエディタで主作業を続ける
- WithMate 側では小さい `Companion Window` で依頼、相談、提案生成を行う
- AI の作業はユーザー作業ディレクトリではなく shadow worktree で完了する
- 変更結果は `Diff / Apply Window` で確認する
- ユーザーが apply した時だけ、自分の作業ディレクトリへ反映される

このため Companion は、`AI に全部任せる実行面` ではなく、`人が主導し、AI の提案を受け取り、必要な分だけ採用する面` になる。

## Mode Separation

Companion と Agent は同じ WithMate に共存するが、主役と approval の考え方が異なるため、同一面に混ぜない。

### Companion Mode

- 主役: 人間
- 基本体験: proposal-first
- AI の変更先: shadow worktree
- approval: Diff / Apply Window での確認と apply
- 向いている用途: IDE 主体の継続作業、局所提案、差分レビュー

### Agent Mode

- 主役: 実行中の coding agent session
- 基本体験: session を走らせて結果を見る
- AI の変更先: 既存 WithMate / provider 実行系の方針に従う
- approval: session 側の approval model に従う
- 向いている用途: まとまった task 実行、継続 turn、既存 CLI parity 系ワークフロー

Companion は Agent の置き換えではない。  
`既存 WithMate を残したまま、別の作業モードとして追加する` のが前提である。

## Repository Eligibility

Companion の対象は Git 管理ディレクトリだけに限定する。

理由:

- 差分の比較対象を安定して持ちやすい
- snapshot-based sync の基準を取りやすい
- dirty / clean の判定を明確にできる
- review / apply を file 単位で扱いやすい
- ユーザーが日常的に使う変更確認フローと自然に接続できる

Companion は `任意のローカルフォルダを直接編集する汎用 AI` ではなく、`Git の履歴と差分を前提に安全に提案する支援面` として設計する。

## Shadow Workspace Model

Companion では、AI はユーザーの作業ディレクトリを直接触らない。  
代わりに、元リポジトリに対応する shadow worktree を内部で持ち、AI の読取・編集・コマンド実行はその中で完結させる。

### Lifecycle

1. 対象 repo を選ぶ
2. current snapshot を決める
3. その snapshot に対応する shadow worktree を同期する
4. AI は shadow で提案作業を行う
5. ユーザーは Diff / Apply Window で差分を確認する
6. apply を選んだ差分だけをユーザー作業ディレクトリへ反映する

### Why Shadow

- ユーザーの未保存判断を AI 実行から分離できる
- auto approval を閉じた安全な範囲に限定できる
- proposal-first の体験を保ちやすい
- provider 実行や tool 使用を、最終 approval と切り離して扱える

### Snapshot-Based Sync

Companion の同期は `live mirror` ではなく `snapshot-based` とする。

- clean な時は、その時点の HEAD ベースで snapshot を取る
- dirty な時は、未 commit 変更を内部 snapshot として固定してから shadow を合わせる
- 内部 snapshot の実体は temp commit または専用 ref のような app 内部表現を想定する
- 以後の AI 実行は、その固定 snapshot に対して行う

これにより、ユーザー作業ディレクトリの途中状態が実行中に揺れても、AI 側の前提を安定させられる。

## Review / Apply Model

Companion の approval は、session 中に逐次許可を返す形ではなく、`最後に提案差分を review して apply する` 形を主とする。

### Approval Boundary

- shadow 内の操作
  - auto approval を許可する
  - 理由: ユーザー作業ディレクトリへはまだ影響しないため
- ユーザー作業ディレクトリへの反映
  - 明示 apply を必須にする
  - ここが実質の approval になる

### Diff / Apply Window

`Diff / Apply Window` は単なる diff viewer ではなく、Companion における approval 面である。

- AI が何を提案したかを読む
- file 単位で採用 / 不採用を決める
- 必要なら将来 hunk 単位へ拡張する
- apply 前に、ユーザーが自分の作業として受け入れるかを最終判断する

Companion の価値は `直接編集された結果を見ること` より、`提案を読んで採用範囲を決められること` にある。

## Current Snapshot

current WithMate は direct session / agent 実行系の設計と実装を主軸にしている。  
Companion はそれを置き換えず、同一アプリ内の別モードとして追加する想定で整理する。

現時点の snapshot は次のとおり。

- Agent モード中心の WithMate は継続する
- Companion は proposal-first 体験の future candidate として設計を先に固める
- 主 UI は `小さい Companion Window + Diff / Apply Window`
- repo 制約は Git-only
- workspace 制約は shadow worktree 前提
- sync 制約は snapshot-based
- approval 制約は `shadow 内 auto / user workspace 反映時 explicit`

## Relation To Existing Docs

- `docs/design/product-direction.md`
  - WithMate 全体の中で Companion を追加モードとして位置づける
- `docs/design/window-architecture.md`
  - `Companion Window` と `Diff / Apply Window` を将来の window 責務にどう載せるかの基礎にする
- `docs/design/desktop-ui.md`
  - Companion UI を current desktop tone とどう並立させるかの参照先とする
- `docs/design/session-run-lifecycle.md`
  - 既存 Agent session の lifecycle と Companion の review/apply lifecycle を混同しないための参照先とする
- `docs/design/provider-adapter.md`
  - provider 実行を Main Process 側へ閉じる前提を Companion 側でも再利用するための参照先とする
- `docs/design/session-launch-ui.md`
  - `どこで始めるかを先に決める` という launch 判断の考え方を Companion 側にも接続する

## Open Questions

- Companion の起動導線を `Home Window` にどう載せるか
- `Companion Window` を完全独立 window にするか、常設の小窓 variant にするか
- Diff / Apply Window の最小初期 UI を file list + split diff のどこまでにするか
- snapshot の内部表現を temp commit と専用 ref のどちらへ寄せるか
- apply 失敗時の conflict 解決導線を Companion 内へどこまで持つか
- 将来の hunk apply を初期設計にどこまで織り込むか
- Agent モードから Companion モードへ、またはその逆へ、同一 repo 文脈をどう受け渡すか
