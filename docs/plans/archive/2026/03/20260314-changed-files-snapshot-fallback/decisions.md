# Decisions

- Changed Files の正本は `file_change` 単独ではなく、workspace snapshot 差分との合成結果にする
- explicit な `file_change` は優先し、snapshot 差分は漏れ補完として扱う
- 差分対象は既存 snapshot 制約と ignore ルールに従う
