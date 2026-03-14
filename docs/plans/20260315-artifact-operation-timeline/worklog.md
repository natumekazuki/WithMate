# Worklog

## Timeline

### 0001

- 日時: 2026-03-15
- チェックポイント: `Details` の表示モデル見直し
- 実施内容: 既存の artifact が `activitySummary` の文字列配列しか持っておらず、`agent_message` は chat 本文に集約された結果しか見えないことを確認した。Details 下段を operation timeline に差し替える方針を決めた
- 検証: `src/App.tsx`, `src-electron/codex-adapter.ts`, `docs/design/agent-event-ui.md` を確認
- メモ: `Changed Files` と `Run Checks` はそのまま残し、下段だけ時系列化する
- 関連コミット: なし

### 0002

- 日時: 2026-03-15
- チェックポイント: operation timeline 実装
- 実施内容: `MessageArtifact` に `operationTimeline` を追加し、`CodexAdapter` で `turn.items` 由来の operation を保持するようにした。Session `Details` では `agent_message` を含む timeline を表示し、旧 artifact は `activitySummary` からの fallback で読めるようにした
- 検証: `npm run typecheck`, `npm run build`
- メモ: `agent_message` は `MessageRichText` で描画し、それ以外は summary/details を順に表示する
- 関連コミット: 未作成

## Open Items

- コミット作成
