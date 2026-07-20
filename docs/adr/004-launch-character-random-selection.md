# 004 Launch Character Random Selection

- 状態: Accepted
- 日付: 2026-07-20

## Context

New Session ダイアログでは Character を固定選択できる。Character の利用機会を分散するため、選択をアプリへ任せる導線も必要になった。

完全な均等抽選では、直前に使った Character が続けて選ばれる可能性を下げられない。一方、利用回数や抽選履歴を新たに永続化すると、schema と更新経路が増える。既存の通常 Session summary は最終利用日時の降順で取得できるため、永続化を変更せずに最近の利用状況を抽選へ反映できる。

## Decision

- New Session ダイアログの Character 一覧先頭に、ランダム選択を置く。
- Agent と Companion のランダム開始は、active Character を共通の候補とする。
- 通常 Session の最終利用順から Character ごとの直近位置を求め、最近使われた Character から順に `1, 2, 3, ...` の線形な重みを与える。履歴にない Character には、履歴にある候補より大きい同一の重みを与える。
- Character 作成 Session は利用履歴に含めない。
- 通常 Session の履歴が0件なら、active Character を均等に抽選する。active Character が0件なら、既存の neutral Character を使う。
- 履歴の読み込み中または取得失敗時はランダム開始を拒否する。取得成功後の0件だけを均等抽選として扱う。
- DB schema と Session summary API は変更しない。

実装の正本は `src/home/home-launch-state.ts` と `src/home/home-launch-actions.ts`、観測可能な契約は `scripts/tests/home-launch-state.test.ts` と `scripts/tests/home-launch-actions.test.ts` に置く。

## Alternatives

### 常に均等抽選する

実装は単純だが、最近使っていない Character を優先する目的を満たさない。

### 最も長く使っていない Character だけから選ぶ

利用機会を強く分散できるが、抽選結果が狭い候補へ固定されやすく、ランダム選択としての幅が小さくなる。

### 利用回数または抽選履歴を永続化する

利用傾向を細かく制御できるが、schema、migration、更新経路が必要になる。既存データで目的を満たせる今回の範囲を超える。

### 開始操作のたびに履歴を再取得する

最新状態を直接確認できるが、開始時の追加 I/O と失敗経路が増える。Home が購読している Session summary の取得成功状態を使えば、同じ要件を満たせる。

## Consequences

### Positive

- 最近使っていない Character の選択確率を上げつつ、すべての active Character に選択可能性を残せる。
- Agent と Companion で同じ抽選方針を使える。
- 新しい永続化データと migration を追加せずに実現できる。
- 履歴未取得を履歴0件と誤認した均等抽選を防げる。

### Negative

- 抽選確率は利用回数ではなく、Character ごとの直近利用順だけで決まる。
- Session summary の読み込みに失敗している間は、固定 Character では開始できるが、ランダム選択では開始できない。
- 複数の Home window 間で購読更新に短い遅延がある場合、その間は抽選時の重みが一致しない可能性がある。
