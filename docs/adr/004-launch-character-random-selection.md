# 004 Launch Character Random Selection

- 状態: Accepted
- 日付: 2026-07-20
- 更新日: 2026-08-22

## Context

New Session ダイアログでは Character を固定選択できる。Character の利用機会を分散するため、選択をアプリへ任せる導線も必要になった。当初は catalog 上の1件を default Character として初期選択していたが、この指定はランダム導線と初期選択の責務が競合し、Character作成・archive・public APIにも専用の状態遷移を広げていた。

完全な均等抽選では、直前に使った Character が続けて選ばれる可能性を下げられない。一方、利用回数や抽選履歴を新たに永続化すると、schema と更新経路が増える。通常 Session の `last_active_at` 順から Character ごとの最新位置を求める専用projectionをstorage ownerから取得し、永続化を変更せずに最近の利用状況を抽選へ反映する。

## Decision

- New Session ダイアログの Character 一覧先頭に、ランダム選択を置く。
- New Session と Companion の launch dialog は、開くたびにランダム選択を初期状態とする。利用者が active Character を明示選択した場合だけ、そのCharacterを使用する。
- Agent と Companion のランダム開始は、active Character を共通の候補とする。
- 開いている通常 Session Window で使用中の Character は、未使用の active Character がある間は抽選候補から除外する。すべての active Character が使用中の場合は除外せず、重複を許容する。
- 残った抽選候補について、通常 Session の最終利用順から Character ごとの直近位置を求め、最近使われた Character から順に `1, 2, 3, ...` の線形な重みを与える。履歴にない Character には、履歴にある候補より大きい同一の重みを与える。
- Character 作成 Session は利用履歴に含めない。
- 通常 Session の履歴が0件なら、残った抽選候補を均等に抽選する。active Character が0件なら、既存の neutral Character を使う。
- 履歴の読み込み中または取得失敗時はランダム開始を拒否する。取得成功後の0件だけを均等抽選として扱う。
- 開いている通常 Session Window 一覧の読み込み中または取得失敗時もランダム開始を拒否する。取得成功後の0件だけを「使用中なし」として扱う。
- DB schema は変更しない。Session summary APIはbounded page queryへ拡張し、抽選では全 `SessionSummary[]` を使わず、通常SessionのCharacterごとの最新利用順位を返す専用projectionを使う。
- catalog上のdefault Character指定は廃止し、作成・archive・一覧・launch解決・public projectionから参照しない。
- `characters.is_default`列とunique indexは既存DB互換のlegacy metadataとして残す。既存値は書き換えず、table rebuildを伴う別migrationが必要になった時点で物理削除を再検討する。

実装の正本は `src/home/home-launch-state.ts`、`src/home/home-launch-actions.ts`、`src/home/home-session-summary-query.ts`、`src/open-session-window-subscription.ts`、観測可能な契約は `scripts/tests/home-launch-state.test.ts`、`scripts/tests/home-launch-actions.test.ts`、`scripts/tests/open-session-window-subscription.test.ts`、`scripts/tests/session-storage-v6.test.ts` に置く。

## Alternatives

### 常に均等抽選する

実装は単純だが、最近使っていない Character を優先する目的を満たさない。

### 最も長く使っていない Character だけから選ぶ

利用機会を強く分散できるが、抽選結果が狭い候補へ固定されやすく、ランダム選択としての幅が小さくなる。

### 利用回数または抽選履歴を永続化する

利用傾向を細かく制御できるが、schema、migration、更新経路が必要になる。既存データで目的を満たせる今回の範囲を超える。

### Character 用projectionを使わず、Home pageから履歴を再利用する

Homeのbounded pageは表示対象に限定されるため、全履歴を正しく再現できず、古いSession数に応じた一括取得へ戻りやすい。storage ownerの専用projectionを使い、表示用pageと抽選用履歴を分離する。

provider ごとの実行設定は security boundary が異なるため、この判断の対象外とし、ADR 007 に従って Main Process が作成直前に最新一件を取得する。

## Consequences

### Positive

- 最近使っていない Character の選択確率を上げつつ、すべての active Character に選択可能性を残せる。
- Agent と Companion で同じ抽選方針を使える。
- launchの初期選択とcatalogの状態遷移が分離される。
- 新しい永続化データと migration を追加せずに実現できる。
- 履歴未取得を履歴0件と誤認した均等抽選を防げる。

### Negative

- 抽選確率は利用回数ではなく、Character ごとの直近利用順だけで決まる。
- Session Window の購読更新前に別の Home Window から同時に開始した場合は、同じ Character が選ばれる可能性が残る。
- Character usage projection の読み込みに失敗している間は、固定 Character では開始できるが、ランダム選択では開始できない。
- Session Window 一覧の初回取得に失敗している間も、固定 Character では開始できるが、ランダム選択では開始できない。
- 複数の Home window 間で購読更新に短い遅延がある場合、その間は抽選時の重みが一致しない可能性がある。
- legacyな`is_default`列とindexは、物理削除までschemaに残る。
