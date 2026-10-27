import { desktopCapturer, webContents } from "electron";
import type { Session, WebContents, WebFrameMain } from "electron";

export interface HtmlPreviewPermissionPrompt {
  title: string;
  detail: string;
  choices: string[];
}

interface PermissionOptions {
  ask: (prompt: HtmlPreviewPermissionPrompt) => Promise<number | null>;
  isActive: () => boolean;
  ownsContents: (contents: WebContents) => boolean;
}

const labels: Record<string, string> = {
  media: "camera and microphone", geolocation: "location", notifications: "notifications",
  "clipboard-read": "clipboard reading",
  "clipboard-sanitized-write": "clipboard writing",
  "deprecated-sync-clipboard-read": "clipboard reading",
  "display-capture": "screen sharing", fullscreen: "fullscreen", pointerLock: "pointer lock",
  keyboardLock: "keyboard lock", fileSystem: "file access",
  midi: "MIDI devices", midiSysex: "MIDI system messages", "idle-detection": "idle state",
  "speaker-selection": "audio output selection", "window-management": "display information",
  "storage-access": "cross-site cookie access",
  "top-level-storage-access": "third-party cookie access", mediaKeySystem: "protected media",
};

function origin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin !== "null" ? parsed.origin : parsed.host ? `${parsed.protocol}//${parsed.host}` : "null";
  } catch { return "null"; }
}

/** Installs permission UI only on the mount's isolated, in-memory Session. */
export function installHtmlPreviewPermissions(session: Session, options: PermissionOptions) {
  let disposed = false;
  const attachments = new Map<WebContents, { generation: number; cleanup: () => void }>();
  const grants = new Map<WebFrameMain, Set<string>>();
  const pending = new Set<() => void>();
  const active = (contents: WebContents) => !disposed && options.isActive()
    && !contents.isDestroyed() && options.ownsContents(contents);

  function frameGuard(frame: WebFrameMain | null) {
    if (!frame || frame.detached) return null;
    const contents = webContents.fromFrame(frame);
    if (!contents || !active(contents)) return null;
    attachContents(contents);
    const generation = attachments.get(contents)!.generation;
    const url = frame.url;
    return () => active(contents) && !frame.detached && frame.url === url
      && attachments.get(contents)?.generation === generation;
  }

  function findFrame(contents: WebContents, url: string | undefined, isMainFrame: boolean, requestingOrigin?: string) {
    if (!active(contents)) return null;
    const frames = isMainFrame ? [contents.mainFrame] : contents.mainFrame.framesInSubtree.filter((frame) => frame !== contents.mainFrame);
    const matching = frames.filter((frame) => !frame.detached && (!url || frame.url === url)
      && (!requestingOrigin || origin(frame.url) === origin(requestingOrigin)));
    return matching.length === 1 ? matching[0]! : null;
  }

  function complete<T>(callback: (value: T) => void, denied: T) {
    let done = false;
    const cancel = () => finish(denied);
    function finish(value: T) {
      if (done) return;
      done = true;
      pending.delete(cancel);
      callback(value);
    }
    pending.add(cancel);
    return finish;
  }

  async function choose(frame: WebFrameMain | null, title: string, choices: string[], detail = "", attribution = "Requested by") {
    const valid = frameGuard(frame);
    if (!valid || !frame || choices.length === 0) return null;
    const selected = await options.ask({ title, detail: `${attribution}: ${origin(frame.url)}${detail ? `\n${detail}` : ""}`, choices });
    return valid() && selected !== null && Number.isInteger(selected) && selected >= 0 && selected < choices.length ? selected : null;
  }

  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!contents) return false;
    const frame = findFrame(contents, details.requestingUrl, details.isMainFrame, details.securityOrigin ?? requestingOrigin);
    if (!frame) return false;
    // These checks enable a chooser, not device access. Chromium retains only explicitly selected devices.
    if (permission === "usb" || permission === "hid" || permission === "serial") return true;
    const key = permission === "media" ? `media:${details.mediaType ?? "unknown"}` : permission;
    return grants.get(frame)?.has(key) ?? false;
  });

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const finish = complete<boolean>(callback, false);
    const frame = findFrame(contents, details.requestingUrl, details.isMainFrame,
      "securityOrigin" in details ? details.securityOrigin : undefined);
    const valid = frameGuard(frame);
    if (!valid || !frame) { finish(false); return; }
    const types = permission === "media" && "mediaTypes" in details ? details.mediaTypes ?? [] : [];
    const label = permission === "media" && types.length
      ? types.map((type) => type === "video" ? "camera" : "microphone").join(" and ") : labels[permission] ?? `web permission (${permission})`;
    const detail = "filePath" in details ? `File: ${details.filePath}\nAccess: ${details.fileAccessType}` : "";
    void choose(frame, `Allow ${label}?`, ["Allow", "Deny"], detail).then((selected) => {
      const allowed = selected === 0 && valid();
      if (allowed && permission !== "fileSystem" && permission !== "display-capture") {
        const approved = grants.get(frame) ?? new Set<string>();
        if (permission === "media") types.forEach((type) => approved.add(`media:${type}`));
        else approved.add(permission);
        grants.set(frame, approved);
      }
      finish(allowed);
    }, () => finish(false));
  });

  session.setDisplayMediaRequestHandler((request, callback) => {
    const finish = complete<Electron.Streams>(callback, {});
    const valid = frameGuard(request.frame);
    if (!valid || !request.userGesture || !request.videoRequested
      || !request.frame || origin(request.frame.url) !== origin(request.securityOrigin)) { finish({}); return; }
    void (async () => {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
      if (!valid()) { finish({}); return; }
      const selected = await choose(request.frame, "Choose a screen or window to share", sources.map((source) => `${source.name} (${source.id})`));
      if (selected === null || !valid()) { finish({}); return; }
      let audio: "loopback" | undefined;
      if (request.audioRequested && process.platform === "win32") {
        const sound = await choose(request.frame, "Also share system audio?", ["Share audio", "Share video only"]);
        if (sound === null || !valid()) { finish({}); return; }
        if (sound === 0) audio = "loopback";
      }
      if (valid()) finish({ video: sources[selected]!, ...(audio ? { audio } : {}) });
      else finish({});
    })().catch(() => finish({}));
  });

  function selectDevice(frame: WebFrameMain | null, title: string, devices: { id: string; name: string }[], callback: (id: string) => void, page?: WebContents) {
    const finish = complete<string>(callback, "");
    // Serial and Bluetooth events omit the requesting frame. Identify the whole page,
    // including its embedded origins, rather than misattribute a request to its focused frame.
    const embeddedOrigins = page ? [...new Set(page.mainFrame.framesInSubtree
      .filter((child) => child !== page.mainFrame && !child.detached).map((child) => origin(child.url)))] : [];
    const detail = page ? `Electron does not identify which frame requested this device.${embeddedOrigins.length
      ? `\nEmbedded origins: ${embeddedOrigins.join(", ")}` : ""}` : "";
    void choose(frame, title, devices.map((device) => `${device.name} (${device.id})`), detail,
      page ? "Requesting page (including embedded frames)" : "Requested by").then(
      (selected) => finish(selected === null ? "" : devices[selected]!.id), () => finish(""));
  }

  const usb = (event: Electron.Event, details: Electron.SelectUsbDeviceDetails, callback: (id?: string) => void) => {
    event.preventDefault();
    selectDevice(details.frame, "Choose a USB device", details.deviceList.map((device) => ({ id: device.deviceId, name: device.productName ?? "USB device" })), callback);
  };
  const hid = (event: Electron.Event, details: Electron.SelectHidDeviceDetails, callback: (id?: string) => void) => {
    event.preventDefault();
    selectDevice(details.frame, "Choose an HID device", details.deviceList.map((device) => ({ id: device.deviceId, name: device.name })), callback);
  };
  const serial = (event: Electron.Event, ports: Electron.SerialPort[], contents: WebContents, callback: (id: string) => void) => {
    event.preventDefault();
    if (!active(contents)) { callback(""); return; }
    selectDevice(contents.mainFrame, "Choose a serial port", ports.map((port) => ({ id: port.portId, name: port.displayName ?? port.portName })), callback, contents);
  };
  session.on("select-usb-device", usb);
  session.on("select-hid-device", hid);
  session.on("select-serial-port", serial);

  function attachContents(contents: WebContents) {
    if (!active(contents) || attachments.has(contents)) return;
    const entry = { generation: 0, cleanup: () => {} };
    let choosingBluetooth = false;
    const navigation = () => {
      entry.generation += 1;
      grants.clear();
      for (const cancel of [...pending]) cancel();
    };
    const bluetooth = (event: Electron.Event, devices: Electron.BluetoothDevice[], callback: (id: string) => void) => {
      event.preventDefault();
      if (choosingBluetooth || devices.length === 0) return;
      choosingBluetooth = true;
      selectDevice(contents.mainFrame, "Choose a Bluetooth device", devices.map((device) => ({ id: device.deviceId, name: device.deviceName })), (id) => {
        choosingBluetooth = false;
        callback(id);
      }, contents);
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
