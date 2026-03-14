# Recent Sessions UI

- 作成日: 2026-03-11
- 対象: `Home Window` 内のセッション一覧

## Goal

`Recent Sessions` を「最近作ったカード一覧」ではなく、「いま再開したい作業を素早く選ぶ一覧」として設計する。  
一覧だけで判断できる情報を残しつつ、横スクロールや過密表示を避ける。
配置先は `Session Drawer` ではなく `Home Window` とする。

## Primary Use Cases

### 1. 今やっている作業に戻る

- 直前の会話を再開したい
- どのキャラクターで続けているかを確認したい
- `running / idle / saved` の状態を見たい
- 実行中の session を Home 上ですぐ開き直したい

### 2. 別の作業へ切り替える

- 同じ workspace 内の別セッションへ切り替えたい
- 何の作業だったかを短い要約で見分けたい
- 最終更新時刻で近さを判断したい

### 3. 古いセッションを見つける

- 今日の作業か、昨日以前かをざっくり見分けたい
- 完全な会話本文ではなく、再開判断に必要な最小情報だけ見たい

## TUI Workflow Alignment

PowerShell で `Codex` を起動する前後の実際の流れと照らし合わせると、ユーザーは次の判断をしている。

### 実際の PowerShell フロー

1. PowerShell を開く
2. どのリポジトリ / workspace で作業するか決める
3. 必要なら `git status` や直前タスクを思い出す
4. `codex` または `codex resume` を実行する
5. 対象セッションを再開する
6. TUI に入って作業を続ける

### WithMate で置き換えるべき判断

`Recent Sessions` は、このうち 2 から 5 を短縮するための UI として設計する。

- どの workspace で再開するか
- どのタスクを再開するか
- どのキャラクターで続けるか
- 直前の状態が `running / interrupted` かどうか
- 最近触った順でどれが近いか

つまり `Recent Sessions` は「最近の会話一覧」ではなく、`codex resume` 前の判断材料を UI 化したものとして扱う。

### 一覧に出すべき情報の再解釈

- `taskTitle`
  - PowerShell で言う「いまから再開したい作業名」
- `workspacePath`
  - PowerShell で言う「どのディレクトリに `cd` するか」
- `updatedAt`
  - PowerShell で言う「どれが一番最近触った作業か」
- `character`
  - WithMate 固有価値としての再開軸

### 一覧に出さなくてよい情報

- フルの会話タイトル
- 長い補足文
- Turn Summary の中身
- diff や実行ログ

これらは TUI 起動前判断には不要で、再開後に初めて読む情報である。

## Step Mapping

`PowerShell -> codex` の流れをそのまま UI に置き換えると、WithMate で必要な面は次のように整理できる。

| PowerShell / TUI の実際の行動 | その時にしている判断 | WithMate で受け持つ UI | 一覧に必要な情報 |
| --- | --- | --- | --- |
| PowerShell を開く | これから作業を始める | `Home Window` | なし |
| `cd <repo>` する | どの workspace に入るか決める | `Home Window` / `New Session Launch` | `workspacePath` |
| `git status` や前回タスクを思い出す | 何の作業に戻るか決める | `Home Window` / `Recent Sessions` | `taskTitle`, `updatedAt` |
| `codex` を起動する | 新規か継続かを決める | `New Session Launch` or `Recent Sessions` | `provider` |
| `codex resume` の picker で選ぶ | どの session を続けるか決める | `Home Window` / `Recent Sessions` | `character`, `updatedAt` |
| TUI に入って実行を続ける | どの設定で走っているか確認する | `Session Window` | `runState`, `approvalMode`, `character` |

### Implication

- `Recent Sessions` は `Home Window` に置く `resume picker` の置き換えであって、会話一覧そのものではない
- `Current Session Header` は `Session Window` に置き、`cd` 後に今どの workspace へ入っているかを示す
- `Work Chat` は TUI 本体に入った後の作業面であり、一覧の判断材料を持ち込みすぎない
- `Character Stream` は TUI にない WithMate 固有価値なので、再開判断ではなく継続体験の面として扱う

## Home Window States

TUI の手前にある判断を UI 化するなら、`Home Window` は少なくとも次の状態を扱える必要がある。

1. `直前の作業をそのまま再開したい`
- 最上段に最近使った session を置く
- `updatedAt` が最優先

2. `同じ workspace の別作業に切り替えたい`
- `workspacePath` が同じものを近くで見分けられる必要がある
- `taskTitle` を主に見分ける

3. `別 workspace の作業へ移りたい`
- 一覧で絶対パスは出さず、短い workspace 名で切り替えられるようにする
- 必要なら hover や詳細でフルパスを見る

4. `いま走っている session を見分けたい`
- `running` は一覧で即分かる状態にする
- `saved` や `idle` と混ざらない視認性を持たせる

## UI Consequences

- セッションカードは `task title` を主見出しにする
- `character` はアイコンで認識できれば十分で、名前は常設しなくてよい
- `workspacePath` は補助情報として `Workspace : <path>` の形で出す
- `updatedAt` は `updatedAt: yyyy/MM/dd HH:mm` の形で出す
- `running / interrupted` は通常 card に混ぜず、Home 上段の chip で優先表示する
- 一覧上部に 1 個の検索入力を置き、`taskTitle` と `workspace` の部分一致で chip と通常 card の両方を絞り込めるようにする
- `running` の session は通常一覧とは別に Home 上段で先に拾えるようにする
- crash recovery で `interrupted` になった session も badge で識別できるようにする
- `interrupted` session も通常一覧とは別に Home 上段で先に拾えるようにする

## Information Priority

### 必須

- キャラクターアイコン
- セッション名または短い task title
- `workspacePath`
- 最終更新時刻
- 実行中なら再オープンしやすい位置

### 一覧では不要

- 長い絶対パス
- task summary
- 会話本文の抜粋
- Turn Summary の内容

## Card Structure

セッションカードは以下の情報に絞る。

1. 1行目
- キャラクターアイコン
- task title

2. 2行目
- `Workspace : <path>`

3. 3行目
- `updatedAt: yyyy/MM/dd HH:mm`

## Layout Rules

- すべてのテキストは `min-width: 0` を持つコンテナに入れる
- 長いタイトルや summary は省略記号で切る
- 絶対パスは一覧では表示しない
- status badge は右端固定にし、本文列へ食い込ませない
- 横スクロールは発生させない
- `running` session 用の導線はカード重複でうるさくしすぎず、最小の再オープン chip で十分
- `interrupted` session も同じ chip 形式で再オープンできれば十分

## Mock Direction

React モックでは、`Home Window` 上の `Recent Sessions` データを次の形へ寄せる。

- `taskTitle`
- `workspacePath`
- `updatedAt`
- `status`
- `character`

現在の `title` / `subtitle` のまま長文を置く構造はやめる。

## Next Step

- `Home Window` モックで session data を `taskTitle / workspacePath / updatedAt / character / threadId` へ再設計する
- Home 上のカードは 3 行構成を維持し、横スクロールを避ける省略表示へ寄せる
- 将来は `Pinned` や `Today / Earlier` の区切り、workspace ごとの軽い grouping を検討する

## Search Behavior

- 検索入力は `Recent Sessions` の上部に 1 つ置く
- 部分一致の対象は次の 3 つ
  - `taskTitle`
  - `workspacePath`
  - `workspaceLabel`
- `running / interrupted` chip も同じ条件で絞り込む
- 一致 0 件のときは、session 0 件とは別の空状態を出す

## Minimal Label Policy

- Home 全体で面の役割が自明なら見出しや補助文は置かない
- セッションカードも resume 判断に必要な情報だけを残す
- キャラクター名や provider 名のように、他要素で補える情報は常設しない
