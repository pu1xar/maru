// The sidebar's search over every session's conversation (DESIGN.md 6u): under the sessions whose
// names match, the places in conversations that hold the same text, newest first. A row opens its
// session and the session's find at that place. The server pages the hits (GET /api/search);
// "더 보기" brings the next page.
import { useEffect, useRef, useState } from "react";
import type { SearchHit, SearchResponse, SessionSummary } from "@maru/shared";
import { hasSearchText, sessionDisplayName } from "@maru/shared";

import { cn } from "~/lib/utils";
import { DEFAULT_TIMESTAMP_FORMAT, formatChatTimestampTooltip, formatDayAwareTimestamp } from "~/timestampFormat";
import { Spinner } from "./ui/spinner";

/** How long typing pauses before the search goes out, ms. */
const SEARCH_DELAY_MS = 300;
/** Hits per page (a page size: "더 보기" brings the rest). */
const PAGE = 50;

let warmed = false;

/** Asks the server to catch its index up before the first search (the first pass reads every transcript). */
export function warmConversationSearch(): void {
  if (warmed) return;
  warmed = true;
  void fetch("/api/search?q=&limit=1").catch(() => {
    warmed = false;
  });
}

interface State {
  query: string;
  hits: SearchHit[];
  sessions: Map<string, SessionSummary>;
  total: number;
}

export function ConversationSearchResults({
  query,
  onOpen,
}: {
  query: string;
  onOpen: (hit: SearchHit, session: SessionSummary, query: string) => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = (q: string, offset: number) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    fetch(`/api/search?${new URLSearchParams({ q, offset: String(offset), limit: String(PAGE) })}`, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
        return (await r.json()) as SearchResponse;
      })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setState((prev) => {
          const keep = prev && prev.query === res.query && offset > 0;
          const sessions = new Map(keep ? prev.sessions : []);
          for (const s of res.sessions) sessions.set(s.key, s);
          return { query: res.query, hits: keep ? [...prev.hits, ...res.hits] : res.hits, sessions, total: res.total };
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  };

  useEffect(() => {
    if (!hasSearchText(query)) {
      abortRef.current?.abort();
      setState(null);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => load(query.trim(), 0), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!hasSearchText(query)) return null;
  const current = state && state.query === query.trim() ? state : null;
  return (
    <section aria-label="Found in conversations" data-conversation-search="" className="flex min-w-0 flex-col gap-px">
      <div className="flex items-center gap-2 px-2 pt-3 pb-1 text-xs font-medium text-sidebar-muted-foreground">
        <span>Found in conversations</span>
        {current ? <span className="tabular-nums" data-conversation-search-total="">{current.total}</span> : null}
        {loading ? <Spinner aria-hidden className="size-3" /> : null}
      </div>
      {error ? (
        <p role="status" className="px-2 py-2 text-xs text-destructive-foreground wrap-anywhere">
          {error}
        </p>
      ) : null}
      {current && current.total === 0 && !loading ? (
        <p role="status" className="px-2 py-2 text-xs text-sidebar-muted-foreground">
          No matches
        </p>
      ) : null}
      {current?.hits.map((hit, i) => {
        const session = current.sessions.get(hit.key);
        if (!session) return null;
        return <HitRow key={`${hit.key}:${hit.itemId ?? hit.at ?? ""}:${i}`} hit={hit} session={session} onOpen={() => onOpen(hit, session, current.query)} />;
      })}
      {current && current.hits.length < current.total ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => load(current.query, current.hits.length)}
          className="mx-2 my-1 rounded-md px-2 py-1 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:cursor-default"
        >
          {loading ? "Loading" : `Show more (${current.total - current.hits.length})`}
        </button>
      ) : null}
    </section>
  );
}

function HitRow({ hit, session, onOpen }: { hit: SearchHit; session: SessionSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-search-hit={hit.itemId ?? ""}
      className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <span className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">{sessionDisplayName(session)}</span>
        {hit.at ? (
          <time
            dateTime={hit.at}
            title={formatChatTimestampTooltip(hit.at, DEFAULT_TIMESTAMP_FORMAT)}
            className="shrink-0 tabular-nums text-sidebar-muted-foreground"
          >
            {formatDayAwareTimestamp(hit.at, DEFAULT_TIMESTAMP_FORMAT)}
          </time>
        ) : null}
      </span>
      <span className="line-clamp-2 text-xs text-sidebar-muted-foreground wrap-anywhere">
        <span className={cn("me-1 text-sidebar-foreground/70")}>{hit.role === "user" ? "You" : "Assistant"}</span>
        {hit.snippet.before}
        <mark className="rounded-sm bg-[oklch(0.915_0.11_85)] px-0.5 text-[oklch(0.216164_0.028283_77.423)] dark:bg-[oklch(0.55_0.1_85)] dark:text-[oklch(0.970151_0_0)]">
          {hit.snippet.match}
        </mark>
        {hit.snippet.after}
        {hit.count > 1 ? <span className="ms-1 tabular-nums">({hit.count})</span> : null}
      </span>
    </button>
  );
}
