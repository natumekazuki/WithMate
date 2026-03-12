# Character Chat UI

- 作成日: 2026-03-11
- 対象: React モックのチャット面とキャラ画像表示

## Goal

`Work Chat` を単なる assistant/message UI ではなく、選択中キャラクターが横にいて、そのキャラが実際にしゃべっていると感じられる面へ寄せる。あわせて、`C:\Users\zgmfx\.codex\characters` 配下にある `character.png` を UI の主要な識別子として扱える構成を定義する。

## Inputs

### Character Source Directory

現在のキャラ定義は `C:\Users\zgmfx\.codex\characters` 配下にあり、各キャラディレクトリは以下の 3 ファイルを持つ。

- `character.md`
- `character-notes.md`
- `character.png`

確認済みキャラ:

- `石神のぞみ`
- `倉持めると`
- `大空スバル`
- `戌亥とこ`

## Problem Statement

現行モックでは、キャラクターの存在感を主にテキストラベルと擬似アイコンで表現している。そのため、`Character Stream` 側にはキャラ性がある程度出ていても、`Work Chat` 側は依然として「一般的な assistant UI」に見えやすい。

また、実際のキャラ定義ディレクトリとモック内のハードコードデータにズレがあり、今後の実装でキャラ選択・表示・ロール注入の一貫性を崩すリスクがある。

## Design Direction

### 1. Chat First, Character Visible

- チャットの主目的は coding agent としての指示・結果確認
- ただし assistant の発話は「選択中キャラが話している」認知を強める
- キャラ感は装飾過多ではなく、`顔 / 名前 / 吹き出し / 声色補助` の 4 要素で出す

### 2. Character Image Usage

キャラ画像は以下で共通利用する。

- `Recent Sessions` のセッションアイコン
- `Current Session Header` の固定キャラ表示
- `Work Chat` の assistant message avatar
- `Character Stream` の pinned character 表示
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
  tone: string;
  streamMode: string;
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
- character name を message header に出す
- accent message は「感情が乗った返答」として視覚差をつける

### Recent Sessions

- テキストの擬似アイコンを廃止し、キャラ画像の小型サムネイルへ置き換える
- task 情報より先に「誰の session か」を 0.5 拍で認識できる配置にする

### Current Session Header

- 選択中キャラの小さな portrait を固定表示する
- coding agent としての情報量は維持しつつ、キャラ固定状態を視覚化する

### Character Stream

- pinned character と chat avatar の見た目を揃える
- 右面だけ浮いた別デザインにならないよう、共通の portrait スタイルを持たせる
- API キー未設定時は、完全非表示ではなく縮退表示を第一候補とする
- 縮退表示では、独り言機能が API 利用前提であることを明示する

### Launch Dialog

- character choice に画像を出し、選択時の情緒価値を上げる
- ただし session 作成 UI なので、チャット本体より派手にはしない

## Non Goals

- 画像のトリミング編集機能
- キャラ立ち絵の全身表示
- Live2D のようなアニメーション表示
- 実ディレクトリ走査の Main/Renderer 接続

## Current Implementation Snapshot

- `src/App.tsx` に `characterCatalog` を追加し、モックが使うキャラ名 / 画像パス / tone / stream mode を一元化した
- `characterCatalog` の `iconPath` は `C:\Users\zgmfx\.codex\characters\<name>\character.png` を指す
- `Work Chat` は assistant 側だけ avatar + character name + tone を常時表示し、キャラ会話感を強めた
- `Recent Sessions` `Current Session Header` `Character Stream` `Launch Dialog` も同じ avatar 表現へ統一した
- Vite dev では `/@fs/` 経由で画像を読み、`vite.config.ts` の `server.fs.allow` で `C:/Users/zgmfx/.codex/characters` を許可した
- 独り言の provider / auth / Memory 方針は `docs/design/monologue-provider-policy.md` を参照する

## Open Points

- Electron 実装時に画像 path を `/@fs/` のまま使うか、Main Process から別 URL へ正規化して渡すか
- assistant bubble に tail や発話アニメーションを足すか
- avatar のトリミングを常に円形で固定するか、将来キャラごとの表現差を許すか

## Current Recommendation

MVP は以下を採用する。

- 円形 avatar
- character name label と tone label 付き assistant bubble
- session / header / stream / launch の画像表現を共通化
- 画像参照は catalog 層を通す

これで `キャラがしゃべっている感` を強めつつ、作業 UI の可読性は崩しにくい。
