// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: the dialog layout of components/AddProjectToMachineDialog.tsx (header, panel, list,
// footer, MiddleTruncate for paths). Local change: it searches the sessions outside the user's
// list (DESIGN.md 6d) and adds the ones picked; the list itself changes when the server's update
// arrives over /ws.
import type { SessionSummary } from "@maru/shared";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { STATUS_LABEL, displayName, relativeTime, shortPath } from "~/model";
import { chooseSession, describeError, fetchSessionCandidates } from "~/projectsApi";
import { ClaudeAI, OpenAI } from "./Icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { MiddleTruncate } from "./ui/middle-truncate";

/** One page of the search answer; "Show more" fetches the next. */
const PAGE = 50;

export function AddSessionDialog(props: { open: boolean; onClose: () => void; now: number }) {
  const { open, onClose, now } = props;
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const load = async (q: string, offset: number) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchSessionCandidates(q, offset, PAGE);
      if (mine !== seq.current) return;
      setRows((prev) => (offset === 0 ? page.sessions : [...prev, ...page.sessions]));
      setTotal(page.total);
    } catch (err) {
      if (mine === seq.current) setError(describeError(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches from the server as the query changes
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(query, 0), query ? 200 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  const add = async (s: SessionSummary) => {
    try {
      await chooseSession({ provider: s.provider, id: s.id, chosen: true });
      setAdded((prev) => new Set(prev).add(s.key));
    } catch (err) {
      setError(`Could not add to the list: ${describeError(err)}`);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setQuery("");
          setRows([]);
          setAdded(new Set());
          setError(null);
        }
      }}
    >
      <DialogPopup className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add session</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {/* The search icon sits at the input's start, inside its border (T3 MenuSearchInput). */}
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute start-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              nativeInput
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Name, first prompt, path, ID"
              aria-label="Search sessions"
              autoComplete="off"
              autoFocus
              className="[&_input]:ps-8"
            />
          </div>
          {error ? (
            <p role="alert" className="text-destructive-foreground text-sm">
              {error}
            </p>
          ) : null}
          <ul className="-mx-2 flex max-h-[min(60vh,32rem)] flex-col overflow-y-auto" aria-label="Sessions you can add">
            {rows.map((s) => {
              const done = added.has(s.key);
              return (
                <li key={s.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40">
                  {s.provider === "claude" ? (
                    <ClaudeAI className="size-3.5 shrink-0" />
                  ) : (
                    <OpenAI className="size-3.5 shrink-0" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{displayName(s)}</span>
                    {/* Time, account and state stay whole; only the path gives way, from its middle. */}
                    <span className="flex min-w-0 gap-1.5 text-muted-foreground text-xs">
                      <span className="shrink-0">
                        {relativeTime(s.updatedAt, now)}, {s.account}
                        {s.status !== "closed" ? `, ${STATUS_LABEL[s.status]}` : ""}
                      </span>
                      <MiddleTruncate className="min-w-0 font-mono" value={shortPath(s.cwd)} />
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant={done ? "ghost" : "outline"}
                    disabled={done}
                    onClick={() => void add(s)}
                    aria-label={done ? "Added" : `Add ${displayName(s)}`}
                  >
                    {done ? <CheckIcon /> : <PlusIcon />}
                    {done ? "Added" : "Add"}
                  </Button>
                </li>
              );
            })}
            {!loading && rows.length === 0 ? (
              <li className="px-2 py-6 text-center text-muted-foreground text-sm">
                {query ? "No matching sessions" : "No sessions to add"}
              </li>
            ) : null}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <span className="me-auto self-center text-muted-foreground text-xs">
            {loading ? "Searching" : `${rows.length} / ${total}`}
          </span>
          {rows.length < total ? (
            <Button type="button" variant="outline" disabled={loading} onClick={() => void load(query, rows.length)}>
              Show more
            </Button>
          ) : null}
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
