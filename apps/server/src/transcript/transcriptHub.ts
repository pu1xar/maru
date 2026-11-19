// One follower per transcript file, shared by every screen that shows the file.
//
// A screen reads a page first (readTail) and then subscribes from the page's endOffset. The hub
// runs one followTranscript per file, counted by subscribers: the last unsubscribe stops it.
// Each subscriber keeps its own cursor, so it receives every record after its offset exactly
// once, wherever the shared follower stands when it joins:
//   - behind the follower (its page is older than what the follower already handed out): the
//     gap is read with readRange and delivered first; live batches arriving meanwhile wait
//     behind it
//   - ahead of the follower: records before its offset are skipped
//
// The transform turns a batch of raw records into what subscribers receive; the normalized item
// model is injected here. It runs once per live batch for all subscribers at the follower's
// position, and separately for a catch-up or a partial batch.
import path from "node:path";
import { followTranscript, readRange } from "./claudeTranscript.ts";
import type { Follower, RawRecord, ReadStats, ResetInfo } from "./claudeTranscript.ts";

export type Transform<T> = (records: RawRecord[], file: string) => T;

export interface TranscriptListener<T> {
  /** Records after the subscriber's offset, in file order, passed through the transform. */
  onRecords(batch: T): void;
  /** The file was truncated, replaced or removed. Records from offset 0 follow. */
  onReset?(info: ResetInfo): void;
  /** Read errors, transform errors, and errors this listener's callbacks threw. */
  onError?(err: unknown): void;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface TranscriptHubOptions {
  debounceMs?: number;
  pollMs?: number;
  /** Errors for subscribers without onError. Default: console.error. */
  onError?: (err: unknown) => void;
  stats?: ReadStats;
}

export interface TranscriptHubStats {
  /** Files followed now, one follower each. */
  files: number;
  subscribers: number;
  /** Cumulative. */
  followersStarted: number;
  followersStopped: number;
  catchUps: number;
  /** Live batches that waited behind a catch-up read. */
  queuedBatches: number;
  resets: number;
  errors: number;
}

export interface TranscriptHub<T> {
  subscribe(file: string, fromOffset: number, listener: TranscriptListener<T>): Subscription;
  /** Subscribers of one file now (0 when nobody follows it). */
  subscriberCount(file: string): number;
  stats(): TranscriptHubStats;
  /** Stop every follower. Subscriptions end without a callback. */
  close(): void;
}

interface Sub<T> {
  listener: TranscriptListener<T>;
  /** Offset of the next record this subscriber should receive. */
  pos: number;
  /** A catch-up read is in flight; live batches wait in `queued`. */
  catchingUp: boolean;
  queued: RawRecord[][];
  closed: boolean;
}

interface Entry<T> {
  file: string;
  follower: Follower | null;
  /** End of the last batch the follower handed out (its start offset before the first). */
  pos: number;
  subs: Set<Sub<T>>;
  /** Bumped on every reset, so a catch-up read of the old file is dropped. */
  generation: number;
}

/** A transform result shared by the subscribers that receive the whole batch. */
interface Shared<T> {
  state: "unset" | "ok" | "failed";
  value: T | undefined;
  error: unknown;
}

export function createTranscriptHub(opts?: TranscriptHubOptions): TranscriptHub<RawRecord[]>;
export function createTranscriptHub<T>(opts: TranscriptHubOptions & { transform: Transform<T> }): TranscriptHub<T>;
export function createTranscriptHub<T>(opts: TranscriptHubOptions & { transform?: Transform<T> } = {}): TranscriptHub<T> {
  const transform: Transform<T> = opts.transform ?? ((records) => records as unknown as T);
  const fallbackError = opts.onError ?? ((err: unknown) => console.error("transcript hub:", err));
  const entries = new Map<string, Entry<T>>();
  const counts = { followersStarted: 0, followersStopped: 0, catchUps: 0, queuedBatches: 0, resets: 0, errors: 0 };

  function notifyError(sub: Sub<T>, err: unknown): void {
    counts.errors++;
    if (sub.closed) return;
    const handler = sub.listener.onError;
    if (handler === undefined) {
      fallbackError(err);
      return;
    }
    try {
      handler.call(sub.listener, err);
    } catch (inner) {
      fallbackError(inner);
    }
  }

  /** Hand `records` to one subscriber, minus those before its cursor. */
  function deliver(entry: Entry<T>, sub: Sub<T>, records: RawRecord[], shared: Shared<T> | null): void {
    if (sub.closed) return;
    let first = 0;
    while (first < records.length && records[first]!.offset < sub.pos) first++;
    if (first === records.length) return;
    const slice = first === 0 ? records : records.slice(first);
    const last = slice[slice.length - 1]!;
    sub.pos = last.offset + last.length;
    let batch: T;
    try {
      if (first === 0 && shared !== null) {
        if (shared.state === "unset") {
          try {
            shared.value = transform(slice, entry.file);
            shared.state = "ok";
          } catch (err) {
            shared.error = err;
            shared.state = "failed";
          }
        }
        if (shared.state === "failed") throw shared.error;
        batch = shared.value as T;
      } else {
        batch = transform(slice, entry.file);
      }
    } catch (err) {
      notifyError(sub, err);
      return;
    }
    try {
      sub.listener.onRecords(batch);
    } catch (err) {
      notifyError(sub, err);
    }
  }

  function onBatch(entry: Entry<T>, records: RawRecord[]): void {
    const last = records[records.length - 1];
    if (last === undefined) return;
    entry.pos = last.offset + last.length;
    const shared: Shared<T> = { state: "unset", value: undefined, error: undefined };
    for (const sub of entry.subs) {
      if (sub.catchingUp) {
        counts.queuedBatches++;
        sub.queued.push(records);
      } else {
        deliver(entry, sub, records, shared);
      }
    }
  }

  function onReset(entry: Entry<T>, info: ResetInfo): void {
    counts.resets++;
    entry.generation++;
    entry.pos = 0;
    for (const sub of entry.subs) {
      sub.pos = 0;
      sub.catchingUp = false;
      sub.queued = [];
      if (sub.listener.onReset === undefined) continue;
      try {
        sub.listener.onReset(info);
      } catch (err) {
        notifyError(sub, err);
      }
    }
  }

  function onFollowError(entry: Entry<T>, err: unknown): void {
    if (entry.subs.size === 0) {
      counts.errors++;
      fallbackError(err);
      return;
    }
    for (const sub of entry.subs) notifyError(sub, err);
  }

  /** Deliver [from, to) to a subscriber that joined behind the follower, then its queue. */
  function catchUp(entry: Entry<T>, sub: Sub<T>, from: number, to: number): void {
    counts.catchUps++;
    sub.catchingUp = true;
    const generation = entry.generation;
    const finish = (records: RawRecord[] | null): void => {
      // A reset since the read began means the records belong to the old file.
      if (sub.closed || !sub.catchingUp || entry.generation !== generation) return;
      sub.catchingUp = false;
      const queued = sub.queued;
      sub.queued = [];
      if (records !== null) deliver(entry, sub, records, null);
      for (const batch of queued) deliver(entry, sub, batch, null);
    };
    readRange(entry.file, from, to, opts.stats).then(finish, (err: unknown) => {
      notifyError(sub, new Error(`catch-up read of ${entry.file} [${from}, ${to}) failed; those records are missing`, { cause: err }));
      finish(null);
    });
  }

  function release(key: string, entry: Entry<T>, sub: Sub<T>): void {
    if (sub.closed) return;
    sub.closed = true;
    entry.subs.delete(sub);
    if (entry.subs.size > 0 || entries.get(key) !== entry) return;
    entries.delete(key);
    entry.follower?.stop();
    entry.follower = null;
    counts.followersStopped++;
  }

  return {
    subscribe(file: string, fromOffset: number, listener: TranscriptListener<T>): Subscription {
      if (!Number.isSafeInteger(fromOffset) || fromOffset < 0) {
        throw new RangeError(`fromOffset must be a non-negative integer, got ${fromOffset}`);
      }
      const key = path.resolve(file);
      const sub: Sub<T> = { listener, pos: fromOffset, catchingUp: false, queued: [], closed: false };
      let entry = entries.get(key);
      if (entry === undefined) {
        const created: Entry<T> = { file: key, follower: null, pos: fromOffset, subs: new Set([sub]), generation: 0 };
        entries.set(key, created);
        created.follower = followTranscript(key, fromOffset, (records) => onBatch(created, records), {
          debounceMs: opts.debounceMs,
          pollMs: opts.pollMs,
          stats: opts.stats,
          onReset: (info) => onReset(created, info),
          onError: (err) => onFollowError(created, err),
        });
        counts.followersStarted++;
        entry = created;
      } else {
        entry.subs.add(sub);
        if (fromOffset < entry.pos) catchUp(entry, sub, fromOffset, entry.pos);
      }
      const joined = entry;
      return { unsubscribe: () => release(key, joined, sub) };
    },

    subscriberCount(file: string): number {
      return entries.get(path.resolve(file))?.subs.size ?? 0;
    },

    stats(): TranscriptHubStats {
      let subscribers = 0;
      for (const e of entries.values()) subscribers += e.subs.size;
      return { files: entries.size, subscribers, ...counts };
    },

    close(): void {
      for (const [key, entry] of entries) {
        for (const sub of [...entry.subs]) release(key, entry, sub);
      }
    },
  };
}
