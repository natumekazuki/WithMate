# Session Character Copy

- 作成日: 2026-03-25
- 対象: SessionWindow の固定文言を character ごとに差し替える仕組み

## Goal

SessionWindow の固定文言を character 体験へ寄せつつ、character 未設定時は bland な default copy で運用できるようにする。

## State Model

`CharacterProfile` に session copy 設定を持たせる。

```ts
type CharacterSessionCopy = {
  pendingApproval?: string;
  pendingWorking?: string;
  pendingResponding?: string;
  pendingPreparing?: string;
  retryInterruptedTitle?: string;
  retryFailedTitle?: string;
  retryCanceledTitle?: string;
  latestCommandWaiting?: string;
  latestCommandEmpty?: string;
  changedFilesEmpty?: string;
  contextEmpty?: string;
};
```

- 値はすべて optional
- 未設定時は bland default copy を使う
- `{name}` placeholder を許可し、描画時に character 名へ置換する

## Rendering Policy

- session copy の lookup は Renderer 側で行う
- truth source は `resolvedCharacter`
- Session へ copy を複製しない
- character 更新後は既存 session でも reopen なしで反映できる構成を維持する

## Default Copy Policy

- default は短く、無味で、provider 非依存の wording を使う
- character copy がある時だけ語尾や温度感を変える

初期 default の例:

- pending approval: `承認を待機中`
- pending working: `処理を実行中`
- pending responding: `応答を生成中`
- pending preparing: `応答を準備中`
- retry interrupted title: `前回の依頼は中断されたままです`
- retry failed title: `前回の依頼は完了できませんでした`
- retry canceled title: `この依頼は途中で停止しました`
- latest command waiting: `最初の command を待機中`
- latest command empty: `直近 run の command 記録はありません`
- changed files empty: `ファイル変更はありません`
- context empty: `context usage はまだありません`

## Editor

- Character Editor に `Session Copy` 編集面を追加する
- 初回 slice は free text field 群でよい
- helper text で `{name}` placeholder を案内する

## Out Of Scope

- main process dialog
- Home / monitor / settings copy
- provider prompt / memory 連携
