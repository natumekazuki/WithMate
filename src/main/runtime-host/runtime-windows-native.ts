import koffi from "koffi";

const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_IO_PENDING = 997;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_BROKEN_PIPE = 109;
const ERROR_NO_DATA = 232;
const ERROR_PIPE_NOT_CONNECTED = 233;
const ERROR_OPERATION_ABORTED = 995;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PIPE_BUSY = 231;
const ERROR_SEM_TIMEOUT = 121;
const ERROR_NOT_FOUND = 1168;
const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x00000080;
const WAIT_TIMEOUT = 0x00000102;
const WAIT_FAILED = 0xffffffff;
const INFINITE = 0xffffffff;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const SECURITY_IDENTIFICATION = 0x00010000;
const SECURITY_SQOS_PRESENT = 0x00100000;
export const WINDOWS_PIPE_CLIENT_SECURITY_QOS = SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;
const PIPE_ACCESS_DUPLEX = 0x00000003;
const PIPE_TYPE_BYTE = 0x00000000;
const PIPE_READMODE_BYTE = 0x00000000;
const PIPE_WAIT = 0x00000000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
const PIPE_UNLIMITED_INSTANCES = 255;
const SDDL_REVISION_1 = 1;
const SE_KERNEL_OBJECT = 6;
const OWNER_SECURITY_INFORMATION = 0x00000001;
const DACL_SECURITY_INFORMATION = 0x00000004;
const OWNER_AND_DACL_SECURITY_INFORMATION = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
const MAX_PIPE_CHUNK_BYTES = 64 * 1024;
const WINDOWS_SDDL_WELL_KNOWN_SIDS = new Map([
  ["SY", "S-1-5-18"],
  ["LS", "S-1-5-19"],
  ["NS", "S-1-5-20"],
]);

type NativeHandle = bigint | null;

export type WindowsSecureMutexResult =
  | Readonly<{
      status: "acquired";
      daclSddl: string;
      release(): void;
    }>
  | Readonly<{
      status: "busy";
      daclSddl: string;
    }>;

export type WindowsPipeConnection = Readonly<{
  peerPrincipalId: string;
  endpointSecurity: Readonly<{ daclSddl: string }>;
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}>;

export type WindowsPipeListener = Readonly<{
  accept(signal?: AbortSignal): Promise<WindowsPipeConnection>;
  close(): Promise<void>;
}>;

export class RuntimeEndpointUnavailableError extends Error {
  constructor(readonly reason: "absent" | "busy" | "timeout" | "closed") {
    super("Runtime endpoint is unavailable.");
    this.name = "RuntimeEndpointUnavailableError";
  }
}

export function getCurrentWindowsPrincipalSid(): string {
  assertWindows();
  const native = loadWindowsNativeApi();
  return readProcessTokenSid(native.getCurrentProcess());
}

export function isWindowsReparsePoint(targetPath: string): boolean {
  assertWindows();
  const native = loadWindowsNativeApi();
  const attributes = native.getFileAttributes(targetPath) as number;
  if (attributes === INVALID_FILE_ATTRIBUTES) {
    throw windowsFailure("Runtime application directory attributes could not be read.", native.getLastError());
  }
  return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
}

export function acquireSecureWindowsMutex(name: string, principalSid: string): WindowsSecureMutexResult {
  assertWindows();
  const native = loadWindowsNativeApi();
  return withSecureAttributes(principalSid, (securityAttributes) => {
    const handle = native.createMutex(securityAttributes, false, name) as NativeHandle;
    if (isInvalidHandle(handle)) {
      throw windowsFailure("Runtime owner claim could not be opened.", native.getLastError());
    }
    let acquired = false;
    try {
      const daclSddl = inspectSecureKernelObjectSecurity(handle, principalSid);
      const wait = native.waitForSingleObject(handle, 0) as number;
      if (wait === WAIT_TIMEOUT) {
        native.closeHandle(handle);
        return { status: "busy", daclSddl };
      }
      if (wait !== WAIT_OBJECT_0 && wait !== WAIT_ABANDONED) {
        throw windowsFailure("Runtime owner claim could not be acquired.", native.getLastError());
      }
      acquired = true;
      let released = false;
      return {
        status: "acquired",
        daclSddl,
        release() {
          if (released) return;
          released = true;
          if (!native.releaseMutex(handle)) {
            native.closeHandle(handle);
            throw windowsFailure("Runtime owner claim could not be released.", native.getLastError());
          }
          native.closeHandle(handle);
        },
      };
    } catch (error) {
      if (acquired) native.releaseMutex(handle);
      native.closeHandle(handle);
      throw error;
    }
  });
}

export function createSecureWindowsPipeListener(
  pipeName: string,
  principalSid: string,
  maximumInstances: number,
): WindowsPipeListener {
  assertWindows();
  if (!Number.isInteger(maximumInstances) || maximumInstances < 1 || maximumInstances > PIPE_UNLIMITED_INSTANCES) {
    throw new RangeError("Runtime named pipe instance limit is invalid.");
  }
  const native = loadWindowsNativeApi();
  let closed = false;
  type PipeInstance = {
    handle: NativeHandle;
    daclSddl: string;
    owner: "listener" | "connection" | "closed";
  };
  const pendingInstances = new Set<PipeInstance>();
  const acceptOperations = new Set<Promise<WindowsPipeConnection>>();
  const connections = new Set<ReturnType<typeof createWindowsPipeConnection>>();
  const capacityWaiters: Array<{
    resolve(): void;
    reject(error: unknown): void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  const settleCapacityWaiters = () => {
    if (closed) {
      for (const waiter of capacityWaiters.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
        waiter.reject(new RuntimeEndpointUnavailableError("closed"));
      }
      return;
    }
    if (connections.size + pendingInstances.size >= maximumInstances) return;
    const waiter = capacityWaiters.shift();
    if (waiter === undefined) return;
    waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
    waiter.resolve();
  };
  const waitForCapacity = async (signal?: AbortSignal) => {
    while (connections.size + pendingInstances.size >= maximumInstances) {
      throwIfAborted(signal);
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject, ...(signal === undefined ? {} : { signal }) } as {
          resolve(): void;
          reject(error: unknown): void;
          signal?: AbortSignal;
          onAbort?: () => void;
        };
        const onAbort = () => {
          const index = capacityWaiters.indexOf(waiter);
          if (index >= 0) capacityWaiters.splice(index, 1);
          reject(abortFailure());
        };
        waiter.onAbort = onAbort;
        capacityWaiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  };
  const closeInstance = (instance: PipeInstance) => {
    if (instance.owner !== "listener") return;
    instance.owner = "closed";
    pendingInstances.delete(instance);
    native.cancelIoEx(instance.handle, null);
    native.disconnectNamedPipe(instance.handle);
    native.closeHandle(instance.handle);
    settleCapacityWaiters();
  };
  const createInstance = () =>
    withSecureAttributes(principalSid, (securityAttributes) => {
      const handle = native.createNamedPipe(
        pipeName,
        PIPE_ACCESS_DUPLEX |
          FILE_FLAG_OVERLAPPED |
          (connections.size === 0 && pendingInstances.size === 0 ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        maximumInstances,
        MAX_PIPE_CHUNK_BYTES,
        MAX_PIPE_CHUNK_BYTES,
        0,
        securityAttributes,
      ) as NativeHandle;
      if (isInvalidHandle(handle)) {
        throw windowsFailure("Runtime named pipe could not be created.", native.getLastError());
      }
      try {
        const created: PipeInstance = {
          handle,
          daclSddl: inspectSecureKernelObjectSecurity(handle, principalSid),
          owner: "listener",
        };
        pendingInstances.add(created);
        return created;
      } catch (error) {
        native.closeHandle(handle);
        throw error;
      }
    });
  let waitingInstance: ReturnType<typeof createInstance> | undefined = createInstance();
  const acceptOne = async (signal?: AbortSignal): Promise<WindowsPipeConnection> => {
    while (true) {
      throwIfAborted(signal);
      if (closed) throw new RuntimeEndpointUnavailableError("closed");
      if (waitingInstance === undefined) {
        await waitForCapacity(signal);
        throwIfAborted(signal);
      }
      if (closed) throw new RuntimeEndpointUnavailableError("closed");
      const created = waitingInstance ?? createInstance();
      waitingInstance = undefined;
      try {
        const connectionState = await connectNamedPipe(native, created.handle, signal);
        if (connectionState === "client_disconnected") {
          closeInstance(created);
          continue;
        }
        if (closed) throw new RuntimeEndpointUnavailableError("closed");
        const peerPrincipalId = readImpersonatedNamedPipeClientSid(created.handle);
        if (peerPrincipalId !== principalSid) {
          throw new Error("Runtime named pipe client principal is not authorized.");
        }
        const connection = createWindowsPipeConnection(created.handle, peerPrincipalId, created.daclSddl, true, () => {
          connections.delete(connection);
          settleCapacityWaiters();
        });
        created.owner = "connection";
        pendingInstances.delete(created);
        connections.add(connection);
        return connection;
      } catch (error) {
        closeInstance(created);
        throw error;
      }
    }
  };

  return {
    accept(signal) {
      const operation = acceptOne(signal);
      acceptOperations.add(operation);
      const remove = () => acceptOperations.delete(operation);
      operation.then(remove, remove);
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      settleCapacityWaiters();
      for (const instance of pendingInstances) closeInstance(instance);
      await Promise.all([...connections].map((connection) => connection.close()));
      await Promise.allSettled([...acceptOperations]);
    },
  };
}

export async function connectSecureWindowsPipe(
  pipeName: string,
  principalSid: string,
  options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
): Promise<WindowsPipeConnection> {
  assertWindows();
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("Runtime named pipe connection timeout is invalid.");
  }
  const native = loadWindowsNativeApi();
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    throwIfAborted(options.signal);
    const handle = native.createFile(
      pipeName,
      GENERIC_READ | GENERIC_WRITE,
      0,
      null,
      OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | WINDOWS_PIPE_CLIENT_SECURITY_QOS,
      null,
    ) as NativeHandle;
    if (!isInvalidHandle(handle)) {
      try {
        const daclSddl = inspectSecureKernelObjectSecurity(handle, principalSid);
        const peerPrincipalId = principalSid;
        return createWindowsPipeConnection(handle, peerPrincipalId, daclSddl, false, () => undefined);
      } catch (error) {
        native.closeHandle(handle);
        throw error;
      }
    }

    const errorCode = native.getLastError() as number;
    if (errorCode === ERROR_FILE_NOT_FOUND) throw new RuntimeEndpointUnavailableError("absent");
    if (errorCode !== ERROR_PIPE_BUSY) {
      throw windowsFailure("Runtime named pipe could not be opened.", errorCode);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RuntimeEndpointUnavailableError("timeout");
    const waitDuration = Math.min(remaining, 100);
    const available = await waitNamedPipe(native, pipeName, waitDuration);
    if (!available) {
      const waitError = native.getLastError() as number;
      if (waitError !== ERROR_SEM_TIMEOUT && waitError !== ERROR_FILE_NOT_FOUND) {
        throw windowsFailure("Runtime named pipe availability could not be checked.", waitError);
      }
    }
  }
}

function createWindowsPipeConnection(
  handle: NativeHandle,
  peerPrincipalId: string,
  daclSddl: string,
  serverSide: boolean,
  onClose: () => void,
) {
  const native = loadWindowsNativeApi();
  let closed = false;
  let reading = false;
  let writing = false;

  return {
    peerPrincipalId,
    endpointSecurity: { daclSddl },
    async read(signal?: AbortSignal): Promise<Uint8Array | null> {
      if (closed) return null;
      if (reading) throw new Error("Concurrent runtime named pipe reads are not allowed.");
      reading = true;
      try {
        const buffer = Buffer.allocUnsafe(MAX_PIPE_CHUNK_BYTES);
        const bytesRead = await runOverlappedIo(
          native,
          handle,
          (overlapped) => native.readFile(handle, buffer, buffer.byteLength, null, overlapped),
          signal,
          true,
        );
        if (bytesRead === null || bytesRead === 0) return null;
        return Uint8Array.from(buffer.subarray(0, bytesRead));
      } finally {
        reading = false;
      }
    },
    async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
      if (closed) throw new RuntimeEndpointUnavailableError("closed");
      if (writing) throw new Error("Concurrent runtime named pipe writes are not allowed.");
      writing = true;
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
          const written = await runOverlappedIo(
            native,
            handle,
            (overlapped) => native.writeFile(handle, chunk, chunk.byteLength, null, overlapped),
            signal,
            false,
          );
          if (written === null || written < 1) {
            throw new RuntimeEndpointUnavailableError("closed");
          }
          offset += written;
        }
      } finally {
        writing = false;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      native.cancelIoEx(handle, null);
      if (serverSide) native.disconnectNamedPipe(handle);
      native.closeHandle(handle);
      onClose();
    },
  };
}

async function connectNamedPipe(
  native: ReturnType<typeof createWindowsNativeApi>,
  handle: NativeHandle,
  signal?: AbortSignal,
): Promise<"connected" | "client_disconnected"> {
  const operation = createOverlapped(native);
  try {
    const connected = native.connectNamedPipe(handle, operation.buffer);
    if (connected) return "connected";
    const errorCode = native.getLastError() as number;
    if (errorCode === ERROR_PIPE_CONNECTED) return "connected";
    if (isPipeEofError(errorCode)) return "client_disconnected";
    if (errorCode !== ERROR_IO_PENDING) {
      throw windowsFailure("Runtime named pipe could not accept a client.", errorCode);
    }
    const result = await waitForOverlapped(native, handle, operation, signal, true);
    return result === null ? "client_disconnected" : "connected";
  } finally {
    native.closeHandle(operation.event);
  }
}

async function runOverlappedIo(
  native: ReturnType<typeof createWindowsNativeApi>,
  handle: NativeHandle,
  start: (overlapped: Buffer) => unknown,
  signal: AbortSignal | undefined,
  eofAllowed: boolean,
): Promise<number | null> {
  throwIfAborted(signal);
  const operation = createOverlapped(native);
  try {
    const started = start(operation.buffer);
    if (!started) {
      const errorCode = native.getLastError() as number;
      if (eofAllowed && isPipeEofError(errorCode)) return null;
      if (errorCode !== ERROR_IO_PENDING) {
        throw windowsFailure("Runtime named pipe I/O could not be started.", errorCode);
      }
      return await waitForOverlapped(native, handle, operation, signal, eofAllowed);
    }
    const transferred = [0];
    if (!native.getOverlappedResult(handle, operation.buffer, transferred, false)) {
      const errorCode = native.getLastError() as number;
      if (eofAllowed && isPipeEofError(errorCode)) return null;
      throw windowsFailure("Runtime named pipe I/O result is unavailable.", errorCode);
    }
    return transferred[0] as number;
  } finally {
    native.closeHandle(operation.event);
  }
}

async function waitForOverlapped(
  native: ReturnType<typeof createWindowsNativeApi>,
  handle: NativeHandle,
  operation: Readonly<{ event: NativeHandle; buffer: Buffer }>,
  signal?: AbortSignal,
  eofAllowed = false,
): Promise<number | null> {
  const onAbort = () => {
    native.cancelIoEx(handle, operation.buffer);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const wait = await waitForSingleObject(native, operation.event);
    if (wait !== WAIT_OBJECT_0) {
      throw windowsFailure("Runtime named pipe I/O wait failed.", wait);
    }
    const transferred = [0];
    if (!native.getOverlappedResult(handle, operation.buffer, transferred, false)) {
      const errorCode = native.getLastError() as number;
      if (errorCode === ERROR_OPERATION_ABORTED) throw abortFailure();
      if (eofAllowed && isPipeEofError(errorCode)) return null;
      throw windowsFailure("Runtime named pipe I/O failed.", errorCode);
    }
    throwIfAborted(signal);
    return transferred[0] as number;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function isPipeEofError(errorCode: number): boolean {
  return errorCode === ERROR_BROKEN_PIPE || errorCode === ERROR_NO_DATA || errorCode === ERROR_PIPE_NOT_CONNECTED;
}

function createOverlapped(native: ReturnType<typeof createWindowsNativeApi>) {
  const event = native.createEvent(null, true, false, null) as NativeHandle;
  if (isInvalidHandle(event)) {
    throw windowsFailure("Runtime named pipe I/O event could not be created.", native.getLastError());
  }
  const buffer = Buffer.alloc(native.overlappedSize);
  koffi.encode(buffer, native.overlappedType, {
    Internal: 0,
    InternalHigh: 0,
    Offset: 0,
    OffsetHigh: 0,
    hEvent: event,
  });
  return { event, buffer };
}

function waitForSingleObject(native: ReturnType<typeof createWindowsNativeApi>, handle: NativeHandle): Promise<number> {
  return new Promise((resolve, reject) => {
    native.waitForSingleObject.async(handle, INFINITE, (error: unknown, result: number) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      if (result === WAIT_FAILED) {
        reject(windowsFailure("Runtime native wait failed.", native.getLastError()));
        return;
      }
      resolve(result);
    });
  });
}

function waitNamedPipe(
  native: ReturnType<typeof createWindowsNativeApi>,
  pipeName: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    native.waitNamedPipe.async(pipeName, timeoutMs, (error: unknown, result: boolean) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function readImpersonatedNamedPipeClientSid(handle: NativeHandle): string {
  const native = loadWindowsNativeApi();
  if (!native.impersonateNamedPipeClient(handle)) {
    throw windowsFailure("Runtime named pipe client could not be impersonated.", native.getLastError());
  }
  try {
    const token = [null] as [NativeHandle];
    if (!native.openThreadToken(native.getCurrentThread(), TOKEN_QUERY, true, token) || isInvalidHandle(token[0])) {
      throw windowsFailure("Runtime named pipe client token could not be opened.", native.getLastError());
    }
    try {
      return readTokenSid(token[0]);
    } finally {
      native.closeHandle(token[0]);
    }
  } finally {
    if (!native.revertToSelf()) {
      throw windowsFailure("Runtime named pipe client impersonation could not be reverted.", native.getLastError());
    }
  }
}

function readProcessTokenSid(processHandle: NativeHandle): string {
  const native = loadWindowsNativeApi();
  const token = [null] as [NativeHandle];
  if (!native.openProcessToken(processHandle, TOKEN_QUERY, token) || isInvalidHandle(token[0])) {
    throw windowsFailure("Runtime process token could not be opened.", native.getLastError());
  }
  try {
    return readTokenSid(token[0]);
  } finally {
    native.closeHandle(token[0]);
  }
}

function readTokenSid(tokenHandle: NativeHandle): string {
  const native = loadWindowsNativeApi();
  const requiredBytes = [0];
  if (native.getTokenInformation(tokenHandle, TOKEN_USER, null, 0, requiredBytes)) {
    throw new Error("Runtime process token size probe returned an invalid result.");
  }
  if (
    native.getLastError() !== ERROR_INSUFFICIENT_BUFFER ||
    !Number.isSafeInteger(requiredBytes[0]) ||
    (requiredBytes[0] as number) < koffi.sizeof("void *")
  ) {
    throw windowsFailure("Runtime process token identity size is unavailable.", native.getLastError());
  }
  const tokenUser = Buffer.alloc(requiredBytes[0] as number);
  if (!native.getTokenInformation(tokenHandle, TOKEN_USER, tokenUser, tokenUser.byteLength, requiredBytes)) {
    throw windowsFailure("Runtime process token identity could not be read.", native.getLastError());
  }
  const sidPointer = koffi.decode(tokenUser, "void *") as NativeHandle;
  if (isInvalidHandle(sidPointer)) throw new Error("Runtime process token identity is invalid.");
  return convertSidPointerToString(sidPointer, "Runtime process token identity could not be converted.");
}

function convertSidPointerToString(sidPointer: NativeHandle, failureMessage: string): string {
  const native = loadWindowsNativeApi();
  const sidString = [null] as [NativeHandle];
  if (!native.convertSidToStringSid(sidPointer, sidString) || isInvalidHandle(sidString[0])) {
    throw windowsFailure(failureMessage, native.getLastError());
  }
  try {
    const decoded = koffi.decode(sidString[0], "char16_t", -1) as unknown;
    if (typeof decoded !== "string" || !/^S-\d+(?:-\d+)+$/u.test(decoded)) {
      throw new Error("Runtime process token identity is invalid.");
    }
    return decoded;
  } finally {
    native.localFree(sidString[0]);
  }
}

function withSecureAttributes<T>(
  principalSid: string,
  use: (securityAttributes: Readonly<Record<string, unknown>>) => T,
): T {
  if (!/^S-\d+(?:-\d+)+$/u.test(principalSid)) throw new Error("Runtime principal SID is invalid.");
  const native = loadWindowsNativeApi();
  const descriptor = [null] as [NativeHandle];
  const descriptorBytes = [0];
  const sddl = `O:${principalSid}D:P(A;;GA;;;SY)(A;;GA;;;${principalSid})`;
  if (
    !native.convertStringSecurityDescriptorToSecurityDescriptor(sddl, SDDL_REVISION_1, descriptor, descriptorBytes) ||
    isInvalidHandle(descriptor[0])
  ) {
    throw windowsFailure("Runtime endpoint security descriptor could not be created.", native.getLastError());
  }
  try {
    return use({
      nLength: native.securityAttributesSize,
      lpSecurityDescriptor: descriptor[0],
      bInheritHandle: 0,
    });
  } finally {
    native.localFree(descriptor[0]);
  }
}

function inspectSecureKernelObjectSecurity(handle: NativeHandle, principalSid: string): string {
  const native = loadWindowsNativeApi();
  const descriptor = [null] as [NativeHandle];
  const ownerSid = [null] as [NativeHandle];
  const result = native.getSecurityInfo(
    handle,
    SE_KERNEL_OBJECT,
    OWNER_AND_DACL_SECURITY_INFORMATION,
    ownerSid,
    null,
    null,
    null,
    descriptor,
  ) as number;
  if (result !== 0 || isInvalidHandle(descriptor[0]) || isInvalidHandle(ownerSid[0])) {
    throw windowsFailure("Runtime endpoint ACL could not be inspected.", result);
  }
  try {
    const inspectedOwnerSid = convertSidPointerToString(
      ownerSid[0],
      "Runtime endpoint owner identity could not be converted.",
    );
    const sddlPointer = [null] as [NativeHandle];
    const characters = [0];
    if (
      !native.convertSecurityDescriptorToStringSecurityDescriptor(
        descriptor[0],
        SDDL_REVISION_1,
        OWNER_AND_DACL_SECURITY_INFORMATION,
        sddlPointer,
        characters,
      ) ||
      isInvalidHandle(sddlPointer[0])
    ) {
      throw windowsFailure("Runtime endpoint ACL could not be serialized.", native.getLastError());
    }
    try {
      const sddl = koffi.decode(sddlPointer[0], "char16_t", -1) as unknown;
      if (typeof sddl !== "string") throw new Error("Runtime endpoint ACL is invalid.");
      validateWindowsKernelObjectSecuritySddl(sddl, principalSid, inspectedOwnerSid);
      return sddl;
    } finally {
      native.localFree(sddlPointer[0]);
    }
  } finally {
    native.localFree(descriptor[0]);
  }
}

export function validateWindowsKernelObjectSecuritySddl(
  sddl: string,
  principalSid: string,
  inspectedOwnerSid?: string,
): void {
  const accessEntries = sddl.match(/\([^)]*\)/gu) ?? [];
  const expectedTrustees = new Set([principalSid, "S-1-5-18"]);
  const normalizedEntries = accessEntries.map((entry) => {
    const fields = entry.slice(1, -1).split(";");
    if (fields.length !== 6) return undefined;
    const [type, flags, rights, objectGuid, inheritObjectGuid, trustee] = fields;
    if (
      type !== "A" ||
      flags !== "" ||
      objectGuid !== "" ||
      inheritObjectGuid !== "" ||
      !["GA", "FA", "0x1f0001", "0x1f01ff"].includes(rights as string)
    ) {
      return undefined;
    }
    return normalizeWindowsSddlSid(trustee as string);
  });
  const owner = /^O:([^:()]+)D:/u.exec(sddl)?.[1];
  const effectiveOwnerSid = inspectedOwnerSid ?? (owner === undefined ? undefined : normalizeWindowsSddlSid(owner));
  let failureReason: string | undefined;
  if (owner === undefined || effectiveOwnerSid !== principalSid) {
    failureReason = "owner-mismatch";
  } else if (!sddl.startsWith(`O:${owner}D:P`)) {
    failureReason = "dacl-not-protected";
  } else if (accessEntries.length !== 2) {
    failureReason = "ace-count";
  } else if (normalizedEntries.some((entry) => entry === undefined)) {
    failureReason = "ace-shape";
  } else if (
    new Set(normalizedEntries).size !== expectedTrustees.size ||
    [...expectedTrustees].some((trustee) => !normalizedEntries.includes(trustee))
  ) {
    failureReason = "trustee-set";
  }
  if (failureReason !== undefined) {
    throw new Error(
      `Runtime endpoint ACL is not restricted to the current user and SYSTEM (reason: ${failureReason}).`,
    );
  }
}

function normalizeWindowsSddlSid(sid: string): string {
  return WINDOWS_SDDL_WELL_KNOWN_SIDS.get(sid) ?? sid;
}

function isInvalidHandle(handle: NativeHandle): boolean {
  if (handle === null || handle === 0n) return true;
  return BigInt.asIntN(koffi.sizeof("void *") * 8, handle) === -1n;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortFailure();
}

function abortFailure(): Error {
  const error = new Error("Runtime endpoint operation was aborted.");
  error.name = "AbortError";
  return error;
}

function windowsFailure(message: string, errorCode: unknown): Error {
  const error = new Error(`${message} (Windows error ${String(errorCode)})`);
  error.name = "RuntimeWindowsBoundaryError";
  return error;
}

function assertWindows(): void {
  if (process.platform !== "win32") throw new Error("Windows runtime endpoint support is unavailable.");
}

let cachedWindowsNativeApi: ReturnType<typeof createWindowsNativeApi> | undefined;

function loadWindowsNativeApi() {
  cachedWindowsNativeApi ??= createWindowsNativeApi();
  return cachedWindowsNativeApi;
}

function createWindowsNativeApi() {
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const handle = koffi.pointer("WithMateRuntimeWindowsHandle", koffi.opaque());
  const securityAttributes = koffi.struct("WithMateRuntimeSecurityAttributes", {
    nLength: "uint32_t",
    lpSecurityDescriptor: "void *",
    bInheritHandle: "int",
  });
  const overlapped = koffi.struct("WithMateRuntimeOverlapped", {
    Internal: "uintptr_t",
    InternalHigh: "uintptr_t",
    Offset: "uint32_t",
    OffsetHigh: "uint32_t",
    hEvent: handle,
  });
  return {
    getCurrentProcess: kernel32.func("void * __stdcall GetCurrentProcess()"),
    getCurrentThread: kernel32.func("void * __stdcall GetCurrentThread()"),
    getLastError: kernel32.func("uint32_t __stdcall GetLastError()"),
    getFileAttributes: kernel32.func("uint32_t __stdcall GetFileAttributesW(str16)"),
    createMutex: kernel32.func("__stdcall", "CreateMutexW", handle, [
      koffi.pointer(securityAttributes),
      "bool",
      "str16",
    ]),
    releaseMutex: kernel32.func("bool __stdcall ReleaseMutex(void *)"),
    waitForSingleObject: kernel32.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)"),
    createNamedPipe: kernel32.func("__stdcall", "CreateNamedPipeW", handle, [
      "str16",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      koffi.pointer(securityAttributes),
    ]),
    connectNamedPipe: kernel32.func("bool __stdcall ConnectNamedPipe(void *, void *)"),
    disconnectNamedPipe: kernel32.func("bool __stdcall DisconnectNamedPipe(void *)"),
    createFile: kernel32.func(
      "void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)",
    ),
    waitNamedPipe: kernel32.func("bool __stdcall WaitNamedPipeW(str16, uint32_t)"),
    readFile: kernel32.func("bool __stdcall ReadFile(void *, _Out_ uint8_t *, uint32_t, void *, void *)"),
    writeFile: kernel32.func("bool __stdcall WriteFile(void *, const uint8_t *, uint32_t, void *, void *)"),
    getOverlappedResult: kernel32.func("bool __stdcall GetOverlappedResult(void *, void *, _Out_ uint32_t *, bool)"),
    cancelIoEx: kernel32.func("bool __stdcall CancelIoEx(void *, void *)"),
    createEvent: kernel32.func("void * __stdcall CreateEventW(void *, bool, bool, str16)"),
    closeHandle: kernel32.func("bool __stdcall CloseHandle(void *)"),
    localFree: kernel32.func("void * __stdcall LocalFree(void *)"),
    openProcessToken: advapi32.func("bool __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)"),
    openThreadToken: advapi32.func("bool __stdcall OpenThreadToken(void *, uint32_t, bool, _Out_ void **)"),
    impersonateNamedPipeClient: advapi32.func("bool __stdcall ImpersonateNamedPipeClient(void *)"),
    revertToSelf: advapi32.func("bool __stdcall RevertToSelf()"),
    getTokenInformation: advapi32.func(
      "bool __stdcall GetTokenInformation(void *, int, _Out_ void *, uint32_t, _Out_ uint32_t *)",
    ),
    convertSidToStringSid: advapi32.func("bool __stdcall ConvertSidToStringSidW(void *, _Out_ void **)"),
    convertStringSecurityDescriptorToSecurityDescriptor: advapi32.func(
      "bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32_t, _Out_ void **, _Out_ uint32_t *)",
    ),
    convertSecurityDescriptorToStringSecurityDescriptor: advapi32.func(
      "bool __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *, uint32_t, uint32_t, _Out_ void **, _Out_ uint32_t *)",
    ),
    getSecurityInfo: advapi32.func(
      "uint32_t __stdcall GetSecurityInfo(void *, int, uint32_t, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **)",
    ),
    securityAttributesSize: koffi.sizeof(securityAttributes),
    overlappedType: overlapped,
    overlappedSize: koffi.sizeof(overlapped),
  };
}
