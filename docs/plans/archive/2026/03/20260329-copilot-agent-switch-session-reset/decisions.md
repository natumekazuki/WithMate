# Decisions

## 2026-03-29

### この task は new-plan とする

- 既存 remediation / startup fallback task は archive 済みである
- 今回の主目的は SessionWindow における Copilot custom agent 切り替え時の会話継続性修正であり、既存 archived task とは目的・変更範囲・検証軸が独立している

### 採用決定: 第一候補を今回 task の実装方針とする

- custom agent 切り替え時は `threadId` を reset せず維持する
- `src-electron/copilot-adapter.ts` では custom agent 切り替え後の config を反映したうえで、`resumeSession(threadId, config)` を試す方向で実装する
- 今回 task の scope は「Copilot custom agent 切り替え時の `threadId` 維持」と「adapter resume 挙動の確認」に限定する
- 自動テストは今回 task の完了条件に含める
- 手動テストは plan に手順のみ残し、実施はユーザー担当とする
- `model / reasoningEffort` 変更時の `threadId` reset は今回 task の Out Of Scope として明示維持する
- validation は `npm test` / `npm run build` / `npm exec tsc -p tsconfig.electron.json --noEmit --pretty false` を基準コマンドとする

### fallback は実装しないが、リスクとして保持する

- もし Copilot SDK が custom agent 切り替え後の `resumeSession()` を安全に扱えないことが判明した場合は、conversation restart を明示する別案が必要になる
- ただし現時点では fallback 実装を同一 task へ混在させず、第一候補の検証結果を見て follow-up 判断する

### pending decision を維持: model / reasoningEffort の `threadId` reset

- `src/App.tsx:2319-2353` の model / reasoningEffort 変更時 reset は、今回 task へ混ぜない
- 理由は、目的・変更範囲・検証観点が custom agent 切り替え問題と完全には一致せず、今回の実装着手を遅らせるためである
- 判定: `new-plan`
- 想定影響範囲: `src/App.tsx` の設定変更経路、session persistence、Copilot adapter resume 条件
- 検証観点: 設定変更後の session continuity、UI expectation、一貫した reset ルールの定義
