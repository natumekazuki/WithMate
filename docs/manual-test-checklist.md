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

## 補足

- `DB を初期化` は DB file 削除ではなく Main Process の論理 reset を使う
- `Character Stream` は現行 UI に含まれないため、項目表にも含めない
