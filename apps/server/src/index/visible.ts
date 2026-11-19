import type { IndexEvent, ProviderId, SessionSummary } from "@maru/shared";
import type { ChosenStore } from "../state/chosen.ts";
import type { SessionIndex } from "./store.ts";

type Listener = (e: IndexEvent) => void;

/**
 * The part of the index the UI sees: the chosen sessions and the subagent threads under them
 * (DESIGN.md 6d). Turns index events and choice changes into upserts and removes of that set.
 */
export class VisibleIndex {
  private index: SessionIndex;
  private chosen: ChosenStore;
  private visible = new Set<string>();
  private listeners = new Set<Listener>();

  constructor(index: SessionIndex, chosen: ChosenStore) {
    this.index = index;
    this.chosen = chosen;
    for (const s of index.snapshot()) if (this.isVisible(s)) this.visible.add(s.key);
    index.subscribe((e) => this.onIndex(e));
    chosen.onChange(() => this.recompute());
  }

  isVisible(s: SessionSummary): boolean {
    if (this.chosen.has(s.provider, s.id)) return true;
    const parent = parseKey(s.parentKey);
    return parent !== null && this.chosen.has(parent.provider, parent.id);
  }

  snapshot(): SessionSummary[] {
    return this.index.snapshot().filter((s) => this.visible.has(s.key));
  }

  /** Top-level sessions not in the list, most recent first, for the "add a session" search. */
  candidates(query: string): SessionSummary[] {
    const q = query.trim().toLowerCase();
    return this.index.snapshot().filter((s) => {
      if (s.parentKey || this.visible.has(s.key)) return false;
      if (!q) return true;
      return [s.name, s.title, s.preview, s.cwd, s.id, s.account].some((v) => v && v.toLowerCase().includes(q));
    });
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: IndexEvent): void {
    for (const l of this.listeners) l(e);
  }

  private onIndex(e: IndexEvent): void {
    if (e.type === "remove") {
      if (this.visible.delete(e.key)) this.emit(e);
      return;
    }
    const show = this.isVisible(e.session);
    if (show) {
      this.visible.add(e.session.key);
      this.emit(e);
    } else if (this.visible.delete(e.session.key)) {
      this.emit({ type: "remove", key: e.session.key });
    }
  }

  private recompute(): void {
    for (const s of this.index.snapshot()) {
      const show = this.isVisible(s);
      const was = this.visible.has(s.key);
      if (show && !was) {
        this.visible.add(s.key);
        this.emit({ type: "upsert", session: s });
      } else if (!show && was) {
        this.visible.delete(s.key);
        this.emit({ type: "remove", key: s.key });
      }
    }
  }
}

function parseKey(key: string | null): { provider: ProviderId; id: string } | null {
  if (!key) return null;
  const m = /^(claude|codex):[^:]+:(.+)$/.exec(key);
  return m ? { provider: m[1] as ProviderId, id: m[2]! } : null;
}
