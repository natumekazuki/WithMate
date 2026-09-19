import { app, BrowserWindow, type KeyboardInputEvent } from "electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CaseResult = {
  owner: "main" | "auxiliary";
  auxiliaryCount: number;
  history: "short" | "long";
  operation: "type" | "delete" | "paste";
  samplesMs: number[];
  medianMs: number;
  p95Ms: number;
  longTaskCount: number;
  counters: Record<string, number>;
};

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const preloadPath = resolve(root, "scripts", "benchmark-composer-input-preload.cjs");

function resolveRendererPath(): string {
  const argumentIndex = process.argv.indexOf("--renderer-dir");
  const rendererDir = argumentIndex >= 0 && process.argv[argumentIndex + 1]
    ? process.argv[argumentIndex + 1]!
    : resolve(root, "dist");
  return resolve(rendererDir, "session.html");
}
const rendererPath = resolveRendererPath();

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

async function waitForTextarea(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      const textarea = document.querySelector('textarea[data-shortcut-scope="composer"]');
      if (textarea && !textarea.disabled) return resolve(true);
      if (performance.now() - started > 15000) return reject(new Error("Composer textarea was not rendered."));
      requestAnimationFrame(poll);
    };
    poll();
  })`);
}

async function measureInput(window: BrowserWindow, inputEvents: KeyboardInputEvent[], pasteText?: string): Promise<number[]> {
  await window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('textarea[data-shortcut-scope="composer"]');
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, ${JSON.stringify("seed ".repeat(10))});
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify("seed ".repeat(10))} }));
    window.__withmateBenchmark?.observer?.disconnect();
    window.__withmateBenchmark = { values: [], inputTimes: [], longTasks: 0, observer: null };
    textarea.addEventListener("input", () => window.__withmateBenchmark.inputTimes.push(performance.now()));
    window.__withmateBenchmark.observer = new PerformanceObserver((list) => { window.__withmateBenchmark.longTasks += list.getEntries().length; });
    window.__withmateBenchmark.observer.observe({ type: "longtask", buffered: false });
  })()`);
  const samples: number[] = [];
  for (const event of inputEvents) {
    const beforeLength = await window.webContents.executeJavaScript("document.querySelector('textarea[data-shortcut-scope=\"composer\"]')?.value.length ?? 0") as number;
    const targetLength = pasteText !== undefined
      ? beforeLength + pasteText.length
      : event.type === "char" ? beforeLength + 1 : Math.max(0, beforeLength - 1);
    if (pasteText !== undefined) {
      await window.webContents.executeJavaScript(`(() => {
        const textarea = document.querySelector('textarea[data-shortcut-scope="composer"]');
        const data = new DataTransfer(); data.setData("text/plain", ${JSON.stringify(pasteText)});
        textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(textarea, textarea.value + ${JSON.stringify(pasteText)});
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: ${JSON.stringify(pasteText)} }));
      })()`);
    } else {
      window.webContents.sendInputEvent(event);
    }
    const rendererLatency = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = performance.now();
      const poll = () => {
        const textarea = document.querySelector('textarea[data-shortcut-scope="composer"]');
        const inputTime = window.__withmateBenchmark?.inputTimes?.[0];
        if (textarea && textarea.value.length === ${targetLength} && typeof inputTime === "number") {
          window.__withmateBenchmark.inputTimes.shift();
          return requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - inputTime)));
        }
        if (performance.now() - started > 2000) return reject(new Error("Composer input was not observed."));
        requestAnimationFrame(poll);
      }; poll();
    })`) as number;
    samples.push(rendererLatency);
  }
  return samples;
}

async function runCase(auxiliaryCount: number, history: "short" | "long", owner: CaseResult["owner"], operation: CaseResult["operation"]): Promise<CaseResult> {
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: preloadPath, contextIsolation: true, sandbox: false, backgroundThrottling: false,
    additionalArguments: [`--benchmark-auxiliary-count=${auxiliaryCount}`, `--benchmark-history=${history}`],
  } });
  try {
    window.webContents.on("console-message", (_event, _level, message) => { if (message.includes("error")) console.error(message); });
    await window.loadFile(rendererPath, { search: "?sessionId=benchmark-main" });
    await waitForTextarea(window);
    if (owner === "auxiliary") {
      await window.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Auxiliary");
        if (!button) throw new Error("Auxiliary target button was not rendered.");
        button.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const events: KeyboardInputEvent[] = operation === "delete"
      ? Array.from({ length: 29 }, () => ({ type: "keyDown", keyCode: "BACKSPACE" as string }))
      : Array.from({ length: 29 }, () => ({ type: "char", keyCode: "x" as string }));
    const pasteText = operation === "paste" ? "x".repeat(160) : undefined;
    const samples = (await measureInput(window, events, pasteText)).slice(5);
    const telemetry = await window.webContents.executeJavaScript("window.withmate.getBenchmarkTelemetry()");
    const longTaskCount = await window.webContents.executeJavaScript("window.__withmateBenchmark?.longTasks ?? 0") as number;
    return { owner, auxiliaryCount, history, operation, samplesMs: samples, medianMs: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), longTaskCount, counters: telemetry.counters };
  } finally {
    await window.close();
  }
}

async function main(): Promise<void> {
  if (!existsSync(rendererPath)) throw new Error("dist/session.html がありません。先に npm run build:renderer を実行してください。");
  await app.whenReady();
  const results: CaseResult[] = [];
  for (const auxiliaryCount of [1, 10, 100]) for (const history of ["short", "long"] as const) for (const owner of ["main", "auxiliary"] as const) for (const operation of ["type", "delete", "paste"] as const) {
    results.push(await runCase(auxiliaryCount, history, owner, operation));
  }
  console.log(JSON.stringify({
    benchmark: "composer-input-render-ipc",
    commit: process.env.GIT_COMMIT ?? "unknown",
    rendererPath,
    electronVersion: process.versions.electron,
    platform: process.platform,
    architecture: process.arch,
    viewport: { width: 1280, height: 900 },
    measurement: "input event to second requestAnimationFrame; not actual paint latency; synthetic API without DB",
    warmupSamplesPerCase: 5,
    samplesPerCase: 24,
    results,
  }, null, 2));
  app.quit();
}

main().catch((error) => { console.error(error); app.exit(1); });
