# Decisions

- `Audit / LiveRun / Telemetry / Composer` は Session domain とは分けて扱い、runtime shared state として切り出す
- type 名や event payload shape は極力維持し、今回の slice は import 境界の整理に絞る
- `currentTimestampLabel` など generic helper は `app-state.ts` に残し、domain 固有 helper だけを外へ出す
