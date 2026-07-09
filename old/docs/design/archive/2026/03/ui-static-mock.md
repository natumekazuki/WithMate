# UI Static Mock

- 作成日: 2026-03-11
- 対象: メイン画面の静的モック

## Goal

要件定義にある `Sidebar + Work Chat + Character Stream` の構成を、実装前に視覚確認できる静的モックとして作成する。

## Scope

- デスクトップ向けのメインレイアウト
- モバイル幅で破綻しないレスポンシブ対応
- セッション一覧、チャット本文、独り言ストリーム、入力欄のダミー表示

## Out Of Scope

- Electron 統合
- 実データ接続
- React 実装
- 状態遷移や入力送信の動作

## Screen Structure

- Sidebar
  - アプリタイトル
  - Sessions
  - Characters
  - Settings
- Main Header
  - 現在セッション名
  - Provider / Character / Workspace の状態表示
- Work Chat
  - ユーザー発言
  - キャラクター返信
  - 入力欄
- Character Stream
  - 独り言カード
  - 現在の感情 / モード表示

## Visual Direction

- 軽い未来感とデスクトップツール感を両立する
- 白ベースに寄せつつ、青緑とオレンジで温度差を作る
- フラット一枚ではなく、グラデーションと薄いノイズ感で空気を作る
- Character Stream 側は少し私的で感情寄り、Work Chat 側は作業寄りの整理された見た目にする

## Deliverables

- `mock/main-screen/index.html`
- `mock/main-screen/style.css`
