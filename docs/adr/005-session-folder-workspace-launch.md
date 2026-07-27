# 005 SessionFolder Workspace Launch

- 状態: Accepted
- 日付: 2026-07-26

## Context

New Session は既存 directory の選択を必須としていた。一方、作業対象がまだ存在しない Session では、WithMate が管理する `session-files/{sessionId}` をそのまま workspace として開始したい。

SessionFolder の path は Session ID に依存する。renderer で仮 path や仮 ID を作ると、Main Process が所有する app data path、directory 作成、Session 永続化の境界が分散する。

## Decision

- New Session dialog の Agent Mode では `Browse` と `SessionFolder` を排他的な workspace 選択として扱う
- Companion Mode では `SessionFolder` を表示せず、Agent Mode で選択済みの場合は mode 切替時に選択を解除する
- `SessionFolder` の選択時は renderer に path を持たせず、作成方法だけを launch request として Main Process へ渡す
- Main Process は launch request を許可済み field から再構築し、renderer 由来の Session ID や旧 workspace field を永続化へ渡さない
- Main Process は directory / SessionFolder / 内部 create の Session ID を同じ UUID ベースの発行境界で所有する
- Session の新規永続化は update 用 upsert と分け、ID の一意制約を使う insert-only operation で原子的に衝突を拒否する
- `Start New Session` 時に Main Process が次の順序で処理する
  1. Session ID を発行する
  2. `session-files/{sessionId}` を新規 directory として排他的に作成する
  3. 作成した absolute path を `workspacePath`、`SessionFolder` を `workspaceLabel` として Session を永続化する
  4. renderer は作成済み Session ID で Session Window を開く
- directory 作成に失敗した場合は Session を永続化しない
- 同じ ID の Session record または SessionFolder が存在する場合は、既存データを再利用または上書きせず作成を失敗させる
- Session 永続化の呼び出し後に失敗した場合は、永続化済み Session の workspace を誤って削除しないよう、その場では directory を削除しない
- Session record を削除しても、その Session 自身の `session-files/{sessionId}` を workspace としていた場合は directory と内容を保持する
- SessionFolder workspace の判定は filesystem の path 比較規則に合わせ、Windows では大文字小文字を区別しない
- bulk 削除では削除前の stored Session summary で未読込 Session も分類し、通常の directory workspace に対する既存 cleanup を維持する

## Alternatives

- SessionFolder 選択時に directory を作成する: dialog を閉じた場合に未使用 directory が残るため採用しない
- renderer で仮 ID と path を作る: app data path と ID 発行の所有者が renderer へ漏れるため採用しない
- Session を先に永続化してから directory を作成する: directory 作成失敗時に実在しない workspace を持つ Session が残るため採用しない
- create 前の存在確認だけで ID 衝突を判定する: 並行 create が同じ ID を確認して通過できるため採用しない
- Session record の削除と同時に SessionFolder workspace も削除する: 作業成果物を不可逆に失うため採用しない
- Settings で任意の workspace root を設定する: 今回は既存の SessionFolder を workspace として再利用すれば要件を満たすため採用しない

## Consequences

### Positive

- button 選択だけでは filesystem に副作用が起きない
- 永続 Session の `workspacePath` は作成時点から実在する
- 既存の SessionFolder の terminal、attachment、provider access の経路を workspace として再利用できる

### Negative

- Session 永続化処理が post-commit failure を返した場合、未参照の SessionFolder が残る可能性がある
- Session record を削除した SessionFolder workspace は自動 cleanup されず、directory が残る
- Session 作成 IPC は concrete directory と managed SessionFolder の discriminated request を扱う
