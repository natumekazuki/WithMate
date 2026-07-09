# Decisions

## Decision 1

- status: accepted
- 内容: `@path` 候補検索は既存の file-only API を残し、UI 向けに file / folder の kind を返す候補 API として扱う。
- 理由: 既存の `searchWorkspaceFilePaths()` 呼び出しとテストの file-only 契約を保ちながら、renderer には視覚表示に必要な種別情報を渡せるため。

## Decision 2

- status: accepted
- 内容: directory 候補は `scanWorkspacePaths()` の `visitedDirectories` から取得し、root 自体は候補に含めない。
- 理由: `.gitignore` で除外された directory は走査対象にならず、既存の ignore 判定と cache 再検証を流用できるため。
