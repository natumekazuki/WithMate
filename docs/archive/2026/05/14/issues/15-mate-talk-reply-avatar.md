# MateTalk の返信メッセージに Mate アイコンを反映する

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug
- Related:
  - `src/chat/use-mate-talk-window-state.ts`
  - `src/chat/MateTalkChatModeApp.tsx`
  - `src/chat/mate-talk-chat-projection.tsx`
  - `src/chat/text-chat-projection.tsx`
  - `src/chat/chat-window-adapter.ts`
  - `src/session-components.tsx`
  - `./14-mate-avatar-path-materialization.md`

## Summary

MateTalk は `mateProfile` を読み込んでいるが、返信 message column へ渡す `character` 情報には `iconPath` が含まれていない。  
そのため、Mate アイコン画像を設定済みでも、MateTalk の返信メッセージでは画像が出ず、イニシャル fallback のままになる。

## Current behavior

- `src/chat/use-mate-talk-window-state.ts` は `withmateApi.getMateProfile()` で Mate profile を取得する
- `src/chat/MateTalkChatModeApp.tsx` は `buildMateTalkChatWindowProps()` に `mateName` は渡すが `avatarFilePath` は渡していない
- `src/chat/mate-talk-chat-projection.tsx` / `src/chat/text-chat-projection.tsx` の props も icon path を受け取らない
- `src/chat/chat-window-adapter.ts` の `createStaticTextConversationMessageColumnProps()` は `createStaticChatCharacterProfile({ id, name })` を呼び、`iconPath` を設定しない
- 結果として MateTalk の assistant 側 message avatar は常に fallback 表示になる

## Problem

- Home の `Your Mate` や Mate profile editor ではアイコンが見えても、MateTalk の会話面では見えない
- Mate 用 avatar 設定が surface ごとに一貫しない
- 先に入れた `avatarFilePath` materialization 修正だけでは、MateTalk の projection bug は解消しない

## Expected behavior

- Mate avatar が設定されている場合、MateTalk の返信メッセージでも同じアイコンが表示される
- avatar 未設定時だけ、現在どおりイニシャル fallback を使う

## Proposed scope

1. `useMateTalkWindowState` / `MateTalkChatModeApp` から Mate avatar path を chat projection へ渡す
2. `mate-talk-chat-projection.tsx` と `text-chat-projection.tsx` の input に icon path を追加する
3. `chat-window-adapter.ts` の static chat character 生成時に `iconPath` を渡す
4. MateTalk message column の regression test を追加する

## Acceptance criteria

- [ ] Mate avatar 設定済みの状態で MateTalk を開くと、返信メッセージの avatar に画像が出る
- [ ] avatar path は `CharacterAvatar` が読める形式で message column へ渡る
- [ ] avatar 未設定時は fallback 表示のまま維持される
- [ ] MateTalk projection / adapter の regression test で icon path の伝播が固定される

## Notes / open questions

- 今回の論点は message column の avatar 伝播であり、header に avatar を出すかどうかは別スコープでよい
- `./14-mate-avatar-path-materialization.md` を直した後でも、この issue は別途解消が必要

