# 015 Chat Layout Preference Boundary

- 状態: Accepted
- 日付: 2026-08-03
- Supersedes: `docs/adr/011-session-side-pane-preference-boundary.md`

## Context

共通 chat layout の Header、ActionDock、File Explorer、Context pane を、それぞれ対応する splitter から開閉できるようにする。左右 pane は中央領域を守るため排他的なまま維持し、Header と ActionDock は独立した上下 dock として扱う。

表示設定は次に開く Window へ引き継ぐ必要がある一方、すでに開いている Window は作業中の local state と drag 済みサイズを維持し、別 Window の操作へ追従させない。また、一般 App Settings の全体保存が古い snapshot で layout preference を巻き戻さない境界が必要になる。

## Decision

- chat layout preference は `header`、`actionDock`、`sidePane` の組として所有する
- 既定値は Header が `hidden`、ActionDock が `compact`、side pane が `none` とする
- side pane は `files | context | none` の単一値を維持し、左右を同時表示しない
- preference は一般 App Settings 更新と分離した専用更新境界で、操作対象の1項目だけを保存する
- 新しく開く Agent / Companion / Auxiliary Window は利用可能な永続値を初期値として使い、既存 Window は後続の設定 snapshot へ追従しない
- drag 済みの左右幅と ActionDock 高さは Window local state とし、永続化しない
- title 編集、retry、picker、blocked feedback などによる強制表示は effective state として扱い、保存済み preference を変更しない
- Header と ActionDock の開閉、および左右 pane と ActionDock の drag は splitter が所有する。Header 内やActionDock 内に別の開閉操作を置かない
- Header は1行分の固定高とし、高さ変更は受け付けない
- ActionDock は完全には非表示にせず、compact state でも draft、添付数、run 状態、末尾移動、Send / Cancel に必要な最小情報を残す
- ActionDock の高さは layout 高の40%を上限とし、中央の chat / preview surface の最小高を優先する。expanded 時は上部操作列と下部設定・送信列を固定し、中央の textarea 領域だけを伸縮させる

## Alternatives

- Header、ActionDock、左右 pane を独立 boolean で保存する: 左右同時表示禁止を全更新経路で再実装する必要があるため採用しない
- layout preference を一般 App Settings snapshot として保存する: Settings の未保存 draft を置き換え、並行保存が layout preference を巻き戻せるため採用しない
- drag 済みサイズも永続化する: Window サイズが異なる環境で中央領域を圧迫し、復元時の補正規則が増えるため採用しない
- 強制表示を preference へ書き戻す: 一時的な操作状態が次の Window の初期表示を変更するため採用しない
- ActionDock を完全に非表示にする: run 中の Cancel や送信に必要な状態へ到達できなくなるため採用しない

## Consequences

### Positive

- 4辺の dock の開閉責務を splitter に集約できる
- Window 間の初期設定共有と、開いている Window の作業状態維持を両立できる
- 一時的な強制表示と利用者の保存設定を分離できる
- 中央の message / preview surface を常に確保できる

### Negative

- preference の各項目を対象指定で更新する専用 IPC と storage key が必要になる
- compact / expanded と effective forced state を renderer で分けて扱う必要がある
- Window ごとの drag 済みサイズは再起動後に復元されない
