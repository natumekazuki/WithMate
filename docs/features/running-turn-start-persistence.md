# running turn開始時の永続化

## 概要

prompt送信時は、providerを起動する前にuser messageとrunning状態を永続化します。通常のMain／AuxiliaryとCharacter authoringでは、同じ開始処理で使用するCharacter snapshotも確定します。

## 開始transaction

開始処理は、対象Sessionに対して次の値を一つのtransactionで保存します。

- 追加するuser message
- running状態とturn metadata
- 当該turnで使用するCharacter snapshot
- Sessionの更新日時など開始に伴うmetadata

保存が完了する前にprovider実行を開始しません。

## incremental保存

開始処理は追加messageと状態差分を保存します。databaseに存在する全messageを読み直し、同じ内容を全件書き戻す方式は使用しません。

v2、v3、v6のstorage adapterは同じapplication serviceの入力を受け取り、それぞれのschemaに合わせてtransactionを実行します。

## Character snapshot

Character authoringを開始する場合は、開始時点の最新snapshotを保存します。以前のturnで使用したsnapshotや、validation前に残った一時値を再利用しません。

通常のMain／Auxiliaryでは、送信開始時にactive Characterのcanonical定義を前回snapshotと比較し、変更があれば有効な定義部分だけを更新して保存します。archived Characterでは保存済みsnapshotを使います。owner、表示metadata、会話履歴、provider threadを維持する境界と失敗条件は[Character Storage](../design/character-storage.md#runtime-snapshot)に従います。

validationまたは保存に失敗した場合は、開始transaction全体を失敗させます。user messageだけ、running状態だけ、またはsnapshot clearだけが先に確定する状態を作りません。

## 失敗時の扱い

- 永続化失敗時はproviderを起動しません。
- errorを呼び出し元へ返し、送信成功として表示しません。
- retry時は、既に保存済みかどうかをSessionのcurrent stateから判定します。
- 別Sessionの保存処理へ対象Sessionの差分を混在させません。

## 関連文書

- [Electron Session Store](../design/electron-session-store.md)
- [長いSessionの性能改善](long-session-performance.md)
