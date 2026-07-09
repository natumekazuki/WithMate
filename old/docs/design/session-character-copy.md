# Session Microcopy

- 作成日: 2026-03-25
- 更新日: 2026-05-24
- 対象: SessionWindow の microcopy を system default / user default / character override で解決する仕組み

## Goal

SessionWindow の固定文言を system default で安定運用しつつ、ユーザーが default copy を編集できるようにする。複数 character 復帰後は character ごとの override を差分として重ね、character 未設定時や壊れた設定では system default へ fallback する。

## Position

- 状態: supporting doc
- current UI 全体の正本は `docs/design/desktop-ui.md`
- この文書は Session microcopy slot の詳細仕様だけを扱う
- character override の DB / UI 実装は複数 character 復帰時に扱う

## State Model

microcopy は stable slot ID ごとの複数候補として持つ。1 slot 1 string にはしない。

```ts
type MicrocopySlot =
  | "chat.pending.response_waiting"
  | "dock.status.approval"
  | "dock.status.working"
  | "dock.status.responding"
  | "dock.status.preparing"
  | "retry.interrupted.title"
  | "retry.failed.title"
  | "retry.canceled.title"
  | "empty.latest_command.waiting"
  | "empty.latest_command"
  | "empty.changed_files"
  | "empty.context";

type MicrocopyCatalog = Partial<Record<MicrocopySlot, string[]>>;
```

- 値はすべて複数候補の配列
- 未設定時は system default copy を使う
- 空文字、空配列、未知 slot は normalize 時に破棄または fallback する
- `{name}` placeholder を許可し、描画時に character 名へ置換する

## Storage Policy

- built-in system default はコード同梱の復旧用正本として保持する
- user default は `app_settings` の `user_microcopy_catalog_json` に JSON として保存する
- この追加は既存 `app_settings` key/value の範囲なので V5 schema migration を要求しない
- character override は将来 `CharacterProfile` 側に差分として持たせる
- character override は user default 全体を複製せず、変更した slot だけを保存する

将来の character 側 shape:

```ts
type CharacterMicrocopyOverrides = Partial<Record<MicrocopySlot, string[]>>;

type CharacterProfile = {
  id: string;
  name: string;
  microcopyOverrides?: CharacterMicrocopyOverrides;
};
```

解決順:

1. character override
2. user default
3. built-in system default

## Rendering Policy

- microcopy の lookup は Renderer 側で `resolveMicrocopy()` を通す
- Session へ microcopy を複製しない
- user default 更新後は既存 session でも reopen なしで反映できる構成を維持する
- 候補選択は slot ごとの stable seed から決め、同じ表示中に文言が揺れないようにする
- chat message column と ActionDock は別 slot にする
- message column は会話時系列の placeholder、ActionDock は状態表示と操作を担当する

## Default Copy Policy

- default は短く、無味で、provider 非依存の wording を使う
- character override がある時だけ語尾や温度感を変える

初期 default の例:

- chat pending response waiting: `応答を準備しています`, `出力を待機しています`
- dock approval: `承認を待機中`
- dock working: `処理を実行中`
- dock responding: `応答を生成中`
- dock preparing: `応答を準備中`
- retry interrupted title: `前回の依頼は中断されたままです`
- retry failed title: `前回の依頼は完了できませんでした`
- retry canceled title: `この依頼は途中で停止しました`
- latest command waiting: `最初の command を待機中`
- latest command empty: `直近 run の command 記録はありません`
- changed files empty: `ファイル変更はありません`
- context empty: `context usage はまだありません`

## Editor

- Settings に `Default Microcopy` 編集面を追加する
- Character Editor には将来 `Character Microcopy Override` 編集面を追加する
- 各 slot は 1 行 input の候補リストで編集する
- `+` で候補行を追加し、`×` で候補行を削除する
- slot ごとに `system default に戻す` / `user default を使う` を提供する
- 候補リスト部分だけを card 内でスクロールさせ、footer や card 外へはみ出させない
- helper text で `{name}` placeholder と複数候補運用を案内する

## Out Of Scope

- character override の永続化 table 設計
- character override 編集 UI
- main process dialog
- Home / monitor / settings copy
- provider prompt / memory 連携
