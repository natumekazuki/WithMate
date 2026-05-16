# MateTalk の自己定義発話を core に分類しやすくする

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug
- Related:
  - `src-electron/mate-talk-service.ts`
  - `src-electron/mate-memory-generation-prompt.ts`
  - `src-electron/mate-memory-generation-schema.ts`
  - `src-electron/mate-memory-generation-service.ts`
  - `src-electron/mate-growth-apply-service.ts`
  - `src-electron/mate-profile-file-renderer.ts`
  - `./17-mate-profile-section-roles.md`

## Summary

MateTalk の会話後には Memory Candidate 生成と Growth apply が走るが、自己認識や人格の核を固定したい発話が `core` ではなく `bond` や `work_style` に落ちやすい。  
そのため、「私は誰か」「一人称」「自分の性格」などを会話で教えても、`mate/core.md` に安定して反映されず、自己定義の学習 UX が弱い。

## Current behavior

- `mate-talk-service.ts` は MateTalk の turn 後に Memory 生成をスケジュールする
- `mate-memory-generation-prompt.ts` / `mate-memory-generation-schema.ts` は `targetSection = core` を許可している
- `mate-growth-apply-service.ts` は `core` 反映条件を厳しめに持っている
- recent runtime では `mate_talk` 由来の applied event は存在する一方、自己定義に見える発話が `bond` / `work_style` に落ち、`core` 側に定着していないケースがある
- Settings では current rendered `core.md` を直接確認しにくく、「処理が走っていない」のか「別 section に入った」のかを判別しづらい

## Problem

- ユーザーが Mate の自己認識を会話で固定しにくい
- `core` が薄いままだと、provider instruction sync を通した各 provider 上でも人格の核が弱くなる
- `bond` / `work_style` に本来 `core` で持つべき情報が混ざり、section 責務も崩れる
- 「自己認識を教えたのに Settings で確認できない」という体験につながる

## Expected behavior

- Mate 自身の自己定義、人格の核、一人称、自己認識に関する発話は `core` へ安定して分類される
- ユーザーとの関係や呼称だけが `bond`、作業時の振る舞いだけが `work_style` へ入る
- MateTalk 由来の自己定義学習が `mate/core.md` に反映され、後続の provider instruction sync でも活用される

## Proposed scope

1. `mate-memory-generation-prompt.ts` の section 分類指示と例を見直し、`core` の条件を明示する
2. 自己定義系の発話を `core` へ寄せる分類規則または post-processing を追加する
3. `mate-growth-apply-service.ts` の `core` 適用条件が現在の product 意図と一致しているか見直す
4. MateTalk 由来の代表的な自己定義発話を使った regression test を追加する

## Acceptance criteria

- [ ] MateTalk で自己認識を固定する代表的な発話が `core` に反映される
- [ ] 一人称や人格の核に関する発話が `bond` / `work_style` に誤分類されにくくなる
- [ ] 呼称や距離感の発話は引き続き `bond` に入る
- [ ] 作業時の説明方針や態度は引き続き `work_style` に入る
- [ ] classification の regression test で `core` 着地が固定される

## Notes / open questions

- `core` 誤分類の原因が prompt instruction、structured output の例示、後段 apply 条件のどこに寄っているかは切り分けが必要
- current runtime では `core` が product 上の意図より保守的に扱われている可能性が高い

