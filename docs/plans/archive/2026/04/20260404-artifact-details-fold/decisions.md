# 20260404-artifact-details-fold decisions

## Decision 1

- status: 採用
- 内容: `Run Checks` は畳まず、`Changed Files` と `operationTimeline` だけを default closed にする
- 理由: 変更量の主因は file list と operation details であり、checks まで閉じると artifact の要約が弱くなりすぎる
