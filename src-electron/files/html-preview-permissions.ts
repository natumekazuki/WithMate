import { desktopCapturer, webContents } from "electron";
import type { Session, WebContents, WebFrameMain } from "electron";
import { HTML_PREVIEW_SCHEME } from "../../src-shared/window/html-preview.js";

/** アプリ側の確認 UI に表示する要求内容と、回答の選択肢。 */
export interface HtmlPreviewPermissionPrompt {
  title: string;
  detail: string;
  choices: string[];
}

/** 確認 UI の呼び出しと、現在のマウントに属するコンテンツかどうかの判定を委ねる。 */
interface PermissionOptions {
  ask: (
    prompt: HtmlPreviewPermissionPrompt,
    signal: AbortSignal,
  ) => Promise<number | null>;
  isActive: () => boolean;
  ownsContents: (contents: WebContents) => boolean;
}

const labels: Record<string, string> = {
  media: "camera and microphone",
  geolocation: "location",
  notifications: "notifications",
  "clipboard-read": "clipboard reading",
  "clipboard-sanitized-write": "clipboard writing",
  "deprecated-sync-clipboard-read": "clipboard reading",
  "display-capture": "screen sharing",
  fullscreen: "fullscreen",
  pointerLock: "pointer lock",
  keyboardLock: "keyboard lock",
  fileSystem: "file access",
  midi: "MIDI devices",
  midiSysex: "MIDI system messages",
  "idle-detection": "idle state",
  "speaker-selection": "audio output selection",
  "window-management": "display information",
  "storage-access": "cross-site cookie access",
  "top-level-storage-access": "third-party cookie access",
  mediaKeySystem: "protected media",
};

/** 標準のオリジン表記を優先し、ホスト付き URL では必要に応じてスキームとホストを組み立てる。 */
function origin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin !== "null"
      ? parsed.origin
      : parsed.host
        ? `${parsed.protocol}//${parsed.host}`
        : "null";
  } catch {
    return "null";
  }
}

/** 権限確認 UI は、マウント専用に隔離されたインメモリの Session にだけ設定する。 */
export function installHtmlPreviewPermissions(
  session: Session,
  options: PermissionOptions,
) {
  let disposed = false;
  const attachments = new Map<
    WebContents,
    { generation: number; cleanup: () => void }
  >();
  const grants = new Map<WebFrameMain, Set<string>>();
  const pending = new Set<() => void>();
  /** 破棄済みのコンテンツや、マウントの管理外にあるコンテンツの要求を除外する。 */
  const active = (contents: WebContents) =>
    !disposed &&
    options.isActive() &&
    !contents.isDestroyed() &&
    options.ownsContents(contents);

  /** 確認待ちの間に要求元フレームの URL やナビゲーション世代が変わっていないかを再判定できるようにする。 */
  function frameGuard(frame: WebFrameMain | null) {
    if (!frame || frame.detached) return null;
    const contents = webContents.fromFrame(frame);
    if (!contents || !active(contents)) return null;
    attachContents(contents);
    const generation = attachments.get(contents)!.generation;
    const url = frame.url;
    return () =>
      active(contents) &&
      !frame.detached &&
      frame.url === url &&
      attachments.get(contents)?.generation === generation;
  }

  /** Electron の要求情報と一致する生存フレームが一つに定まる場合にだけ返す。 */
  function findFrame(
    contents: WebContents,
    url: string | undefined,
    isMainFrame: boolean,
    requestingOrigin?: string,
  ) {
    if (!active(contents)) return null;
    const frames = isMainFrame
      ? [contents.mainFrame]
      : contents.mainFrame.framesInSubtree.filter(
          (frame) => frame !== contents.mainFrame,
        );
    const matching = frames.filter(
      (frame) =>
        !frame.detached &&
        (!url || frame.url === url) &&
        (!requestingOrigin || origin(frame.url) === origin(requestingOrigin)),
    );
    return matching.length === 1 ? matching[0]! : null;
  }

  /** 遷移や破棄でも既定の拒否値で応答できる、取消可能な一回限りの完了処理を作る。 */
  function complete<T>(callback: (value: T) => void, denied: T) {
    let done = false;
    const controller = new AbortController();
    /** 確認 UI に取消を通知し、Electron 側にも拒否を返す。 */
    const cancel = () => {
      controller.abort();
      finish(denied);
    };
    /** 待機中の取消処理を解除して、Electron のコールバックに一度だけ結果を渡す。 */
    function finish(value: T) {
      if (done) return;
      done = true;
      pending.delete(cancel);
      callback(value);
    }
    pending.add(cancel);
    return Object.assign(finish, { signal: controller.signal });
  }

  /** 要求元を示して確認し、回答時もフレームが有効で選択番号が範囲内の場合に限り採用する。 */
  async function choose(
    frame: WebFrameMain | null,
    signal: AbortSignal,
    title: string,
    choices: string[],
    detail = "",
    attribution = "Requested by",
  ) {
    const valid = frameGuard(frame);
    if (!valid || !frame || signal.aborted || choices.length === 0) return null;
    const selected = await options.ask(
      {
        title,
        detail: `${attribution}: ${origin(frame.url)}${detail ? `\n${detail}` : ""}`,
        choices,
      },
      signal,
    );
    return !signal.aborted &&
      valid() &&
      selected !== null &&
      Number.isInteger(selected) &&
      selected >= 0 &&
      selected < choices.length
      ? selected
      : null;
  }

  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (!contents && (permission === "usb" || permission === "hid")) {
        const requested = details.securityOrigin ?? requestingOrigin;
        let requester: string;
        try {
          const parsed = new URL(requested);
          // カスタムスキームのうち、不透明でないオリジンを持つのはアプリが標準スキームとして登録したものだけ。
          if (
            parsed.origin === "null" &&
            (parsed.protocol !== `${HTML_PREVIEW_SCHEME}:` || !parsed.host)
          )
            return false;
          requester = origin(requested);
        } catch {
          return false;
        }
        // 明示的に選ばれたデバイスへのアクセスは、引き続きネイティブ側の許可で決まる。
        // ここではオリジンだけを確認し、このマウント内で有効なページが選択画面を開けるようにする。
        return [...attachments.keys()].some(
          (page) =>
            active(page) &&
            page.mainFrame.framesInSubtree.some(
              (frame) => !frame.detached && origin(frame.url) === requester,
            ),
        );
      }
      if (!contents) return false;
      const frame = findFrame(
        contents,
        details.requestingUrl,
        details.isMainFrame,
        details.securityOrigin ?? requestingOrigin,
      );
      if (!frame) return false;
      // ここで許可するのは選択画面であり、デバイスへのアクセスではない。Chromium が保持するのは明示的に選ばれたデバイスだけ。
      if (
        permission === "usb" ||
        permission === "hid" ||
        permission === "serial"
      )
        return true;
      const key =
        permission === "media"
          ? `media:${details.mediaType ?? "unknown"}`
          : permission;
      return grants.get(frame)?.has(key) ?? false;
    },
  );

  session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const finish = complete<boolean>(callback, false);
      const frame = findFrame(
        contents,
        details.requestingUrl,
        details.isMainFrame,
        "securityOrigin" in details ? details.securityOrigin : undefined,
      );
      const valid = frameGuard(frame);
      if (!valid || !frame) {
        finish(false);
        return;
      }
      const types =
        permission === "media" && "mediaTypes" in details
          ? (details.mediaTypes ?? [])
          : [];
      const label =
        permission === "media" && types.length
          ? types
              .map((type) => (type === "video" ? "camera" : "microphone"))
              .join(" and ")
          : (labels[permission] ?? `web permission (${permission})`);
      const detail =
        "filePath" in details
          ? `File: ${details.filePath}\nAccess: ${details.fileAccessType}`
          : "";
      void choose(
        frame,
        finish.signal,
        `Allow ${label}?`,
        ["Allow", "Deny"],
        detail,
      ).then(
        (selected) => {
          const allowed = selected === 0 && valid();
          if (
            allowed &&
            permission !== "fileSystem" &&
            permission !== "display-capture"
          ) {
            const approved = grants.get(frame) ?? new Set<string>();
            if (permission === "media")
              types.forEach((type) => approved.add(`media:${type}`));
            else approved.add(permission);
            grants.set(frame, approved);
          }
          finish(allowed);
        },
        () => finish(false),
      );
    },
  );

  session.setDisplayMediaRequestHandler((request, callback) => {
    const finish = complete<Electron.Streams>(callback, {});
    const valid = frameGuard(request.frame);
    if (
      !valid ||
      !request.userGesture ||
      !request.videoRequested ||
      !request.frame ||
      origin(request.frame.url) !== origin(request.securityOrigin)
    ) {
      finish({});
      return;
    }
    void (async () => {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (finish.signal.aborted || !valid()) {
        finish({});
        return;
      }
      const selected = await choose(
        request.frame,
        finish.signal,
        "Choose a screen or window to share",
        sources.map((source) => `${source.name} (${source.id})`),
      );
      if (selected === null || !valid()) {
        finish({});
        return;
      }
      let audio: "loopback" | undefined;
      if (request.audioRequested && process.platform === "win32") {
        const sound = await choose(
          request.frame,
          finish.signal,
          "Also share system audio?",
          ["Share audio", "Share video only"],
        );
        if (sound === null || !valid()) {
          finish({});
          return;
        }
        if (sound === 0) audio = "loopback";
      }
      if (valid())
        finish({ video: sources[selected]!, ...(audio ? { audio } : {}) });
      else finish({});
    })().catch(() => finish({}));
  });

  /** 選択したデバイスの識別子を返す。要求元フレームが特定できない種類ではページ全体を確認先として示す。 */
  function selectDevice(
    frame: WebFrameMain | null,
    title: string,
    devices: { id: string; name: string }[],
    callback: (id: string) => void,
    page?: WebContents,
  ) {
    const finish = complete<string>(callback, "");
    // Serial と Bluetooth のイベントには要求元のフレームが含まれない。
    // フォーカス中のフレームの要求と決めつけず、埋め込みオリジンも含めてページ全体を特定する。
    const embeddedOrigins = page
      ? [
          ...new Set(
            page.mainFrame.framesInSubtree
              .filter((child) => child !== page.mainFrame && !child.detached)
              .map((child) => origin(child.url)),
          ),
        ]
      : [];
    const detail = page
      ? `Electron does not identify which frame requested this device.${
          embeddedOrigins.length
            ? `\nEmbedded origins: ${embeddedOrigins.join(", ")}`
            : ""
        }`
      : "";
    void choose(
      frame,
      finish.signal,
      title,
      devices.map((device) => `${device.name} (${device.id})`),
      detail,
      page ? "Requesting page (including embedded frames)" : "Requested by",
    ).then(
      (selected) => finish(selected === null ? "" : devices[selected]!.id),
      () => finish(""),
    );
  }

  /** USB の既定選択を止め、要求元フレームを示す確認 UI に候補を渡す。 */
  const usb = (
    event: Electron.Event,
    details: Electron.SelectUsbDeviceDetails,
    callback: (id?: string) => void,
  ) => {
    event.preventDefault();
    selectDevice(
      details.frame,
      "Choose a USB device",
      details.deviceList.map((device) => ({
        id: device.deviceId,
        name: device.productName ?? "USB device",
      })),
      callback,
    );
  };
  /** HID の既定選択を止め、要求元フレームを示す確認 UI に候補を渡す。 */
  const hid = (
    event: Electron.Event,
    details: Electron.SelectHidDeviceDetails,
    callback: (id?: string) => void,
  ) => {
    event.preventDefault();
    selectDevice(
      details.frame,
      "Choose an HID device",
      details.deviceList.map((device) => ({
        id: device.deviceId,
        name: device.name,
      })),
      callback,
    );
  };
  /** 現在のマウントに属するページに限り、ページを示してシリアルポートの選択を求める。 */
  const serial = (
    event: Electron.Event,
    ports: Electron.SerialPort[],
    contents: WebContents,
    callback: (id: string) => void,
  ) => {
    event.preventDefault();
    if (!active(contents)) {
      callback("");
      return;
    }
    selectDevice(
      contents.mainFrame,
      "Choose a serial port",
      ports.map((port) => ({
        id: port.portId,
        name: port.displayName ?? port.portName,
      })),
      callback,
      contents,
    );
  };
  session.on("select-usb-device", usb);
  session.on("select-hid-device", hid);
  session.on("select-serial-port", serial);

  /** 管理対象のコンテンツに、許可を失効させる監視と Bluetooth の選択処理を一度だけ登録する。 */
  function attachContents(contents: WebContents) {
    if (!active(contents) || attachments.has(contents)) return;
    const entry = {
      generation: 0,
      /** イベント登録が完了した時点で、登録を解除する処理に差し替える。 */
      cleanup: () => {},
    };
    let choosingBluetooth = false;
    /** 遷移または破棄で世代を進め、マウント内の許可と未回答の確認を失効させる。 */
    const navigation = () => {
      entry.generation += 1;
      grants.clear();
      for (const cancel of [...pending]) cancel();
    };
    /** 候補がある場合のみページ単位で選択を求め、確認待ちの再通知ではダイアログを重ねない。 */
    const bluetooth = (
      event: Electron.Event,
      devices: Electron.BluetoothDevice[],
      callback: (id: string) => void,
    ) => {
      event.preventDefault();
      if (choosingBluetooth || devices.length === 0) return;
      choosingBluetooth = true;
      selectDevice(
        contents.mainFrame,
        "Choose a Bluetooth device",
        devices.map((device) => ({
          id: device.deviceId,
          name: device.deviceName,
        })),
        (id) => {
          choosingBluetooth = false;
          callback(id);
        },
        contents,
      );
    };
    contents.on("did-start-navigation", navigation);
    contents.on("destroyed", navigation);
    contents.on("select-bluetooth-device", bluetooth);
    entry.cleanup = () => {
      contents.off("did-start-navigation", navigation);
      contents.off("destroyed", navigation);
      contents.off("select-bluetooth-device", bluetooth);
    };
    attachments.set(contents, entry);
  }

  /** マウントの終了時に未回答の要求を取り消し、許可と Electron のイベント登録を解放する。 */
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const cancel of [...pending]) cancel();
    for (const entry of attachments.values()) entry.cleanup();
    attachments.clear();
    grants.clear();
    session.setPermissionRequestHandler(null);
    session.setPermissionCheckHandler(null);
    session.setDisplayMediaRequestHandler(null);
    session.off("select-usb-device", usb);
    session.off("select-hid-device", hid);
    session.off("select-serial-port", serial);
  };
  cleanup.attachContents = attachContents;
  return cleanup;
}
