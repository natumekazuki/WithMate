# 実機テスト項目表

## 目的

- Electron 実行時の現行機能を人手で確認するためのチェックリスト
- 現時点で実装済みの UI / 永続化 / ランタイム挙動のみを対象にする
- `Character Stream` / monologue plane の未着手機能は含めない

## 更新方針

- ユーザーが触れる挙動を変更した場合は、この項目表を同じ論理変更単位で更新する
- 初回リリース前のため後方互換性は前提にせず、非互換変更後の復旧導線も確認対象に含める
- 追加した項目は、実装済み機能の再現手順と期待結果が読める粒度で書く

## 前提

- `npm install` 済み
- 実機確認は Electron で行う
- 起動コマンド:

```bash
npm run electron:start
```

## 項目

| ID | 領域 | 手順 | 期待結果 |
| --- | --- | --- | --- |
| MT-001 | Home 起動 | `npm run electron:start` でアプリを起動する | Home Window が表示される |
| MT-002 | Home 一覧 | session が 0 件の状態で起動する | 空状態メッセージが表示される |
| MT-003 | Characters 一覧 | character が 0 件の状態で起動する | 空状態メッセージと `Add Character` が表示される |
| MT-004 | Settings overlay | Home の `Settings` を押す | Settings overlay が開き、`System Prompt Prefix` / `Coding Agent Providers` / `Coding Agent Credentials` / `Model Catalog` / `Danger Zone` が見える |
| MT-005 | Settings copy | Settings overlay を確認する | `OpenAI API Key (Coding Agent)` が coding plane 用と読め、`Character Stream 用ではない` 補助文と future note が表示される |
| MT-006 | Compatibility note | Settings overlay を確認する | `初回リリース前のため後方互換性は考慮しない` と `DB 初期化で復旧する` 旨の note が表示される |
| MT-007 | Settings save | `System Prompt Prefix` または coding provider 設定を変更して `Save Settings` を押す | 保存成功メッセージが表示され、再度開いても保持される |
| MT-008 | Model catalog export | Settings の `Model Catalog` から `Export Models` を押す | catalog JSON が保存される |
| MT-009 | Model catalog import | Settings の `Model Catalog` から `Import Models` を実行する | import 成功メッセージが表示され、active revision が更新される |
| MT-010 | DB reset confirm | Settings の `Danger Zone` で `DB を初期化` を押す | confirm が出る |
| MT-011 | DB reset success | idle session のみ存在する状態で `DB を初期化` を実行する | sessions / audit logs / app settings / model catalog が初期状態へ戻り、characters は保持される |
| MT-012 | DB reset reject | 実行中 session がある状態で `DB を初期化` を実行する | reset が拒否され、実行中 session の完了またはキャンセルを促す |
| MT-013 | New Session 起動 | Home の `New Session` を押す | launch dialog が開く |
| MT-014 | New Session 作成 | title と workspace と character を選び `Start New Session` を押す | Session Window が開き、Home の session 一覧に追加される |
| MT-015 | Session 実行 | Session Window の textarea に入力して送信する | user message が追加され、pending と live activity が表示される |
| MT-016 | Session 実行キャンセル | 実行中に `Cancel` を押す | 実行が止まり、session は `idle` に戻り、Audit Log に `CANCELED` が残る |
| MT-017 | Approval / Model / Depth | idle 状態の Session Window で approval / model / depth を変更する | 選択値が保存され、再度開いても保持される |
| MT-018 | Audit Log | Session Window の `Audit Log` を押す | 1 turn 1 record の監査ログが閲覧できる |
| MT-019 | Diff | artifact の `Open Diff` を押し、必要なら `Open In Window` も押す | inline diff と Diff Window の両方で split diff が開く |
| MT-020 | Character persistence | character を作成 / 編集 / 削除する | `characters/` 相当の保存内容が Home と Session に反映される |
| MT-021 | Character editor title theme | Home から Character Editor を開く | header title の文字色が現在のキャラ `main` 色で表示される |
| MT-022 | Session theme accent | Session Window を開く | header title、assistant / pending bubble、composer settings、`Send / Cancel`、Details 展開後の artifact block に character theme の accent が反映され、`user-bubble` は neutral tone を維持する |
| MT-023 | Diff theme accent | Session から Diff を開く | `titlebar / subbar / pane header` に character theme の薄い accent が反映され、`Before / After` の文字が背景色に埋もれず読める |
| MT-024 | Live progress sort / emphasis | `in_progress` と `completed` が混在する run を実行し、可能なら `pending` または未知 status 相当の step も観察する | pending bubble で `failed / canceled / in_progress` bucket が先頭、`completed` が後段に並び、`pending` や未知 status は completed より前へ割り込まず safe degradation し、`in_progress` が最も目立つ |
| MT-025 | Live progress labels | pending bubble と assistant artifact の operation timeline を見比べる | `type` label が両方で一致し、step `status` は `実行中 / 完了 / エラー / キャンセル / 待機` の人間向け表記になる |
| MT-026 | Live progress command visibility | `command_execution` を含む run を実行し、pending bubble を assistantText 未着時と completed 後の両方で確認する | command 文字列が常時表示され、通常 paragraph ではなく command 専用の monospace block として即判別でき、completed 後も安全確認に使える濃さで読める |
| MT-027 | Live progress running without assistantText | step 更新が先に来て assistantText が遅れる run を観察する | pending bubble に実行中 indicator と `in_progress` step が出て、typing dots だけに依存せず「今動いている」と判断できる |
| MT-028 | Live progress details / usage | command output や todo 更新を含む run を実行する | command 本体や主要 summary は常時表示のまま、`details` は二次情報として折りたたまれ、usage は live run footer 集約のみで `input / output` 常時表示、`cached` は 0 より大きい時だけ表示される |
| MT-029 | Live progress assistant text separation | assistant 本文と step 更新が両方ある run を実行する | `assistantText` が pending bubble 本文として表示され、`agent_message` を live step row として重複表示しない |
| MT-030 | Live progress file_change visibility-first | 複数ファイルを変更する run を実行し、`file_change` summary が複数行になる状態を作る | `file_change` step が paragraph 1 個ではなく action chip + path の line item list で表示され、list 自体は bubble の高さを暴れさせすぎない範囲で scan しやすい |
| MT-031 | Live progress file_change raw fallback | `file_change` summary が 1 行の run、または複数行でも `kind: path` として読みにくい summary を確認する | 既存どおり raw summary fallback が使われ、非 `file_change` step の表示も退行しない |
| MT-032 | Live progress error block | provider error または tool error を再現する | `liveRun.errorMessage` が step list と分離した alert block に出て、failed / canceled step と見た目が混線しない |
| MT-033 | Live progress no false running on completed-only steps | `assistantText` 未着のまま visible step が全件 `completed` になる run を観察する | pending bubble に step list は残っても `実行中 / コーディングエージェントがステップを実行中` 表示は出ない |
| MT-034 | Live progress failed step and error block separation without assistantText | `assistantText` 未着のまま `failed` step と `liveRun.errorMessage` が同時に出る run を観察する | failed step は step list 内で `エラー` として見え、`liveRun.errorMessage` は別 alert block に出て、`実行中` 表示とも競合しない |
| MT-035 | Scroll follow mode | long session で 80px を超えて上へスクロールして読み返し中にする。そのまま新着 assistant message / pending 更新 / live run step 更新（status / summary / details 変更を含む）を発生させる。続けて assistantText streaming 中の run も観察する。最後に session を切り替える | 上スクロール中は位置が維持され、追従停止中は `新着あり` または `読み返し中` の導線が出る。follow ON なら assistantText streaming が自然に追従し、step の status / summary / details 変化でも follow mode が反映される。session 切替で follow state と新着導線がリセットされる |

## 補足

- `DB を初期化` は DB file 削除ではなく Main Process の論理 reset を使う
- `Character Stream` は現行 UI に含まれないため、項目表にも含めない
