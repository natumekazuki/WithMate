# Repository Glossary

## 概要

Repository Glossaryは、Git checkoutごとの用語集をSessionから参照する機能です。用語集の正本はcheckout rootの`.withmate/glossary.yaml`であり、WithMateのdatabaseやSession messageを正本にはしません。

## Sessionでの表示

Session Windowの右ペインに`Glossary`タブを表示します。用語集が有効な場合は、次の操作を利用できます。

- 用語、別名、定義の一覧表示
- 用語と定義を対象にした検索
- 検索結果の追加読み込み
- 一つの用語を選択した詳細表示
- message内の登録語から該当する定義への移動

用語集ファイルがない`missing`、有効だが0件の`valid`、primary workspaceが非Gitの`not-applicable`は正常状態として、paneの状態labelや説明本文を空にします。pane shellと必要な操作・accessibilityは維持します。`invalid`、`unsupported`、`watch-error`は実失敗として原因を表示します。非Gitの`not-applicable`はrenderer projection専用のtyped stateであり、Glossary operationのerror codeは従来どおり`GLOSSARY_TARGET_INVALID`を使います。Glossaryが利用できないことを理由にchat実行は停止しません。

## 更新と監視

WithMateは`.withmate/glossary.yaml`の更新を監視し、同じcheckoutを使用しているSessionへ新しいprojectionを配信します。監視開始に失敗した場合は、後続の参照時に再試行します。

検索結果とmessage annotationには用語集のrevisionを付けます。検索中に用語集が更新された場合、古いrevisionの結果を現在の一覧へ混在させません。

## coding agentからの操作

Repository Glossaryにはmanaged Skill、CLI、MCPを用意しています。Sessionから起動されたcoding agentの操作は、起動元Session、checkout、turnへ束縛されます。

自発的な用語追加を許可する場合はSettingsで有効化し、1 turnあたりの追加上限を設定します。上限を超える操作や、別Session、別checkout、終了済みturnからの操作は拒否します。

## 境界と制約

- 用語集はGit checkout単位で解決します。任意の親directoryや別repositoryの用語集へ自動fallbackしません。
- annotationは通常の文章を対象にし、code、数式、link labelなど誤注釈になりやすい範囲を除外します。
- file更新は既存revisionを前提に行い、並行更新を無条件で上書きしません。
- schema不正や競合が発生した場合、成功したように表示しません。

## 関連文書

- [Repository Glossary Runbook](../runbooks/repository-glossary.md)
- [ADR 022: Repository Glossary Boundary](../adr/022-repository-glossary-boundary.md)
