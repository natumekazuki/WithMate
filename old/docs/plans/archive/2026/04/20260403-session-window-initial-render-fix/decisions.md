# Decisions

## Decision 1

- status: confirmed
- decision: `auditLogRefreshSignature` は `displayedMessages` ではなく `selectedSession?.messages.length ?? 0` を参照する
- rationale:
  - `displayedMessages` は後方で定義されており、render 中の `useMemo` から触ると TDZ 例外になる
  - 必要なのは message 件数だけなので、session 本体から直接参照した方が依存が少なく初期化順にも安全
