import { parentPort, workerData } from "node:worker_threads";

import {
  runPowerShellClipboardHelper,
  WindowsFileDropClipboardWriter,
  type ClipboardHelperProcessRequest,
} from "./windows-file-drop-clipboard-writer.js";

const { payload, systemRoot } = workerData as {
  payload: ClipboardHelperProcessRequest["payload"];
  systemRoot: string;
};
const writer = new WindowsFileDropClipboardWriter({
  platform: "win32",
  createOperationMarker: () => payload.marker,
  runHelper: (request, waitForWrite) => runPowerShellClipboardHelper(request, systemRoot, waitForWrite),
});
parentPort!.postMessage(await writer.copyFile(payload.path));
