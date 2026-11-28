import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import {
  localPrAgentInput, localPrCiRunSchema, localPrCommitSchema, localPrVersionSchema,
  type LocalPrData, type LocalPrFailure, type LocalPrInput, type LocalPrOperation, type LocalPrResult,
  type LocalPrVersion, type LocalPrCiRun,
} from "../../src-shared/local-pr/local-pr-contract.js";
import { assertRuntimeTurnAdmission, runWithoutRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../platform/agent-runtime/runtime-turn-admission.js";
import { prepareLocalPrCiCheckout, readLocalPrCiDefinition } from "./local-pr-ci-definition.js";
import { runLocalPrCiShell } from "./local-pr-ci-process.js";

/** CI の操作は、GUI と Agent で共通の操作契約に従う。 */
export type LocalPrCiOperation = Extract<LocalPrOperation, `pr_ci_${string}`>;
type Repository = { repositoryId: string; workspacePath: string };
type Options = { userDataPath: string; onChanged?: (repositoryId: string, prId: string) => void };
const recordSchema = z.strictObject({ repositoryId: z.string().min(1), prId: z.uuid(), mergeBaseCommit: localPrCommitSchema, run: localPrCiRunSchema });
type RecordEntry = z.infer<typeof recordSchema>;
type StopReason = "canceled" | "interrupted";
type Active = { controller: AbortController; reason?: StopReason; done: Promise<void> };
const logLimit = 2 * 1024 * 1024;
const pageSize = 16 * 1024;
const truncationNotice = Buffer.from("\n[WithMate CI log limit reached]\n");

/** Main が管理する Local PR CI のライフサイクル。認可と PR・版の解決はディスパッチャーが担う。 */
export class LocalPrCiService {
  private readonly root: string;
  private readonly history: string;
  private readonly work: string;
  private readonly records = new Map<string, RecordEntry>();
  private readonly active = new Map<string, Active>();
  private initialization?: Promise<void>;
  private accepting = true;
  private stopUnconfirmed = false;

  constructor(private readonly options: Options) {
    if (!isAbsolute(options.userDataPath)) throw new Error("CI requires an absolute userData path.");
    this.root = join(options.userDataPath, "local-pr-ci");
    this.history = join(this.root, "runs");
    this.work = join(this.root, "work");
  }

  /** 保存済みの実行中レコードを復旧する。前回のアプリ起動時に保存された PID にはシグナルを送らない。 */
  initialize(): Promise<void> {
    return this.initialization ??= this.loadRecords();
  }

  /** 新規実行を拒否し、実行中の処理を中断し、終了を確認してからアプリの後処理に進む。 */
  async shutdown(): Promise<void> {
    this.accepting = false;
    await this.initialize();
    const current = [...this.active.values()];
    for (const task of current) this.requestStop(task, "interrupted");
    const completed = await Promise.race([
      Promise.allSettled(current.map((task) => task.done)),
      delay(10_000, null, { ref: false }),
    ]);
    if (!completed || this.stopUnconfirmed || completed.some((result) => result.status === "rejected")) {
      throw new Error("Local PR CI shutdown could not confirm or persist every active run's termination.");
    }
  }

  /** 解決済みの版とリポジトリに対して CI 操作を実行する。変更可能な ref は解決しない。 */
  async execute<T extends LocalPrCiOperation>(
    repository: Repository, prId: string, version: LocalPrVersion, operation: T, input: LocalPrInput<T>,
  ): Promise<LocalPrResult<T>> {
    let effect: LocalPrFailure["effect"] = "none";
    const ok = (data: LocalPrData<LocalPrCiOperation>): LocalPrResult<T> => ({ ok: true, data: data as LocalPrData<T> });
    try {
      if (!(typeof operation === "string" && operation.startsWith("pr_ci_") && Object.hasOwn(localPrAgentInput, operation))) {
        return failure("invalid_input", "Unknown CI operation.");
      }
      const parsed = localPrAgentInput[operation].safeParse(input);
      if (!parsed.success || parsed.data.prId !== prId || parsed.data.version !== version.version ||
        !localPrVersionSchema.safeParse(version).success || !repository.repositoryId || !isAbsolute(repository.workspacePath)) {
        return failure("invalid_input", "The CI operation does not match the resolved PR version.");
      }
      await this.initialize();
      if (!this.accepting) return failure("ci_unavailable", "Local PR CI is shutting down.");
      const matches = (entry: RecordEntry) => entry.repositoryId === repository.repositoryId && entry.prId === prId &&
        entry.run.version === version.version && entry.run.headCommit === version.headCommit &&
        entry.run.targetCommit === version.targetCommit && entry.mergeBaseCommit === version.mergeBaseCommit;

      if (operation === "pr_ci_validate") return ok((await readLocalPrCiDefinition(repository.workspacePath, version.headCommit)).definition);
      if (operation === "pr_ci_list") return ok({ runs: [...this.records.values()].filter(matches).map(({ run }) => run)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });

      const runId = "runId" in parsed.data && typeof parsed.data.runId === "string" ? parsed.data.runId : undefined;
      const previous = runId ? this.records.get(runId) : undefined;
      if (runId && (!previous || !matches(previous))) return failure("ci_run_not_found", "CI run not found for this version.");
      if (operation === "pr_ci_log" && previous) {
        const offset = "offset" in parsed.data && typeof parsed.data.offset === "number" ? parsed.data.offset : 0;
        return ok(await this.readLog(previous.run.id, offset));
      }
      if (operation === "pr_ci_cancel" && previous) {
        const task = this.active.get(previous.run.id);
        if (!task || previous.run.state !== "running") return failure("ci_not_running", "This CI run is not running.");
        // 起動時の復旧中に呼び出し元の捕捉済み Turn が終わることがあるため、停止要求の送信前に確認する。
        assertRuntimeTurnAdmission();
        effect = "unknown";
        this.requestStop(task, "canceled");
        if (!await Promise.race([task.done.then(() => true), delay(10_000, false, { ref: false })])) {
          return failure("ci_stop_unconfirmed", "CI process termination has not been confirmed.", effect);
        }
        return ok(this.records.get(previous.run.id)!.run);
      }

      const { definition, commands } = await readLocalPrCiDefinition(repository.workspacePath, version.headCommit);
      if (!commands) return failure(definition.state === "invalid" ? "ci_definition_invalid" : "ci_not_configured", definition.error ?? "No .withmate/ci.yml in this submission.");
      if (!this.accepting) return failure("ci_unavailable", "Local PR CI shut down during this request.");
      if ([...this.records.values()].some((entry) => matches(entry) && entry.run.state === "running")) {
        return failure("ci_already_running", "CI is already running for this PR version.");
      }

      // 並行する要求が同じ組に対して二重に実行を始めないよう、いずれの await よりも前に予約する。
      const record: RecordEntry = { repositoryId: repository.repositoryId, prId, mergeBaseCommit: version.mergeBaseCommit, run: {
        id: randomUUID(), version: version.version, headCommit: version.headCommit, targetCommit: version.targetCommit,
        state: "running", startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null,
      } };
      // Git の読み取り中に捕捉済みの Turn が終わることがある。予約後の CI はアプリが所有するジョブとなる。
      assertRuntimeTurnAdmission();
      effect = "unknown";
      const { saved, run } = runWithoutRuntimeTurnAdmission(() => this.start(record, repository.workspacePath, commands));
      await saved;
      return ok(run);
    } catch (error) {
      if (error instanceof RuntimeTurnInactiveError) throw error;
      return failure("ci_error", errorMessage(error), effect);
    }
  }

  /** 管理ディレクトリを作成し、完全かつスキーマに適合したレコードだけを復旧する。 */
  private async loadRecords(): Promise<void> {
    await directory(this.root);
    await directory(this.history);
    if (process.platform !== "win32") await directory(this.work);
    for (const entry of await readdir(this.history, { withFileTypes: true })) {
      if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
      const path = this.runPath(entry.name, "run.json");
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null; // クラッシュ前に予約が公開されなかった。
        throw error;
      });
      if (!info) continue;
      if (!info.isFile() || info.size > 64 * 1024) throw new Error("Invalid managed CI record file.");
      const record = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (record.run.id !== entry.name) throw new Error("Managed CI record does not match its location.");
      if (record.run.state === "running") {
        record.run = { ...record.run, state: "interrupted", finishedAt: new Date().toISOString(), error: "The application stopped before the CI result was confirmed." };
        await this.save(record);
      }
      this.records.set(record.run.id, record);
    }
  }

  /** Git の準備やリポジトリに対するコマンドの実行より先に、永続化された予約を公開する。 */
  private start(record: RecordEntry, workspacePath: string, commands: string[]): { saved: Promise<void>; run: LocalPrCiRun } {
    const run = record.run;
    const task: Active = { controller: new AbortController(), done: Promise.resolve() };
    this.active.set(run.id, task);
    this.records.set(run.id, record);
    const saved = (async () => {
      await mkdir(join(this.history, run.id), { mode: 0o700 });
      await writeFile(this.runPath(run.id, "output.log"), "", { flag: "wx", mode: 0o600 });
      await this.save(record);
      this.changed(record);
    })();
    task.done = saved.then(() => this.run(record, task, workspacePath, commands), (error) => {
      this.records.delete(run.id);
      throw error;
    }).finally(() => this.active.delete(run.id));
    // この Promise はウィンドウの所有物ではない。最終状態の保存失敗はサービスの状態に反映される。
    void task.done.catch(() => undefined);
    return { saved, run };
  }

  /** ログを閉じ、プロセスの所有状態を確認してから、実行の最終状態を保存する。 */
  private async run(record: RecordEntry, task: Active, workspacePath: string, commands: string[]): Promise<void> {
    const log = createWriteStream(this.runPath(record.run.id, "output.log"), { flags: "a" });
    const flushed = finished(log).then(() => true, () => false);
    let logged = 0;
    let truncated = false;
    const append = (chunk: Buffer) => {
      if (truncated || log.destroyed) return;
      const remaining = logLimit - truncationNotice.length - logged;
      log.write(chunk.subarray(0, remaining));
      logged += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) {
        log.write(truncationNotice);
        truncated = true;
      }
    };

    let state: LocalPrCiRun["state"] = "failed";
    let exitCode: number | null = null;
    let error: string | null = null;
    let stopped = true;
    let work: string | undefined;
    try {
      if (task.reason) {
        state = task.reason;
      } else {
        work = await this.createWorkDirectory(record.run.id);
        const checkout = join(work, "checkout");
        await prepareLocalPrCiCheckout(workspacePath, checkout, record.run.headCommit, task.controller.signal);
        if (task.reason) {
          state = task.reason;
        } else {
          // ネイティブ側での取得や解放が例外を投げた場合は、所有状態を確認できるまでチェックアウトをそのまま残す。
          stopped = false;
          ({ state, exitCode, error, stopped } = await runLocalPrCiShell(work, checkout, commands, {
            signal: task.controller.signal, reason: () => task.reason,
          }, append));
        }
      }
    } catch (cause) {
      state = stopped ? task.reason ?? "failed" : "interrupted";
      error = stopped && task.reason ? null : errorMessage(cause);
    }
    if (error) append(Buffer.from(`\n[WithMate CI] ${error}\n`));
    log.end();
    if (!await flushed) {
      state = "interrupted";
      error = "The CI log could not be saved.";
    }
    if (!stopped) this.stopUnconfirmed = true;
    if (work && stopped) {
      await rm(work, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
    }

    const final = { ...record.run, state, exitCode, error, finishedAt: new Date().toISOString() };
    try {
      await this.save({ ...record, run: final });
      record.run = final;
    } catch (cause) {
      record.run = { ...final, state: "interrupted", error: "The terminal CI result could not be persisted." };
      this.changed(record);
      throw cause;
    }
    this.changed(record);
  }

  /** この実行専用のチェックアウト先を割り当てる。履歴は引き続き userData に保持する。 */
  private async createWorkDirectory(id: string): Promise<string> {
    // core.longpaths が有効でも、Git for Windows は深い userData のパスでオブジェクトを書き込めない場合がある。
    if (process.platform === "win32") return mkdtemp(join(tmpdir(), "withmate-pr-ci-"));
    const work = join(this.work, id);
    await mkdir(work, { mode: 0o700 });
    return work;
  }

  /** シャットダウンは処理待ちのキャンセルを上書きできる。どちらの要求も、それだけで最終結果にはならない。 */
  private requestStop(task: Active, reason: StopReason): void {
    if (!task.reason || reason === "interrupted") task.reason = reason;
    task.controller.abort();
  }

  /** 呼び出し元からファイルシステムのパスを受け取らず、UTF-16 のログを上限付きのページで返す。 */
  private async readLog(id: string, offset: number): Promise<LocalPrData<"pr_ci_log">> {
    const path = this.runPath(id, "output.log");
    const info = await lstat(path);
    if (!info.isFile() || info.size > logLimit) throw new Error("Invalid managed CI log file.");
    const content = await readFile(path, "utf8");
    let end = Math.min(offset + pageSize, content.length);
    if (end < content.length && /[\uDC00-\uDFFF]/u.test(content.charAt(end))) end--;
    return { log: content.slice(offset, end), nextOffset: Math.max(offset, end), hasMore: end < content.length };
  }

  /** 実行レコードはアトミックに置き換え、書き込み途中の JSON ファイルで上書きしない。 */
  private async save(record: RecordEntry): Promise<void> {
    const path = this.runPath(record.run.id, "run.json");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** 実行ディレクトリには、サービスが生成したか、検証済みのレコード ID だけを使う。 */
  private runPath(id: string, name: "run.json" | "output.log"): string {
    return join(this.history, id, name);
  }

  /** イベントの配送はベストエフォートであり、永続化された結果は変わらない。 */
  private changed(record: RecordEntry): void {
    try { this.options.onChanged?.(record.repositoryId, record.prId); } catch { /* ウィンドウの切断は CI の失敗ではない。 */ }
  }
}

/** 既存の通常ディレクトリだけを管理対象の CI ルートとして再利用できる。 */
async function directory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(path)).isDirectory()) throw new Error("Invalid managed CI directory.");
}

/** 境界での失敗を共通の Local PR の結果に変換する。 */
function failure(code: string, message: string, effect: LocalPrFailure["effect"] = "none"): LocalPrFailure {
  return { ok: false, code, message, effect };
}

/** 生のスタックトレースは公開せず、理由を保持する。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Local PR CI failed.";
}
