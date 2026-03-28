# Character Chat UI

## Position

- 状態: historical note
- current の上位方針は `docs/design/product-direction.md`
- current UI 正本は `docs/design/desktop-ui.md`

- 作成日: 2026-03-11
- 対象: React モックのチャット面とキャラ画像表示

> 注記: 本書は React モック段階の draft を含む。`Character Stream` まわりの記述は future option / historical draft として読み、current milestone の正本仕様としては `product-direction.md` と `monologue-provider-policy.md` を優先する。

## Goal

`Work Chat` を単なる assistant/message UI ではなく、選択中キャラクターが横にいて、そのキャラが実際にしゃべっていると感じられる面へ寄せる。あわせて、WithMate 管理下の `character.png` を UI の主要な識別子として扱える構成を定義する。

## Inputs

### Character Source Directory

現在のキャラ定義は WithMate 専用 storage 配下にあり、各キャラディレクトリは以下のファイルを持つ。

- `character.md`
- `character.png`

## Problem Statement

現行モックでは、キャラクターの存在感を主にテキストラベルと擬似アイコンで表現している。そのため、`Character Stream` 側にはキャラ性がある程度出ていても、`Work Chat` 側は依然として「一般的な assistant UI」に見えやすい。

また、実際のキャラ定義ディレクトリとモック内のハードコードデータにズレがあり、今後の実装でキャラ選択・表示・ロール注入の一貫性を崩すリスクがある。

## Design Direction

### 1. Chat First, Character Visible

- チャットの主目的は coding agent としての指示・結果確認
- ただし assistant の発話は「選択中キャラが話している」認知を強める
- キャラ感は装飾過多ではなく、`顔 / 吹き出し / 発話内容` を中心に出す

### 2. Character Image Usage

キャラ画像は以下で共通利用する。

- `Recent Sessions` のセッションアイコン
- `Work Chat` の assistant message avatar
- `Launch Dialog` の character choice

### 3. Chat Bubble Direction

assistant 側は以下の構成を基本とする。

1. avatar
2. character name label
3. speech bubble
4. optional turn summary toggle

ユーザー側は従来どおり簡潔な bubble とし、視覚的な主役を assistant 側へ寄せる。

### 4. Character Catalog Layer

モック段階でも、画面表示で使うキャラ情報は 1 箇所にまとめる。

```ts
type CharacterCatalogItem = {
  id: string;
  name: string;
  iconPath: string;
};
```

役割:

- 画面表示用のキャラ情報を一元化する
- 現在の `characterPresets` を置き換える
- 将来の本実装では `characters/` 走査結果や adapter 出力へ差し替えやすくする

### 5. Asset Handling Boundary

モックと本実装で責務を分ける。

- モック: character catalog に定義した画像参照を使って見た目を詰める
- 本実装: Main Process 側で character directory を走査し、Renderer へ表示用 metadata を渡す

このため、React コンポーネントは「どこから画像が来たか」ではなく、「表示用 URL / path が渡される」前提で組む。

## UI Changes

### Work Chat

- assistant message に常時 avatar を表示する
- avatar と吹き出しの距離を詰めて、キャラ会話感を出す
- accent message は「感情が乗った返答」として視覚差をつける

### Recent Sessions

- テキストの擬似アイコンを廃止し、キャラ画像の小型サムネイルへ置き換える
- task 情報より先に「誰の session か」を 0.5 拍で認識できる配置にする

### Character Stream

- pinned character と chat avatar の見た目を揃える
- 右面だけ浮いた別デザインにならないよう、共通の portrait スタイルを持たせる
- 本来の価値は `キャラがいま何をしゃべっているか` に絞る
- historical draft では縮退表示案も含んでいたが、current milestone の正本では Character Stream UI 自体を適用しない
- mood badge や説明テキストのようなメタ情報は持ち込まない
- API キー未設定時の表示方針は future の Settings / monologue 実装と合わせて再定義する

### Launch Dialog

- character choice に画像を出し、選択時の情緒価値を上げる
- ただし session 作成 UI なので、チャット本体より派手にはしない

## Non Goals

- 画像のトリミング編集機能
- キャラ立ち絵の全身表示
- Live2D のようなアニメーション表示
- 実ディレクトリ走査の Main/Renderer 接続

## Draft Snapshot / Historical Notes

- 以下はモック作成時の方向メモを含む。
- `Character Stream` に関する記述は current milestone の実装済み機能を意味しない。
- current / future の正本境界は `product-direction.md`、`character-storage.md`、`monologue-provider-policy.md` を参照する。

## Open Points

- Electron 実装時に画像 path を `/@fs/` のまま使うか、Main Process から別 URL へ正規化して渡すか
- assistant bubble に tail や発話アニメーションを足すか
- avatar のトリミングを常に円形で固定するか、将来キャラごとの表現差を許すか

## Current Recommendation

MVP は以下を採用する。

- 円形 avatar
- avatar 中心の assistant bubble
- session / header / launch の画像表現を共通化し、stream 側は future option として扱う
- 画像参照は catalog 層を通す

これで `キャラがしゃべっている感` を強めつつ、作業 UI の可読性は崩しにくい。
