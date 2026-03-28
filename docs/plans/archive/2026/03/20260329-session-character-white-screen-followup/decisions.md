# Decisions

- Character 側は runtime error の原因が特定済みなので先に修正する
- Session 側は `App.tsx` の TDZ を疑い、初期化順の見直しで直す
- 一時的な debug instrumentation は原因特定後に除去する
