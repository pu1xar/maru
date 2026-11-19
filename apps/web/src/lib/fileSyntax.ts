// Syntax colors for the file preview: `useFileSpans` hands a whole file to a Web Worker
// (`syntaxWorker.ts`) and returns its spans once they arrive. Until then the preview draws plain
// text, and the colors fill in without moving a line. One worker reads the files in turn; several
// previews (split view panes) queue their reads. A preview's read still running when its own
// file is replaced or closed ends with the worker (a running highlight cannot be interrupted),
// and the worker starts again for the next read in the queue.
import { useEffect, useState } from "react";

import type { SyntaxLanguage } from "./syntaxLanguages.ts";
import type { SyntaxSpans } from "./syntaxSpans.ts";
import type { SyntaxWorkerReply, SyntaxWorkerRequest } from "./syntaxWorker.ts";

interface Job {
  readonly request: SyntaxWorkerRequest;
  readonly settle: (spans: SyntaxSpans | null) => void;
}

let worker: Worker | null = null;
let nextId = 1;
/** The read the worker is doing now, and the reads waiting for it. */
let running: Job | null = null;
const queue: Job[] = [];

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL("./syntaxWorker.ts", import.meta.url), { type: "module" });
  created.onmessage = (event: MessageEvent<SyntaxWorkerReply>) => {
    if (running?.request.id !== event.data.id) return;
    const done = running;
    running = null;
    done.settle(event.data.spans);
    pump();
  };
  created.onerror = (event) => {
    console.warn("syntax worker failed", event.message);
    stopWorker();
    pump();
  };
  worker = created;
  return created;
}

/** Starts the next waiting read when the worker is free. */
function pump(): void {
  if (running || queue.length === 0) return;
  running = queue.shift()!;
  ensureWorker().postMessage(running.request);
}

/** Ends the worker and the read it is doing, which settles as null (plain text). */
function stopWorker(): void {
  worker?.terminate();
  worker = null;
  const done = running;
  running = null;
  done?.settle(null);
}

/** Reads `code` in the worker. Resolves null when cancelled, failed, or unreadable by the grammar. */
function highlightInWorker(code: string, language: SyntaxLanguage): { result: Promise<SyntaxSpans | null>; cancel: () => void } {
  const id = nextId++;
  let job: Job | null = null;
  const result = new Promise<SyntaxSpans | null>((resolve) => {
    job = { request: { id, code, language }, settle: resolve };
  });
  queue.push(job!);
  pump();
  return {
    result,
    cancel: () => {
      if (running?.request.id === id) {
        stopWorker();
        pump();
        return;
      }
      const at = queue.findIndex((j) => j.request.id === id);
      if (at >= 0) queue.splice(at, 1)[0]!.settle(null);
    },
  };
}

/**
 * The spans of `code` read as `language`, or null while the worker reads, for plain text, and when
 * the grammar could not read all of it. `code` must be the exact string the preview slices lines
 * from, since spans are offsets into it.
 */
export function useFileSpans(code: string, language: SyntaxLanguage | null): SyntaxSpans | null {
  const [state, setState] = useState<{ code: string; language: SyntaxLanguage; spans: SyntaxSpans } | null>(null);
  useEffect(() => {
    if (language === null || code.length === 0) return;
    const read = highlightInWorker(code, language);
    let live = true;
    void read.result.then((spans) => {
      if (live && spans) setState({ code, language, spans });
    });
    return () => {
      live = false;
      read.cancel();
    };
  }, [code, language]);
  return state !== null && state.code === code && state.language === language ? state.spans : null;
}
