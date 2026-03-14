# Character Chat UI Plan

- 作成日: 2026-03-11
- 目的: チャット UI を「キャラクターが実際にしゃべっている」感覚へ寄せ、`C:\Users\zgmfx\.codex\characters` 配下の `character.png` をキャラアイコンとして扱える構成へ見直す。

## Goal

- assistant の発話面をキャラ会話として認識しやすい UI に再設計する。
- `Recent Sessions`、`Current Session Header`、`Work Chat`、`Character Stream` のアイコン表現を、実キャラ画像前提へ揃える。
- いまのハードコードされたキャラ情報と、実際のキャラ定義ディレクトリの差分を吸収できる土台を作る。

## Task List

- [x] 現行モックのキャラ表示箇所を棚卸しし、画像適用対象を確定する
- [x] キャラ画像の参照方針を決め、モック用の character catalog 構造を定義する
- [x] チャット UI を「キャラが話している」見た目へ再設計する
- [x] `Recent Sessions` / `Header` / `Character Stream` のアイコン表現を統一する
- [x] React モックへ反映し、`typecheck` と `build` を通す
- [x] 設計ドキュメントを更新する

## Affected Files

- `src/App.tsx`
- `src/styles.css`
- `docs/design/ui-react-mock.md`
- `docs/design/session-launch-ui.md`
- `docs/design/character-chat-ui.md`

## Design Check

- 新しい Design Doc が必要
- 理由: キャラ画像の参照元、キャラ表示の責務、チャット UI の見せ方を後続実装でも使う仕様として固定したいため
- 追加対象: `docs/design/character-chat-ui.md`

## Risks

- 現在の React モックは `星導ショウ` と `フレン・E・ルスタリオ` を含むが、実キャラ定義ディレクトリには存在しないため、表示データの整合が必要
- Vite 単体のブラウザ実行では外部絶対パス画像の扱いが本実装と異なるため、モック用データ構造と本実装の責務分離が必要
- キャラ感を強めすぎると coding agent 本体の可読性を落とすため、作業面の密度管理が必要

## Notes / Logs

- 実キャラ定義ディレクトリ確認結果: `石神のぞみ` `倉持めると` `大空スバル` `戌亥とこ`
- 各キャラは `character.md` `character-notes.md` `character.png` を持つ
- 現在のモックは文字ベースの擬似アイコンを使っており、実アセット連携は未着手
- 実装では `characterCatalog` を追加し、モック内のキャラ情報を 1 箇所へ集約した
- 画像参照は Vite dev 上で `/@fs/` を使い、`vite.config.ts` の `server.fs.allow` に `C:/Users/zgmfx/.codex/characters` を追加した
- `Work Chat` は assistant 側だけ avatar と speaker label を常時表示し、ユーザー側は簡潔な bubble のままにした
- モック内の存在しないキャラは外し、`石神のぞみ` `倉持めると` `大空スバル` `戌亥とこ` ベースへ揃えた
- `npm run typecheck` と `npm run build` を通過
- ユーザーメモとして、`RecentSessions` は常時表示不要、画像未表示、文字入力場所が分かりにくい、元のチャット UI が消えたのが意図的か不明、の 4 点を次回確認事項として残した
