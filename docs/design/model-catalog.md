# Model Catalog

- 作成日: 2026-03-14
- 更新日: 2026-03-14
- 対象: WithMate の provider-aware model / reasoning depth catalog

## Goal

WithMate の model catalog を SQLite で管理し、Session Window と provider adapter が同じ catalog revision を参照できるようにする。

外部との入出力は versionless JSON で行い、アプリ内部だけ revision を持つ。

## Decision

- model catalog の正本は SQLite に置く
- catalog の import / export 形式は versionless JSON にする
- 初回起動で active catalog が無ければ、アプリ同梱の `public/model-catalog.json` を import して seed する
- import のたびに内部 revision を新規採番し、active revision を切り替える
- Session は `provider / model / reasoningEffort / catalogRevision` を保持する
- Session Window の model 設定は catalog 選択のみとし、自由入力は許可しない

## JSON Format

```json
{
  "providers": [
    {
      "id": "codex",
      "label": "Codex",
      "defaultModelId": "gpt-5.4",
      "defaultReasoningEffort": "high",
      "models": [
        {
          "id": "gpt-5.4",
          "label": "GPT-5.4",
          "reasoningEfforts": ["minimal", "low", "medium", "high"]
        }
      ]
    }
  ]
}
```

### Rules

- top-level に `version` は持たない
- `providers` は 1 件以上必須
- provider ごとに
  - `id`
  - `label`
  - `defaultModelId`
  - `defaultReasoningEffort`
  - `models`
  が必須
- `defaultModelId` はその provider の `models` に存在しなければならない
- `defaultReasoningEffort` は `defaultModelId` の `reasoningEfforts` に含まれていなければならない

## Internal Storage

SQLite では次の 4 テーブルで保持する。

### `model_catalog_revisions`

- `revision INTEGER PRIMARY KEY AUTOINCREMENT`
- `source TEXT NOT NULL`
- `imported_at TEXT NOT NULL`
- `is_active INTEGER NOT NULL`

### `model_catalog_providers`

- `revision INTEGER NOT NULL`
- `provider_id TEXT NOT NULL`
- `label TEXT NOT NULL`
- `default_model_id TEXT NOT NULL`
- `default_reasoning_effort TEXT NOT NULL`
- `sort_order INTEGER NOT NULL`

### `model_catalog_models`

- `revision INTEGER NOT NULL`
- `provider_id TEXT NOT NULL`
- `model_id TEXT NOT NULL`
- `label TEXT NOT NULL`
- `reasoning_efforts_json TEXT NOT NULL`
- `sort_order INTEGER NOT NULL`

## Revision Policy

- active catalog は常に 1 revision
- import 時は既存 revision を破壊更新しない
- 新 revision を作って `is_active = 1` に切り替える
- Session には `catalogRevision` を保存する
- Session Window の選択肢は常に current active revision を正本にして表示する
- Session 内で model / depth を変更した場合は current active revision に乗り換える
- 既存 session が旧 revision を持っていても、current model が catalog から消えていない限り active revision の候補を選べる

## Seed Policy

- app 起動時に active catalog が無ければ、`public/model-catalog.json` を import する
- seed で作られた revision は `source = bundled`
- ユーザー import で作られた revision は `source = imported`

## UI Policy

### Session Window

- textarea 下に `Model` select を出す
- 候補は current active catalog の provider catalog から出す
- `Depth` は selected model の `reasoningEfforts` だけを chip で出す
- current session の model が catalog から消えている場合は、互換用の 1 項目だけ一時表示する

### Home / New Session

- Home の `Settings` overlay から `Import Models` / `Export Models` を実行できる
- file picker / save dialog は Main Process が開く
- import 成功時は active revision を切り替える
- current milestone では model / depth を出さない
- new session は active catalog の provider default で作る

## Resolution Policy

adapter 実行時は session が持つ `catalogRevision` と `provider` を使って provider catalog を読む。

- `requestedModel` が exact match すればその model を使う
- model が見つからなければそのままエラーにする
- depth が model catalog の定義に無ければそのままエラーにする
- 実 provider 側でさらに拒否された場合も、そのまま実行エラーとして扱う

## Import / Export Policy

- export は active revision を versionless JSON に戻す
- import は JSON を validate して新 revision として保存する
- partial merge はしない
- provider / model の追加・削除も revision 単位で扱う

## Non Goals

- SDK / CLI から model catalog を自動取得すること
- remote catalog 配信を前提にすること
- provider ごとの capability probe を runtime で行うこと

## References

- `docs/design/provider-adapter.md`
- `docs/design/session-persistence.md`
- `docs/plans/20260314-model-catalog-db.md`
