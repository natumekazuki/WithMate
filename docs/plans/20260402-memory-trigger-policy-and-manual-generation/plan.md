# 2026-04-02 Memory Trigger Policy And Manual Generation

## Goal

- `SessionStart` の独り言を、前回の独り言以降に会話更新がない場合は発火させない
- `Session Window` close 時の自動 `Session Memory extraction` を停止する
- `Session Window` から手動で `Session Memory extraction` を実行できるボタンを追加する
- 独り言 API 分離は今回の対象外にする

## Scope

- `src-electron/character-reflection.ts`
- `src-electron/memory-orchestration-service.ts`
- `src-electron/session-window-bridge.ts`
- `src-electron/main.ts`
- `src-electron/main-ipc-registration.ts`
- `src-electron/main-ipc-deps.ts`
- `src-electron/preload-api.ts`
- `src/withmate-ipc-channels.ts`
- `src/withmate-window-api.ts`
- `src/App.tsx`
- `src/session-components.tsx`
- 関連テスト
- 関連 design / backlog / checklist

## Checkpoints

1. trigger policy を仕様どおりに変更する
2. 手動 `Session Memory` 生成導線を main / preload / renderer に追加する
3. docs と tests を同期して検証する
