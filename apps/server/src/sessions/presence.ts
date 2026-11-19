// The state rows keyed by a session (`provider:id`: its Group assignment, its position in the
// Group, its pin, its place in the list, a /model choice waiting for its next start, the name the user gave) and when they
// go (DESIGN.md 6b). A session that went to the trash or off the list keeps them, so a restore
// brings it back where it was. They go once the session is in none of the places it can be:
// - Claude: a transcript `projects/<enc>/<id>.jsonl` in any account
// - Codex: a thread row in any home's state database (archived rows too), or a rollout file named
//   with its id under `sessions/` or `archived_sessions/`
// - the trash: an entry folder `<id>__<provider>-<account>`, readable or not
// - the live index (a thread the daemon announced before its row was written)
// A place that cannot be read in full leaves every session of that provider standing.
//
// Locks are kept: a lock also guards a session's leftovers (an orphan subtree or rollout) from the
// orphan cleanup (DESIGN.md 6).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "@maru/shared";
import type { ClaudeAccount, CodexAccount } from "../config.ts";
import type { ProjectStore } from "../projects/store.ts";
import type { ChosenStore } from "../state/chosen.ts";
import type { SessionChoiceStore } from "../state/sessionChoices.ts";
import type { SessionNameStore } from "../state/sessionNames.ts";
import { scanProjects } from "./claudeFiles.ts";
import { stateDbPath } from "./codexFiles.ts";
import { errorMessage, readDirOrEmpty } from "./fsUtil.ts";

/** Ids of the sessions that exist, per provider; null when a place of that provider could not be read. */
export interface SessionPresence {
  claude: Set<string> | null;
  codex: Set<string> | null;
  /** Why a provider is null. */
  unread: Array<{ provider: ProviderId; reason: string }>;
}

export interface PresenceDeps {
  claudeAccounts: ClaudeAccount[];
  codexAccounts: CodexAccount[];
  trashRoot: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const TRASH_ENTRY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__(claude|codex)-/;

export function readPresence(deps: PresenceDeps): SessionPresence {
  const unread: SessionPresence["unread"] = [];
  let claude: Set<string> | null;
  try {
    for (const a of deps.claudeAccounts) mustBeFolder(a.dir);
    claude = scanProjects(deps.claudeAccounts).transcripts;
  } catch (err) {
    claude = null;
    unread.push({ provider: "claude", reason: errorMessage(err) });
  }
  let codex: Set<string> | null = new Set();
  try {
    for (const a of deps.codexAccounts) {
      mustBeFolder(a.home);
      codexIds(a.home, codex);
    }
  } catch (err) {
    codex = null;
    unread.push({ provider: "codex", reason: errorMessage(err) });
  }
  try {
    for (const d of readDirOrEmpty(deps.trashRoot)) {
      const m = TRASH_ENTRY.exec(d.name);
      if (m) (m[2] === "claude" ? claude : codex)?.add(m[1]!);
    }
  } catch (err) {
    const reason = `Trash: ${errorMessage(err)}`;
    if (claude) unread.push({ provider: "claude", reason });
    if (codex) unread.push({ provider: "codex", reason });
    claude = null;
    codex = null;
  }
  return { claude, codex, unread };
}

/**
 * An account's own folder must be there: a missing one (moved, renamed, another HOME) would read
 * as an account with no sessions. Only a missing folder inside it (no projects yet) is empty.
 */
function mustBeFolder(dir: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch (err) {
    throw new Error(`Could not read the account folder: ${dir} (${errorMessage(err)})`);
  }
  if (!st.isDirectory()) throw new Error(`Not an account folder: ${dir}`);
}

/** Thread ids of one Codex home: its state database rows and the ids its rollout files name. */
function codexIds(home: string, out: Set<string>): void {
  const db = stateDbPath(home);
  if (fs.existsSync(db)) {
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      for (const r of conn.prepare("SELECT id FROM threads").all()) out.add(String(r.id));
    } finally {
      conn.close();
    }
  }
  for (const sub of ["sessions", "archived_sessions"]) {
    const stack = [path.join(home, sub)];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const e of readDirOrEmpty(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith(".jsonl")) {
          const m = UUID.exec(e.name);
          if (m) out.add(m[0]);
        }
      }
    }
  }
}

/**
 * The keys (`provider:id`) among `keys` whose session is in none of its places. `live` says the
 * live index holds the session. A provider that could not be read keeps all its keys.
 */
export function goneKeys(keys: Iterable<string>, presence: SessionPresence, live: (key: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const sep = key.indexOf(":");
    const provider = key.slice(0, sep);
    const id = key.slice(sep + 1);
    const ids = provider === "claude" ? presence.claude : provider === "codex" ? presence.codex : null;
    if (ids === null || ids.has(id) || live(key)) continue;
    out.push(key);
  }
  return out;
}

export interface SessionRowStores {
  projects: Pick<ProjectStore, "keys" | "forget">;
  chosen: Pick<ChosenStore, "keys" | "forget">;
  choices: Pick<SessionChoiceStore, "keys" | "forget">;
  names: Pick<SessionNameStore, "keys" | "forget">;
}

export interface ForgetReport {
  /** Keys looked at. */
  checked: number;
  /** Keys whose session is gone; their rows went. */
  gone: string[];
  /** Rows dropped per kind. */
  rows: { assignments: number; positions: number; pins: number; archived: number; chosen: number; choices: number; names: number };
  unread: SessionPresence["unread"];
}

/**
 * Drops the state rows of the sessions among `keys` (every key the stores hold with "all") that
 * exist nowhere any more.
 */
export function forgetGoneSessions(
  keys: Iterable<string> | "all",
  deps: PresenceDeps & { stores: SessionRowStores; live?: (key: string) => boolean },
): ForgetReport {
  const { projects, chosen, choices, names } = deps.stores;
  const wanted = keys === "all" ? new Set([...projects.keys(), ...chosen.keys(), ...choices.keys(), ...names.keys()]) : new Set(keys);
  const presence = readPresence(deps);
  const gone = goneKeys(wanted, presence, deps.live);
  const rows = { assignments: 0, positions: 0, pins: 0, archived: 0, chosen: 0, choices: 0, names: 0 };
  if (gone.length > 0) {
    Object.assign(rows, projects.forget(gone));
    rows.chosen = chosen.forget(gone);
    rows.choices = choices.forget(gone);
    rows.names = names.forget(gone);
  }
  return { checked: wanted.size, gone, rows, unread: presence.unread };
}

/** One log line for a report, or null when nothing went and everything was read. */
export function forgetReportLine(r: ForgetReport, why: string): string | null {
  if (r.gone.length === 0 && r.unread.length === 0) return null;
  const rows = Object.entries(r.rows).map(([k, n]) => `${k} ${n}`).join(", ");
  const unread = r.unread.map((u) => `${u.provider} (${u.reason})`).join(", ");
  return `state rows (${why}): ${r.gone.length} of ${r.checked} sessions gone, dropped ${rows}${unread ? `; not judged: ${unread}` : ""}`;
}
