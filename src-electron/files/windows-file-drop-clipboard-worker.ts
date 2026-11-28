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
  /** 親から受け取ったマーカーを引き継ぎ、書き込みと読み戻しで同じ操作を照合する。 */
  createOperationMarker: () => payload.marker,
  /** 親から指定された SystemRoot で PowerShell を起動し、読み戻しへ書き込み待ちを引き継ぐ。 */
  runHelper: (request, waitForWrite) =>
    runPowerShellClipboardHelper(request, systemRoot, waitForWrite),
});
parentPort!.postMessage(await writer.copyFile(payload.path));
