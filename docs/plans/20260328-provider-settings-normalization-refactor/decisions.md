# Decisions

- first slice は `HomeApp` と shared helper の正規化経路統一に限定する
- storage format や app settings schema は変えない
- 既存の `home-settings-view-model` / `home-settings-draft` を活かしつつ、provider settings bundle を shared helper 化する
