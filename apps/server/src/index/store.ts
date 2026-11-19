import type { IndexEvent, SessionSummary } from "@maru/shared";

type Listener = (e: IndexEvent) => void;

/**
 * In-memory session index fed by the provider sources. Emits only real changes.
 * `annotate` adds what the providers do not know (the user's project assignment).
 */
export class SessionIndex {
  private sessions = new Map<string, SessionSummary>();
  /** Provider output before annotation, kept so a re-annotation can start from it. */
  private raw = new Map<string, SessionSummary>();
  private listeners = new Set<Listener>();
  private annotate: (s: SessionSummary) => SessionSummary;

  constructor(annotate: (s: SessionSummary) => SessionSummary = (s) => s) {
    this.annotate = annotate;
  }

  apply(e: IndexEvent): void {
    if (e.type === "upsert") {
      this.raw.set(e.session.key, e.session);
      this.put(this.annotate(e.session));
    } else {
      this.raw.delete(e.key);
      if (!this.sessions.delete(e.key)) return;
      this.emit(e);
    }
  }

  /** Re-run the annotation for sessions matching `pick` (e.g. after an assignment change). */
  reannotate(pick: (s: SessionSummary) => boolean): void {
    for (const s of this.raw.values()) {
      if (pick(s)) this.put(this.annotate(s));
    }
  }

  private put(s: SessionSummary): void {
    const prev = this.sessions.get(s.key);
    if (prev && sameSummary(prev, s)) return;
    this.sessions.set(s.key, s);
    this.emit({ type: "upsert", session: s });
  }

  private emit(e: IndexEvent): void {
    for (const l of this.listeners) l(e);
  }

  snapshot(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(key: string): SessionSummary | undefined {
    return this.sessions.get(key);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

function sameSummary(a: SessionSummary, b: SessionSummary): boolean {
  const ka = Object.keys(a) as (keyof SessionSummary)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}
