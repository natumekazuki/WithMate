# Session Microcopy

- 対象: Session Window の system default / user default microcopy
- UI全体の正本: [Desktop UI](desktop-ui.md)

## State Model

- slot IDと同梱既定値の正本は `src-shared/settings/microcopy-state.ts` の `MICROCOPY_SLOTS` / `BUILT_IN_MICROCOPY_CATALOG` とする。
- slotごとに複数候補を保持する。外部入力のstringまたはstring配列を、空行を除いた候補配列へnormalizeする。未設定・空のslotは同梱既定値へ戻し、未知slotは表示用catalogへ含めない。
- 解決順は user default、built-in system default。Character別overrideの保存・編集UIは持たない。
- `{name}` は表示対象Character名、path errorの `{path}` は対象pathへ置換する。slot ID、placeholder、内部保存値を表示言語に合わせて変更しない。

## Storage Policy

- user defaultは既存 `app_settings` の `user_microcopy_catalog_json` に保存し、Sessionへ複製しない。
- 同梱既定値は短い英語のprovider-neutral wordingとする。ユーザーが設定した文言の言語は変更しない。
- リリース済み旧日本語既定値は、slotごとの候補数・内容・順序が旧同梱配列と完全一致する場合だけ英語既定値へ移行する。文字列形式、候補の一部変更、順序変更、追加候補はこの一致に含めない。
- 移行は `AppSettingsStorage` の初期化で一回だけ行い、catalog更新と `user_microcopy_catalog_english_migrated` の保存を同じtransactionで確定する。DB更新失敗時はrollbackして上位へ失敗を返す。
- 一度移行した後のcustomは、旧既定値と同文でも再置換しない。初回移行時に旧同梱配列と完全一致する手入力は、同梱値と識別できない。
- 旧path errorの日本語literalは過去の保存値との照合に必要な値であり、未翻訳UIとして置換しない。
- schema versionは変更せず、既存key/value storage内で扱う。

## Rendering Policy

- Rendererのlookupは `resolveMicrocopy()` を通す。候補はslotとstable seedから選び、同じ表示中に文言を揺らさない。
- user default更新は既存Sessionにも設定購読を通して反映する。
- chat message columnとAction Dockは別slotを使うが、同一対象・同一runの既定待機文を重複して主表示しない。runの状態、操作、accessibilityを維持したうえでconsumer側で可視性を決める。
- 空文字をresolverへ渡すことを非表示の仕組みにしない。custom候補を既定待機文の整理に巻き込まず、slot全体の設定と表示状態で判定する。
- custom microcopy、会話本文、Character定義、ファイル内容、Provider向け指示は英語化の対象外とする。

## Editor

- Settingsの `Default microcopy` に各slotのtextareaを置き、1行を1候補として編集する。
- slot名は英語の表示labelを使い、保存するstable slot IDは変えない。
- 候補とplaceholderは既存設定保存経路で保存する。未保存変更・保存中・失敗の表示は [Settings UI](settings-ui.md) に従う。
