# Decisions

- first slice は launch dialog と Home の character list projection に限定する
- character editor 起動や browse handler などの event 処理は `HomeApp.tsx` に残す
- launch state の source of truth は既存の local state を維持し、projection だけ helper に寄せる
