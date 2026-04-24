# Skill/custom agent discovery cache 最適化計画

- 作成日: 2026-04-24
- 完了日: 2026-04-24
- 種別: session plan
- 対象: `docs/optimization-roadmap.md` の `Skill/custom agent discovery cache`
- 状態: 完了

## 目的

Session 切り替えや picker 表示で繰り返される skill / custom agent discovery の同期ファイル読み込みを減らし、同一 workspace / provider / global source の再探索コストを下げる。

## スコープ

- `src-electron/skill-discovery.ts`
  - workspace / provider root ごとの mtime ベース cache を導入する
  - root 単位の discovery 結果と merge / dedupe 後の結果を再利用する
- `src-electron/custom-agent-discovery.ts`
  - workspace / global root ごとの mtime ベース cache を導入する
  - picker 用一覧と runtime config 解決で同じ discovery 結果を再利用する
- `scripts/tests/skill-discovery.test.ts`
  - cache hit と mtime invalidation の観点を追加する
- `scripts/tests/custom-agent-discovery.test.ts`
  - cache hit と mtime invalidation の観点を追加する

## 方針

1. 公開 API は同期のまま維持し、呼び出し元の IPC / provider 経路を広げない。
2. root directory と対象ファイルの mtime / size から fingerprint を作る。
3. fingerprint が変わらない場合は Markdown 再読込と dedupe / sort を避ける。
4. fingerprint が変わった場合は該当 root と merge 結果だけを更新する。

## 実施結果

- skill discovery に root cache と discovery cache を追加した。
- custom agent discovery に root cache と discovery cache を追加した。
- cache hit 時に呼び出し元が返却配列を変更しても cache 本体へ影響しないよう clone して返すようにした。
- `providerSkillRootPath` が `null` の場合も扱えるようにした。
- cache hit と mtime invalidation のテスト観点を追加した。

## 検証

- `tsx --test --test-concurrency=1 scripts/tests/skill-discovery.test.ts scripts/tests/custom-agent-discovery.test.ts`
  - sandbox の子プロセス生成制限により `spawn EPERM` で実行不可。
- `npm run build:electron`
  - `node_modules` が未配置のため `@types/node` を解決できず実行不可。
- TypeScript transpile smoke
  - 変更した 4 ファイルの transpile 診断は成功。
- Runtime smoke
  - 一時 JS 変換後、skill / custom agent の mtime invalidation と custom agent config 解決を単一プロセスで確認済み。

## docs 影響

- `docs/design/` 更新不要: discovery の外部仕様、UI 表示、provider 契約は変更していない。
- `.ai_context/` 更新不要: 公開仕様やアーキテクチャ境界の変更ではない。
- `README.md` 更新不要: 利用者向け手順や起動方法の変更ではない。
