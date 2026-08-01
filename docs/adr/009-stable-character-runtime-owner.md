# ADR 009: Session の Character owner を runtime snapshot から分離する

- Status: Accepted
- Date: 2026-08-01

## Context

Session と Companion は Character の runtime snapshot を保存する。snapshot は通常 Session では immutable だが、canonical definition が無効な場合は生成できず、既存の壊れた row では保存済み owner と一致しないこともある。

owner を snapshot だけから復元すると、snapshot を生成または採用できない時に Character との対応を失う。表示名への fallback は stable ID ではなく、後続処理が別 Character として解釈する原因になる。

## Decision

- `Session.characterId` を runtime snapshot の有無と独立した stable owner ID とする。
- public Session create request は `characterId` を trim した非空 ID として要求し、snapshot がある場合は trim 後の owner ID が一致しなければ副作用前に拒否する。
- 通常 Session と Companion の汎用 update は、保存済み owner と runtime snapshot の差し替えを永続化前に拒否する。
- V6 は schema 上 snapshot がない `character_id` を保持できないため、全 Session kind の runtime policy に同じ owner ID を保存し、read projection の fallback とする。
- 既存 row の relational owner または fallback owner と snapshot owner が異なる場合は owner を維持し、snapshot と provider thread ID を無効化する。
- legacy row に relational owner と runtime policy owner のどちらもない場合は、表示名や snapshot から owner を推測せず、Character ID の生成領域外にある予約 ID `withmate:unresolved-character-owner` へ回復する。この予約 ID は public create と runtime snapshot 解決で拒否し、保存済み snapshot と provider thread ID を無効化する。
- Character authoring の snapshot 更新は public update から分離し、authoring runtime service が所有する内部遷移とする。authoring 固有の判断は ADR 010 に置く。

## Alternatives

### Snapshot の owner を唯一の正本にする

snapshot を生成できない Session が Character との対応を失うため採用しない。

### 表示名を owner ID の fallback にする

表示名は変更可能で一意性も保証されないため採用しない。

### Authoring Session だけ owner ID を別保存する

同じ V6 row と public create/update 境界に Session kind 別の不変条件が生まれ、通常 Session と Companion の壊れた row を回復できないため採用しない。

## Consequences

- snapshot がない、または採用できない場合も stable Character owner を保持できる。
- public create/update、Session normalization、V6 read/write が同じ owner 不変条件を守る。
- owner と snapshot が矛盾する既存 row では、provider continuation より owner の保全を優先する。
- authoring の turn ごとの snapshot 再生成は、汎用 Session/Companion の immutable snapshot 契約を変更しない。
