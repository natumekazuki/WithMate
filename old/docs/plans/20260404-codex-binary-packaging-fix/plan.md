# Plan

- task: installer 環境で Codex binary を起動できるようにする
- date: 2026-04-04
- owner: Codex

## 目的

- install 済みアプリから `@openai/codex-sdk` が `codex.exe` を spawn できない問題を直す
- `app.asar` 内に閉じ込めず、packaging 時に vendor binary を unpack する

## スコープ

- `package.json`
- `docs/design/distribution-packaging.md`

## 進め方

1. `@openai/codex*` を `asarUnpack` 対象へ追加する
2. packaging doc に binary unpack 方針を追記する
3. `npm run dist:dir` で unpack 配置を確認する

## チェックポイント

- [ ] Codex 関連 package が `asarUnpack` 対象になっている
- [ ] packaging doc が current 仕様を説明している
- [ ] unpacked 出力で `codex.exe` の配置を確認する
