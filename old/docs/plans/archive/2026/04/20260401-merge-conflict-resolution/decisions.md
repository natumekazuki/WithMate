# Decisions

## D-001

- 状態: 採用
- 決定: remote 側の `threadId reset + internal retry` 方針を正本として採用し、local 側の `elicitationRequest` 系統を上乗せして両立させる
- 理由: stale thread / session 起因の復旧方針が code / test / docs で一貫しており、merge 後の session recovery の挙動が読みやすい

## D-002

- 状態: 採用
- 決定: `docs/task-backlog.md` は 2026-04-01 時点の完了状況を維持しつつ、remote 側で追加された local review follow-up と stale-thread 関連メモを統合する
- 理由: backlog の正本を古い状態へ戻さず、今回取り込んだ remote 側の優先度情報だけを落とさず残すため
