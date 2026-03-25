# 20260325 additional-directory-allowlist

## Goal

- session ごとに `追加ディレクトリ` の許可リストを持てるようにする
- 未許可の workspace 外 path は `file / folder` 添付で拒否する
- 許可済み追加ディレクトリを Codex `additionalDirectories` と snapshot 監視対象へ反映する

## Scope

- session metadata / storage への `allowedAdditionalDirectories` 追加
- composer 添付解決の許可判定変更
- snapshot / diff の複数 root 対応
- Session UI の追加ディレクトリ管理
- Codex remove 対応

## Out Of Scope

- Copilot provider native の directory allowlist 制御
- 実ファイル削除
- slash command 対応

## Steps

1. session 型と storage を拡張する
2. 添付解決を許可済み追加ディレクトリ前提へ変更する
3. snapshot / diff を複数 root で比較できるようにする
4. Session UI に add/remove 導線を追加する
5. docs と tests を更新する
