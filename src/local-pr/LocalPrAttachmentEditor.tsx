import { useRef, useState, type ClipboardEvent } from "react";
import {
  formatMarkdownImageReference,
  isSupportedComposerImagePath,
} from "../../src-shared/files/composer-image-reference.js";
import type { LocalPrWindowApi } from "../../src-shared/local-pr/local-pr-contract.js";
import { ComposerIcon } from "../chat/composer/composer-icon.js";
import { ButtonContent } from "../ui/button-content.js";

/** 既存ファイルをコピーしたり Session Files を使ったりせず、PR にファイル参照を挿入する。 */
export function LocalPrAttachmentEditor({
  api,
  text,
  onChange,
  disabled,
  onBusyChange,
}: {
  api: LocalPrWindowApi;
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 選択範囲を Markdown のリンクまたは画像参照で置き換える。 */
  function insert(paths: string[], start: number, end: number) {
    if (!paths.length) return;
    const links = paths
      .map((path) => {
        const image = formatMarkdownImageReference(path);
        return isSupportedComposerImagePath(path) ? image : image.slice(1);
      })
      .join("\n");
    const before = text.slice(0, start);
    const after = text.slice(end);
    const insertion = `${before && !/\s$/.test(before) ? "\n" : ""}${links}${after && !/^\s/.test(after) ? "\n" : ""}`;
    const result = before + insertion + after;
    if (result.length > 20000)
      throw new Error(
        "The attachment reference exceeds the description length limit.",
      );
    onChange(result);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(
        start + insertion.length,
        start + insertion.length,
      );
    });
  }

  /** 既存ファイルは元のパスのまま使う。クリップボードのバイト列だけが新規ファイルを必要とする。 */
  async function attach(files?: File[]) {
    const start = field.current?.selectionStart ?? text.length;
    const end = field.current?.selectionEnd ?? start;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const paths = files
        ? await Promise.all(
            files.map(async (file) => {
              const original = api.clipboardFilePath(file);
              return (
                original ||
                api.saveClipboardImage({
                  mimeType: file.type,
                  data: await file.arrayBuffer(),
                })
              );
            }),
          )
        : await api.pickAttachment();
      insert(paths, start, end);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  /** クリップボードにファイルがある場合だけ添付処理へ渡し、通常のテキスト貼り付けは妨げない。 */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const directFiles = Array.from(event.clipboardData.files);
    const files = directFiles.length
      ? directFiles
      : Array.from(event.clipboardData.items)
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    void attach(files);
  }

  return (
    <>
      <textarea
        ref={field}
        disabled={disabled || busy}
        aria-labelledby="local-pr-description-label"
        value={text}
        maxLength={20000}
        onChange={(event) => onChange(event.target.value)}
        onPaste={paste}
      />
      <button
        type="button"
        className="drawer-toggle compact secondary composer-attachment-trigger composer-icon-button"
        disabled={disabled || busy}
        aria-label="Attach Files"
        title="Attach Files"
        aria-busy={busy || undefined}
        onClick={() => void attach()}
      >
        <ButtonContent busy={busy}>
          <ComposerIcon name="attach" />
          <span className="visually-hidden">Attach Files</span>
        </ButtonContent>
      </button>
      {error && (
        <p className="local-pr-warning" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
