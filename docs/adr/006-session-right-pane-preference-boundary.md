# 006 Session Right Pane Preference Boundary

- 状態: Superseded by ADR 011
- 日付: 2026-07-30

## Context

Session の right pane 表示状態は、次に開く Agent / Companion Window の初期表示へ引き継ぐ必要がある。一方、すでに開いている Window は操作中の local state を維持し、別 Window の切り替えへ追従させない。

App Settings の全体更新通知は Settings Window の編集 draft も置き換える。right pane の切り替えを全体更新として配信すると、表示だけの操作によって未保存の設定が失われる。また、一般 Settings 保存が読み取った古い全体 snapshot を後から書き戻すと、並行して行われた right pane の切り替えを巻き戻す。

## Decision

- right pane 表示状態は app 共通設定として永続化するが、一般 Settings 更新とは別の専用更新境界で所有する
- right pane の切り替えでは全体 App Settings を配信せず、すでに開いている Window の表示状態を変更しない
- 一般 Settings の保存と rollback は right pane 表示状態を書き換えない
- 一般 Settings 保存後に返却または配信する全体 projection は、すべての待機処理が完了した時点の right pane 表示状態を読み直して構築する
- app 全体を初期化する明示的な reset では、right pane 表示状態も既定値へ戻してよい

## Alternatives

- right pane の切り替えを通常の App Settings 更新として扱う: 既存 Window への全体配信が Settings Window の未保存 draft と renderer local state を置き換えるため採用しない
- 一般 Settings の全体 snapshot に right pane 表示状態を含めて保存する: 非同期処理中の切り替えを古い snapshot で巻き戻せるため採用しない
- Window ごとにだけ保持して永続化しない: 新しく開く Session でも最後に選んだ表示状態を使う要件を満たさないため採用しない
- 表示切り替えを開いている全 Window へ専用配信する: 既存 Window は local state を維持するという操作契約に反するため採用しない

## Consequences

### Positive

- right pane の切り替えによって Settings Window の未保存 draft が失われない
- 一般 Settings 保存と right pane 切り替えが並行しても、後から完了した処理が専用設定を巻き戻さない
- 新しく開く Session は最後に保存した表示状態を使い、既存 Window は操作中の表示状態を維持する

### Negative

- app 共通設定に、全体更新とは別の更新経路が一つ増える
- 全体 App Settings を返却または配信する処理は、非同期処理後に最新 projection を再取得する必要がある
