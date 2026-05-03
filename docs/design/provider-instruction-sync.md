# Provider Instruction Sync

- 作成日: 2026-05-03
- 対象: WithMate 4.0.0 の Mate Profile と provider native instruction file の同期

## Goal

WithMate が管理する Mate Profile を、各 coding provider の instruction file へ安定して同期し、毎 turn prompt に Mate 定義全文を合成しない実行経路を作る。

この文書は、provider root、instruction file path、projection、同期 lifecycle、privacy boundary を定義する。

## Position

- SingleMate の product / storage 方針は `docs/design/single-mate-architecture.md` を参照する
- provider instruction sync table の詳細は `docs/design/mate-storage-schema.md` を参照する
- coding plane の prompt detail は `docs/design/prompt-composition.md` を参照する
- provider 実行境界は `docs/design/provider-adapter.md` を参照する
- Settings UI の扱いは `docs/design/settings-ui.md` へ反映する

## Core Decisions

- Mate Profile の正本は WithMate が管理する
- provider instruction file は Mate Profile から生成した projection として扱う
- Growth Event は直接 projection せず、Mate Profile に圧縮反映された現在状態だけを読む
- `projection_allowed = false` の Growth 由来情報は provider instruction file へ出さない
- provider root directory と instruction file path は Settings で指定可能にする
- provider instruction sync の設定 UI は既存 Settings に追加する
- provider / skill root 系の既存設定値と同じ保存導線、validation、view model の流儀に合わせる
- MVP 対象は WithMate が current 実装でサポートしている provider に限定する
- repository 配下の共有 instruction file ではなく、user / provider root 配下の個人用 instruction file を基本対象にする
- 4.0.0 MVP では `managed-block` を既定の write mode とする
- provider instruction file 全体は user / provider の所有物として扱い、WithMate は marker block 内だけを更新する
- `managed-file` は専用 file をユーザーが明示指定した場合だけ使う
- `managed-file` でも WithMate-owned marker がある file だけを更新対象にする
- 既存 unmanaged file がある場合は上書きせず hard fail にし、Settings で backup / diff preview / path 変更を促す
- session 開始前に instruction sync を実行する
- provider が instruction を session 開始時にしか読まない場合、Mate 更新の即時反映は新規 session / restart を必要とする

## Target Model

4.0.0 の永続 schema は `docs/design/mate-storage-schema.md` の `provider_instruction_targets` と `provider_instruction_sync_runs` を正本にする。

```ts
type ProviderInstructionTarget = {
  providerId: "codex" | "copilot";
  targetId: "main";
  rootDirectory: string;
  instructionFilePath: string;
  writeMode: "managed-file" | "managed-block";
  enabled: boolean;
  requiresRestart: boolean;
};
```

UI / API では `managed-file` / `managed-block` の kebab-case を使う。
SQLite などの永続化層では `managed_file` / `managed_block` の snake_case に正規化し、adapter 境界で相互変換する。
marker comment では kebab-case を使い、比較時は marker value を DB enum へ正規化してから `write_mode` と照合する。

### `rootDirectory`

provider ごとの user / provider root directory。

例:

```text
<providerRoot>/
```

repo 配下の workspace path ではなく、個人環境の provider root を基本にする。

### `instructionFilePath`

`rootDirectory` からの相対 path として保存する。

例:

```text
AGENTS.md
copilot-instructions.md
```

実装では、保存前に `rootDirectory + instructionFilePath` が provider root 配下に収まることを検証する。
検証は文字列 prefix ではなく canonical path で行う。
symlink / junction / `..` / drive letter 差異 / UNC path を解決した後、resolved target が resolved provider root 配下に残る場合だけ許可する。
resolved target が WithMate の Mate source root、read-only projection workspace、memory-runtime、repository workspace、temporary run directory、または app が管理する別 domain の directory 配下に入る場合は hard fail とする。
file 作成または更新前に、WithMate-owned marker と target metadata が現在の target 設定と一致することを確認する。

Settings では、既存 provider root / skill root と同じ設定面に追加する。
4.0.0 MVP では専用 window を作らず、provider ごとの root directory、instruction relative path、enabled、write mode、fail policy を編集できるようにする。

### `writeMode`

#### `managed-file`

WithMate が file 全体を所有する。

特徴:

- 生成結果が安定する
- idempotent に書ける
- WithMate-owned marker を持つ file だけを更新する
- 既存 user instruction との merge は行わず、unmanaged file は上書きしない
- 専用 file をユーザーが明示指定した場合だけ使う

更新条件:

- file が存在しない場合は、WithMate-owned marker を含む新規 file として作成してよい
- file が存在し、WithMate-owned marker がある場合だけ全体更新してよい
- file が存在し、WithMate-owned marker がない場合は hard fail とする
- hard fail 時は file 内容を破壊せず、Settings に backup / diff preview / path 変更の導線を出す
- WithMate-owned marker があっても、marker 内の `target_id` / `provider_id` / `write_mode` が保存済み target と一致しない場合は hard fail とする。marker の `mode=managed-block` は比較前に DB enum `managed_block` へ正規化する

#### `managed-block`

既存 file の marker block だけを WithMate が差し替える。

候補 marker:

```md
<!-- WITHMATE:BEGIN provider=codex target=main mode=managed-block -->
...
<!-- WITHMATE:END provider=codex target=main mode=managed-block -->
```

特徴:

- user instruction と共存できる
- block 外を壊さない
- 頻繁な Mate projection 更新でも user instruction と責務を分けられる
- 4.0.0 MVP の既定方針

更新条件:

- file が存在しない場合は、WithMate block を含む新規 file として作成してよい
- file が存在し、WithMate block がない場合は、Settings の確認後に block を末尾へ追加してよい
- file が存在し、WithMate block がある場合は、block 内だけを完全再生成する
- marker が壊れている、重複している、target metadata が一致しない場合は hard fail とし、Settings で再作成または手動修復を促す
- block 内には `target_id`、`provider_id`、`write_mode`、`generated_at` を machine-readable comment として含める
- marker の `provider` / `target` / `mode` と DB の `provider_id` / `target_id` / `write_mode` が一致しない場合は更新しない。`mode` は kebab-case marker value を snake_case DB value へ正規化して比較する

## Projection Policy

provider instruction へは Mate Profile 全文をそのまま書かない。

含めるもの:

- Mate Core の短い安定 projection
- Bond Profile の短い安定 projection
- Work Style の短い安定 projection
- coding correctness / safety / repository instruction 優先の guard
- Mate Profile や Growth Event を勝手に編集しない規則

含めないもの:

- Growth Event 全履歴
- Growth Candidate
- `projection_allowed = false` の Growth 由来情報
- session transcript
- 長い notes
- Project Digest
- repository に保存すべきでない個人情報
- workspace path / remote URL / customer name / workplace name / secret
- provider に不要な UI 文脈

## Generated Instruction Structure

provider に依存しない共通構造は次の形にする。

```md
# WithMate Mate Instructions

You are running inside WithMate.

## Priority

- Follow repository instructions and code correctness before persona.
- Use the Mate context for tone, continuity, and work preferences.
- Do not edit Mate Profile, Growth Event, or provider instruction files unless WithMate explicitly asks.

## Mate Core

...

## Bond Profile

...

## Work Style

...

```

provider ごとの heading や注意書きは adapter で差し替えてよい。

## Project Digest

Project Digest は provider root の instruction file には含めない。
project 情報は Mate の恒久 instruction ではなく、その workspace / prompt にだけ効く session context として扱う。

4.0.0 では、prompt 送信時に WithMate が関連 Memory / Profile Item を検索し、必要最小限の context block として provider request に差し込む。
この context block は provider instruction file へ永続化しない。

Ephemeral injection contract:

- input は current workspace identity、Git 情報、user input、enabled Mate、retrieval budget とする
- Git 管理 workspace だけ project tag / Project Digest candidate を検索対象にする
- retrieval は Profile Item / tag catalog の hybrid retrieval を使う
- Profile Item は `projection_allowed = 1`、`state = active`、forgotten / disabled / superseded 除外を必須 filter にする
- tag catalog は active catalog entry だけを検索補助に使い、tag 値そのものを provider instruction file へ永続化しない
- 出力は provider request の一時 context block だけに入れ、provider instruction file、Project Digest markdown、repository file へは書かない
- prompt audit には使用した item id、score、token estimate、injection reason を残し、raw transcript や absolute path は残さない

Growth Event は Project Digest prompt injection の直接出力対象にしない。
Growth Event は Profile Item / Project Digest を生成する apply の evidence としてのみ使い、prompt へ渡す statement は圧縮済みの active Profile Item から作る。

対象:

- Git 管理 workspace では Git 情報から project tag を解決する
- Git 非管理 workspace では project tag を付与せず、Project Digest も差し込まない
- user input、workspace identity、project tag、embedding / SQL filter / rule rerank で関連 Profile Item を検索する
- token budget 内に収まる短い statement だけを渡す

含めないもの:

- provider root instruction file への Project Digest 常設
- repository tracked file への Project Digest 書き込み
- workspace path / remote URL / customer name / workplace name / secret
- raw transcript

## Sync Lifecycle

1. user が Mate Profile を作成または更新する
2. WithMate が Mate projection を生成する
3. enabled な provider target を列挙する
4. target path を検証する
5. instruction file を書き出す
6. sync result を記録する
7. session 起動時に最新 sync status を確認する
8. provider が restart を必要とする場合は UI に表示する

## Sync Result

候補型:

```ts
type ProviderInstructionSyncResult = {
  providerId: string;
  targetId: string;
  targetPath: string;
  status: "synced" | "skipped" | "failed";
  requiresRestart: boolean;
  message: string;
  syncedAt: string;
};
```

`targetPath` は UI / log では repo 外 path をそのまま docs に残さず、表示用に短縮する。

## Settings UI

Settings は provider ごとに次を持つ。

- sync enabled
- root directory
- instruction file path
- write mode
- last sync status
- manual sync action

初期値は provider ごとに推定してよいが、存在しない path を黙って作らない。
root directory が存在しない場合は、作成確認または手動修正を促す。

## Prompt Composition Boundary

4.0.0 では、Mate 定義全文を毎 turn prompt に合成しない。

turn prompt に残してよいもの:

- user input
- 添付 reference
- 必要最小限の WithMate run marker

turn prompt に残さないもの:

- Mate Core 全文
- Bond Profile 全文
- Work Style 全文
- Growth Event

監査ログでは logical prompt と provider instruction sync status を分けて記録する。

## Privacy Boundary

- 個人 Mate 情報は repository tracked file へ直接書き込まない
- provider root 配下の個人 instruction file を基本対象にする
- workspace 配下へ bridge file を置く場合は、個人情報を含まない最小 marker に限定する
- `.withmate/` のような workspace-local data を使う場合は ignore / exclude 方針を別途決める
- Growth の保存可否と provider projection 可否は別判定にする
- Growth forget / redaction 後は、対象内容が provider instruction projection から消えることを検証する

## Failure Policy

sync が失敗した場合:

- session 起動を必ず止めるかは provider / user setting で決める
- warning として起動継続する場合、Mate projection が古い可能性を表示する
- `last_sync_state = 'redaction_required'` は、忘却済み内容が provider instruction file に残る可能性がある状態を表す
- 4.0.0 MVP では `redaction_required` でも session 起動を block せず、sync warning として扱う
- 将来、forget 保証を強める場合は `redaction_required` を session 起動 block 条件に昇格できるよう state は残す
- target path が provider root 外へ出る場合は hard fail とする
- target path が Mate source root、read-only projection workspace、memory-runtime、repository workspace、temporary run directory に入る場合は hard fail とする
- write permission がない場合は manual fix を促す

## Validation

- provider root 外 path を拒否できる
- `managed-block` が marker block 内だけを idempotent に差し替えられる
- `managed-file` は専用 file 指定時だけ idempotent に同じ内容を書ける
- Mate Profile 更新後に projection が変わる
- Growth forget 後に provider instruction file から対象内容が消える
- provider sync は `active_revision_id` を read snapshot として projection を作り、compose 後に revision が変わっていないことを確認する
- session 起動前 sync が実行される
- sync 失敗時に UI が warning を出す
- prompt audit で Mate 定義全文が毎 turn 合成されていないことを確認できる

## Deferred / Validation Items

- provider ごとの default root は候補表示に留め、存在しない path は黙って作らない
- Copilot が user root instruction を読むタイミングは targeted validation で実測する
- instruction file 変更後の restart required 判定は provider adapter の capability / validation result として扱う
- Project Digest の session context injection は本書の ephemeral injection contract と `docs/design/prompt-composition.md` 側で検証する

## Related

- `docs/design/single-mate-architecture.md`
- `docs/design/product-direction.md`
- `docs/design/prompt-composition.md`
- `docs/design/provider-adapter.md`
- `docs/design/settings-ui.md`
