# ADR 022: WindowsのSession runtime credentialは固定user directoryへ公開する

## Status

Accepted

## Context

Session CLIとMCPは、起動中のWithMateが公開するloopback runtimeへ接続するため、平文の一時credentialをdiscovery fileから取得する。POSIXではownerとpermission bitを検証できるが、Windowsでは同じ検証を適用できない。

任意の`WITHMATE_SESSION_RUNTIME_DIR`をWindowsでも受理すると、共有directoryや別userが制御するdirectoryを選択できる。file作成後にACLを調整する方式では、credentialを書き込んでからACL確定までの間に別principalが内容を読める可能性がある。

## Decision

- WindowsのSession runtime directoryは`%LOCALAPPDATA%\WithMate\session-runtime`に固定し、`WITHMATE_SESSION_RUNTIME_DIR`を受理しない。
- runtime directory、generation file、pointer fileは、current user、SYSTEM、AdministratorsだけにFullControlを許可するprotected DACLとする。
- owner、継承保護、許可principalと権限をSIDで再読検証する。検証できない場合はruntime publicationをfail closedする。
- credential fileは空fileとして作成してACLを確定・検証した後にだけ内容を書き込む。途中失敗時は部分fileを除去する。
- POSIXでは既存のenvironment override、owner検証、`0700` directoryと`0600` fileの契約を維持する。

## Alternatives

### Windowsでも任意directoryを受理してACLだけを設定する

指定先の既存ACL、owner、reparse point、共有運用を上書きする影響が大きく、credential authorityをoperator指定pathへ拡張するため採用しない。

### credentialを書き込んだ後にACLを設定する

ACL確定前の露出windowを作るため採用しない。

### Windowsではdiscovery fileを使わない

CLIとMCPの接続方式がplatformで分岐し、ADR 021のapplication boundaryを複雑にするため採用しない。

## Consequences

- Windowsのruntime credentialはuser-localな固定場所に限定され、別OS userへ読まれる経路をfail closedにできる。
- Windows PowerShellまたは.NET ACL APIを利用できない環境ではSession runtimeを公開できない。WithMate本体の他機能は継続できるが、Session CLIとMCPはruntime unavailableになる。
- Windowsでruntime directoryを移動するenvironment overrideは利用できない。

