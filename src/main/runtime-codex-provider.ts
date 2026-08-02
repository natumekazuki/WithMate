import { constants as fsConstants } from "node:fs";
import { access, open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { CodexAdapter, CodexAppServerTransport, type CodexAppServerTransportOptions } from "./providers/codex/index.js";
import type {
  ApplicationRunProviderRuntime,
  ApplicationRunProviderRuntimeFactory,
} from "./application-run-runtime-service.js";
import { ApplicationRunProviderRuntimeStartupError } from "./application-run-provider-failure.js";
import { CODEX_PROVIDER_ID } from "./providers/codex/codex-provider-definition.js";

export const WITHMATE_CODEX_EXECUTABLE_ENV = "WITHMATE_CODEX_EXECUTABLE";
const MAX_EXECUTABLE_HEADER_ENTRIES = 4_096;

export type CodexApplicationRunRuntimeFactoryDependencies = Readonly<{
  createTransport?: (options: CodexAppServerTransportOptions) => CodexAppServerTransport;
}>;

export class CodexApplicationRunRuntimeFactory implements ApplicationRunProviderRuntimeFactory {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #createTransport: (options: CodexAppServerTransportOptions) => CodexAppServerTransport;
  #pendingCleanup: CodexAppServerTransport | undefined;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    dependencies: CodexApplicationRunRuntimeFactoryDependencies = {},
  ) {
    this.#environment = { ...environment };
    this.#createTransport = dependencies.createTransport ?? ((options) => new CodexAppServerTransport(options));
  }

  supports(providerId: string): boolean {
    return providerId === CODEX_PROVIDER_ID;
  }

  async start(providerId: string, generationId: string, signal: AbortSignal): Promise<ApplicationRunProviderRuntime> {
    if (!this.supports(providerId)) {
      throw new ApplicationRunProviderRuntimeStartupError("capability", "Provider runtime is unsupported.");
    }
    try {
      await this.closePending();
    } catch (error) {
      throw new ApplicationRunProviderRuntimeStartupError("process", "Provider runtime cleanup is still pending.", {
        cause: error,
      });
    }
    let executable: string;
    try {
      executable = await resolveConfiguredCodexExecutable(this.#environment);
    } catch (error) {
      throw new ApplicationRunProviderRuntimeStartupError(
        "configuration",
        "Codex executable configuration is invalid.",
        { cause: error },
      );
    }
    let transport: CodexAppServerTransport;
    try {
      transport = this.#createTransport({
        executable,
        clientInfo: {
          name: "withmate",
          version: "0.1.0",
          title: "WithMate Runtime Host",
        },
      });
    } catch (error) {
      throw new ApplicationRunProviderRuntimeStartupError("process", "Codex runtime transport could not be created.", {
        cause: error,
      });
    }
    try {
      const connectionInfo = await transport.start(signal);
      const cliVersion = observeCodexCliVersion(connectionInfo.userAgent);
      const adapter = new CodexAdapter(transport, {
        cliVersion,
      });
      return Object.freeze({ providerId, generationId, adapter });
    } catch (error) {
      this.#pendingCleanup = transport;
      try {
        await this.closePending();
      } catch (cleanupError) {
        throw new ApplicationRunProviderRuntimeStartupError("process", "Codex runtime startup cleanup is pending.", {
          cause: new AggregateError([error, cleanupError]),
        });
      }
      if (error instanceof ApplicationRunProviderRuntimeStartupError) throw error;
      throw new ApplicationRunProviderRuntimeStartupError("process", "Codex runtime process startup failed.", {
        cause: error,
      });
    }
  }

  async closePending(): Promise<void> {
    const transport = this.#pendingCleanup;
    if (transport === undefined) return;
    await transport.close();
    if (this.#pendingCleanup === transport) this.#pendingCleanup = undefined;
  }
}

export function observeCodexCliVersion(userAgent: string): string {
  const prefix = "codex-cli/";
  return userAgent.startsWith(prefix) && userAgent.length > prefix.length ? userAgent.slice(prefix.length) : userAgent;
}

export async function resolveConfiguredCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const configured = environment[WITHMATE_CODEX_EXECUTABLE_ENV];
  if (typeof configured !== "string" || configured.length === 0 || configured.includes("\0")) {
    throw new TypeError("Codex executable is not configured.");
  }
  if (!path.isAbsolute(configured)) {
    throw new TypeError("Codex executable must be an absolute path.");
  }
  if (platform === "win32" && path.extname(configured).toLocaleLowerCase("en-US") !== ".exe") {
    throw new TypeError("Codex executable must be a native Windows executable.");
  }
  const metadata = await stat(configured);
  if (!metadata.isFile()) throw new TypeError("Codex executable must be a regular file.");
  if (platform !== "win32") await access(configured, fsConstants.X_OK);
  const handle = await open(configured, "r");
  try {
    if (!(await hasNativeExecutableFormat(handle, metadata.size, platform))) {
      throw new TypeError("Codex executable must be a native executable.");
    }
  } finally {
    await handle.close();
  }
  return configured;
}

async function hasNativeExecutableFormat(
  handle: FileHandle,
  fileSize: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (platform === "win32") return hasPortableExecutableHeader(handle, fileSize);
  const header = await readExact(handle, 4, 0);
  if (header === undefined) return false;
  if (platform === "darwin") return hasMachOExecutable(handle, fileSize, header);
  if (isElfPlatform(platform)) return hasElfExecutableHeader(handle, fileSize, header);
  return false;
}

async function hasPortableExecutableHeader(handle: FileHandle, fileSize: number): Promise<boolean> {
  const dosHeader = await readExact(handle, 64, 0);
  if (dosHeader === undefined || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) return false;
  const peOffset = new DataView(dosHeader.buffer, dosHeader.byteOffset, dosHeader.byteLength).getUint32(0x3c, true);
  if (peOffset < dosHeader.byteLength || !rangeFits(fileSize, peOffset, 24)) return false;
  const coff = await readExact(handle, 24, peOffset);
  if (coff === undefined || coff[0] !== 0x50 || coff[1] !== 0x45 || coff[2] !== 0x00 || coff[3] !== 0x00) {
    return false;
  }
  const view = new DataView(coff.buffer, coff.byteOffset, coff.byteLength);
  const machine = view.getUint16(4, true);
  const sectionCount = view.getUint16(6, true);
  const optionalHeaderSize = view.getUint16(20, true);
  const characteristics = view.getUint16(22, true);
  if (
    machine === 0 ||
    sectionCount === 0 ||
    sectionCount > MAX_EXECUTABLE_HEADER_ENTRIES ||
    (characteristics & 0x0002) === 0
  ) {
    return false;
  }
  const optionalHeaderOffset = peOffset + coff.byteLength;
  if (!rangeFits(fileSize, optionalHeaderOffset, optionalHeaderSize)) return false;
  const optionalHeader = await readExact(handle, optionalHeaderSize, optionalHeaderOffset);
  if (optionalHeader === undefined) return false;
  const optionalView = new DataView(optionalHeader.buffer, optionalHeader.byteOffset, optionalHeader.byteLength);
  const magic = optionalView.getUint16(0, true);
  const minimumOptionalHeaderSize = magic === 0x010b ? 96 : magic === 0x020b ? 112 : undefined;
  if (
    minimumOptionalHeaderSize === undefined ||
    optionalHeaderSize < minimumOptionalHeaderSize ||
    optionalView.getUint32(16, true) === 0
  ) {
    return false;
  }
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  if (!rangeFits(fileSize, sectionTableOffset, sectionCount * 40)) return false;
  let hasExecutableSection = false;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = await readExact(handle, 40, sectionTableOffset + index * 40);
    if (section === undefined) return false;
    const sectionView = new DataView(section.buffer, section.byteOffset, section.byteLength);
    const rawBytes = sectionView.getUint32(16, true);
    const rawOffset = sectionView.getUint32(20, true);
    const sectionCharacteristics = sectionView.getUint32(36, true);
    if (rawBytes > 0 && !rangeFits(fileSize, rawOffset, rawBytes)) return false;
    if (rawBytes > 0 && (sectionCharacteristics & 0x20000000) !== 0) hasExecutableSection = true;
  }
  return hasExecutableSection;
}

function isElfPlatform(platform: NodeJS.Platform): boolean {
  return ["android", "freebsd", "haiku", "linux", "netbsd", "openbsd", "sunos"].includes(platform);
}

async function hasElfExecutableHeader(handle: FileHandle, fileSize: number, magic: Uint8Array): Promise<boolean> {
  if (magic[0] !== 0x7f || magic[1] !== 0x45 || magic[2] !== 0x4c || magic[3] !== 0x46) return false;
  const identity = await readExact(handle, 16, 0);
  if (identity === undefined) return false;
  const elfClass = identity[4];
  const dataEncoding = identity[5];
  if ((elfClass !== 1 && elfClass !== 2) || (dataEncoding !== 1 && dataEncoding !== 2) || identity[6] !== 1) {
    return false;
  }
  const headerSize = elfClass === 1 ? 52 : 64;
  const header = await readExact(handle, headerSize, 0);
  if (header === undefined) return false;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const littleEndian = dataEncoding === 1;
  const type = view.getUint16(16, littleEndian);
  const machine = view.getUint16(18, littleEndian);
  const version = view.getUint32(20, littleEndian);
  const programHeaderOffset = elfClass === 1 ? view.getUint32(28, littleEndian) : safeUint64(view, 32, littleEndian);
  if (programHeaderOffset === undefined) return false;
  const declaredHeaderSize = view.getUint16(elfClass === 1 ? 40 : 52, littleEndian);
  const programHeaderEntrySize = view.getUint16(elfClass === 1 ? 42 : 54, littleEndian);
  const programHeaderCount = view.getUint16(elfClass === 1 ? 44 : 56, littleEndian);
  const minimumProgramHeaderSize = elfClass === 1 ? 32 : 56;
  if (
    (type !== 2 && type !== 3) ||
    machine === 0 ||
    version !== 1 ||
    declaredHeaderSize !== headerSize ||
    programHeaderCount === 0 ||
    programHeaderCount > MAX_EXECUTABLE_HEADER_ENTRIES ||
    programHeaderEntrySize < minimumProgramHeaderSize ||
    programHeaderOffset < headerSize ||
    !rangeFits(fileSize, programHeaderOffset, programHeaderCount * programHeaderEntrySize)
  ) {
    return false;
  }
  let hasExecutableLoadSegment = false;
  for (let index = 0; index < programHeaderCount; index += 1) {
    const entry = await readExact(
      handle,
      minimumProgramHeaderSize,
      programHeaderOffset + index * programHeaderEntrySize,
    );
    if (entry === undefined) return false;
    const entryView = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    const segmentType = entryView.getUint32(0, littleEndian);
    if (segmentType !== 1) continue;
    const flags = entryView.getUint32(elfClass === 1 ? 24 : 4, littleEndian);
    const segmentOffset =
      elfClass === 1 ? entryView.getUint32(4, littleEndian) : safeUint64(entryView, 8, littleEndian);
    const fileBytes = elfClass === 1 ? entryView.getUint32(16, littleEndian) : safeUint64(entryView, 32, littleEndian);
    const memoryBytes =
      elfClass === 1 ? entryView.getUint32(20, littleEndian) : safeUint64(entryView, 40, littleEndian);
    if (
      segmentOffset === undefined ||
      fileBytes === undefined ||
      memoryBytes === undefined ||
      memoryBytes < fileBytes ||
      !rangeFits(fileSize, segmentOffset, fileBytes)
    ) {
      return false;
    }
    if ((flags & 0x1) !== 0 && fileBytes > 0) hasExecutableLoadSegment = true;
  }
  return hasExecutableLoadSegment;
}

async function hasMachOExecutable(handle: FileHandle, fileSize: number, header: Uint8Array): Promise<boolean> {
  const magic = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, false);
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    return hasFatMachOExecutable(handle, fileSize, magic);
  }
  return hasThinMachOExecutable(handle, 0, fileSize, magic);
}

async function hasThinMachOExecutable(
  handle: FileHandle,
  offset: number,
  size: number,
  magic: number,
): Promise<boolean> {
  const is64Bit = magic === 0xfeedfacf || magic === 0xcffaedfe;
  if (!is64Bit && magic !== 0xfeedface && magic !== 0xcefaedfe) return false;
  const littleEndian = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const headerSize = is64Bit ? 32 : 28;
  if (!rangeFits(size, 0, headerSize)) return false;
  const header = await readExact(handle, headerSize, offset);
  if (header === undefined) return false;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const cpuType = view.getUint32(4, littleEndian);
  const fileType = view.getUint32(12, littleEndian);
  const commandCount = view.getUint32(16, littleEndian);
  const commandBytes = view.getUint32(20, littleEndian);
  if (
    cpuType === 0 ||
    fileType !== 2 ||
    commandCount === 0 ||
    commandCount > MAX_EXECUTABLE_HEADER_ENTRIES ||
    commandBytes < commandCount * 8 ||
    commandBytes > 16 * 1024 * 1024 ||
    !rangeFits(size, headerSize, commandBytes)
  ) {
    return false;
  }
  const commandEnd = offset + headerSize + commandBytes;
  let commandOffset = offset + headerSize;
  let hasExecutableSegment = false;
  let hasEntryPoint = false;
  for (let index = 0; index < commandCount; index += 1) {
    const commandHeader = await readExact(handle, 8, commandOffset);
    if (commandHeader === undefined) return false;
    const commandView = new DataView(commandHeader.buffer, commandHeader.byteOffset, commandHeader.byteLength);
    const command = commandView.getUint32(0, littleEndian);
    const commandSize = commandView.getUint32(4, littleEndian);
    const alignment = is64Bit ? 8 : 4;
    if (commandSize < 8 || commandSize % alignment !== 0 || commandOffset + commandSize > commandEnd) return false;
    if (command === 0x1 || command === 0x19) {
      const minimumSegmentSize = command === 0x19 ? 72 : 56;
      const segment =
        commandSize >= minimumSegmentSize ? await readExact(handle, minimumSegmentSize, commandOffset) : undefined;
      if (segment === undefined) return false;
      const segmentView = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
      const sectionCount = segmentView.getUint32(command === 0x19 ? 64 : 48, littleEndian);
      const sectionSize = command === 0x19 ? 80 : 68;
      if (
        sectionCount > MAX_EXECUTABLE_HEADER_ENTRIES ||
        commandSize !== minimumSegmentSize + sectionCount * sectionSize
      ) {
        return false;
      }
      const fileOffset =
        command === 0x19 ? safeUint64(segmentView, 40, littleEndian) : segmentView.getUint32(32, littleEndian);
      const fileBytes =
        command === 0x19 ? safeUint64(segmentView, 48, littleEndian) : segmentView.getUint32(36, littleEndian);
      const initialProtection = segmentView.getUint32(command === 0x19 ? 60 : 44, littleEndian);
      if (fileOffset === undefined || fileBytes === undefined || !rangeFits(size, fileOffset, fileBytes)) {
        return false;
      }
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
        const section = await readExact(
          handle,
          sectionSize,
          commandOffset + minimumSegmentSize + sectionIndex * sectionSize,
        );
        if (section === undefined) return false;
        const sectionView = new DataView(section.buffer, section.byteOffset, section.byteLength);
        const sectionBytes =
          command === 0x19 ? safeUint64(sectionView, 40, littleEndian) : sectionView.getUint32(36, littleEndian);
        const sectionOffset = sectionView.getUint32(command === 0x19 ? 48 : 40, littleEndian);
        const sectionType = sectionView.getUint32(command === 0x19 ? 64 : 56, littleEndian) & 0xff;
        const isZeroFill = sectionType === 0x1 || sectionType === 0xc || sectionType === 0x12;
        if (
          sectionBytes === undefined ||
          (!isZeroFill && sectionBytes > 0 && !rangeFits(size, sectionOffset, sectionBytes))
        ) {
          return false;
        }
      }
      if (fileBytes > 0 && (initialProtection & 0x4) !== 0) hasExecutableSegment = true;
    }
    if (command === 0x80000028) {
      if (commandSize < 24) return false;
      hasEntryPoint = true;
    } else if (command === 0x5) {
      if (commandSize < 16) return false;
      hasEntryPoint = true;
    }
    commandOffset += commandSize;
  }
  return commandOffset === commandEnd && hasExecutableSegment && hasEntryPoint;
}

async function hasFatMachOExecutable(handle: FileHandle, fileSize: number, magic: number): Promise<boolean> {
  const is64Bit = magic === 0xcafebabf || magic === 0xbfbafeca;
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const header = await readExact(handle, 8, 0);
  if (header === undefined) return false;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const architectureCount = view.getUint32(4, littleEndian);
  const entrySize = is64Bit ? 32 : 20;
  if (architectureCount === 0 || architectureCount > 64 || !rangeFits(fileSize, 8, architectureCount * entrySize)) {
    return false;
  }
  for (let index = 0; index < architectureCount; index += 1) {
    const entry = await readExact(handle, entrySize, 8 + index * entrySize);
    if (entry === undefined) return false;
    const entryView = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    const cpuType = entryView.getUint32(0, littleEndian);
    const sliceOffset = is64Bit ? safeUint64(entryView, 8, littleEndian) : entryView.getUint32(8, littleEndian);
    const sliceSize = is64Bit ? safeUint64(entryView, 16, littleEndian) : entryView.getUint32(12, littleEndian);
    if (
      cpuType === 0 ||
      sliceOffset === undefined ||
      sliceSize === undefined ||
      sliceSize === 0 ||
      !rangeFits(fileSize, sliceOffset, sliceSize)
    ) {
      return false;
    }
    const sliceMagicBytes = await readExact(handle, 4, sliceOffset);
    if (sliceMagicBytes === undefined) return false;
    const sliceMagic = new DataView(
      sliceMagicBytes.buffer,
      sliceMagicBytes.byteOffset,
      sliceMagicBytes.byteLength,
    ).getUint32(0, false);
    if (!(await hasThinMachOExecutable(handle, sliceOffset, sliceSize, sliceMagic))) return false;
  }
  return true;
}

function safeUint64(view: DataView, byteOffset: number, littleEndian: boolean): number | undefined {
  const value = view.getBigUint64(byteOffset, littleEndian);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function rangeFits(containerSize: number, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(containerSize) &&
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    containerSize >= 0 &&
    offset >= 0 &&
    length >= 0 &&
    offset <= containerSize &&
    length <= containerSize - offset
  );
}

async function readExact(handle: FileHandle, byteLength: number, position: number): Promise<Uint8Array | undefined> {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const result = await handle.read(bytes, offset, byteLength - offset, position + offset);
    if (result.bytesRead === 0) return undefined;
    offset += result.bytesRead;
  }
  return bytes;
}
