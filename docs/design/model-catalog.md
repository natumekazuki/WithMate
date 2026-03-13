# Model Catalog

- 作成日: 2026-03-14
- 対象: WithMate の model / reasoning depth 選択仕様

## Goal

WithMate で `Codex SDK` 実行時に使う model と reasoning depth を、
アプリ組み込みの catalog を基準に選択できるようにする。

同時に、最新 model へ完全自動追従するのではなく、
`アプリ更新で catalog を増やす` 方針と `自由入力` を両立させる。

## Decision

- model catalog はアプリへ組み込む
- model 名は自由入力も許可する
- reasoning depth は組み込み catalog で定義した候補だけを UI に出す
- custom model では、depth の候補表示だけ default profile に寄せる
- 実行時は adapter 側で `requested -> resolved` を解決する

## Bundled Catalog

現行 catalog:

| Model | Label | Depth |
| --- | --- | --- |
| `gpt-5.4` | `GPT-5.4` | `minimal / low / medium / high` |
| `gpt-5.3-codex` | `GPT-5.3 Codex` | `low / medium / high / xhigh` |
| `gpt-5.2-codex` | `GPT-5.2 Codex` | `low / medium / high / xhigh` |

既知 alias:

- `gpt-5.1-codex-mini` -> `gpt-5.3-codex`
- `gpt-5.1-codex-max` -> `gpt-5.2-codex`

## Defaults

- default model: `gpt-5.4`
- default reasoning depth: `high`

これらは session 作成時の初期値としても使う。

## UI Policy

### Session Window

- composer の textarea 下に `Model` 入力欄を置く
- model は datalist 付き text input で選択 / 自由入力の両方を許可する
- depth は chip で選択する
- depth 候補は current model に対応する catalog entry から出す
- current model が catalog 外なら default profile の depth 候補を出す

### Home / New Session

- current milestone では model / depth を launch dialog に出さない
- 新規 session は default model / default depth で作る
- 詳細な model 調整は Session Window 側へ寄せる

## Resolution Policy

WithMate では user selection と actual execution setting を分けて扱う。

### 1. requested

- `session.model`
- `session.reasoningEffort`

### 2. resolved

adapter 実行前に次を解決する。

- alias model は canonical model へ寄せる
- selected depth が model 非対応なら近い深さへ落とす
  - 例: `xhigh` が無いなら `high`
  - さらに無ければ `medium -> low -> minimal`

custom model で capability が不明な場合は、
model 名はそのまま使い、depth も selected value をそのまま渡す。

## Visibility Policy

無言 fallback は避ける。

- turn artifact の `runChecks` に
  - `model`
  - `reasoning`
  を出す
- fallback が起きた場合は `requested -> resolved` の形で表示する

## Non Goals

- SDK / CLI から model catalog を自動取得すること
- remote catalog を配布してアプリ外更新だけで追従すること
- unknown custom model の capability を runtime probe すること

## References

- `docs/design/provider-adapter.md`
- `docs/design/electron-session-store.md`
- `docs/plans/20260314-session-model-controls.md`
