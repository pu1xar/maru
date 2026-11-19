// Web Worker: reads one whole file with the highlighter and answers with spans (syntaxSpans.ts).
// The page's main thread stays free while a large file is read; its typed arrays move back
// without a copy. `fileSyntax.ts` owns the worker's lifetime.
import { highlightSyntax } from "./syntaxHighlight.ts";
import type { SyntaxLanguage } from "./syntaxLanguages.ts";
import { encodeSpans, type SyntaxSpans } from "./syntaxSpans.ts";

export interface SyntaxWorkerRequest {
  readonly id: number;
  readonly code: string;
  readonly language: SyntaxLanguage;
}

export interface SyntaxWorkerReply {
  readonly id: number;
  /** Null when the grammar could not read all of the code (it then stays plain). */
  readonly spans: SyntaxSpans | null;
  readonly ms: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<SyntaxWorkerRequest>) => void) | null;
  postMessage(message: SyntaxWorkerReply, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, code, language } = event.data;
  const started = performance.now();
  const tokens = highlightSyntax(code, language);
  const spans = tokens === null ? null : encodeSpans(tokens);
  scope.postMessage(
    { id, spans, ms: performance.now() - started },
    spans === null ? [] : [spans.starts.buffer, spans.roles.buffer],
  );
};
