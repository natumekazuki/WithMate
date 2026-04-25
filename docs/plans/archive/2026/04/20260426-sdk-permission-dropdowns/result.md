# Result

## 状態

完了。

## 変更概要

- Approval UI を radio group から dropdown へ変更した。
- Approval の正本を `never` / `on-request` / `on-failure` / `untrusted` に変更し、旧値 `allow-all` / `safety` / `provider-controlled` は読み込み時に互換変換する。
- Codex 用 Sandbox dropdown を追加し、`read-only` / `workspace-write` / `workspace-write + network` / `danger-full-access` を選べるようにした。
- `workspace-write + network` は Codex SDK へ `sandboxMode: "workspace-write"` と `networkAccessEnabled: true` の組み合わせで渡す。
- Provider ごとに Approval / Sandbox の選択肢を分ける helper を追加した。
- Depth の表示を SDK 値そのままにした。
- session storage、CodexAdapter、CopilotAdapter、Design Doc、README を更新した。

## 検証

- `npx tsc -p tsconfig.electron.json --noEmit --pretty false`: 成功。
- `npx tsc --noEmit --pretty false`: 既存の `src/session-components.tsx` 型エラーなどで失敗。
- `node --import tsx --test scripts/tests/codex-adapter.test.ts scripts/tests/session-state.test.ts scripts/tests/home-settings-view-model.test.ts`: sandbox の `spawn EPERM` で起動前に失敗。

## コミット

未作成。
