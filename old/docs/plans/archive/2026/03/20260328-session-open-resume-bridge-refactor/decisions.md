# Decisions

## Decision 1: first target は Session Window の bridge に限定する

- `session 起動 / 再開` という表現だと session metadata の生成・保存責務まで広がる
- current の hotspot は `openSessionWindow()` に集中している window registry / close policy / background hook である
- そのため、この slice では `Session Window bridge` に限定し、session 作成・更新の保存責務は後続に送る

## Decision 2: BrowserWindow の生成自体は main.ts に残す

- `createBaseWindow()` や `loadSessionEntry()` は Electron runtime と密結合している
- first slice では BrowserWindow の生成を bridge へ押し込まず、生成済み window の registry / event wiring を切り出す

## Decision 3: session-start / session-window-close の hook も bridge に含める

- `runCharacterReflection(..., { triggerReason: "session-start" })`
- `runSessionMemoryExtraction(..., { triggerReason: "session-window-close" })`

これらは window lifecycle に直接従属しているため、runtime service ではなく bridge の責務として扱う
