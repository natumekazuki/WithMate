# Recent Sessions UI

- 作成日: 2026-03-11
- 対象: Session Drawer 内のセッション一覧

## Goal

`Recent Sessions` を「最近作ったカード一覧」ではなく、「いま再開したい作業を素早く選ぶ一覧」として設計する。  
一覧だけで判断できる情報を残しつつ、横スクロールや過密表示を避ける。

## Primary Use Cases

### 1. 今やっている作業に戻る

- 直前の会話を再開したい
- どのキャラクターで続けているかを確認したい
- `running / idle / saved` の状態を見たい

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
- 直前の状態が `running / idle / saved` のどれか
- 最近触った順でどれが近いか

つまり `Recent Sessions` は「最近の会話一覧」ではなく、`codex resume` 前の判断材料を UI 化したものとして扱う。

### 一覧に出すべき情報の再解釈

- `taskTitle`
  - PowerShell で言う「いまから再開したい作業名」
- `workspaceLabel`
  - PowerShell で言う「どのディレクトリに `cd` するか」
- `updatedAt`
  - PowerShell で言う「どれが一番最近触った作業か」
- `status`
  - PowerShell で言う「いま動いているか、保存済みか」
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
| PowerShell を開く | これから作業を始める | アプリ起動直後のメイン画面 | なし |
| `cd <repo>` する | どの workspace に入るか決める | Session Drawer / Current Session Header | `workspaceLabel` |
| `git status` や前回タスクを思い出す | 何の作業に戻るか決める | Session Drawer | `taskTitle`, `taskSummary`, `updatedAt` |
| `codex` を起動する | 新規か継続かを決める | 新規セッション導線 or 既存セッション選択 | `status`, `provider` |
| `codex resume` の picker で選ぶ | どの session を続けるか決める | Session Drawer | `character`, `updatedAt`, `status` |
| TUI に入って実行を続ける | どの設定で走っているか確認する | Header / Work Chat / Character Stream | `runState`, `approvalMode`, `character` |

### Implication

- `Recent Sessions` は `resume picker` の置き換えであって、会話一覧そのものではない
- `Current Session Header` は `cd` 後に今どの workspace へ入っているかを示す面に近い
- `Work Chat` は TUI 本体に入った後の作業面であり、一覧の判断材料を持ち込みすぎない
- `Character Stream` は TUI にない WithMate 固有価値なので、再開判断ではなく継続体験の面として扱う

## Launch States

TUI の手前にある判断を UI 化するなら、Drawer は少なくとも次の状態を扱える必要がある。

1. `直前の作業をそのまま再開したい`
- 最上段に最近使った session を置く
- `updatedAt` と `status` が最優先

2. `同じ workspace の別作業に切り替えたい`
- `workspaceLabel` が同じものを近くで見分けられる必要がある
- `taskTitle` と短い `taskSummary` を出す

3. `別 workspace の作業へ移りたい`
- 一覧で絶対パスは出さず、短い workspace 名で切り替えられるようにする
- 必要なら hover や詳細でフルパスを見る

4. `いま走っている session を見分けたい`
- `running` は一覧で即分かる状態にする
- `saved` や `idle` と混ざらない視認性を持たせる

## UI Consequences

- セッションカードは `task title` を主見出しにする
- `character` は主題ではないが、再開時の文脈復元に効くのでアイコンと名前の両方を持てる余地を残す
- `workspaceLabel` は 1 行目ではなく補助情報に下げる
- `status` は右端固定にして、`running` の視認性を優先する
- `taskSummary` は 1 行だけに制限し、無ければ省略可能にする

## Information Priority

### 必須

- キャラクターアイコン
- セッション名または短い task title
- `workspace` の短縮名
- 最終更新時刻
- 状態 (`running`, `idle`, `saved` など)

### あると良い

- Provider badge (`Codex`)
- 1 行の task summary

### 一覧では不要

- 長い絶対パス
- 2 行以上の補足文
- 会話本文の抜粋
- Turn Summary の内容

## Card Structure

セッションカードは以下の情報に絞る。

1. 1行目
- キャラクターアイコン
- task title
- status badge

2. 2行目
- workspace short name
- provider
- updated time

3. 3行目
- 必要なら 1 行だけの task summary

## Layout Rules

- すべてのテキストは `min-width: 0` を持つコンテナに入れる
- 長いタイトルや summary は省略記号で切る
- 絶対パスは一覧では表示しない
- status badge は右端固定にし、本文列へ食い込ませない
- 横スクロールは発生させない

## Mock Direction

React モックでは、`Recent Sessions` のデータを次の形へ寄せる。

- `taskTitle`
- `taskSummary`
- `workspaceLabel`
- `updatedAt`
- `status`
- `provider`
- `character`

現在の `title` / `subtitle` のまま長文を置く構造はやめる。

## Next Step

- React モックの session data を `taskTitle / taskSummary / workspaceLabel / updatedAt / status / character / threadLabel` へ再設計した
- Drawer 内カードを 2.5 行構成へ変更し、横スクロールを避ける省略表示へ寄せた
- 将来は `Pinned` や `Today / Earlier` の区切り、workspace ごとの軽い grouping を検討する
