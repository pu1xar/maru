// Attachments in the terminal mode (DESIGN.md 6n), drawn the way the Claude Code CLI names a pasted
// picture: `[Image #1]`. The CLI writes that placeholder into the prompt; here the text stays the
// user's and each waiting attachment gets its own line over the input's top rule, with the same
// paste, drop and upload as the chat composer (lib/composerAttachments.ts). A sent message lists
// its attachments under its `❯` line. Colors and layout are `.term-*` rules in index.css.
import { useRef, useState } from "react";

import type { ComposerAttachment } from "~/lib/composerAttachments";
import { formatBytes, terminalAttachmentLabel, type SentAttachment } from "~/lib/composerAttachments.logic";
import { useFileOpen } from "~/rightPanel";
import { ImagePreviewDialog, type PreviewImage } from "../chat/ImagePreviewDialog";

/** The n-th label of each kind, counting pictures and files apart (`[Image #2]` is the second picture). */
function labels<T>(items: readonly T[], kindOf: (t: T) => "image" | "file", nameOf: (t: T) => string): string[] {
  let images = 0;
  let files = 0;
  return items.map((t) => (kindOf(t) === "image" ? terminalAttachmentLabel("image", ++images, nameOf(t)) : terminalAttachmentLabel("file", ++files, nameOf(t))));
}

/** One line per waiting attachment: label, name, size or progress, remove. */
export function TerminalAttachmentLines(props: { items: readonly ComposerAttachment[]; onRemove: (localId: string) => void }) {
  const [preview, setPreview] = useState<number | null>(null);
  if (props.items.length === 0) return null;
  // The server's word once uploaded (a picture it sends by path is a file); the local guess before.
  const kindOf = (a: ComposerAttachment) => a.uploaded?.kind ?? (a.previewUrl !== null ? "image" : "file");
  const names = labels(props.items, kindOf, (a) => a.name);
  const pictures = props.items.filter((a) => kindOf(a) === "image" && a.previewUrl !== null);
  const images: PreviewImage[] = pictures.map((a) => ({ src: a.previewUrl!, name: a.name }));
  return (
    <div className="term-attachments" data-composer-attachments="">
      {props.items.map((a, i) => {
        const state = a.status === "uploading"
          ? `${a.sizeBytes > 0 ? Math.min(99, Math.floor((a.sentBytes / a.sizeBytes) * 100)) : 0}%`
          : a.status === "failed" ? a.error ?? "Upload failed" : formatBytes(a.sizeBytes);
        const isPicture = pictures.includes(a);
        return (
          <div key={a.localId} className="term-attachment">
            {/* `.term-link-row` resets every property (all: unset), so the color goes on an inner span. */}
            {isPicture ? (
              <button type="button" className="term-link-row" onMouseDown={(e) => e.preventDefault()} onClick={() => setPreview(pictures.indexOf(a))}>
                <span className="term-accent">{names[i]}</span>
              </button>
            ) : (
              <span className="term-accent">{names[i]}</span>
            )}
            <span className="term-attachment-name">{isPicture ? ` ${a.name}` : ""}</span>
            <span className={a.status === "failed" ? "term-err" : a.uploaded?.notice ? "term-warn" : "term-dim"}>
              {`  ${a.uploaded?.notice ? `${state}, ${a.uploaded.notice}` : state}`}
            </span>
            <button type="button" className="term-link-row" aria-label={`Remove ${a.name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onRemove(a.localId)}>
              <span className="term-dim">{"  [x]"}</span>
            </button>
          </div>
        );
      })}
      {preview !== null ? <ImagePreviewDialog images={images} index={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** `[+ file]` in the footer: the system file chooser (the CLI has no button; a phone has no paste of files). */
export function TerminalAttachButton(props: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        data-composer-file-input=""
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          props.onFiles(files);
        }}
      />
      <button
        type="button"
        className="term-link-row"
        disabled={props.disabled}
        aria-label="Attach file"
        title="Attach file (paste or drag and drop also work)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
      >
        <span className="term-dim">[+ file]</span>
      </button>
    </>
  );
}

/** A sent message's attachments under its `❯` line: `⎿  [Image #1] name`, a picture opens large, a file opens in the panel. */
export function TerminalSentAttachments(props: { attachments: readonly SentAttachment[] }) {
  const open = useFileOpen();
  const [preview, setPreview] = useState<number | null>(null);
  if (props.attachments.length === 0) return null;
  const names = labels(props.attachments, (a) => a.kind, (a) => a.name);
  const pictures = props.attachments.filter((a) => a.url !== null);
  return (
    <div className="term-sent-attachments">
      {props.attachments.map((a, i) => {
        const act = a.url !== null ? () => setPreview(pictures.indexOf(a)) : a.path && open ? () => open({ path: a.path! }) : null;
        const label = a.kind === "image" ? `${names[i]} ${a.name}` : names[i];
        return (
          <div key={a.key} className="term-dim">
            {"⎿  "}
            {act ? (
              <button type="button" className="term-link-row" title={a.path ?? a.name} onClick={act}>
                {label}
              </button>
            ) : (
              <span title={a.path ?? a.name}>{label}</span>
            )}
          </div>
        );
      })}
      {preview !== null ? (
        <ImagePreviewDialog images={pictures.map((a) => ({ src: a.url!, name: a.name }))} index={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}
