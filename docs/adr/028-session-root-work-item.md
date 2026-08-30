# ADR 028: Root SessionのWork Itemを長期状態の正本として所有する

## Status

Accepted

## Context

`standalone` と `overall-coordinator` のroot Sessionは、委譲先の進行だけでなく、自身の目的、判断、引継ぎ状態を後続Sessionが復元できる形で保持する必要がある。既存のdelegated Work Itemは作成者から対象Sessionへの不変な委任契約であり、root用途の追加でその作成権限やcreator/target関係を緩和してはならない。

## Decision

- Work Itemは `root` と `delegated` を判別できるunionとする。rootはroot Session自身が所有し、各 `standalone` / `overall-coordinator` root Sessionに一件だけ存在する。ID、kind、root、creator、target、parent、作成時刻、過去の履歴、実効権限の上限はimmutableとする。
- root Work ItemのgoalはSessionのtask titleから初期化する。scope、completion criteria、authority説明は空を許可し、root ownerのrevisionで具体化する。authorityの自由記述は認可へ使わず、既存Session role、communication policy、runtime capabilityだけを実効権限の根拠とする。
- root Work Itemはroot Sessionの作成と同一SQLite transactionで作成し、どちらか片方だけのcommitを許さない。rootの一意性はSession単位のDB制約とservice validationで守る。既存delegated Work Itemの作成権限・変更権限・creator/target制約は維持する。
- current projectionと全mutationは一つの単調増加revisionで直列化する。mutationはprincipal単位のidempotency keyを持ち、canonical replayを返す。migration前のledgerにcanonical responseが存在しない場合は現在値を代用せず、versioned error `IDEMPOTENCY_RESPONSE_UNAVAILABLE` と `effect: applied` を返す。append-only event streamには少なくとも `created`、`migration_baseline`、`contract_revised`、`progress`、`handoff`、`state_transitioned`、`result_reported` を記録する。
- root ownerはgoal、scope、completion criteria、authority説明、state、progress、blockers、next action、terminal resultをrevisionedかつidempotentに更新できる。terminal rootは再開せず、別目的は新しいroot Sessionで開始する。
- terminal resultは、全descendantがterminalでnested aggregation decisionが確定したsnapshotだけを受け付ける。active root、active descendant、未回収結果が残るroot Sessionは削除を拒否する。parent-null delegated resultは報告だけでは回収済みとせず、同じrootのRoot WorkItemがterminalになった時点を保守的な回収境界とする。terminalかつ回収済みのdelegated Work Itemは参照Sessionの物理削除に合わせて履歴と関連ledgerを同一transactionで削除する。削除可能なterminal root Sessionは、自己所有root Work Itemと履歴を同一transactionで物理削除し、execution associationも同じ削除へ含める。
- migrationでは既存Work Itemを `delegated` として保持し、移行時点から `migration_baseline` を一件だけ記録する。存在しない過去の履歴を生成せず、legacy parent-null delegated Work Itemを自動reparentしない。migration、repair、backfill、idempotency replayはこの境界を越えない。

## Consequences

- Sessionを引き継ぐ側はWork Itemのcurrent projectionとevent historyだけで、rootの目的、判断、残作業、次のactionを復元できる。
- rootのowner mutationを追加しても、delegated Work Itemの委任authority matrixとaggregation scopeは変わらない。
- root Session削除にはdescendant、aggregation、executionの収束確認が必要になり、terminal履歴のcascade削除を含むtransactionが必要になる。
- 移行直後の既存delegated Work Itemは過去履歴を装わず、baseline以降の観測可能な履歴だけを持つ。

## Alternatives

### delegated Work Itemのcreator/target制約をrootにも適用する

root owner自身の長期状態を更新できず、Session引継ぎの正本を別途持つことになるため採用しない。

### authority説明文を認可へ使う

自由記述の改ざんや表記揺れが実効権限を変えるため採用しない。既存bindingとruntime capabilityを唯一の認可根拠とする。

### 既存Work Itemをrootへ自動reparentする

過去に存在しなかった親子関係と権限を捏造し、移行後のaggregationを変えるため採用しない。

## References

- ADR 026: 通常SessionのRoleと親子関係をimmutable bindingとして所有する
- `docs/design/session-external-runtime.md`
- `docs/design/database-schema.md`
- `docs/plans/20260830-session-root-work-item/plan.md`
