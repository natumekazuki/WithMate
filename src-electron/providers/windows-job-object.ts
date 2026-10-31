import koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

type NativeHandle = bigint | null;

type WindowsJobApi = Readonly<{
  createJobObject: (securityAttributes: null, name: null) => NativeHandle;
  setInformationJobObject: (
    jobHandle: Exclude<NativeHandle, null>,
    informationClass: number,
    limits: ReturnType<typeof jobLimits>,
    limitsSize: number,
  ) => number;
  openProcess: (desiredAccess: number, inheritHandle: number, pid: number) => NativeHandle;
  assignProcessToJobObject: (
    jobHandle: Exclude<NativeHandle, null>,
    processHandle: Exclude<NativeHandle, null>,
  ) => number;
  terminateJobObject: (jobHandle: Exclude<NativeHandle, null>, exitCode: number) => number;
  closeHandle: (handle: Exclude<NativeHandle, null>) => number;
  jobLimitsSize: number;
}>;

export type WindowsJobObjectDependencies = Readonly<{
  platform?: NodeJS.Platform;
  api?: WindowsJobApi;
}>;

export interface WindowsJobObject {
  assignProcess(pid: number): void;
  terminate(): void;
  close(): void;
}

export class WindowsJobObjectAcquisitionError extends Error {
  readonly owner: WindowsJobObject;

  constructor(owner: WindowsJobObject, options?: ErrorOptions) {
    super("Windows process ownership was only partially acquired.", options);
    this.name = "WindowsJobObjectAcquisitionError";
    this.owner = owner;
  }
}

export function createWindowsJobObject(dependencies: WindowsJobObjectDependencies = {}): WindowsJobObject {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    throw new Error("Windows process ownership is unavailable.");
  }

  const native = dependencies.api ?? loadWindowsJobApi();
  const jobHandle = native.createJobObject(null, null);
  if (jobHandle === null || jobHandle === 0n) throw new Error("Windows process ownership could not be created.");

  let closed = false;
  const pendingProcessHandles = new Set<Exclude<NativeHandle, null>>();
  const owner: WindowsJobObject = {
    assignProcess(pid) {
      if (closed) throw new Error("Windows process ownership is closed.");
      const processHandle = native.openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid);
      if (processHandle === null || processHandle === 0n) {
        throw new Error("Windows process ownership could not open its process.");
      }
      let assignmentError: Error | undefined;
      if (!native.assignProcessToJobObject(jobHandle, processHandle)) {
        assignmentError = new Error("Windows process ownership could not assign its process.");
      }
      if (!native.closeHandle(processHandle)) {
        pendingProcessHandles.add(processHandle);
        const releaseError = new Error("Windows process handle ownership could not be released.");
        throw assignmentError === undefined
          ? releaseError
          : new AggregateError([assignmentError, releaseError], "Windows process ownership assignment failed.");
      }
      if (assignmentError !== undefined) throw assignmentError;
    },
    terminate() {
      if (closed) return;
      if (!native.terminateJobObject(jobHandle, 1)) {
        throw new Error("Windows process ownership could not terminate its processes.");
      }
    },
    close() {
      if (closed) return;
      for (const processHandle of [...pendingProcessHandles]) {
        if (!native.closeHandle(processHandle)) {
          throw new Error("Windows process handle ownership could not be released.");
        }
        pendingProcessHandles.delete(processHandle);
      }
      if (!native.closeHandle(jobHandle)) throw new Error("Windows process ownership could not be released.");
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

function loadWindowsJobApi(): WindowsJobApi {
  cachedWindowsJobApi ??= createWindowsJobApi();
  return cachedWindowsJobApi;
}

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
  return {
    createJobObject: kernel32.func("CreateJobObjectW", handle, ["void *", "str16"]),
    setInformationJobObject: kernel32.func("SetInformationJobObject", "int", [
      handle,
      "int",
      koffi.pointer(extendedLimits),
      "uint32_t",
    ]),
    openProcess: kernel32.func("OpenProcess", handle, ["uint32_t", "int", "uint32_t"]),
    assignProcessToJobObject: kernel32.func("AssignProcessToJobObject", "int", [handle, handle]),
    terminateJobObject: kernel32.func("TerminateJobObject", "int", [handle, "uint32_t"]),
    closeHandle: kernel32.func("CloseHandle", "int", [handle]),
    jobLimitsSize: koffi.sizeof(extendedLimits),
  };
}

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
