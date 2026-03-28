# Decisions

## Decision 1: bulk write path だけを先に寄せる

- `syncSessionsForCharacter()` まで広げると character storage との境界が混ざる
- 先に `replaceAllSessions()` と migration / rollback / reset で使う一括置換だけを対象にする

## Decision 2: invalidation と cleanup も service の責務に含める

- provider thread invalidation
- removed session の telemetry/background cleanup
- removed session の reflection checkpoint cleanup

これらは bulk replace に従属する副作用なので、service に含める
