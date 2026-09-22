# Session UI Copy

- 対象: Session Window の待機・実行状態・通常emptyに関する表示
- UI全体の正本: [Desktop UI](desktop-ui.md)

## Current Policy

- current Settings UIにmicrocopyの編集面や保存設定は置かない。ユーザーまたはCharacterごとのmicrocopy catalog、slot、候補をruntime設定として保持しない。
- 正常なempty / idle / pendingの説明本文は表示せず、必要なshell、操作、spinner、accessible statusだけを残す。読込中はloading文字列を重ねずspinnerへ集約し、実エラー、validation、安全・回復に必要な説明は保持する。
- 会話本文、Character定義、テンプレート本文、ファイル内容・path、Provider向け指示などユーザーが入力・生成した内容はUI用copyとは別の内容として、原文と保存値を維持する。

## Ownership

- 表示面ごとの短いlabel、見出し、button、option、status名は各consumerが所有し、Desktop UIのPascalCase（空白なし）規則に従う。
- 長いerror・safety説明とscreen reader向けの自然文は、必要な意味が伝わる文章として維持する。
- 同一target・同一requestの状態は一つの主表示へ集約し、会話本文、ActionDock、right pane、compact / expandedの非表示側で同じ説明を重複させない。
