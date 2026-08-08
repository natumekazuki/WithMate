import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, openSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import koffi from "koffi";

export const PROCESS_OWNER_FORCE_WAIT_MS = 3_000;

const SYSTEMD_SUPERVISOR_MARKER = "WITHMATE_PROBE_SUBJECT_SPAWNED_V1:";
export const activeProcessOwners = new Set();

function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function boundedTimeout(deadlineAt, requestedMs, operation) {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) throw new Error(`${operation} exceeded the probe deadline`);
  return Math.max(1, Math.min(requestedMs, remaining));
}

function boundedSleep(requestedMs, deadlineAt, operation) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, boundedTimeout(deadlineAt, requestedMs, operation)),
  );
}

export function resolveCodexInvocation(timeoutMs) {
  if (process.platform !== "win32") return { command: "codex", prefixArgs: [] };
  const located = spawnSync("where.exe", ["codex.cmd"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (located.error !== undefined || located.status !== 0) throw new Error("codex command discovery failed");
  const commandShim = located.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (commandShim === undefined) throw new Error("codex command shim was not found");
  const installRoot = dirname(commandShim);
  const cliScript = join(installRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  const bundledNode = join(installRoot, "node.exe");
  if (!existsSync(cliScript)) throw new Error("codex CLI script was not found beside the command shim");
  return { command: existsSync(bundledNode) ? bundledNode : process.execPath, prefixArgs: [cliScript] };
}

const WINDOWS_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
let launched = false;
process.once("disconnect", () => {
  if (!launched) process.exit(70);
});
process.once("message", (message) => {
  if (message === null || typeof message !== "object" || message.kind !== "launch") process.exit(70);
  launched = true;
  let child;
  try {
    child = spawn(message.executable, message.arguments, {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
  } catch {
    process.exit(71);
  }
  child.once("spawn", () => {
    process.send?.(
      { kind: "process_spawned", supervisorPid: process.pid, subjectPid: child.pid },
      () => process.disconnect(),
    );
  });
  child.once("error", () => process.exit(71));
  child.once("exit", (code) => process.exit(code ?? 1));
});
`;

const SYSTEMD_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const marker = ${JSON.stringify(SYSTEMD_SUPERVISOR_MARKER)};
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.once("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(70);
  }
  if (message === null || typeof message !== "object" || message.kind !== "launch") process.exit(70);
  reader.close();
  process.stdin.pause();
  let child;
  try {
    child = spawn(message.executable, message.arguments, {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      stdio: "inherit",
    });
  } catch {
    process.exit(71);
  }
  child.once("spawn", () => {
    process.stderr.write(marker + JSON.stringify({ supervisorPid: process.pid, subjectPid: child.pid }) + "\n");
    if (Number.isSafeInteger(message.terminateSupervisorAfterSpawnMs)) {
      setTimeout(() => process.kill(process.pid, "SIGKILL"), message.terminateSupervisorAfterSpawnMs);
    }
  });
  child.once("error", () => process.exit(71));
  child.once("exit", (code) => process.exit(code ?? 1));
});
`;

export function spawnOwnedProcess(executable, argumentsList, options = {}, ownershipTestHooks = {}) {
  if (process.platform !== "win32") {
    assertLinuxSystemdContainmentAvailable();
    const unitName = `withmate-probe-${randomUUID().replaceAll("-", "")}.service`;
    const controller = spawn(
      "systemd-run",
      [
        "--user",
        "--pipe",
        "--wait",
        "--quiet",
        "--collect",
        "--service-type=exec",
        `--unit=${unitName}`,
        "--property=Delegate=yes",
        "--property=KillMode=control-group",
        "--",
        process.execPath,
        "--eval",
        SYSTEMD_SUPERVISOR_SOURCE,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const owner = registerProcessOwner({
      controller,
      child: controller,
      unitName,
      cgroupKillHandle: undefined,
      writeCgroupKill: ownershipTestHooks.writeLinuxCgroupKill ?? writeSync,
      cleanupIssued: false,
      released: false,
      ready: undefined,
      controllerExit: processExitPromise(controller),
      hasControllerExited: () => processHasExited(controller),
      terminate: () => terminateLinuxSystemdOwner(owner),
      release: () => releaseLinuxSystemdOwner(owner),
      releaseTerminatesTree: true,
    });
    owner.ready = initializeLinuxSystemdOwner(
      owner,
      controller,
      executable,
      argumentsList,
      options,
      ownershipTestHooks,
    );
    return owner;
  }

  const job = createProbeWindowsJobObject();
  let controller;
  try {
    controller = spawn(process.execPath, ["--eval", WINDOWS_SUPERVISOR_SOURCE], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
  } catch (error) {
    try {
      job.close();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "probe process supervisor creation failed");
    }
    throw error;
  }

  const owner = registerProcessOwner({
    controller,
    child: controller,
    ready: undefined,
    controllerExit: processExitPromise(controller),
    hasControllerExited: () => processHasExited(controller),
    terminate: () => terminateWindowsProcessOwner(job, controller),
    release: () => job.close(),
    releaseTerminatesTree: true,
  });
  owner.ready = initializeWindowsProcessOwner(
    owner,
    job,
    controller,
    executable,
    argumentsList,
    options,
    ownershipTestHooks,
  );
  return owner;
}

function processExitPromise(child) {
  if (processHasExited(child)) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

function registerProcessOwner(owner) {
  const tracked = {
    ...owner,
    released: owner.released === true,
    release() {
      owner.release();
      tracked.released = true;
    },
    forget: () => activeProcessOwners.delete(tracked),
    async cleanup(deadlineAt, operation, observedPids = []) {
      const { releaseError, terminationError } = terminateAndReleaseProcessOwner(tracked);
      if (terminationError !== undefined && !tracked.releaseTerminatesTree) throw terminationError;
      if (releaseError !== undefined) throw releaseError;
      const cleanupVerified = await forgetOwnerAfterVerifiedCleanup(
        tracked,
        [...new Set([tracked.supervisorPid, tracked.subjectPid, ...observedPids])],
        deadlineAt,
        operation,
      );
      if (!cleanupVerified) throw new Error(`${operation} was not confirmed`);
      return { exitConfirmed: true };
    },
  };
  activeProcessOwners.add(tracked);
  return tracked;
}

export function emergencyStopOwnedProcesses() {
  for (const owner of [...activeProcessOwners]) {
    try {
      owner.terminate();
    } catch {
      // release() retains the independent Job Object or delegated-cgroup fallback.
    }
    try {
      owner.release();
    } catch {
      // Failed cleanup remains unverified and the probe exits non-zero.
    }
  }
}

export async function deleteTempAfterVerifiedProcessCleanup(processCleanupVerified, deleteTemp) {
  if (processCleanupVerified !== true) return false;
  await deleteTemp();
  return true;
}

export function terminateAndReleaseProcessOwner(owner, terminateOperation = () => owner.terminate()) {
  let terminationError;
  try {
    terminateOperation();
  } catch (error) {
    terminationError = error;
  }
  let releaseError;
  try {
    owner.release();
  } catch (error) {
    releaseError = error;
  }
  return { releaseError, terminationError };
}

function terminateWindowsProcessOwner(job, controller) {
  const errors = [];
  try {
    job.terminate();
  } catch (error) {
    errors.push(error);
  }
  if (!processHasExited(controller)) {
    try {
      controller.kill("SIGKILL");
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Windows process ownership termination failed");
}

function assertLinuxSystemdContainmentAvailable() {
  if (process.platform !== "linux") {
    throw new Error("POSIX process ownership requires Linux systemd with delegated cgroup v2 containment");
  }
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) throw new Error("Linux process ownership requires cgroup v2");
  const manager = spawnSync("systemctl", ["--user", "show-environment"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROCESS_OWNER_FORCE_WAIT_MS,
  });
  if (manager.error !== undefined || manager.status !== 0) {
    throw new Error("Linux process ownership requires an available systemd user manager");
  }
  const runner = spawnSync("systemd-run", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROCESS_OWNER_FORCE_WAIT_MS,
  });
  if (runner.error !== undefined || runner.status !== 0)
    throw new Error("Linux process ownership requires systemd-run");
}

async function initializeLinuxSystemdOwner(owner, controller, executable, argumentsList, options, ownershipTestHooks) {
  try {
    await waitForSpawn(controller);
    if (controller.pid === undefined) throw new Error("systemd-run wrapper has no identity");
    const cgroupPath = await waitForLinuxSystemdControlGroup(owner.unitName);
    owner.cgroupPath = cgroupPath;
    const openCgroupKill = ownershipTestHooks.openLinuxCgroupKill ?? openSync;
    owner.cgroupKillHandle = openCgroupKill(`${cgroupPath}/cgroup.kill`, fsConstants.O_WRONLY);
    if (ownershipTestHooks.failLinuxBeforeLaunch === true) {
      throw new Error("simulated failure after delegated cgroup acquisition");
    }
    if (ownershipTestHooks.stallBeforeSubjectLaunch === true) await new Promise(() => {});
    const launched = await launchFromSystemdSupervisor(
      controller,
      executable,
      argumentsList,
      options,
      ownershipTestHooks,
    );
    owner.supervisorPid = launched.supervisorPid;
    owner.subjectPid = launched.subjectPid;
  } catch (error) {
    await rejectAfterFailedOwnerCleanup(owner, error);
  }
}

async function waitForLinuxSystemdControlGroup(unitName) {
  assertOwnedSystemdUnitName(unitName);
  const deadlineAt = Date.now() + PROCESS_OWNER_FORCE_WAIT_MS;
  while (remainingMs(deadlineAt) > 0) {
    const result = systemctlShow(unitName, "ControlGroup");
    const controlGroup = result.status === 0 ? result.stdout.trim() : "";
    if (controlGroup.length > 0) return validateLinuxSystemdControlGroup(unitName, controlGroup);
    await boundedSleep(25, deadlineAt, "systemd control group discovery");
  }
  throw new Error("systemd unit control group was not created");
}

function validateLinuxSystemdControlGroup(unitName, controlGroup) {
  if (!controlGroup.startsWith("/") || controlGroup.includes("\0")) {
    throw new Error("systemd returned an invalid control group path");
  }
  const segments = controlGroup.split("/").slice(1);
  if (
    segments.length === 0 ||
    segments.at(-1) !== unitName ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes("\\"))
  ) {
    throw new Error("systemd returned an unexpected control group path");
  }
  const root = "/sys/fs/cgroup";
  const cgroupPath = resolve(root, `.${controlGroup}`);
  if (!cgroupPath.startsWith(`${root}/`) || basename(cgroupPath) !== unitName) {
    throw new Error("systemd control group escaped the cgroup v2 mount");
  }
  return cgroupPath;
}

export function assertOwnedSystemdUnitName(unitName) {
  if (!/^withmate-probe-[0-9a-f]{32}\.service$/u.test(unitName)) {
    throw new Error("probe systemd unit name is not owned by this process");
  }
}

function cleanupRecoveryTargetForOwner(owner) {
  const unitName = owner?.unitName;
  if (typeof unitName !== "string") return undefined;
  try {
    assertOwnedSystemdUnitName(unitName);
  } catch {
    return undefined;
  }
  return Object.freeze({ kind: "systemd_user_unit", unitName });
}

export function cleanupRecoveryTargetsForOwners(owners) {
  const targets = new Map();
  for (const owner of owners) {
    const target = cleanupRecoveryTargetForOwner(owner);
    if (target !== undefined) targets.set(target.unitName, target);
  }
  return [...targets.values()].sort((left, right) => left.unitName.localeCompare(right.unitName));
}

function systemctlShow(unitName, property) {
  assertOwnedSystemdUnitName(unitName);
  return spawnSync("systemctl", ["--user", "show", `--property=${property}`, "--value", unitName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROCESS_OWNER_FORCE_WAIT_MS,
  });
}

function systemdUnitIsInactiveOrAbsent(unitName) {
  const result = systemctlShow(unitName, "ActiveState");
  if (result.error !== undefined) return false;
  if (result.status !== 0) return /(?:could not be found|not found|does not exist)/iu.test(result.stderr);
  const state = result.stdout.trim();
  return state === "inactive" || state === "failed";
}

export async function waitForSystemdUnitInactiveOrAbsent(unitName, deadlineAt, operation) {
  while (!systemdUnitIsInactiveOrAbsent(unitName)) await boundedSleep(25, deadlineAt, operation);
}

export function stopOwnedSystemdUnit(unitName) {
  assertOwnedSystemdUnitName(unitName);
  const result = spawnSync("systemctl", ["--user", "stop", unitName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROCESS_OWNER_FORCE_WAIT_MS,
  });
  if (result.error === undefined && result.status === 0) return;
  if (systemdUnitIsInactiveOrAbsent(unitName)) return;
  throw new Error("systemd unit stop failed");
}

function terminateLinuxSystemdOwner(owner) {
  if (owner.cleanupIssued === true) return;
  if (owner.cgroupKillHandle !== undefined) {
    try {
      owner.writeCgroupKill(owner.cgroupKillHandle, "1");
      owner.cleanupIssued = true;
      return;
    } catch (error) {
      if (processHasExited(owner.controller) && systemdUnitIsInactiveOrAbsent(owner.unitName)) {
        owner.cleanupIssued = true;
        return;
      }
      throw new AggregateError([error], "delegated cgroup termination failed");
    }
  }
  stopOwnedSystemdUnit(owner.unitName);
  owner.cleanupIssued = true;
}

function releaseLinuxSystemdOwner(owner) {
  if (owner.released === true) return;
  if (owner.cleanupIssued !== true) {
    try {
      terminateLinuxSystemdOwner(owner);
    } catch (terminationError) {
      try {
        stopOwnedSystemdUnit(owner.unitName);
        owner.cleanupIssued = true;
      } catch (fallbackError) {
        throw new AggregateError(
          [terminationError, fallbackError],
          "delegated cgroup termination and exact systemd unit fallback failed",
        );
      }
    }
  }
  if (owner.cgroupKillHandle !== undefined) {
    closeSync(owner.cgroupKillHandle);
    owner.cgroupKillHandle = undefined;
  }
  owner.released = true;
}

async function initializeWindowsProcessOwner(
  owner,
  job,
  controller,
  executable,
  argumentsList,
  options,
  ownershipTestHooks,
) {
  try {
    await waitForSpawn(controller);
    if (controller.pid === undefined) throw new Error("probe process supervisor has no identity");
    const assignProcess = ownershipTestHooks.assignWindowsProcess ?? ((pid) => job.assignProcess(pid));
    assignProcess(controller.pid);
    if (ownershipTestHooks.stallBeforeSubjectLaunch === true) await new Promise(() => {});
    const launched = await launchFromSupervisor(controller, executable, argumentsList, options);
    owner.supervisorPid = launched.supervisorPid;
    owner.subjectPid = launched.subjectPid;
  } catch (error) {
    await rejectAfterFailedOwnerCleanup(owner, error);
  }
}

async function rejectAfterFailedOwnerCleanup(owner, cause) {
  const errors = [cause];
  try {
    await owner.cleanup(Date.now() + PROCESS_OWNER_FORCE_WAIT_MS, "partial process owner cleanup");
  } catch (error) {
    errors.push(error);
  }
  throw errors.length === 1 ? cause : new AggregateError(errors, "partial process ownership setup failed");
}

export function waitForSpawn(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolvePromise();
    };
    const onError = () => {
      child.off("spawn", onSpawn);
      rejectPromise(new Error("owned process could not be spawned"));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function waitForProcessOwnerReady(owner, deadlineAt, operation) {
  const timeoutMs = boundedTimeout(deadlineAt, remainingMs(deadlineAt), operation);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${operation} exceeded the probe deadline`)), timeoutMs);
    owner.ready.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function launchFromSupervisor(controller, executable, argumentsList, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let launchedMessage;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      controller.off("message", onMessage);
      controller.off("error", onError);
      controller.off("exit", onExit);
      if (error === undefined) resolvePromise(launchedMessage);
      else rejectPromise(error);
    };
    const onMessage = (message) => {
      if (message?.kind === "process_spawned") {
        if (
          !Number.isSafeInteger(message.supervisorPid) ||
          message.supervisorPid <= 0 ||
          !Number.isSafeInteger(message.subjectPid) ||
          message.subjectPid <= 0
        ) {
          finish(new Error("probe process supervisor returned invalid process identities"));
          return;
        }
        launchedMessage = message;
        finish();
      }
      if (message?.kind === "process_spawn_failed") finish(new Error("owned process could not be spawned"));
    };
    const onError = () => finish(new Error("probe process supervisor failed"));
    const onExit = () => finish(new Error("probe process supervisor exited before launch"));
    controller.on("message", onMessage);
    controller.once("error", onError);
    controller.once("exit", onExit);
    controller.send(
      {
        kind: "launch",
        executable,
        arguments: argumentsList,
        cwd: options.cwd,
        env: options.env ?? process.env,
      },
      (error) => {
        if (error !== null && error !== undefined) {
          finish(new Error("probe process supervisor could not receive launch configuration"));
        }
      },
    );
  });
}

function launchFromSystemdSupervisor(controller, executable, argumentsList, options, ownershipTestHooks) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderrBuffer = "";
    let settled = false;
    const finish = (error, launched) => {
      if (settled) return;
      settled = true;
      controller.stderr.off("data", onData);
      controller.off("error", onError);
      controller.off("exit", onExit);
      if (error === undefined) resolvePromise(launched);
      else rejectPromise(error);
    };
    const onData = (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString("utf8")}`.slice(-65_536);
      const markerAt = stderrBuffer.indexOf(SYSTEMD_SUPERVISOR_MARKER);
      if (markerAt < 0) return;
      const lineStart = markerAt + SYSTEMD_SUPERVISOR_MARKER.length;
      const lineEnd = stderrBuffer.indexOf("\n", lineStart);
      if (lineEnd < 0) return;
      let launched;
      try {
        launched = JSON.parse(stderrBuffer.slice(lineStart, lineEnd));
      } catch {
        finish(new Error("systemd process supervisor returned an invalid launch marker"));
        return;
      }
      if (
        !Number.isSafeInteger(launched?.supervisorPid) ||
        launched.supervisorPid <= 0 ||
        !Number.isSafeInteger(launched?.subjectPid) ||
        launched.subjectPid <= 0
      ) {
        finish(new Error("systemd process supervisor returned invalid process identities"));
        return;
      }
      finish(undefined, launched);
    };
    const onError = () => finish(new Error("systemd-run wrapper failed"));
    const onExit = () => finish(new Error("systemd process supervisor exited before launch"));
    controller.stderr.on("data", onData);
    controller.once("error", onError);
    controller.once("exit", onExit);
    controller.stdin.write(
      `${JSON.stringify({
        kind: "launch",
        executable,
        arguments: argumentsList,
        cwd: options.cwd,
        env: options.env ?? process.env,
        terminateSupervisorAfterSpawnMs: ownershipTestHooks.terminateSupervisorAfterSpawnMs,
      })}\n`,
      (error) => {
        if (error !== null && error !== undefined) {
          finish(new Error("systemd process supervisor could not receive launch configuration"));
        }
      },
    );
  });
}

let cachedWindowsJobApi;

function createProbeWindowsJobObject() {
  const native = (cachedWindowsJobApi ??= loadProbeWindowsJobApi());
  const jobHandle = native.createJobObject(null, null);
  if (jobHandle === null || jobHandle === 0n) throw new Error("probe process ownership could not be created");

  let closed = false;
  const pendingProcessHandles = new Set();
  const owner = {
    assignProcess(pid) {
      if (closed) throw new Error("probe process ownership is closed");
      const processHandle = native.openProcess(0x0001 | 0x0100, 0, pid);
      if (processHandle === null || processHandle === 0n) {
        throw new Error("probe process ownership could not open its process");
      }
      let assignmentError;
      if (!native.assignProcessToJobObject(jobHandle, processHandle)) {
        assignmentError = new Error("probe process ownership could not assign its process");
      }
      if (!native.closeHandle(processHandle)) {
        pendingProcessHandles.add(processHandle);
        const releaseError = new Error("probe process handle could not be released");
        throw assignmentError === undefined
          ? releaseError
          : new AggregateError([assignmentError, releaseError], "probe process assignment failed");
      }
      if (assignmentError !== undefined) throw assignmentError;
    },
    terminate() {
      if (closed) return;
      if (!native.terminateJobObject(jobHandle, 1)) throw new Error("probe process ownership termination failed");
    },
    close() {
      if (closed) return;
      for (const processHandle of [...pendingProcessHandles]) {
        if (!native.closeHandle(processHandle)) throw new Error("probe process handle release failed");
        pendingProcessHandles.delete(processHandle);
      }
      if (!native.closeHandle(jobHandle)) throw new Error("probe process ownership release failed");
      closed = true;
    },
  };

  try {
    if (!native.setInformationJobObject(jobHandle, 9, jobLimits(), native.jobLimitsSize)) {
      throw new Error("probe process ownership could not be configured");
    }
  } catch (error) {
    try {
      owner.close();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "probe process ownership setup failed");
    }
    throw error;
  }
  return owner;
}

function loadProbeWindowsJobApi() {
  const kernel32 = koffi.load("kernel32.dll");
  const handle = koffi.pointer("WithMateProbeWindowsHandle", koffi.opaque());
  const ioCounters = koffi.struct("WithMateProbeWindowsIoCounters", {
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  const basicLimits = koffi.struct("WithMateProbeWindowsBasicJobLimits", {
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
  const extendedLimits = koffi.struct("WithMateProbeWindowsExtendedJobLimits", {
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
      LimitFlags: 0x00002000,
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

export function processHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function waitForProcessExit(child, requestedMs, deadlineAt, operation) {
  if (processHasExited(child)) return;
  const timeoutMs = boundedTimeout(deadlineAt, requestedMs, operation);
  await new Promise((resolvePromise) => {
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise();
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

export async function waitForOwnedControllerExit(owner, requestedMs, deadlineAt, operation) {
  if (owner.hasControllerExited()) return;
  const timeoutMs = boundedTimeout(deadlineAt, requestedMs, operation);
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    owner.controllerExit.then(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

export async function waitForObservedProcessesExit(pids, deadlineAt) {
  while (pids.some((pid) => processIsAlive(pid))) {
    await boundedSleep(25, deadlineAt, "owned process exit observation");
  }
}

export async function forgetOwnerAfterVerifiedCleanup(owner, observedPids, deadlineAt, operation) {
  if (owner.released !== true || (process.platform !== "win32" && owner.cgroupKillHandle !== undefined)) return false;
  while (remainingMs(deadlineAt) > 0) {
    const processTreeExited = processHasExited(owner.controller) && observedPids.every((pid) => !processIsAlive(pid));
    const platformOwnerReleased = process.platform === "win32" || systemdUnitIsInactiveOrAbsent(owner.unitName);
    if (processTreeExited && platformOwnerReleased) {
      owner.forget();
      return true;
    }
    await boundedSleep(25, deadlineAt, operation);
  }
  return false;
}

async function fixtureDescendantPid(owner, deadlineAt, operation) {
  const reader = createInterface({ input: owner.controller.stdout });
  try {
    const line = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`${operation} timed out`)),
        boundedTimeout(deadlineAt, PROCESS_OWNER_FORCE_WAIT_MS, operation),
      );
      reader.once("line", (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      });
      reader.once("close", () => {
        clearTimeout(timer);
        rejectPromise(new Error(`${operation} closed before reporting`));
      });
    });
    const descendantPid = JSON.parse(line).descendantPid;
    if (!Number.isSafeInteger(descendantPid) || descendantPid <= 0) {
      throw new Error(`${operation} returned an invalid identity`);
    }
    return descendantPid;
  } finally {
    reader.close();
  }
}

function processTreeFixtureSource() {
  return String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
setInterval(() => {}, 1000);
`;
}

export async function processOwnerContractSelfTest() {
  const normalDeadline = Date.now() + 10_000;
  const normalOwner = spawnOwnedProcess(process.execPath, ["--eval", processTreeFixtureSource()], { env: process.env });
  let normalDescendantPid;
  try {
    await normalOwner.ready;
    normalDescendantPid = await fixtureDescendantPid(normalOwner, normalDeadline, "normal owner fixture");
    await normalOwner.cleanup(normalDeadline, "normal owner cleanup", [normalDescendantPid]);
  } finally {
    if (activeProcessOwners.has(normalOwner)) {
      await normalOwner.cleanup(normalDeadline, "normal owner final cleanup", [normalDescendantPid]);
    }
  }
  const normalCleanup =
    !activeProcessOwners.has(normalOwner) &&
    !processIsAlive(normalOwner.subjectPid) &&
    !processIsAlive(normalDescendantPid);

  let assignmentFailure = true;
  if (process.platform === "win32") {
    const failureDeadline = Date.now() + 10_000;
    const failedOwner = spawnOwnedProcess(
      process.execPath,
      ["--eval", "setInterval(() => {}, 1000)"],
      { env: process.env },
      {
        assignWindowsProcess: () => {
          throw new Error("simulated Job assignment failure");
        },
      },
    );
    try {
      await failedOwner.ready;
      assignmentFailure = false;
    } catch {
      assignmentFailure = !activeProcessOwners.has(failedOwner) && processHasExited(failedOwner.controller);
    } finally {
      if (activeProcessOwners.has(failedOwner)) {
        await failedOwner.cleanup(failureDeadline, "assignment failure final cleanup");
      }
    }
  }

  const controllerFirstDeadline = Date.now() + 10_000;
  const controllerFirstOwner = spawnOwnedProcess(process.execPath, ["--eval", processTreeFixtureSource()], {
    env: process.env,
  });
  let controllerFirstDescendantPid;
  try {
    await controllerFirstOwner.ready;
    controllerFirstDescendantPid = await fixtureDescendantPid(
      controllerFirstOwner,
      controllerFirstDeadline,
      "controller-first owner fixture",
    );
    controllerFirstOwner.controller.kill("SIGKILL");
    await waitForProcessExit(
      controllerFirstOwner.controller,
      PROCESS_OWNER_FORCE_WAIT_MS,
      controllerFirstDeadline,
      "controller-first controller exit",
    );
    await controllerFirstOwner.cleanup(controllerFirstDeadline, "controller-first owner cleanup", [
      controllerFirstDescendantPid,
    ]);
  } finally {
    if (activeProcessOwners.has(controllerFirstOwner)) {
      await controllerFirstOwner.cleanup(controllerFirstDeadline, "controller-first owner final cleanup", [
        controllerFirstDescendantPid,
      ]);
    }
  }
  const controllerFirstCleanup =
    !activeProcessOwners.has(controllerFirstOwner) &&
    !processIsAlive(controllerFirstOwner.subjectPid) &&
    !processIsAlive(controllerFirstDescendantPid);

  const readinessDeadline = Date.now() + 10_000;
  const stalledOwner = spawnOwnedProcess(
    process.execPath,
    ["--eval", "setInterval(() => {}, 1000)"],
    { env: process.env },
    { stallBeforeSubjectLaunch: true },
  );
  let readinessDeadlineRejected = false;
  try {
    await waitForProcessOwnerReady(stalledOwner, Date.now() + 100, "stalled owner readiness");
  } catch (error) {
    readinessDeadlineRejected = error?.message === "stalled owner readiness exceeded the probe deadline";
  } finally {
    if (activeProcessOwners.has(stalledOwner)) {
      await stalledOwner.cleanup(readinessDeadline, "stalled owner readiness cleanup");
    }
  }
  const readinessDeadlineCleanup =
    readinessDeadlineRejected &&
    !activeProcessOwners.has(stalledOwner) &&
    processHasExited(stalledOwner.controller) &&
    !processIsAlive(stalledOwner.subjectPid);

  const failureDeadline = Date.now() + 10_000;
  const cleanupFailureOwner = spawnOwnedProcess(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    env: process.env,
  });
  await cleanupFailureOwner.ready;
  const originalTerminate = cleanupFailureOwner.terminate;
  const originalRelease = cleanupFailureOwner.release;
  cleanupFailureOwner.terminate = () => {
    throw new Error("simulated owner termination failure");
  };
  cleanupFailureOwner.release = () => {
    throw new Error("simulated owner release failure");
  };
  let cleanupFailureUnverified = false;
  try {
    await cleanupFailureOwner.cleanup(failureDeadline, "simulated failed cleanup");
  } catch {
    cleanupFailureUnverified = activeProcessOwners.has(cleanupFailureOwner);
  } finally {
    cleanupFailureOwner.terminate = originalTerminate;
    cleanupFailureOwner.release = originalRelease;
    await cleanupFailureOwner.cleanup(failureDeadline, "cleanup failure fixture recovery");
  }

  return {
    assignmentFailure,
    cleanupFailureUnverified,
    controllerFirstCleanup,
    normalCleanup,
    readinessDeadlineCleanup,
  };
}
