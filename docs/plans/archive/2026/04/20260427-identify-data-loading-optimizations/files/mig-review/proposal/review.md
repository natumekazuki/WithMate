# V1→V2 migration write mode 品質レビュー

## Findings

### 重大: `--overwrite` で `--v1` と `--v2` が同一パスの場合、V1 DB を削除する

- 対象: `scripts/migrate-database-v1-to-v2.ts:524`, `scripts/migrate-database-v1-to-v2.ts:532`, `scripts/migrate-database-v1-to-v2.ts:536`
- 内容: `v1DbPath` の存在確認後、`overwrite && existsSync(v2DbPath)` の場合に `removeSqliteDatabaseFiles(input.v2DbPath)` を実行してから V1 DB を read-only で開く。`--v1 withmate.db --v2 withmate.db --overwrite` のような誤指定では、読み取り元の V1 DB 本体と `-wal` / `-shm` が削除される。
- 影響: 「V1 DB は変更しない」「V1 DB は backup / rollback source として残す」という設計に反する破壊的挙動。write mode の最優先修正対象。
- 推奨: `resolve` / `realpath` ベースで `v1DbPath` と `v2DbPath` が同一ファイルを指す場合は、overwrite 有無に関係なく削除前にエラーにする。`-wal` / `-shm` も同じベースパスとして扱うテストを追加する。

### 高: overwrite は既存 V2 を先に削除するため、移行失敗時に旧 V2 を失う

- 対象: `scripts/migrate-database-v1-to-v2.ts:532`, `scripts/migrate-database-v1-to-v2.ts:610`, `scripts/migrate-database-v1-to-v2.ts:850`
- 内容: 既存 V2 を削除してから新規 DB を作り、transaction 内で schema 作成と insert を行う。transaction は新規 V2 の partial insert を抑えるが、削除済みの旧 V2 は保護しない。途中で FK 失敗、I/O 失敗、schema 変更との不整合などが起きると、旧 V2 は戻らず、空または未完成の target file が残る可能性がある。
- 影響: overwrite の安全性が不十分。app startup policy が「V2 DB が存在する場合は V2 DB を正本として開く」なので、失敗後の空 target が存在判定だけを通るリスクもある。
- 推奨: 同じ plan で、`v2DbPath.tmp` などの一時 DB に移行して検証・close した後に atomic replace する方式へ変更する。最低限、失敗時に作成途中の target / wal / shm を削除し、既存 V2 をバックアップから戻すテストを追加する。

### 高: broken `usage_json` が write mode では V2 detail にそのまま混入する

- 対象: `scripts/migrate-database-v1-to-v2.ts:731`, `scripts/migrate-database-v1-to-v2.ts:793`, `scripts/migrate-database-v1-to-v2.ts:796`
- 内容: `usage_json` が壊れている場合、issue は記録するが、`usageForInsert = row.usage_json ? row.usage_json : ""` により invalid JSON を `audit_log_details.usage_json` へ保存する。dry-run は issue として扱うだけなので、dry-run と write の挙動が乖離している。
- 影響: `docs/design/database-v2-migration.md:134` の「broken JSON は対象 row / field を skip」に反する。V2 本体へ broken JSON を持ち込むため、後続の V2 reader が detail 読み込み時に再度壊れた JSON を処理することになる。
- 推奨: parse 成功時だけ元 JSON または正規化 JSON を保存し、parse 失敗時は `usage_json = ''` にする。write mode の broken JSON fixture を追加し、`issues` と V2 detail の両方を検証する。

### 中: `message.accent` の移行が設計と schema に対して欠落している

- 対象: `docs/design/database-v2-migration.md:113`, `src-electron/database-schema-v2.ts:78`, `scripts/migrate-database-v1-to-v2.ts:621`, `scripts/migrate-database-v1-to-v2.ts:669`
- 内容: V2 schema は `session_messages.accent` を持ち、設計も boolean を `0` / `1` に変換するとしているが、write mode の insert 対象列に `accent` がなく、全 message が default `0` になる。
- 影響: V1 の assistant message で使われている accent 表示が V2 移行後に失われる。現行テストも `accent` を含む fixture を持たず、退行を固定できていない。
- 推奨: `messagesForInsert` に `accent` を含め、`INSERT INTO session_messages` で `accent` を明示保存する。`accent: true` / `accent: false` / 未定義の fixture を追加する。

### 中: `assistant_text_preview` に全文を保存しており、V2 の一覧軽量化設計からずれている

- 対象: `docs/design/database-v2-migration.md:74`, `docs/design/database-v2-migration.md:115`, `src-electron/database-schema-v2.ts:111`, `scripts/migrate-database-v1-to-v2.ts:781`, `scripts/migrate-database-v1-to-v2.ts:800`
- 内容: `audit_logs.assistant_text_preview` に `row.assistant_text` 全文を入れ、同じ全文を `audit_log_details.assistant_text` にも入れている。設計は audit log 一覧で detail payload を読まないことを目的に preview/detail を分けているが、summary table に全文が残る。
- 影響: 長い assistant output が `audit_logs` summary query に残り、V2 の data loading optimization 効果を削る。テストは detail 側の全文だけを確認しており、preview が bounded であることを固定していない。
- 推奨: preview 長の上限と整形方針を設計に明記し、migration では `assistant_text_preview` に bounded preview だけを保存する。長文 assistant fixture で `audit_logs.assistant_text_preview` と `audit_log_details.assistant_text` の差を検証する。

### 中: write mode の TDD / plan 証跡が task plan に反映されていない

- 対象: `docs/plans/20260427-identify-data-loading-optimizations/worklog.md:68`, `docs/plans/20260427-identify-data-loading-optimizations/result.md:15`, `docs/plans/20260427-identify-data-loading-optimizations/result.md:41`
- 内容: 対象コードには write mode 実装と write mode test が入っているが、worklog / result は dry-run 追加までで止まっており、result にはまだ「write mode を実装する」が残タスクとして残っている。
- 影響: slice granularity と TDD evidence を plan から追跡できない。repo plan の完了条件、検証済み範囲、レビュー指摘対応の判断が曖昧になる。
- 推奨: 同じ plan で write mode 実装内容、実行した test command、未解決リスクを worklog / result に反映してから次の slice へ進む。

## Same-plan Recommendation

same-plan で修正するべきです。理由は、上記の主要指摘がすべて V1→V2 migration write mode の安全性・設計整合・テスト固定に直結しており、現 slice の完了条件そのものだからです。

優先順:

1. `--v1` / `--v2` 同一パス拒否を追加し、V1 破壊リスクを潰す。
2. overwrite を一時 DB + replace または失敗時復旧可能な方式へ変更する。
3. write mode の broken JSON 方針を dry-run と一致させる。
4. `accent` と bounded `assistant_text_preview` の移行を実装し、fixture test を追加する。
5. worklog / result に write mode の実装・検証・残リスクを反映する。

## New-plan Recommendation

new-plan follow-up は、V2 runtime reader / startup policy の実装と統合検証に分けるのが妥当です。理由は、migration script 単体の修正とは独立した検証軸で、app が V2 DB をどう検出・開くか、summary-first reader がどの query contract を使うかを含むためです。

follow-up 候補:

- V2 startup policy の実装と、失敗 migration artifact を存在判定だけで正本扱いしない検証。
- session / audit log の V2 reader を summary-first に切り替える統合テスト。
- 実運用 V1 DB コピーに対する dry-run / write / V2 read smoke test。

## 確認した観点

- V1 DB は read-only で開かれているが、同一パス overwrite の削除順に重大リスクがある。
- V2 write は transaction 内で実行されているが、overwrite 対象の旧 V2 保護は transaction 外。
- sessions / messages / artifacts / audit details / operations の基本移行は実装されているが、`accent` と preview 粒度に設計 drift がある。
- legacy memory / monologue / background audit / legacy app settings の skip 方針は概ね守られている。
- broken JSON は dry-run と write で `usage_json` の扱いが乖離している。
- tests は基本 happy path と overwrite なしの拒否を固定しているが、同一パス、失敗時 rollback / cleanup、write broken JSON、accent、bounded preview が不足している。

## 実行した検証

- `npx tsx --test scripts/tests/database-v1-to-v2-migration.test.ts scripts/tests/database-schema-v2.test.ts`: pass

## 前提

- `design_proposal_path` は未提示のため、設計 drift は `docs/design/database-v2-migration.md` と `src-electron/database-schema-v2.ts` を基準に確認した。
