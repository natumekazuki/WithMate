# Decisions

## Summary

- Copilot turn の完了待機は fixed timeout に頼らず、event stream の `session.idle` / `session.error` / cancel を正本にする

## Decision Log

### 0001

- 日時: 2026-03-24
- 論点: `session.sendAndWait(..., 180_000)` を延長するか、待機方式自体を変えるか
- 判断: 待機方式自体を変える
- 理由: approval 後の長時間 command は正常系でも 180 秒を超えうるため、timeout 値の調整だけでは再発余地が残るため
- 影響範囲: `src-electron/copilot-adapter.ts`
