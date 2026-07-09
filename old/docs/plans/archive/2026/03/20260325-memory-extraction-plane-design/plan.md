# 20260325 memory-extraction-plane-design

## Goal

- Memory 管理を「専用モデル + 固定プロンプトの裏処理」として定義する
- 保存条件と設定方針を docs に明記する

## Scope

- `docs/design/memory-architecture.md` の更新
- 必要なら `docs/design/product-direction.md` へ current milestone 上の位置づけを追記

## Out Of Scope

- 実装
- Settings UI 追加
- API key / local model backend 実装

## Steps

1. Memory extraction plane の責務と trigger を定義する
2. 専用モデル、固定 prompt、JSON validate、保存条件を docs に追記する
3. plan を閉じて commit する
