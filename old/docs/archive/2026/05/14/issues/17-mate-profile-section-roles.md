# Mate Profile section の責務を core / bond / work-style / notes で明確化する

- Archived: 2026-05-14
- Resolution: Implemented in the SingleMate roadmap pass.

- Status: Archived
- Priority: P1
- Type: Bug
- Related:
  - `src-electron/mate-profile-file-renderer.ts`
  - `src-electron/mate-talk-profile-context.ts`
  - `src-electron/mate-growth-apply-service.ts`
  - `src-electron/mate-instruction-projection.ts`
  - `docs/design/prompt-composition.md`
  - `docs/design/provider-instruction-sync.md`
  - `./16-provider-instruction-inline-profile.md`
  - `./18-mate-talk-core-self-definition-classification.md`

## Summary

`mate/core.md` / `mate/bond.md` / `mate/work-style.md` / `mate/notes.md` は active profile item から再生成される current-state projection だが、section ごとの責務が runtime と UX の両方で十分に固まっていない。  
そのため、ユーザーが「自己認識を固定したい」「関係性だけを教えたい」「作業中の振る舞いを育てたい」と意図して会話しても、どの section に落ちるべきかが不明瞭で、MateTalk と provider instruction sync の効き方がずれやすい。

## Current behavior

- `mate-profile-file-renderer.ts` は `core` / `bond` / `work_style` / `notes` を active profile item から再レンダリングする
- `mate-talk-profile-context.ts` は MateTalk 用 context として `core` / `bond` / `work_style` / `notes` をすべて読む
- `mate-instruction-projection.ts` は provider instruction sync 対象を `core` / `bond` / `work_style` に限定し、`notes` は含めない
- `mate-growth-apply-service.ts` の `core` 適用条件は厳しめで、自己定義に見える内容でも `bond` や `work_style` に落ちやすい
- 現状の確認導線は Settings 上の debug 情報と実際の MateTalk / provider の振る舞いに分かれており、どちらを正導線にするかが明示されていない

## Problem

- ユーザーがどの種類の発話をどの section へ育てたいのかを制御しにくい
- `notes` は MateTalk には効くのに provider instruction sync には乗らないため、同じ学習結果でも surface ごとに効き先がずれる
- 自己認識を固定したつもりでも `core` に定着せず、`bond` / `work_style` に分散しうる
- provider instruction projection を強くしても、section 分類がずれていれば意図どおりの人格定義にならない
- 安定運用時に Settings の詳細確認や手動適用を前提にした UX にはしたくないため、会話中心の導線へ寄せる設計方針も整理が必要

## Expected behavior

- `core` / `bond` / `work_style` / `notes` の責務が明確に定義され、会話からの学習結果もその定義に沿って安定して入る
- 少なくとも以下の期待が成り立つ
  - `core`: Mate 自身の自己定義、人格の核、自己認識
  - `bond`: ユーザーとの関係、呼称、距離感
  - `work_style`: 作業時の振る舞い、説明スタイル、付き合い方
  - `notes`: 補助メモ、未整理メモ、長文メモ、恒久 instruction に直結しない情報
- provider に常時効かせたい定義は `core` / `bond` / `work_style` へ入り、`notes` に入った情報は「MateTalk 専用または補助情報」と分かる
- 詳細確認が必要な場合でも、正の導線は Settings の詳細 viewer ではなく MateTalk 上の会話や各 provider 側の実際の振る舞いに寄せる

## Proposed scope

1. `core` / `bond` / `work_style` / `notes` の canonical な責務を docs と runtime コメントで明文化する
2. MateTalk / Growth apply の分類規則を見直し、自己認識・人格固定の発話が `core` に入りやすくする
3. `notes` の扱いを明文化し、「MateTalk には使うが provider instruction sync には含めない」前提を product / docs で揃える
4. supported provider 全体で section ルールが一貫するよう、Copilot / Codex を含む provider instruction sync 前提で scope を整理する
5. 会話中心の UX 方針に合わせ、詳細確認や安定後の運用を Settings 依存にしないことを scope 上明示する

## Acceptance criteria

- [ ] `core` / `bond` / `work_style` / `notes` の責務が docs と実装の両方で一致する
- [ ] 自己認識を固定する代表的な発話が `core` に反映される
- [ ] 呼称や距離感に関する発話が `bond` に反映される
- [ ] 作業時の説明・態度・進め方に関する発話が `work_style` に反映される
- [ ] `notes` に入った情報が provider instruction sync に含まれない場合、その product ルールが docs / 実装で一致する
- [ ] 詳細確認の正導線が Settings 詳細 viewer ではなく、MateTalk / 実際の provider 挙動寄りの方針で整理されている
- [ ] supported provider 前提の scope になっており、Copilot / Codex のいずれも issue 上で除外されていない

## Notes / open questions

- runtime の `core` 誤分類は follow-up issue に分離して扱う
- section 責務の明確化と provider projection 強化は別 issue だが、実際には密接に連動する
- `notes` を完全に MateTalk 専用にするのか、将来的に opt-in projection を許すのかは設計判断が必要
- current runtime では `core` 反映条件が厳しく、自己認識の学習 UX を阻害している可能性が高い

