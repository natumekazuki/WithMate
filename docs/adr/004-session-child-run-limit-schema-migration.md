# ADR 004: Session child Run安全上限のschema migration

- Status: Accepted
- Date: 2026-07-17

## Context

Sessionの`max_concurrent_child_runs`はApplication Serviceの安全上限以下であることが既存設計で要求される。一方、schema version 1は0以上だけを制約しており、Repository decoderも安全上限を検証していなかったため、上限を超える値が保存され得る。

schema version 1のDDLを同じversion番号のまま差し替えると、既存databaseがmanifest検証に失敗する。version 2へのmigrationでは、既存の上限超過値を拒否して起動不能にするか、安全上限へ補正するかを決める必要がある。

## Decision

Session child Run安全上限の永続化制約はschema version 2として追加し、version 1のDDLとmanifestは変更しない。version 1から2へのmigrationは、既存の`max_concurrent_child_runs`が安全上限を超える場合に安全上限へ補正した後、insertとupdateの両方で範囲外を拒否するschema制約を追加する。

補正は設定値を有効範囲へ収束させるだけとし、既存Runを停止または削除しない。安全上限の具体値はshared constant、Repository decoder、schema artifact、contract testを正本とする。

## Alternatives

- version 1のDDLとmanifestを差し替える: 同じversion番号で異なるschemaが存在し、既存databaseを現行schemaとして再利用できなくなるため採用しない。
- 上限超過値があるdatabaseのmigrationを拒否する: 不正値を保存した旧実装から回復できず、Session全体を利用不能にするため採用しない。
- 上限超過Sessionを削除する: Session、Run、Messageなどの関連dataを失うため採用しない。
- schema制約を追加せずRepository decoderだけで拒否する: decoder以外のwriteや将来の回帰から永続化不変条件を守れないため採用しない。

## Consequences

- version 1 databaseは前進migration後もSession dataを保持し、上限超過設定だけが安全上限へ収束する。
- version 2ではApplication Service、Repository decoder、SQLite schemaが同じ安全上限を強制する。
- migration前backup、transaction、失敗時rollback、再開、manifest検証は既存のSQLite schema lifecycle契約に従う。
