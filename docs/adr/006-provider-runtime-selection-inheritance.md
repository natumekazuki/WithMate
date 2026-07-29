# 006 Provider Runtime Selection Inheritance

- 状態: Accepted
- 日付: 2026-07-30

## Context

New Session と New Companion の launch dialog には、model、reasoning effort、approval mode、sandbox mode、custom agent を表示しない。一方、同じ provider を使う新規作業では、直近 Session の選択を維持したい。

Home が保持する Session summary は Character のランダム選択にも使われるが、固定 Character では読み込み完了を待たない。このキャッシュから実行権限を決めると、未取得または取得失敗時だけ既定値で起動し、直近 Session と異なる権限になる。

また、Auxiliary Session の作成 IPC は renderer から approval mode と sandbox mode を受け取る。未指定と不正値を同じ fallback で扱うと、不正値が親 Session の強い権限へ置き換わる可能性がある。

## Decision

- New Session と New Companion の実行設定は、renderer の Home キャッシュではなく、Main Process の共通 service で作成直前に解決する。
- 選択された有効な provider ごとに、通常 Session storage から Session kind を区別せず、`last_active_at DESC, id DESC` の最新一件だけを取得する。provider の照合は Session summary と同じ正規化規則を使い、legacy の `Codex` も `codex` として扱う。これは既存の model / reasoning effort の継承規則を五項目へ拡張するものである。
- 最新 Session がある場合は、model、reasoning effort、approval mode、sandbox mode、custom agent の五項目を一組として引き継ぐ。model と reasoning effort は現在の model catalog に対して検証する。
- 保存済みの runtime 値は、legacy approval mode の変換を含む既存の Session summary 正規化を経た値を継承元とする。
- 履歴がない場合は、model と reasoning effort に provider default、approval mode に `untrusted`、sandbox mode に `workspace-write`、custom agent に未選択を使う。
- 最新一件の取得、Session summary への変換、または catalog 検証に失敗した場合は既定値へ戻さず、Session ID 発行、SessionFolder または Companion worktree 作成、Session 永続化より前に作成を失敗させる。
- New Session / New Companion の作成 request は五項目を受け取らず、Main Process が解決した値だけを永続化する。
- Session Window から Auxiliary Session を作成する場合、renderer は選択 provider と `latest-session` という選択意図だけを送る。Main Process は認証済みの送信元 window 種別と selection mode を結び付け、Session Window からの explicit selection と runtime option の直接指定を拒否する。Companion Review Window では explicit selection だけを許可する。
- Main Process は共通 service を使って provider 別の最新一件を直接取得し、取得または検証に失敗した場合は Auxiliary ID 発行と永続化より前に作成を中止する。renderer が保持する一覧へは fallback しない。
- Auxiliary Session の approval mode と sandbox mode は、未指定の場合だけ安全側の既定値を使う。値が存在する場合は現行 enum との完全一致を要求し、空白付き、旧値、型違い、enum 外の値を拒否する。親 Session の値へは fallback しない。
- New Session、New Companion、Session Window からの Auxiliary 作成は、Main Process の一つの排他 coordinator 内で、実行設定の解決から workspace side effect と永続化の完了までを処理する。App Settings の更新、model catalog の import、model catalog を含む DB reset も同じ coordinator を使い、作成途中で provider の有効状態や catalog revision が切り替わらないようにする。
- New Companion は coordinator を取得した後に現行の Companion storage を解決し、その operation 内では同じ storage generation を使う。DB reset より後に待機していた作成を、閉じた旧 storage へ保存しない。
- Character のランダム選択に使う履歴は実行権限の決定と分離し、ADR 004 の Home キャッシュ方針を維持する。

実装の正本は `src-electron/session-launch-selection-service.ts`、各 Session storage の provider 別最新一件 query、`src-electron/provider-runtime-operation-coordinator.ts`、`src-electron/main-session-command-facade.ts`、`src-electron/companion-session-service.ts`、`src-electron/auxiliary-session-service.ts` とする。観測可能な契約は対応する `scripts/tests/` の test に置く。

## Alternatives

### Home の Session summary キャッシュを使う

追加 I/O は不要だが、固定 Character の起動では履歴の読み込み完了を待たないため、取得タイミングによって実行権限が変わる。

### すべての Home 起動で全履歴の読み込み完了を待つ

一貫性は得られるが、必要なのは選択 provider の最新一件だけであり、固定 Character の開始まで全履歴取得に結合する。

### 作成時に Session summary 全件を再取得する

最新状態は得られるが、一件の設定解決に不要な行を読み、Character 抽選用の一覧と実行設定の責務も分離できない。

### 選択結果を作成 request に固定し、排他制御を行わない

Main Process 内の追加待機は不要だが、選択後に App Settings または model catalog が更新されると、永続化側の再検証が異なる catalog revision や provider 状態を見る。選択値と保存時の検証条件が一つの時点に揃わず、workspace 作成後に失敗する可能性もある。

### 履歴未取得または取得失敗時は既定値で作成する

起動継続性は高いが、DB 障害と履歴0件を区別できず、直近の明示選択より強い、または異なる権限で起動する可能性がある。

### Auxiliary の不正値を親 Session または安全側既定値へ置き換える

呼び出し側の互換性は高いが、不正な IPC payload を受理した事実を隠す。親 Session への fallback は権限昇格になり得て、安全側既定値への fallback も入力契約違反を検出できない。

## Consequences

### Positive

- Home の履歴読み込み状態にかかわらず、作成時点の直近設定を一貫して使える。
- Session と Companion で五項目の選択規則と failure semantics が揃う。
- 一件 query だけを追加し、全履歴取得を起動の前提にしない。
- renderer 由来の不正値や stale cache が実行権限の正本にならない。
- Auxiliary の malformed IPC 入力が親 Session の強い権限へ変換されない。
- Session Window が selection mode を explicit に偽装して、Main Process の最新一件解決を迂回できない。
- Session Window の最新一件取得失敗時に、古い renderer cache の権限で Auxiliary を作成しない。
- 選択から永続化までの途中で Settings や model catalog が切り替わらず、異なる時点の値を混ぜない。

### Negative

- New Session / New Companion の作成ごとに storage read が一回増える。
- storage read または現行 catalog に対する設定検証が失敗すると、作成は継続できない。
- Character ランダム選択用の履歴取得と provider 実行設定の取得は、目的が異なるため別経路になる。
- Session、Companion、Auxiliary の作成中は、Settings 更新、model catalog import、DB reset、および別の対象作成が直列化される。特に Companion worktree 作成中は、後続操作の待機時間が長くなる場合がある。
- DB reset より後に開始される Companion 作成は、再作成後の storage を使う。
