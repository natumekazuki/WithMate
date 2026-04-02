# copilot-sessionnotfound-runtime-retry plan

## 目的

- `GitHub Copilot` で turn 実行中に `SessionNotFound` が発生しても、user が custom agent 切り替えで回避しなくてよい状態にする
- cached Copilot session 再利用時の stale session / thread recovery を adapter 内で閉じる

## 背景

- 既存実装は `resumeSession(threadId)` が `SessionNotFound` を返した時だけ `createSession()` へ fallback する
- ただし settings 不変で cached session を再利用している turn では、`session.send()` または `session.error` 経由の `SessionNotFound` が adapter retry 条件から漏れている
- custom agent 切り替え時は settingsKey が変わって cached session が破棄され、`resume/create` 経路へ入り直すため一時的に回復して見える

## 対象

- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/design/provider-adapter.md`

## 変更方針

1. `Copilot` adapter の retry classifier に missing session / stale session を含める
2. retry は meaningful partial が無い時だけ 1 回に限定する
3. retry 前に cached session / client を破棄し、同じ `threadId` で `resumeSession()` を試し、失効時は既存 fallback で `createSession()` へ落とす

## 検証

- `npm run build`
- `node --import tsx scripts/tests/copilot-adapter.test.ts`

## 完了条件

- cached Copilot session が `SessionNotFound` で壊れても internal retry で回復する
- meaningful partial が出た stale error は従来どおり握りつぶさず failed 扱いに残る
