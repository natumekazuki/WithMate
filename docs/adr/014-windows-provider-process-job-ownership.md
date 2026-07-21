# ADR 014: Windows Provider process treeのJob Object所有

- Status: Accepted
- Date: 2026-07-21
- Refines: ADR 013のProvider child process ownership

## Context

ADR 013は、runtime hostだけが`codex app-server` child processとProvider connectionを所有することを要求する。Windowsでroot PIDから現在の親子関係を走査してprocess treeを終了する方式には、次の安全性問題がある。

- 中間launcherが先に終了すると、残ったdescendantへroot PIDから到達できない。
- root process終了後にPIDが再利用されると、無関係なprocessを所有対象と誤認し得る。
- `taskkill /T`や`Win32_Process.ParentProcessId`による終了時点の再探索では、spawn時点からの所有権を保持できない。

一方、Node.jsの通常の`spawn`後にchildをJob Objectへ割り当てるだけでは、割当完了前にchildがdescendantを起動または終了する競合を閉じられない。

## Decision

WindowsのCodex App Server transportは、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`を設定したunnamed Job Objectをruntime host内で作成し、そのnative handleをtransportのprocess ownerとする。

transportは、Codexを直接spawnせず、起動指示を待つtrusted Node supervisorを最初にspawnする。supervisorをJob Objectへ割り当てた後にだけIPCで起動設定を渡し、supervisorがCodexを同じstdioへ接続して起動する。Jobからのbreakawayは許可しないため、Codexが起動するCLI wrapperやdescendantも同じJobへ所属する。

graceful close、forced close、unexpected exit、startup failureのいずれでも、transportはPIDや現在の親子関係を再探索しない。Job Objectを終了し、supervisorのexitをboundedに待機してからhandleを解放する。handle解放時にも残存processを終了する。POSIXでは既存のprocess group所有を維持する。

Job Object APIはruntime dependencyのKoffiを通じて呼び出す。native errorやPIDなどの詳細はpublic failureへ投影せず、既存のbounded connection failureへ変換する。

## Alternatives

- `taskkill /T`と`Win32_Process`のPID走査を併用する: 消滅した中間processとPID再利用を安全に扱えないため採用しない。
- Codexを直接spawnしてからJob Objectへ割り当てる: 割当前にdescendantがJob外へ出る競合が残るため採用しない。
- 専用native executableを同梱してsuspended processを作成する: 所有権は表現できるが、追加artifactのbuild、署名、配布を初期transportへ導入する必要があるため採用しない。
- Codex managed daemonへ所有を委譲する: ADR 013で初期control planeの選択肢から除外しており、WithMate runtime hostのprocess ownershipを満たさないため採用しない。

## Consequences

- 中間launcherのlifetimeやPID再利用に依存せず、runtime hostが起動したprocessだけを終了できる。
- WindowsではCodexごとにsupervisor processとJob Object handleを1つ所有する。
- 配布物は対象platformのKoffi native packageを含める必要がある。packaging検証ではKoffiのloadとJob Object作成を確認する。
- Job Object作成、supervisor spawn、Job割当、起動指示の各failureでは、作成済みprocessとhandleを同じtransport ownerが回収する。

## Related decisions and evidence

- `docs/adr/013-runtime-host-and-run-mutation-control-plane.md`
- `src/main/providers/codex/owned-process.ts`
- `src/main/providers/codex/windows-job-object.ts`
- `test/codex-app-server-transport.test.ts`
- [Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft: AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
