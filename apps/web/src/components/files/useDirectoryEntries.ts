// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Source: apps/web/src/components/files/useDirectoryEntries.ts (one listing per folder, read when
// the tree needs it, four reads at a time with the rest queued, one read per folder in flight and
// a refresh asked during one runs after it, a listing whose folder went away is dropped, refresh
// re-reads every folder read so far that the root still reaches, an error is shown for a folder
// the root reaches).
// Local changes: a folder is read with GET /api/file/tree (DESIGN.md 6e) instead of an Effect
// atom query, and the listings are fileTree.ts maps keyed by tree path. Answers are applied as
// they come and shown once per animation frame, so "expand all" over thousands of folders renders
// the tree a frame at a time rather than once per folder. A queued first read whose folder is no
// longer wanted (closed meanwhile) is skipped when its turn comes. Every listing is reported to
// the caller, which opens a lone child folder (fileTree.ts openSingleChild).
import { fileTreeApiUrl, type FileTreeListing } from "@maru/shared";
import { useEffect, useRef, useState } from "react";

import { applyListingTo, type Listings, type TreeEntry } from "./fileTree.ts";

/** T3's request cap: folders read at once; the rest wait in order. */
const CONCURRENT_READS = 4;

export interface DirectoryEntries {
  listings: Listings;
  /** Folders whose listing carries ignore labels (inside a repository). */
  checked: ReadonlySet<string>;
  /** Folders the root reaches whose ignore check got no answer from git, in tree order. */
  ignoreUnknown: readonly string[];
  /** Folders being read for the first time (a refresh does not mark its folder). */
  loading: ReadonlySet<string>;
  /** Folders whose last read failed; the tree does not retry them until a refresh. */
  failed: ReadonlySet<string>;
  /** Some read is in flight or queued, a refresh included. */
  pending: boolean;
  /** The root is listed. */
  ready: boolean;
  /** The first failure among folders the root reaches. */
  error: string | null;
  /** Reads a folder unless it is read or being read; `refresh` reads it again. */
  load: (dir: string, refresh?: boolean) => Promise<void>;
  /** Reads every folder read so far again, and retries the failed ones. */
  refresh: () => void;
  /** A folder's children as last read, before they reach the screen; undefined when not read. */
  listingOf: (dir: string) => readonly TreeEntry[] | undefined;
}

interface Snapshot {
  listings: Listings;
  checked: ReadonlySet<string>;
  ignoreFailed: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  pending: number;
}

async function fetchListing(root: string, dir: string): Promise<FileTreeListing> {
  const res = await fetch(fileTreeApiUrl(root, dir));
  const body = (await res.json().catch(() => null)) as (FileTreeListing & { error?: string; detail?: string }) | null;
  if (!res.ok || !body) {
    const label = body?.error ?? `HTTP ${res.status}`;
    throw new Error(body?.detail ? `${label}: ${body.detail}` : label);
  }
  return body;
}

/** Folders the root reaches through the listings, the root included. */
function reachable(listings: Listings): Set<string> {
  const out = new Set<string>([""]);
  const visit = (dir: string) => {
    for (const e of listings.get(dir) ?? []) {
      if (e.kind !== "directory") continue;
      out.add(e.path);
      visit(e.path);
    }
  };
  visit("");
  return out;
}

export function useDirectoryEntries(
  root: string,
  options: {
    /** A folder's new listing, once it is on screen. */
    onListing: (dir: string, children: readonly TreeEntry[]) => void;
    /** Asked when a queued first read gets its turn; false skips it. */
    wanted: (dir: string) => boolean;
  },
): DirectoryEntries {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    listings: new Map(),
    checked: new Set(),
    ignoreFailed: new Set(),
    loading: new Set([""]),
    errors: new Map(),
    pending: 0,
  }));
  const opts = useRef(options);
  opts.current = options;
  const active = useRef(true);

  // Created once: the effects and the tree hold on to it. Reads change this working state; a
  // frame later it is copied into the snapshot React renders.
  const [engine] = useState(() => {
    const work = {
      listings: new Map<string, readonly TreeEntry[]>(),
      checked: new Set<string>(),
      ignoreFailed: new Set<string>(),
      loading: new Set<string>([""]),
      errors: new Map<string, string>(),
      pending: 0,
    };
    // The snapshot shares `listings` until a read changes it after a commit; then it is copied.
    let listingsShared = false;
    const requests = new Map<string, Promise<void>>();
    // Which read of a folder is current. A newer read, or the folder leaving its parent's
    // listing, makes an older read's answer stale.
    const owners = new Map<string, object>();
    const followUps = new Map<string, Promise<void>>();
    const listed: Array<[string, readonly TreeEntry[]]> = [];
    let running = 0;
    const waiting: Array<() => void> = [];
    // The pending commit: an animation frame, or a timer while the page is hidden.
    let frame: { kind: "raf" | "timer"; id: number } | null = null;

    const commit = () => {
      frame = null;
      if (!active.current) return;
      listingsShared = true;
      setSnapshot({
        listings: work.listings,
        checked: new Set(work.checked),
        ignoreFailed: new Set(work.ignoreFailed),
        loading: new Set(work.loading),
        errors: new Map(work.errors),
        pending: work.pending,
      });
      for (const [dir, children] of listed.splice(0)) opts.current.onListing(dir, children);
    };
    const schedule = () => {
      if (frame !== null) return;
      // A hidden page gets no animation frames; a timer keeps the tree current for its return.
      frame = document.hidden
        ? { kind: "timer", id: window.setTimeout(commit, 0) }
        : { kind: "raf", id: window.requestAnimationFrame(commit) };
    };
    const ownListings = () => {
      if (listingsShared) {
        work.listings = new Map(work.listings);
        listingsShared = false;
      }
      return work.listings;
    };

    const start = (dir: string, refresh: boolean): Promise<void> => {
      work.pending++;
      if (!refresh) work.loading.add(dir);
      schedule();
      const owner = {};
      owners.set(dir, owner);
      const request: Promise<void> = (async () => {
        if (running >= CONCURRENT_READS) await new Promise<void>((resolve) => waiting.push(resolve));
        else running++;
        try {
          if (!active.current || owners.get(dir) !== owner) return;
          if (!refresh && !opts.current.wanted(dir)) return;
          const listing = await fetchListing(root, dir);
          if (!active.current || owners.get(dir) !== owner) return;
          const listings = ownListings();
          const removed = applyListingTo(listings, dir, listing.entries);
          if (listing.ignoreChecked) work.checked.add(dir);
          else work.checked.delete(dir);
          if (listing.ignoreFailed) work.ignoreFailed.add(dir);
          else work.ignoreFailed.delete(dir);
          for (const p of [dir, ...removed]) work.errors.delete(p);
          for (const p of removed) {
            owners.delete(p);
            work.loading.delete(p);
            work.checked.delete(p);
            work.ignoreFailed.delete(p);
          }
          listed.push([dir, listings.get(dir) ?? []]);
        } catch (err) {
          if (!active.current || owners.get(dir) !== owner) return;
          work.errors.set(dir, err instanceof Error ? err.message : "Could not read folder");
        } finally {
          const next = waiting.shift();
          if (next) next();
          else running--;
        }
      })().finally(() => {
        if (owners.get(dir) === owner) {
          owners.delete(dir);
          work.loading.delete(dir);
        }
        if (requests.get(dir) === request) requests.delete(dir);
        work.pending--;
        schedule();
      });
      requests.set(dir, request);
      return request;
    };
    const load = (dir: string, refresh = false): Promise<void> => {
      const existing = requests.get(dir);
      if (existing) {
        if (!refresh) return existing;
        let followUp = followUps.get(dir);
        if (!followUp) {
          const queued: Promise<void> = existing.then(() => {
            if (followUps.get(dir) !== queued) return;
            followUps.delete(dir);
            if (active.current) return load(dir, true);
          });
          followUps.set(dir, queued);
          followUp = queued;
        }
        return followUp;
      }
      if (!refresh && work.listings.has(dir)) return Promise.resolve();
      return start(dir, refresh);
    };
    // A folder read before reads again; one never read reads for the first time.
    const retry = (dir: string) => {
      work.errors.delete(dir);
      schedule();
      return load(dir, work.listings.has(dir));
    };
    const cancelFrame = () => {
      if (frame === null) return;
      if (frame.kind === "raf") window.cancelAnimationFrame(frame.id);
      else window.clearTimeout(frame.id);
      frame = null;
    };
    const listingOf = (dir: string) => work.listings.get(dir);
    return { load, retry, cancelFrame, listingOf };
  });

  // Reads the root on mount; a read that lands after unmount is dropped.
  useEffect(() => {
    active.current = true;
    void engine.load("");
    return () => {
      active.current = false;
      engine.cancelFrame();
    };
  }, [engine]);

  const { listings, checked, ignoreFailed, loading, errors, pending } = snapshot;
  const reach = reachable(listings);
  const failed = new Set([...errors.keys()].filter((p) => reach.has(p)));
  const refresh = () => {
    for (const dir of new Set([...listings.keys(), ...failed])) {
      if (!reach.has(dir)) continue;
      void (failed.has(dir) ? engine.retry(dir) : engine.load(dir, true));
    }
  };

  return {
    listings,
    checked,
    ignoreUnknown: [...reach].filter((p) => ignoreFailed.has(p)),
    loading,
    failed,
    pending: pending > 0,
    ready: listings.has(""),
    error: [...errors].find(([p]) => reach.has(p))?.[1] ?? null,
    load: engine.load,
    refresh,
    listingOf: engine.listingOf,
  };
}
