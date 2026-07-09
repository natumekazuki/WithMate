# Plan

- task: Windows / macOS 向け installer 準備
- date: 2026-04-04
- owner: Codex

## 目的

- Electron アプリを配布可能な形へまとめる
- Windows と macOS の両方で installer / app bundle を生成できる build 導線を用意する
- current repo の build 成果物を packaging tool へ正しく接続する

## スコープ

- `package.json`
- installer 用設定ファイルまたは `package.json` 内 build 設定
- 必要な script 追加
- packaging 手順の doc

## 進め方

1. current build 出力と packaging tool の選定を確認する
2. Windows / macOS 両対応の packaging 設定を追加する
3. local で少なくとも pack / dry-run 相当を確認する
4. 手順を docs へ残す

## チェックポイント

- [ ] packaging tool と target を確定する
- [ ] build script と packaging 設定を追加する
- [ ] 実行手順を docs へ記録する
- [ ] local で packaging コマンドを確認する
