# 20260328 IPC Boundary Refactor Decisions

## 初期判断

- IPC channel 名は互換維持のため変更しない
- まずは「型と責務の分割」を優先し、不要な abstraction を増やしすぎない
- `withmate-window.ts` は薄い public entry とし、domain ごとの module を re-export する方向で進める
