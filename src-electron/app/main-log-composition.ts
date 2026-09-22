import { app, BrowserWindow, crashReporter } from "electron";
import path from "node:path";
import type { RendererLogInput } from "../../src-shared/window/app-log-types.js";
import type {
  AppLogError,
  AppLogInput,
} from "../../src-shared/window/app-log-types.js";
import { sanitizeRendererLogInput } from "./renderer-log-input.js";

type LogInput = AppLogInput;

export class MainLogComposition {
  public constructor(
    private readonly writeLog: (input: LogInput) => void,
    private readonly errorToLogError: (error: unknown) => AppLogError,
  ) {}

  public resolveCrashDumpsPath(): string {
    try {
      return app.getPath("crashDumps");
    } catch {
      return path.join(app.getPath("userData"), "Crashpad");
    }
  }
  public startCrashReporter(crashDumpsPath: string): void {
    try {
      crashReporter.start({ uploadToServer: false });
      this.writeLog({
        level: "info",
        kind: "crash-reporter.started",
        process: "main",
        message: "Crash reporter started",
        data: { uploadToServer: false, crashDumpsPath },
      });
    } catch (error) {
      this.writeLog({
        level: "error",
        kind: "crash-reporter.start-failed",
        process: "main",
        message: "Crash reporter failed to start",
        error: this.errorToLogError(error),
        data: { crashDumpsPath },
      });
    }
  }
  public registerProcessLogHandlers(): void {
    process.on("uncaughtExceptionMonitor", (error) =>
      this.writeLog({
        level: "fatal",
        kind: "main.uncaught-exception",
        process: "main",
        message: error.message,
        error: this.errorToLogError(error),
      }),
    );
    process.on("unhandledRejection", (reason) =>
      this.writeLog({
        level: "fatal",
        kind: "main.unhandled-rejection",
        process: "main",
        message:
          reason instanceof Error ? reason.message : "Unhandled rejection",
        error: this.errorToLogError(reason),
        data: reason instanceof Error ? undefined : { reason },
      }),
    );
    app.on("child-process-gone", (_event, details) =>
      this.writeLog({
        level: details.reason === "clean-exit" ? "info" : "error",
        kind: "child-process.gone",
        process: "main",
        message: `Child process gone: ${details.type}`,
        data: {
          type: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          serviceName:
            "serviceName" in details ? details.serviceName : undefined,
          name: "name" in details ? details.name : undefined,
        },
      }),
    );
  }
  public attachWindowLogHandlers = (window: BrowserWindow): void => {
    const write = (input: LogInput) => this.writeLog(input);
    const title = () => this.readWindowTitle(window);
    const url = () => this.readWindowUrl(window);
    write({
      level: "info",
      kind: "app.window.created",
      process: "main",
      message: "Window created",
      windowId: window.id,
      data: { title: title() },
    });
    window.on("closed", () =>
      write({
        level: "info",
        kind: "app.window.closed",
        process: "main",
        message: "Window closed",
        windowId: window.id,
        data: { title: title() },
      }),
    );
    window.webContents.on("render-process-gone", (_event, details) =>
      write({
        level: details.reason === "clean-exit" ? "info" : "error",
        kind: "renderer.process-gone",
        process: "main",
        message: `Renderer process gone: ${details.reason}`,
        windowId: window.id,
        data: {
          reason: details.reason,
          exitCode: details.exitCode,
          url: url(),
          windowTitle: title(),
          isDestroyed: window.isDestroyed(),
        },
      }),
    );
    window.webContents.on("unresponsive", () =>
      write({
        level: "warn",
        kind: "webcontents.unresponsive",
        process: "main",
        message: "Window webContents became unresponsive",
        windowId: window.id,
        data: { url: url(), windowTitle: title() },
      }),
    );
    window.webContents.on("responsive", () =>
      write({
        level: "info",
        kind: "webcontents.responsive",
        process: "main",
        message: "Window webContents became responsive",
        windowId: window.id,
        data: { url: url(), windowTitle: title() },
      }),
    );
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) =>
        write({
          level: "error",
          kind: "renderer.did-fail-load",
          process: "main",
          message: errorDescription,
          windowId: window.id,
          data: {
            errorCode,
            errorDescription,
            validatedURL,
            isMainFrame,
            url: url(),
          },
        }),
    );
    window.webContents.on(
      "did-start-navigation",
      (_event, navigationUrl, isInPlace, isMainFrame) => {
        if (isMainFrame)
          write({
            level: "info",
            kind: "renderer.navigation-started",
            process: "main",
            message: "Renderer main-frame navigation started",
            windowId: window.id,
            data: { url: navigationUrl, isInPlace, windowTitle: title() },
          });
      },
    );
  };
  private readWindowTitle(window: BrowserWindow): string {
    try {
      return window.isDestroyed() ? "" : window.getTitle();
    } catch {
      return "";
    }
  }
  private readWindowUrl(window: BrowserWindow): string {
    try {
      return window.webContents.isDestroyed()
        ? ""
        : window.webContents.getURL();
    } catch {
      return "";
    }
  }
  public writeIpcErrorLog = (input: {
    channel: string;
    durationMs: number;
    error: unknown;
    clientRequestId?: string;
  }): void =>
    this.writeLog({
      level: "error",
      kind: "ipc.error",
      process: "main",
      message: `IPC failed: ${input.channel}`,
      requestId: input.clientRequestId,
      data: {
        channel: input.channel,
        durationMs: input.durationMs,
        success: false,
        clientRequestId: input.clientRequestId,
      },
      error: this.errorToLogError(input.error),
    });
  public writeRendererLog = (
    input: RendererLogInput,
    windowId?: number,
  ): void => {
    const sanitized = sanitizeRendererLogInput(input);
    if (!sanitized) return;
    this.writeLog({
      level: sanitized.level,
      kind: sanitized.kind,
      process: "renderer",
      message: sanitized.message,
      windowId,
      correlationId: sanitized.correlationId,
      data: { url: sanitized.url, detail: sanitized.data },
      error: sanitized.error,
    });
  };
}
