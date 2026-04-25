# Companion Mode 確認事項整理

- 作成日: 2026-04-26
- 対象: `docs/CompanionMode.md` の詳細仕様化
- 状態: 確認事項整理

## Purpose

`docs/CompanionMode.md` のたたき台を、実装可能な詳細仕様へ落とす前に確認すべき論点を整理する。

この文書では、決定済みの仕様と未確認の論点を混ぜない。  
各項目は `確認したいこと`、`暫定方針`、`決める理由` に分けて扱う。

## Status Legend

- `未確認`: まだ方針を決めていない
- `方針案`: 現時点の推奨案はあるが、確定前
- `決定`: `docs/CompanionMode.md` などの正本へ反映済み

## 1. Companion Session Model

### Q1. Companion session の単位

- status: 方針案
- 確認したいこと:
  - 同じ repo / directory で複数 Companion を同時起動できるようにするか
  - 複数 Companion を内部的にどう紐づけるか
  - 1 つの CompanionSession の寿命をどこで切るか
- 暫定方針:
  - `CompanionWorkspace` または `CompanionGroup` を `repo / directory` 単位の親として持つ
  - `CompanionSession` はその配下に複数作れる
  - `1 CompanionSession = 1 Companion Window + 1 conversation + 1 shadow worktree + 1 companion branch` とする
  - 同じ `CompanionGroup` の active CompanionSession は内部的に紐づける
  - 1 つの CompanionSession を開く時は、同じ CompanionGroup の active CompanionSession も強制的に復元する
  - user は各 CompanionSession で改修を進め、完了後に merge 操作を行う
  - merge または discard を CompanionSession の寿命の終端とする
  - merge 完了後に対象 shadow worktree と companion branch を削除する
  - discard 完了後は user workspace へ反映せず、対象 shadow worktree と companion branch を削除する
  - merge 前には、同じ CompanionGroup の他 active CompanionSession との conflict check を行う
- 決める理由:
  - 同じ directory で複数の相談・改修を並行する運用があり得るため
  - conversation、proposal、worktree、branch、merge の寿命を 1 CompanionSession に揃えると、終了条件と cleanup が明確になるため
  - 同じ repo 内の並行作業は互いに conflict し得るため、merge 前に sibling session を確認する必要があるため

#### Q1 詳細メモ

- `CompanionGroup`
  - repo / directory 単位の親
  - active CompanionSession の registry を持つ
  - Home / launch / restore の単位になる
- `CompanionSession`
  - 1 window と 1 conversation を持つ
  - 1 shadow worktree と 1 companion branch を持つ
  - merge 前までは active
  - merge 完了後は closed / merged として履歴化する
- 起動 / 復元:
  - 同じ CompanionGroup の active CompanionSession がある場合、1 つを開くと他も強制的に復元する
  - user が他の CompanionSession の存在を忘れたまま merge / cleanup する状態を避ける
- merge:
  - merge は選択した CompanionSession の変更を target branch へ取り込む操作として扱う
  - merge 対象の CompanionSession を優先し、他の active CompanionSession は sibling check の対象にする
  - 実 branch を直接変更する前に temporary integration branch を作り、選択 CompanionSession の merge 可否を検証する
  - 選択 CompanionSession の merge が成立したら、temporary integration branch の結果を target branch へ反映する
  - その後、同じ CompanionGroup の sibling CompanionSession を temporary check branch 上で個別に merge 試行し、conflict を検出する
  - sibling check の conflict は選択 CompanionSession の merge 完了を妨げず、対象 sibling CompanionSession に警告として紐づける
  - conflict した sibling CompanionSession は、その CompanionSession 上で target branch 更新分との解消を促す
  - merge 成功後に選択 CompanionSession の shadow worktree と companion branch を削除する
- discard:
  - discard は選択 CompanionSession の提案を採用しない終了操作として扱う
  - user workspace と target branch へ変更を反映しない
  - discard 前に確認を出す
  - discard 完了後に shadow worktree と companion branch を削除する

### Q2. Companion session を既存 session model に載せるか

- status: 未確認
- 確認したいこと:
  - 既存 session table に `sessionKind = companion` を追加するか
  - Companion 専用 entity を作るか
- 暫定方針:
  - chat、provider、character、workspace の共通性が高いため、まずは既存 session model への拡張を候補にする
  - proposal、snapshot、apply 状態は Companion 専用 table または artifact として分離する
- 決める理由:
  - Agent Mode と履歴管理を共有できる一方で、proposal-first 固有の状態を通常 session に混ぜすぎると責務が崩れるため

## 2. Snapshot Policy

### Q3. snapshot の取得タイミング

- status: 方針案
- 確認したいこと:
  - Companion 起動時に snapshot を固定するか
  - 依頼送信直前に snapshot を固定するか
  - user が手動で snapshot refresh する導線を持つか
- 暫定方針:
  - 依頼送信直前に snapshot を固定する
  - 必要に応じて `Refresh Snapshot` を追加する
- 決める理由:
  - AI の前提を user の最新作業状態に合わせつつ、実行中の揺れを遮断するため

### Q4. dirty workspace の snapshot 対象

- status: 方針案
- 確認したいこと:
  - tracked 変更、untracked file、ignored file、binary file、large file を snapshot に含めるか
- 暫定方針:
  - tracked 変更は含める
  - untracked file は含める
  - ignored file は原則含めない
  - binary file と large file は本文 snapshot から除外し、metadata と warning を残す
- 決める理由:
  - user がまだ commit していない作業を AI の前提へ含める必要がある一方で、ignored file や大きなファイルを無制限に読むと安全性と性能が崩れるため

### Q5. snapshot の内部表現

- status: 未確認
- 確認したいこと:
  - temp commit を使うか
  - 専用 ref を使うか
  - Git object へ書かず app 内部 snapshot として保持するか
- 暫定方針:
  - 初期設計では `専用 ref または app 内部 snapshot` を候補にする
  - temp commit は Git 履歴や user tooling へ見える副作用を避けられるか確認する
- 決める理由:
  - shadow worktree の再現性、cleanup、user repo への副作用範囲を左右するため

## 3. Shadow Worktree Lifecycle

### Q6. shadow worktree の作成単位

- status: 方針案
- 確認したいこと:
  - repo ごとに 1 shadow worktree を再利用するか
  - proposal ごとに shadow worktree を作るか
- 暫定方針:
  - repo ごとに shadow root を持ち、proposal 実行前に対象 snapshot へ reset する
- 決める理由:
  - proposal ごとの作成は分離しやすいが、性能と cleanup 負荷が高くなるため

### Q7. shadow worktree の cleanup

- status: 未確認
- 確認したいこと:
  - app 起動時に orphan shadow を掃除するか
  - proposal 完了後に即削除するか
  - 一定期間保持するか
- 暫定方針:
  - proposal diff を表示できる間は保持する
  - app 起動時に orphan shadow を検出して cleanup する
  - cleanup 失敗時は Settings 側の maintenance action で再試行できるようにする
- 決める理由:
  - diff 表示と再確認には保持が必要だが、shadow が残り続けると容量と状態管理の問題が出るため

## 4. Review / Apply Policy

### Q8. apply の最小単位

- status: 方針案
- 確認したいこと:
  - MVP は file 単位だけにするか
  - hunk apply を初期から入れるか
- 暫定方針:
  - MVP は file 単位 apply とする
  - 内部データ構造は将来の hunk apply を妨げない形にする
- 決める理由:
  - hunk apply は UX と conflict 処理が重く、MVP の不確実性を増やすため

### Q9. apply 前に user workspace が変わった場合

- status: 方針案
- 確認したいこと:
  - base snapshot と現在の user workspace が異なる file をどう扱うか
- 暫定方針:
  - base snapshot と現在 file が一致する場合だけ apply する
  - 一致しない file は conflict として止める
  - 初期は自動 merge しない
- 決める理由:
  - proposal 生成後に user が同じ file を編集した場合、自動上書きは proposal-first の安全性を損なうため

### Q10. apply 失敗時の導線

- status: 方針案
- 確認したいこと:
  - conflict file に対してどの action を出すか
- 暫定方針:
  - `Skip`
  - `Open Diff`
  - `Rebase Proposal`
  - `Retry Apply`
- 決める理由:
  - 失敗時に行き止まりになると、Companion の安全性は上がっても実用性が落ちるため

## 5. Diff / Apply Window

### Q11. MVP UI の範囲

- status: 方針案
- 確認したいこと:
  - 初期 UI をどこまで持つか
- 暫定方針:
  - changed file list
  - split diff
  - file ごとの apply / skip
  - selected files の apply
  - conflict / binary / large file / deleted file の状態表示
- 決める理由:
  - Diff / Apply Window は approval 面なので、単なる diff viewer より状態と操作が必要になるため

### Q12. Diff Window と Diff / Apply Window の関係

- status: 未確認
- 確認したいこと:
  - 既存 `Diff Window` を拡張するか
  - Companion 専用 `Diff / Apply Window` を新設するか
- 暫定方針:
  - 表示基盤は共有し、approval 操作は Companion 専用 variant として分ける
- 決める理由:
  - 既存 Diff Window は閲覧面で、Companion の Diff / Apply Window は採用判断を行う approval 面で責務が異なるため

## 6. Provider / Approval Boundary

### Q13. shadow 内 auto approval の範囲

- status: 方針案
- 確認したいこと:
  - provider の approval request を完全自動許可するか
  - WithMate 側で危険な操作を止めるか
- 暫定方針:
  - shadow 内の file edit / command は auto approval を許可する
  - repo 外 access、secret access、危険な destructive command は WithMate 側で止める
  - user workspace への反映は Diff / Apply Window の明示 apply に一本化する
- 決める理由:
  - shadow は隔離された実行面だが、外部リソースや認証情報へのアクセスまで無条件に許可すると境界が広がりすぎるため

### Q14. command execution result の見せ方

- status: 未確認
- 確認したいこと:
  - AI が shadow で実行した test / build / command の結果を Diff / Apply Window に表示するか
- 暫定方針:
  - proposal metadata として `Run Checks` に表示する
  - 詳細ログは audit / details に逃がす
- 決める理由:
  - user が apply 判断をするには、差分だけでなく検証結果も必要になるため

## 7. Agent Mode Interop

### Q15. Agent Mode から Companion Mode への受け渡し

- status: 未確認
- 確認したいこと:
  - workspace、provider、character、model、conversation summary をどこまで引き継ぐか
- 暫定方針:
  - workspace、provider、character、model は引き継ぐ
  - conversation は summary として渡す
  - Agent の未反映 diff を Companion に渡す場合は proposal context として扱う
- 決める理由:
  - 同一 repo 文脈を保ちつつ、Agent の direct session と Companion の proposal-first 境界を混ぜないため

### Q16. Companion Mode から Agent Mode への受け渡し

- status: 未確認
- 確認したいこと:
  - 未 apply proposal を Agent に渡せるようにするか
- 暫定方針:
  - 未 apply proposal は user workspace へ反映せず、context として Agent session に渡す
  - Agent が直接 user workspace を触る場合は Agent Mode の approval model に切り替わることを UI で明示する
- 決める理由:
  - mode をまたぐ時に、どの approval model が効いているか user が誤解しないようにするため

## 8. Persistence / History

### Q17. proposal artifact の永続化

- status: 未確認
- 確認したいこと:
  - proposal diff 本文を DB に保存するか
  - shadow worktree から再計算するか
  - snapshot id と changed file metadata だけ保存するか
- 暫定方針:
  - DB には proposal metadata、snapshot id、changed file summary、apply state を保存する
  - diff 本文は必要に応じて snapshot / shadow から再構築する候補にする
- 決める理由:
  - diff 本文を保存すると履歴再現性は上がるが、DB サイズと秘密情報保持のリスクが増えるため

### Q18. apply 済み proposal の扱い

- status: 未確認
- 確認したいこと:
  - apply 済み proposal を再 apply 可能にするか
  - read-only history にするか
- 暫定方針:
  - apply 済み proposal は read-only history として残す
  - 再 apply は新しい proposal として作り直す
- 決める理由:
  - 同じ proposal の再適用は user workspace の現在状態と衝突しやすく、履歴意味も曖昧になるため

## 9. Validation

### Q19. Companion proposal の検証結果

- status: 方針案
- 確認したいこと:
  - AI が shadow で実行した test / lint / build を proposal の採用判断へどう出すか
- 暫定方針:
  - proposal ごとに `checks` を持つ
  - command、exit code、summary、実行時刻を保存する
  - raw log は詳細表示に逃がす
- 決める理由:
  - apply 前に「この提案がどこまで検証済みか」を user が判断できるようにするため

## Next Decisions

次に固める優先順位は次の通り。

1. session model と proposal model
2. snapshot の内部表現
3. apply conflict policy
4. Diff / Apply Window の MVP
5. Agent Mode との受け渡し
