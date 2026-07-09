# Result

- 状態: 完了

## Summary

- `src/home-components.tsx` を追加し、`Settings content` と `launch dialog` を pure props component に分離した
- `src/HomeApp.tsx` は state / effect / handler の結線に寄せ、巨大な JSX block を削減した
- `Recent Sessions` と `Home right pane` の component 分離は follow-up slice に回した

## Verification

- `npm run build`

## Commits

- `efe5eff` `refactor(home): split settings and launch components`
