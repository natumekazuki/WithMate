import koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

/** Win32 API から受け取るネイティブハンドル。取得できなかった場合の null も表す。 */
type NativeHandle = bigint | null;

/** Job の作成・設定、プロセスの割り当て・照会・停止、およびハンドル解放に使うネイティブ境界。 */
type WindowsJobApi = Readonly<{
  createJobObject: (securityAttributes: null, name: null) => NativeHandle;
  setInformationJobObject: (
    jobHandle: Exclude<NativeHandle, null>,
    informationClass: number,
    limits: ReturnType<typeof jobLimits>,
    limitsSize: number,
  ) => number;
  openProcess: (
    desiredAccess: number,
    inheritHandle: number,
    pid: number,
  ) => NativeHandle;
  assignProcessToJobObject: (
    jobHandle: Exclude<NativeHandle, null>,
    processHandle: Exclude<NativeHandle, null>,
  ) => number;
  terminateJobObject: (
    jobHandle: Exclude<NativeHandle, null>,
    exitCode: number,
  ) => number;
  countActiveProcesses: (jobHandle: Exclude<NativeHandle, null>) => number;
  closeHandle: (handle: Exclude<NativeHandle, null>) => number;
  jobLimitsSize: number;
}>;

/** Windows 判定と Job Object のネイティブ操作を置き換えて検証できるようにする依存。 */
export type WindowsJobObjectDependencies = Readonly<{
  platform?: NodeJS.Platform;
  api?: WindowsJobApi;
}>;

/** プロセスを Windows の Job Object に所属させ、その実行範囲とハンドルを管理する契約。 */
export interface WindowsJobObject {
  /** 指定 PID を Job に登録する。必要な一時プロセスハンドルはこの境界で管理する。 */
  assignProcess(pid: number): void;
  /** 所有範囲に属するプロセスの停止を OS に要求する。 */
  terminate(): void;
  /** 保留のプロセスハンドルと Job 自体を解放する。解放済みなら何もしない。 */
  close(): void;
  /** Job にまだアクティブなプロセスがあるかを照会する。 */
  hasProcesses(): boolean;
}

/** Job の作成はできたが設定に失敗し、保持したハンドルの後片付けが必要であることを表す。 */
export class WindowsJobObjectAcquisitionError extends Error {
  readonly owner: WindowsJobObject;

  /** 途中まで取得した Job の所有者と設定失敗の原因を保持する。 */
  constructor(owner: WindowsJobObject, options?: ErrorOptions) {
    super("Windows process ownership was only partially acquired.", options);
    this.name = "WindowsJobObjectAcquisitionError";
    this.owner = owner;
  }
}

/** Windows に限り無名の Job を作成し、最後のハンドルが閉じた際に所属プロセスを停止する設定を適用する。 */
export function createWindowsJobObject(
  dependencies: WindowsJobObjectDependencies = {},
): WindowsJobObject {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("Windows process ownership is unavailable.");
  }

  const native = dependencies.api ?? loadWindowsJobApi();
  const jobHandle = native.createJobObject(null, null);
  if (jobHandle === null || jobHandle === 0n)
    throw new Error("Windows process ownership could not be created.");

  let closed = false;
  const pendingProcessHandles = new Set<Exclude<NativeHandle, null>>();
  const owner: WindowsJobObject = {
    /** 必要なアクセスで対象プロセスを開いて Job に割り当てる。一時ハンドルの解放に失敗した場合は後片付け用に残す。 */
    assignProcess(pid) {
      if (closed) throw new Error("Windows process ownership is closed.");
      const processHandle = native.openProcess(
        PROCESS_TERMINATE | PROCESS_SET_QUOTA,
        0,
        pid,
      );
      if (processHandle === null || processHandle === 0n) {
        throw new Error(
          "Windows process ownership could not open its process.",
        );
      }
      let assignmentError: Error | undefined;
      if (!native.assignProcessToJobObject(jobHandle, processHandle)) {
        assignmentError = new Error(
          "Windows process ownership could not assign its process.",
        );
      }
      if (!native.closeHandle(processHandle)) {
        pendingProcessHandles.add(processHandle);
        const releaseError = new Error(
          "Windows process handle ownership could not be released.",
        );
        throw assignmentError === undefined
          ? releaseError
          : new AggregateError(
              [assignmentError, releaseError],
              "Windows process ownership assignment failed.",
            );
      }
      if (assignmentError !== undefined) throw assignmentError;
    },
    /** 開いている Job の全プロセスに終了を要求し、OS が拒否した場合は失敗を伝える。 */
    terminate() {
      if (closed) return;
      if (!native.terminateJobObject(jobHandle, 1)) {
        throw new Error(
          "Windows process ownership could not terminate its processes.",
        );
      }
    },
    /** 開いている Job のアクティブプロセスを照会する。閉じた Job からは確認できない。 */
    hasProcesses() {
      if (closed) throw new Error("Windows process ownership is closed.");
      return native.countActiveProcesses(jobHandle) > 0;
    },
    /** 解放できていないプロセスハンドルを先に閉じ、最後に Job を閉じる。失敗した場合は所有状態を保持する。 */
    close() {
      if (closed) return;
      for (const processHandle of [...pendingProcessHandles]) {
        if (!native.closeHandle(processHandle)) {
          throw new Error(
            "Windows process handle ownership could not be released.",
          );
        }
        pendingProcessHandles.delete(processHandle);
      }
      if (!native.closeHandle(jobHandle))
        throw new Error("Windows process ownership could not be released.");
      closed = true;
    },
  };

  try {
    if (
      !native.setInformationJobObject(
        jobHandle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        jobLimits(),
        native.jobLimitsSize,
      )
    ) {
      throw new Error("Windows process ownership could not be configured.");
    }
  } catch (error) {
    throw new WindowsJobObjectAcquisitionError(owner, { cause: error });
  }

  return owner;
}

let cachedWindowsJobApi: WindowsJobApi | undefined;

/** 最初の Windows 呼び出しで FFI 境界を作り、以降の Job で共有する。 */
function loadWindowsJobApi(): WindowsJobApi {
  cachedWindowsJobApi ??= createWindowsJobApi();
  return cachedWindowsJobApi;
}

/** kernel32 の Job とプロセス制御関数、対応するハンドルおよび情報構造体を束ねる。 */
function createWindowsJobApi() {
  const kernel32 = koffi.load("kernel32.dll");
  const handle = koffi.pointer("WithMateWindowsHandle", koffi.opaque());
  const ioCounters = koffi.struct("WithMateWindowsIoCounters", {
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  const basicLimits = koffi.struct("WithMateWindowsBasicJobLimits", {
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  const extendedLimits = koffi.struct("WithMateWindowsExtendedJobLimits", {
    BasicLimitInformation: basicLimits,
    IoInfo: ioCounters,
    ProcessMemoryLimit: "uintptr_t",
    JobMemoryLimit: "uintptr_t",
    PeakProcessMemoryUsed: "uintptr_t",
    PeakJobMemoryUsed: "uintptr_t",
  });
  const accounting = koffi.struct("WithMateWindowsJobAccounting", {
    TotalUserTime: "int64_t",
    TotalKernelTime: "int64_t",
    ThisPeriodTotalUserTime: "int64_t",
    ThisPeriodTotalKernelTime: "int64_t",
    TotalPageFaultCount: "uint32_t",
    TotalProcesses: "uint32_t",
    ActiveProcesses: "uint32_t",
    TotalTerminatedProcesses: "uint32_t",
  });
  const query = kernel32.func("QueryInformationJobObject", "int", [
    handle,
    "int",
    koffi.out(koffi.pointer(accounting)),
    "uint32_t",
    "void *",
  ]);
  return {
    createJobObject: kernel32.func("CreateJobObjectW", handle, [
      "void *",
      "str16",
    ]),
    setInformationJobObject: kernel32.func("SetInformationJobObject", "int", [
      handle,
      "int",
      koffi.pointer(extendedLimits),
      "uint32_t",
    ]),
    openProcess: kernel32.func("OpenProcess", handle, [
      "uint32_t",
      "int",
      "uint32_t",
    ]),
    assignProcessToJobObject: kernel32.func("AssignProcessToJobObject", "int", [
      handle,
      handle,
    ]),
    terminateJobObject: kernel32.func("TerminateJobObject", "int", [
      handle,
      "uint32_t",
    ]),
    /** Job の基本会計情報からアクティブプロセス数を取得する。照会失敗をゼロ件と区別する。 */
    countActiveProcesses(jobHandle: Exclude<NativeHandle, null>) {
      const info = { ActiveProcesses: 0 };
      if (
        !query(
          jobHandle,
          JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS,
          info,
          koffi.sizeof(accounting),
          null,
        )
      ) {
        throw new Error(
          "Windows process ownership could not query its processes.",
        );
      }
      return info.ActiveProcesses;
    },
    closeHandle: kernel32.func("CloseHandle", "int", [handle]),
    jobLimitsSize: koffi.sizeof(extendedLimits),
  };
}

/** ハンドルを閉じた際のプロセス停止だけを有効にし、追加の時間・容量上限は設定しない。 */
function jobLimits() {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };
}
