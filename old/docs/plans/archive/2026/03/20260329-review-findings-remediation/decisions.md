# Decisions

## same-plan / follow-up の切り分け理由

### same-plan

- issue 1: `vite.config.ts`
- issue 2: `index.html` / `session.html` / `character.html` / `diff.html`
- issue 3: `src-electron/main.ts`
- issue 4: `src-electron/session-runtime-service.ts`
- issue 5: `src-electron/session-storage.ts`
- issue 6: `package.json`
- issue 7: `package.json`
- issue 8: `src-electron/open-path.ts` / `src-electron/open-terminal.ts`

理由:
- いずれも元レビュー指摘への remediation そのもの
- 変更対象が局所的で、同一の validation 軸で扱える
- docs 更新を含めても今回の repo plan 内で閉じられる

### follow-up

- issue 9: `src-electron/main.ts` 巨大化

理由:
- 主目的が構造改善であり review findings remediation と別目的
- bootstrap / IPC / main process 配線の横断見直しが必要
- cleanup task と同様に今回の repo plan へ混在させると完了条件が曖昧になる

## decision update

### issue 3: `sandbox`

- ユーザー判断:
  - Codex SDK / GitHub Copilot SDK の実行に影響がないなら `sandbox: true` を採用してよい
- 第一候補:
  - `sandbox: true` を採用する
- 実施方針:
  - `sandbox: true` の spot-check を first attempt にする
  - BrowserWindow 起動、主要 preload API / IPC、Codex SDK / GitHub Copilot SDK 実行に影響がなければ ON にする
  - 影響が出る場合のみ `sandbox: false` 維持へフォールバックし、`src-electron/main.ts` と `docs/design/electron-window-runtime.md` を候補に理由を明記する
- 判断基準:
  - preload API と IPC 利用が成立すること
  - BrowserWindow 起動 smoke が通ること
  - Codex SDK / GitHub Copilot SDK 実行に影響がないこと
  - フォールバック時は `sandbox: false` を維持する理由を説明できること

## 確定 decision

### issue 8: path 制約

- 採用方針:
  - 方向性 B（現仕様を採用し、必要なら rationale / docs で扱う）
- 決定内容:
  - `openPath` は任意の target を受け取れる現仕様を維持する
  - 現時点では path allowlist を `openPath` に強制実装しない
  - `AddDirectory` は許可対象ディレクトリを制御できる既存機能として扱うが、`openPath` の強制ガードそのものではない
  - `openSessionTerminal` は session の `workspacePath` を開く用途に限られており、現時点では追加 block の優先度は低い
  - issue 8 は脆弱性 fix 実装ではなく、現仕様として採用し、必要に応じて rationale / docs へ前提を残す扱いにする
- 理由:
  - 任意の target を渡せる `openPath` の仕様を維持したいというユーザー決定がある
  - `AddDirectory` により主要な利用導線で許可対象ディレクトリを制御する機能は提供済みである
  - ただし `AddDirectory` は `openPath` 自体の強制ガードではないため、その点を plan に明確に残す必要がある
  - `openSessionTerminal` は用途が限定されており、現時点で block を追加する優先度が低い
  - 一律 allowlist を `openPath` に入れるより、現仕様の rationale を明示するほうが現状の UX と整合する

## 補足

### issue 1

- 現行 `vite.config.ts` で指摘が再現しない可能性を許容する
- no-op 判定の場合も、元レビュー指摘との差分確認結果を result に残す

### issue 7

- `test` script は最小構成を優先する
- test framework 拡張や cleanup 由来の整備は same-plan に含めない

### issue 8

- 将来 `openPath` / `openSessionTerminal` の policy を再設計する場合のみ follow-up 候補として扱う

## 完了時の扱い

- remediation 実装本体はコミット `76ea6efd59025e18f79936009c65b7a5013f8612` `fix(runtime): レビュー指摘を是正` に固定する
- 完了判定は `npm test` / `npm run build` / `tsc -p tsconfig.electron.json --noEmit --pretty false` success を満たし、`tsc --noEmit --pretty false` は 67 errors / 27 files の既存 baseline fail を悪化させていないことをもって行う
- issue 9（`src-electron/main.ts` 巨大化）と renderer/test 側の既存型エラー baseline は follow-up / 別タスクへ分離したまま閉じる
