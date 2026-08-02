# 011 Session Side Pane Preference Boundary

- 状態: Accepted
- 日付: 2026-08-02
- Supersedes: `docs/adr/006-session-right-pane-preference-boundary.md`

## Context

Session UI に File Explorer を追加する。File Explorer と既存 Context pane を同時表示すると、中央の chat / preview surface が狭くなり、どちらを閉じるべきかを複数の boolean state から判断する必要が生じる。

既存の right pane preference は、次に開く Session Window の初期値として永続化しつつ、すでに開いている Window では renderer local state を維持する。また、一般 App Settings の保存が古い snapshot で pane preference を巻き戻さない専用更新境界を持つ。

## Decision

- pane preference は `files | context | none` の単一値として所有する
- `files` を選ぶ操作は Context pane を閉じ、`context` を選ぶ操作は File Explorer を閉じる。同じ pane の toggle は `none` に戻す
- pane preference は一般 App Settings 更新と分離した専用更新境界で永続化する
- 新しく開く Agent / Auxiliary Session Window は永続値を初期値として使い、既存 Window は別 Window の変更へ追従しない
- canonical key がない既存 database は、legacy `session_right_pane_visible = true` を `context`、`false` または欠損を `none` として読み替える
- canonical key を保存した後は legacy key を fallback として使わない
- File Explorer の user-visible 対応は Agent / Auxiliary Session UI に限定し、Companion UI の導線は追加しない

## Alternatives

- 左右を独立 boolean で保持する: 同時表示禁止をすべての更新経路で再実装する必要があり、不正な組合せを型で排除できないため採用しない
- File Explorer を開いたときだけ Context pane を一時的に隠す: 永続値と実表示が乖離し、再表示時の挙動が予測しにくいため採用しない
- pane state を Window ごとにだけ保持する: 次に開く Session へ最後の選択を引き継ぐ要件を満たさないため採用しない
- pane preference を一般 App Settings snapshot に含めて保存する: 並行する Settings 保存が pane state を巻き戻せるため採用しない

## Consequences

### Positive

- 左右同時表示へ到達する状態を public type から排除できる
- File Explorer と Context pane の切替が一操作で完了する
- 既存の window-local / persisted-initial-state 境界を維持できる

### Negative

- legacy boolean から canonical enum への読込互換が必要になる
- pane toggle の既存 consumer と専用 IPC を同じ論理変更で移行する必要がある
