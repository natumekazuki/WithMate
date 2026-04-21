# 20260421 audit-log-live-persistence

## 目的

- 実行中の audit log を provider `onProgress` 中にも意味ある粒度で永続化し、途中経過の可視性と durability を上げる
- renderer で persisted audit logs と live run を 1 つの表示モデルへ統合し、running row を自然に見せる
- focused tests と既存検証で terminal state の正しさを確認する

## 実施結果

- `src-electron/session-runtime-service.ts` で running audit log の staged update を追加し、`onProgress` ごとの部分結果を永続化しつつ terminal update が後勝ちになるよう保護した
- `src/audit-log-refresh.ts` に persisted audit log と live run の統合 helper を追加し、`src/App.tsx` の audit log modal で running row の置換 / synthetic row 挿入を共通化した
- `scripts/tests/session-runtime-service.test.ts` で progress update・terminal update・late progress 抑止を検証した
- `scripts/tests/audit-log-refresh.test.ts` で persisted row 置換、stale live state 抑止、新 run 開始時の synthetic running row を検証した

## 変更ファイル

- `src-electron/session-runtime-service.ts`
- `src/audit-log-refresh.ts`
- `src/App.tsx`
- `scripts/tests/session-runtime-service.test.ts`
- `scripts/tests/audit-log-refresh.test.ts`

## 検証

- focused tests: `npx tsx --test scripts/tests/session-runtime-service.test.ts scripts/tests/audit-log-refresh.test.ts` ✅
- repo tests: `npm test` ✅
- build: `npm run build` ✅
- `npm run typecheck` は repo 既知の unrelated baseline failure が残っているため今回の完了条件から除外し、対象外変更による修正は行わない

## Docs Sync 判定

- `docs/design/`: 更新不要。理由: 今回は既存 audit log / renderer 表示の実装詳細調整で、公開仕様や設計境界の変更はないため
- `.ai_context/`: 更新不要。理由: repository 全体ルールや恒久運用知識の追加ではないため
- `README.md`: 更新不要。理由: ユーザー向け手順や機能入口の変更はないため

## ステータス

- 状態: 完了
- Remaining: なし
- 実装コミット: `d5e0ef4` `feat: audit log の live 永続化を追加`
- Archive: `docs/plans/archive/2026/04/20260421-audit-log-live-persistence/` へ移動予定

## Archive Check

- tier: session
- 対象: `docs/plans/20260421-audit-log-live-persistence/`
- archive 先: `docs/plans/archive/2026/04/20260421-audit-log-live-persistence/`
- archive-ready: 準備完了
- 実装コミット記録: `d5e0ef4` `feat: audit log の live 永続化を追加`
- rollback target: archive commit 作成後に反映する
