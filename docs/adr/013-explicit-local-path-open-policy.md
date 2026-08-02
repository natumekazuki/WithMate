# 013 Explicit Local Path Open Policy

- 状態: Accepted
- 日付: 2026-08-02

## Context

Session File Explorer の preview は、認可済み root 内の file handle に読込対象を結び付ける。一方、「既定アプリで開く」と「Explorer で表示」は Electron と OS が path を受け取る API であり、認可済み file handle をそのまま外部 application へ渡せない。

認可後から OS が path を解決するまでの間に、別 process が親 directory を junction または symlink へ差し替えると、OS が認可時とは異なる実体を開く可能性がある。この競合を避けるには認可済み内容を一時 file へ複製して開く方法があるが、編集結果が元 file へ反映されず、Explorer で元の場所を示せない。

## Decision

- preview の本文・画像・Markdown resource 読込は、認可済み root と opened handle / identity に結び付ける
- 「既定アプリで開く」と「Explorer で表示」は、明示的な user 操作として扱う
- Main process は handoff 前に対象を opened handle で確認し、認可済み root 内の canonical real path だけを OS へ渡す
- OS への handoff 後は、元 file の path を OS が再解決する。path-only API のため、認可と OS 側の解決を同じ file handle へ原子的に結び付けることは保証しない
- 既定アプリで開いた file は元 file とし、外部 application での編集・保存が元 file へ反映される通常の操作感を維持する
- OS open の失敗は typed result で表示し、通常の Open 操作から Explorer 表示へ自動で切り替えない
- Explorer で表示する操作は、通常の Open とは別の明示操作としてのみ実行する

## Alternatives

- 認可済み内容を一時 file へ複製して開く: junction / symlink の同時差し替えによる再解決を避けられるが、編集結果が元 file へ反映されず、表示位置も元 Workspace と一致しないため採用しない
- 外部 application で開く操作を提供しない: preview できない形式や外部 editor を使う作業を阻害するため採用しない
- 認可済み file handle を外部 application へ渡す: Electron / OS の既定アプリ起動 API が path を要求し、対応できないため採用しない

## Consequences

### Positive

- 既定アプリで開いた file をそのまま編集・保存できる
- Explorer で Workspace 上の元 file の位置を確認できる
- preview 読込の認可境界と、明示的な OS open の外部副作用を区別できる

### Negative

- 別 process が認可直後の短い間に親 directory を junction / symlink へ差し替えられる環境では、OS が root 外の同名 path を開く可能性が残る
- この競合は path-only の OS handoff では自動検知・復旧を保証できない
- 強い敵対的な local filesystem mutation を扱う必要が生じた場合は、元 file の編集性を失う一時 snapshot 方式との product trade-off を再判断する必要がある
