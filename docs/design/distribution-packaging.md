# Distribution Packaging

- 作成日: 2026-04-04
- 対象: Electron アプリの配布ビルド

## Goal

WithMate を開発用の `electron:start` 実行だけでなく、Windows と macOS 向けに配布可能な形へまとめる。  
current milestone では、署名や notarization まで確定せず、まず未署名ビルドを再現できる packaging 導線を正本化する。

## Tooling

- packaging tool は `electron-builder` を正本にする
- build 入力は次の 2 系統
  - renderer: `dist/`
  - Electron main / preload: `dist-electron/`
- `package.json` の `build` セクションで app metadata と target を管理する

## Current Targets

### Windows

- target: `nsis`
- command: `npm run dist:win`
- output: `release/` 配下の installer
- Start Menu shortcut: `WithMate`
- installer から導入した app は Start Menu 検索から `WithMate` で起動できる想定にする

### macOS

- target: `dmg`
- command: `npm run dist:mac`
- output: `release/` 配下の `.dmg`

## Script Policy

- `npm run dist`
  - current platform 向けの default target をビルドする
- `npm run dist:win`
  - Windows installer をビルドする
- `npm run dist:mac`
  - macOS dmg をビルドする
- `npm run dist:dir`
  - unpacked directory を出力して packaging 接続確認に使う

## Build Boundary

- `main` は `dist-electron/src-electron/main.js`
- Main Process 起動時に `app.setAppUserModelId("com.natumekazuki.withmate")` を設定する
- package 対象ファイルは current では次に限定する
  - `dist/**`
  - `dist-electron/**`
  - `package.json`
- provider native package 本体は `files` の除外規則で app bundle 側から外し、`resources/provider-binaries/` 側だけを runtime の正本にする
- `asar` は有効化する
- provider native package は `scripts/stage-provider-binaries.ts` で `build/provider-binaries/` へ stage し、`extraResources` で `resources/provider-binaries/` 配下へ配布する
- packaged runtime の binary path 解決は `src-electron/provider-binary-paths.ts` を正本にする
- `Codex` は `codexPathOverride` で staged binary を明示し、`Copilot` は `cliPath` に staged binary を渡す

## Platform Constraint

- current の Windows 環境では `win` の実ビルド確認を優先する
- macOS artifact の実ビルドは macOS machine または macOS CI runner を前提にする
- current task では macOS 向け設定と手順までは repo に含めるが、local 実ビルド確認までは要求しない

## Signing Policy

- current milestone では署名と notarization を未導入とする
- macOS build は `mac.identity = null` で未署名前提にする
- Windows code signing certificate も current task では扱わない
- 正式配布前に別 task で次を扱う
  - Windows code signing
  - macOS signing
  - macOS notarization

## Asset Policy

- packaging icon は `build/` 配下で管理する
- source asset は `build/icon.svg`
- Windows packaging は `build/icon.ico` を使う
- macOS packaging は `build/icon.png` を source asset として使う
- icon asset の再生成は `npm run icon:generate` を正本にする

## Manual Verification

minimum の確認は次とする。

1. `npm run build`
2. `npm run dist:dir`
3. Windows 環境では必要に応じて `npm run dist:win`
4. Windows installer 導入後、Start Menu 検索で `WithMate` を入力して起動できることを確認する
5. Windows unpacked 出力では `resources/provider-binaries/@openai/codex-win32-x64/vendor/.../codex.exe` と `resources/provider-binaries/@github/copilot-win32-x64/copilot.exe` が存在することを確認する

macOS artifact の実確認は macOS 環境で次を行う。

1. `npm run dist:mac`
2. `.dmg` から app を展開
3. `/Applications` へ配置する
4. Spotlight で `WithMate` を検索して起動できることを確認する

## References

- `README.md`
- `docs/design/window-architecture.md`
- `https://www.electron.build/`
- `https://www.electron.build/nsis.html`
- `https://www.electron.build/multi-platform-build.html`
