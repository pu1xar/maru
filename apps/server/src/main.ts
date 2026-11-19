import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionSource, SessionSummary } from "@maru/shared";
import { assignmentKey, sessionKey } from "@maru/shared";
import { ATTACHMENTS_DIR, CLAUDE_ACCOUNTS, CONFIG_FILE, HOME_DIR, CLAUDE_USAGE, CODEX_ACCOUNTS, CODEX_USAGE, HOST, HOST_SOCKET, PORT, STATE_FILE, STUB_TRASH_DIR, TRASH_DIR } from "./config.ts";
import { AttachmentStore } from "./attachments/store.ts";
import { DEVICE_HOSTS, DEVICE_PORT, DEVICE_URL, FCM_SERVICE_ACCOUNT_FILE, MOBILE_DIR, SHELL_SOCKET, UPDATE_TOKEN_FILE } from "./config.ts";
import { ShellService } from "./shell/service.ts";
import { AccountsService } from "./accounts/service.ts";
import { resolveTmux } from "./shell/tmux.ts";
import { SessionSearch } from "./search/sessionSearch.ts";
import { DeviceStore } from "./devices/store.ts";
import { PairingHub } from "./devices/pairing.ts";
import { createDeviceServer } from "./devices/deviceServer.ts";
import { openFcm } from "./push/fcm.ts";
import { PushService, driveHooks } from "./push/service.ts";
import { OtaUpdates } from "./mobile/ota.ts";
import { MobileApks } from "./mobile/apk.ts";
import { UpdateToken } from "./mobile/updateToken.ts";
import { DesktopBuilds } from "./desktop/builds.ts";
import { LockStore } from "./state/locks.ts";
import { legacyLockLine, migrateLegacyLocks } from "./sessions/legacyLocks.ts";
import { SessionChoiceStore } from "./state/sessionChoices.ts";
import { SessionNameStore } from "./state/sessionNames.ts";
import { CodexHeldStore } from "./state/codexHeld.ts";
import { SessionRewindStore } from "./state/sessionRewinds.ts";
import { SessionRewind } from "./drive/sessionRewind.ts";
import { SessionFork } from "./drive/sessionFork.ts";
import { fileCheckpointingFor } from "./claude/checkpointing.ts";
import { TrashStore } from "./sessions/trash.ts";
import { SessionManager } from "./sessions/manage.ts";
import { forgetGoneSessions, forgetReportLine } from "./sessions/presence.ts";
import { claudeSessionFiles, listSessionAgents, type ListSessionAgentsOptions } from "./claude/sessionAgents.ts";
import { backgroundTaskRows, outputFileOf, readBackgroundTasks, readOutputTail } from "./claude/sessionBackgroundTasks.ts";
import { IdleCloser } from "./drive/idleCloser.ts";
import { processStartOf } from "./claude/registry.ts";
import { SessionIndex } from "./index/store.ts";
import { ProjectStore } from "./projects/store.ts";
import { FoldedGroupStore } from "./state/foldedGroups.ts";
import { ChosenStore } from "./state/chosen.ts";
import { VisibleIndex } from "./index/visible.ts";
import { guardConfig } from "./http/guard.ts";
import { createServer } from "./http/server.ts";
import { createClaudeSource } from "./claude/source.ts";
import { CodexBackgroundTerminals } from "./codex/backgroundTerminals.ts";
import { createCodexSource } from "./codex/source.ts";
import { createTranscriptHub } from "./transcript/transcriptHub.ts";
import { ClaudeThreads } from "./threads/claudeThreads.ts";
import { CodexThreads } from "./threads/codexThreads.ts";
import { ThreadRouter } from "./threads/router.ts";
import { createClaudeDriver } from "./claude/driver.ts";
import { socketHostLink } from "./claude/hostLink.ts";
import { ClaudeRuns } from "./drive/claudeRuns.ts";
import { CodexRuns } from "./drive/codexRuns.ts";
import { PendingSends, claudeMessageEvents, readSendsInTranscript, reconcilePending, settleDelivered, settleEndedRun, settleFromTranscript } from "./drive/pendingSends.ts";
import { transcriptOf } from "./drive/transcriptFacts.ts";
import { SessionAgentControl } from "./drive/sessionAgentControl.ts";
import { SessionRenamer } from "./sessions/rename.ts";
import { SessionCommands } from "./commands/sessionCommands.ts";
import { UsageService } from "./usage/service.ts";
import { protectPrivateFiles } from "./state/privateFiles.ts";
import { DashboardWorkService } from "./dashboard/work.ts";
import { serverVersion } from "./system/version.ts";
import type { ServerMessage } from "@maru/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../../web/dist");
// The release (or checkout) this process runs from: apps/server/src/main.ts sits three folders down.
const version = serverVersion(path.resolve(here, "../../.."));
// The Android app's OTA update of this release (release.sh exports and signs it there, DESIGN.md 2d).
const otaDir = process.env.MARU_OTA_DIR || path.resolve(here, "../../mobile/dist-ota");
// The desktop app's build of this release (release.sh builds or carries it there, DESIGN.md 2e).
const desktopDir = process.env.MARU_DESKTOP_DIR || path.resolve(here, "../../desktop/dist-release");

// Codex threads this server drives (CodexRuns fills it, and after a restart restores it from
// state.sqlite). Every other open Codex thread belongs to another client.
const ownThreadIds = new Set<string>();

// Owner-only modes for the state folder and database, the config file, the trash and the
// attachments (state/privateFiles.ts); before the first store opens the database.
protectPrivateFiles({ stateFile: STATE_FILE, configFile: CONFIG_FILE, folders: [TRASH_DIR, ATTACHMENTS_DIR] });
const projects = new ProjectStore(STATE_FILE);
const chosen = new ChosenStore(STATE_FILE);
// The sidebar folders folded, shared by every client (DESIGN.md 6v). A project's key lives while the project does.
const folds = new FoldedGroupStore(STATE_FILE, (key) => {
  const m = /^project:(.+)$/.exec(key);
  return m ? projects.list().some((p) => p.id === m[1]) : true;
});
folds.prune();
projects.onChange((c) => {
  if (c.kind === "projects") folds.prune();
});
// The hand-set locks of earlier builds: a session is locked now because it is in the list (DESIGN.md 6, 잠금).
{
  const legacyLocks = new LockStore(STATE_FILE);
  try {
    const line = legacyLockLine(migrateLegacyLocks({ locks: legacyLocks, chosen, projects }));
    if (line) console.log(line);
  } catch (err) {
    console.error("legacy locks: failed", err);
  } finally {
    legacyLocks.close();
  }
}
// Model, effort and the like chosen with /model and its kin for a session's next start (DESIGN.md 6m).
const choices = new SessionChoiceStore(STATE_FILE);
// The names the user gave in maru, laid over the provider's own (DESIGN.md 6, 이름 변경).
const names = new SessionNameStore(STATE_FILE);
// The Codex threads this server drives, kept so a restart does not hand them to another client.
const codexHeld = new CodexHeldStore(STATE_FILE);
// Conversation rewinds waiting for the session's next message (DESIGN.md 6o).
const rewinds = new SessionRewindStore(STATE_FILE);
// The status of a Claude session this server runs comes from the session host (ClaudeRuns.annotate).
let driven: (s: SessionSummary) => SessionSummary = (s) => s;
const index = new SessionIndex((s) => ({
  ...driven(s), providerName: s.name, name: names.resolve(s.provider, s.id, s.name), projectId: projects.projectOf(s.provider, s.id), locked: chosen.has(s.provider, s.id),
  position: s.parentKey ? null : projects.ensurePosition(s.provider, s.id, s.updatedAt),
  pinPosition: s.parentKey ? null : projects.pinOf(s.provider, s.id),
  archivedAt: s.parentKey ? null : projects.archivedOf(s.provider, s.id),
}));
const view = new VisibleIndex(index, chosen);
const reannotate = (keys: string[]) => {
  const set = new Set(keys);
  index.reannotate((s) => set.has(assignmentKey(s.provider, s.id)));
};
projects.onChange((c) => {
  if (c.kind === "assignments") reannotate(c.keys);
});
chosen.onChange(reannotate);
names.onChange(reannotate);
// Claude processes the UI starts (M2) run in the session host (DESIGN.md 2b), so a restart of this
// server leaves them running. The Claude index marks their sessions "ui"-owned.
const hostLink = socketHostLink(HOST_SOCKET, { log: (line) => console.log(line) });
const driver = createClaudeDriver({
  link: hostLink,
  log: (line) => console.log(line),
  isSessionOpen: (sid) =>
    CLAUDE_ACCOUNTS.some((a) => {
      const s = index.get(`claude:${a.id}:${sid}`);
      return s !== undefined && s.status !== "closed";
    }),
});
const claudeSource = createClaudeSource(CLAUDE_ACCOUNTS, { ownPids: () => driver.ownPids() });
const codexSource = createCodexSource(CODEX_ACCOUNTS, { ownThreadIds: () => ownThreadIds });
const sources: SessionSource[] = [claudeSource, codexSource];

let broadcast: (msg: ServerMessage) => void = () => {};
const runs = new ClaudeRuns({
  driver, accounts: CLAUDE_ACCOUNTS, index, chosen, projects, choices,
  resweep: () => claudeSource.resweep(),
  broadcast: (msg) => broadcast(msg),
  stateChanged: (key) => index.reannotate((s) => s.key === key),
  models: (key) => commands.models(key),
  listed: async (key) => (await commands.list(key)).commands,
  rewind: { resumeAt: (sid, file) => sessionRewind.resumeAt(sid, file), markerOf: (sid) => rewinds.get(sid) },
  fileCheckpointing: fileCheckpointingFor,
});
driven = (s) => runs.annotate(s);
const codexRuns = new CodexRuns({
  accounts: CODEX_ACCOUNTS, index, chosen, projects, owned: ownThreadIds, choices, held: codexHeld,
  ownerChanged: (account, threadId) => codexSource.ownerChanged(account, threadId),
  broadcast: (msg) => broadcast(msg),
  rename: (req) => renamer.rename(req),
});
// Messages sent that the model has not taken in yet (DESIGN.md 4.4), kept in the state file so a
// restart of this server keeps showing what still waits in the CLI.
let started = false;
const pendingSends = new PendingSends({ file: STATE_FILE, publish: (key, sends) => broadcast({ type: "session.queued", key, sends }) });
runs.onRunEvent((key, ev) => {
  if (ev.type === "exit") {
    void settleEndedRun(pendingSends, key, reconcileDeps.claudeTranscript, reconcileDeps.settleLimit).catch((err) => console.error("pending sends: settle failed", err));
  } else {
    for (const e of claudeMessageEvents(ev.message)) pendingSends.apply(key, e);
  }
});
codexRuns.onThreadEvent((key, ev) => {
  pendingSends.apply(key, ev.type === "userMessage" ? { kind: "taken", id: ev.clientId } : { kind: "turnEnded" });
});
// The Claude transcript of a session key, or null.
const claudeTranscriptFile = (key: string): string | null => {
  const m = /^claude:([^:]+):(.+)$/.exec(key);
  const account = m ? CLAUDE_ACCOUNTS.find((a) => a.id === m[1]) : undefined;
  return account && m ? transcriptOf(account.dir, m[2]!) : null;
};
// A waiting message whose row the conversation shows leaves the list (DESIGN.md 4.4), by the
// transcript when no thread shows it: after a start, a host reconnect, and a subscribe.
const settleClaudeFromTranscripts = async (keys: readonly string[]): Promise<void> => {
  for (const key of keys) await settleFromTranscript(pendingSends, key, claudeTranscriptFile(key), { limit: reconcileDeps.settleLimit });
};
const claudeKeysWaiting = () => pendingSends.keys().filter((k) => k.startsWith("claude:"));
// The lists against what happened while this server could not follow them (DESIGN.md 4.4).
const reconcileDeps = {
  claudeRun: (key: string) => (runs.isDriven(key) ? { busy: runs.turnInfo(key).run?.busy ?? false } : null),
  // One read of the session's transcript for all its messages (drive/pendingSends.ts).
  claudeTranscript: (key: string, ids: ReadonlySet<string>, sinceMs: number) => readSendsInTranscript(claudeTranscriptFile(key), ids, sinceMs),
  // A line the session's open thread has not sent as a row yet is left to the thread's delivery hook.
  settleLimit: (key: string) => claudeThreads.sentEnd(key),
};
// The Esc Esc rewind screen's list and action (drive/sessionRewind.ts).
const sessionRewind = new SessionRewind({
  claudeAccounts: CLAUDE_ACCOUNTS, index, runs, codexRuns, store: rewinds, fileCheckpointing: fileCheckpointingFor,
  hostUp: () => driver.hostStatus().state !== "down",
});
const hub = createTranscriptHub();
const claudeThreads = new ClaudeThreads({
  accounts: CLAUDE_ACCOUNTS, index, hub, turns: runs,
  delivery: {
    delivered: (key, ids) => settleDelivered(pendingSends, key, ids),
    subscribed: (key) => {
      if (pendingSends.stored(key).length > 0) void settleClaudeFromTranscripts([key]).catch((err) => console.error("pending sends: transcript settle failed", err));
    },
  },
});
const threads = new ThreadRouter([
  claudeThreads,
  new CodexThreads({ accounts: CODEX_ACCOUNTS, index, chosen: codexRuns, delivery: { delivered: (key, ids) => settleDelivered(pendingSends, key, ids) } }),
]);
const accounts = [
  ...CLAUDE_ACCOUNTS.map((a) => ({ id: a.id, provider: "claude" as const })),
  ...CODEX_ACCOUNTS.map((a) => ({ id: a.id, provider: "codex" as const })),
];
const renamer = new SessionRenamer({
  names,
  claudeAccounts: CLAUDE_ACCOUNTS,
  codexAccounts: CODEX_ACCOUNTS,
  index,
  heldByServer: (sid) => driver.holds(sid),
  ownPids: () => driver.ownPids(),
  claudeWritten: (account, file) => claudeSource.reread(account, file),
  codexWritten: (account) => codexSource.reread(account),
});
// Fork from a message (drive/sessionFork.ts, DESIGN.md 6q).
const sessionFork = new SessionFork({
  claudeAccounts: CLAUDE_ACCOUNTS, index, runs, codexRuns, store: rewinds, chosen, projects,
  rename: (req) => renamer.rename(req),
  claudeWritten: (account, file) => claudeSource.reread(account, file),
});
// The Group assignment, position, pin, list place and /model choice of sessions that exist nowhere
// any more (sessions/presence.ts, DESIGN.md 6b): a deletion names what it removed, and a sweep
// after the first index takes what went outside this server (by hand, the CLI's own cleanup).
const forgetGone = (keys: Iterable<string> | "all", why: string) => {
  try {
    const report = forgetGoneSessions(keys, {
      claudeAccounts: CLAUDE_ACCOUNTS, codexAccounts: CODEX_ACCOUNTS, trashRoot: TRASH_DIR,
      stores: { projects, chosen, choices, names },
      live: (key) => {
        const [provider, id] = key.split(":") as [string, string];
        return provider === "claude"
          ? CLAUDE_ACCOUNTS.some((a) => index.get(sessionKey("claude", a.id, id)) !== undefined)
          : CODEX_ACCOUNTS.some((a) => index.get(sessionKey("codex", a.id, id)) !== undefined);
      },
    });
    const line = forgetReportLine(report, why);
    if (line) console.log(line);
  } catch (err) {
    console.error(`state rows (${why}): failed`, err);
  }
};
// Locks, deletion and the trash, orphans, units, account moves, rehome (DESIGN.md 6, 6a).
const manage = new SessionManager({
  claudeAccounts: CLAUDE_ACCOUNTS,
  codexAccounts: CODEX_ACCOUNTS,
  index,
  chosen,
  trash: new TrashStore({ root: TRASH_DIR, claudeAccounts: CLAUDE_ACCOUNTS, codexAccounts: CODEX_ACCOUNTS }),
  heldByServer: (sid) => driver.holds(sid),
  ownPids: () => driver.ownPids(),
  claudeWritten: (account, file) => claudeSource.reread(account, file),
  codexWritten: (account, ids) => codexSource.refreshThreads(account, ids),
  removed: (keys) => forgetGone(keys, "delete"),
  stubDir: STUB_TRASH_DIR,
});
// Usage gauges for every account (DESIGN.md 6a); the active flag follows the full index.
// Claude's and Codex's usage need the stored logins, so each is read only when the config turns
// it on (`claudeUsage`, `codexUsage`).
const usage = new UsageService({
  claudeAccounts: CLAUDE_ACCOUNTS,
  codexAccounts: CODEX_ACCOUNTS,
  stateFile: STATE_FILE,
  sessions: index,
  claude: { enabled: CLAUDE_USAGE },
  codex: { enabled: CODEX_USAGE },
});
usage.start().catch((err) => console.error("usage: failed to start", err));
/** Whether a live process holds the session, and when it started (ms, null when unknown). */
const sessionProcess = (key: string) => {
  const s = index.get(key);
  // A run this server holds is open also before the index's first sweep after a restart (2.6 s
  // with the test machine's transcripts), so its running agents do not show as interrupted then.
  const open = (s !== undefined && s.status !== "closed") || runs.isDriven(key);
  const pid = s?.pid ?? runs.pidOf(key);
  const started = pid ? processStartOf(pid) : null;
  const startedMs = started ? Date.parse(`${started} GMT`) : NaN;
  return { open, startedMs: Number.isFinite(startedMs) ? startedMs : null };
};
const sessionAgents = (key: string, opts: ListSessionAgentsOptions = {}) => {
  const { open, startedMs } = sessionProcess(key);
  return listSessionAgents(key, CLAUDE_ACCOUNTS, open, startedMs, opts);
};
// The CLI writes background command and Monitor output under <tmp>/claude-<uid>/.
const CLAUDE_TMP_ROOTS = [path.join("/tmp", `claude-${process.getuid?.() ?? 0}`)];
/** A Claude session's background shell commands and Monitors, and their output (claude/sessionBackgroundTasks.ts). */
const claudeTasks = {
  rows: (key: string) => {
    const files = claudeSessionFiles(key, CLAUDE_ACCOUNTS);
    if (!files) return [];
    const { open, startedMs } = sessionProcess(key);
    return backgroundTaskRows(readBackgroundTasks(files.transcript), { sessionOpen: open, processStartMs: startedMs, liveTaskIds: runs.liveTaskIds(key) });
  },
  output: (key: string, taskId: string) => {
    const files = claudeSessionFiles(key, CLAUDE_ACCOUNTS);
    if (!files) return null;
    const records = readBackgroundTasks(files.transcript);
    const record = records.find((r) => r.taskId === taskId);
    const file = record ? outputFileOf(record, path.basename(files.transcript, ".jsonl"), records, CLAUDE_TMP_ROOTS) : null;
    return file ? readOutputTail(file) : null;
  },
};
// A Codex session's background terminals, read over a connection of their own (codex/backgroundTerminals.ts).
const codexTerminals = new CodexBackgroundTerminals({ accounts: CODEX_ACCOUNTS });
// The 작업 tab's rows with their stop and resume actions (drive/sessionAgentControl.ts).
const agentControl = new SessionAgentControl({
  claudeAccounts: CLAUDE_ACCOUNTS, index, runs, codexRuns, codexTerminals,
  hostUp: () => driver.hostStatus().state !== "down",
  claudeRows: sessionAgents,
  claudeTasks,
});
// The dashboard's work list across the list's sessions (dashboard/work.ts, DESIGN.md 6j).
const dashboard = new DashboardWorkService({
  claudeAccounts: CLAUDE_ACCOUNTS,
  sessions: () => view.snapshot(),
  subscribe: (l) => view.subscribe(l),
  get: (key) => index.get(key),
  rows: (key) => agentControl.list(key),
  pending: () => [...runs.allPending(), ...codexRuns.allPending()],
  driven: (key) => runs.isDriven(key) || codexRuns.isDriven(key),
  hostUp: () => driver.hostStatus().state !== "down",
});
// The composer's `/` menu (commands/sessionCommands.ts).
const commands = new SessionCommands({
  index, claudeAccounts: CLAUDE_ACCOUNTS,
  claudeRun: (key) => runs.commandsOf(key),
  claudeRunModels: (key) => runs.modelsOf(key),
  claudeProbe: (opts) => driver.probe(opts),
  codexSkills: (key, opts) => codexRuns.skills(key, opts),
  codexModels: (key) => codexRuns.models(key),
});
// Ends Claude processes nobody needs any more (drive/idleCloser.ts).
const idleCloser = new IdleCloser({
  runs,
  index,
  isViewed: (key) => claudeThreads.isViewed(key),
  runningAgents: (key) => sessionAgents(key, { light: true }).filter((a) => a.status === "running").length,
  log: (line) => console.log(line),
});
idleCloser.start();
// Paired devices and the Android app (DESIGN.md 2d).
const devices = new DeviceStore(STATE_FILE);
const pairing = new PairingHub(devices);
const ota = new OtaUpdates(otaDir);
const apks = new MobileApks(MOBILE_DIR);
// The Codex threads held before the restart are this server's before the first request or index
// look: a send that came first would take one over as new and lose its turn and goal. Their check
// with the daemon runs alongside (CodexRuns.restore).
codexRuns.restore().then(
  (r) => {
    if (r.kept || r.released) console.log(`codex: restored ${r.kept} driven thread(s), let ${r.released} go`);
  },
  (err) => console.error("codex: restore failed", err),
);
// Pushes to the app (push/, DESIGN.md 2d); off while the Firebase service account file is missing.
const fcm = openFcm(FCM_SERVICE_ACCOUNT_FILE, (line) => console.log(line));
// Shell terminals (DESIGN.md 6s): the shells live in their own tmux server, outside this process.
const shells = new ShellService({ tmux: resolveTmux(), socket: SHELL_SOCKET, log: (line) => console.log(line) });
// The accounts screen (DESIGN.md 6y): reads and edits the config file; the accounts this process runs with stay as started.
const accountSettings = new AccountsService({
  env: process.env,
  home: HOME_DIR,
  running: { claude: CLAUDE_ACCOUNTS, codex: CODEX_ACCOUNTS, claudeUsage: CLAUDE_USAGE, codexUsage: CODEX_USAGE },
  shells,
  log: (line) => console.log(line),
});
const server = createServer({
  view, projects, chosen, folds, threads, runs, codexRuns, pendingSends, renamer, manage, accounts, usage, sessionAgents: agentControl, commands, dashboard,
  sessionHost: () => driver.hostStatus(), guard: guardConfig(PORT), webDir,
  devices: { store: devices, pairing, apks, ota, deviceUrl: DEVICE_URL, devicePort: DEVICE_PORT, pushServer: () => fcm !== null },
  desktop: new DesktopBuilds(desktopDir),
  attachments: new AttachmentStore({ root: ATTACHMENTS_DIR }),
  transcriptRoots: CLAUDE_ACCOUNTS.map((a) => path.join(a.dir, "projects")),
  version,
  rewind: sessionRewind,
  fork: sessionFork,
  shells,
  accountSettings,
  // Every session the scan lists, not only the chosen ones (DESIGN.md 6u).
  search: new SessionSearch({ claudeAccounts: CLAUDE_ACCOUNTS, codexAccounts: CODEX_ACCOUNTS, session: (key) => index.get(key) }),
});
broadcast = (msg) => server.broadcast(msg);
let hostUp = false;
driver.onHostStatus((status) => {
  broadcast({ type: "sessionHost", status });
  // A host connection that came back: the runs are adopted again, but their messages in between are lost.
  const up = status.state !== "down";
  if (up && !hostUp && started) {
    void reconcilePending(pendingSends, reconcileDeps, ["claude"])
      .then(() => settleClaudeFromTranscripts(claudeKeysWaiting()))
      .catch((err) => console.error("pending sends: reconcile failed", err));
  }
  hostUp = up;
});
server.listen(PORT, HOST, () => {
  console.log(`maru ${version ?? "(version unknown)"} listening on http://${HOST}:${PORT}`);
});
// The device listener checks a device token on every request; the reverse proxy sends it only requests that
// carry one (DESIGN.md 2d). It shares the web listener's Host list (the public name).
const deviceServer = DEVICE_PORT === null ? null : createDeviceServer({
  store: devices, pairing, ota, apks, main: server, log: (line) => console.log(line),
  updateToken: new UpdateToken(UPDATE_TOKEN_FILE),
  hosts: new Set([`127.0.0.1:${DEVICE_PORT}`, `localhost:${DEVICE_PORT}`, ...guardConfig(PORT).hosts, ...DEVICE_HOSTS]
    .filter((h) => !h.endsWith(`:${PORT}`))),
  pushServer: () => fcm !== null,
});
deviceServer?.listen(DEVICE_PORT!, HOST, () => {
  console.log(`maru device listener on http://${HOST}:${DEVICE_PORT}`);
});
const push = fcm && new PushService({
  view, devices, sender: fcm, log: (line) => console.log(line), ...driveHooks(runs, codexRuns),
  onScreen: (id) => deviceServer?.hasOpenWs(id) ?? false,
});
if (push) {
  // session.pending (the questions of the sessions this server runs) reaches the push too.
  const toUis = broadcast;
  broadcast = (msg) => {
    toUis(msg);
    push.serverMessage(msg);
  };
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// The host's runs and their pids first, so the first Claude sweep already marks them "ui"-owned.
// ready() waits for one connect attempt only; a host that is down is retried in the background.
await driver.ready();
// What happened to the waiting messages while this server was away (the runs are adopted by now).
// A host that is not up yet leaves the Claude lists for the reconcile when it connects.
await reconcilePending(pendingSends, reconcileDeps, driver.hostStatus().state === "down" ? ["codex"] : ["claude", "codex"])
  .catch((err) => console.error("pending sends: reconcile failed", err));
// What the transcripts already show of the Claude messages still listed (taken ones whose row is
// far above the end of a long turn).
void settleClaudeFromTranscripts(claudeKeysWaiting()).catch((err) => console.error("pending sends: transcript settle failed", err));
started = true;
const sourcesStarted = sources.map((src) => {
  const t0 = Date.now();
  return src.start((e) => index.apply(e)).then(
    () => console.log(`${src.provider}: started in ${Date.now() - t0}ms`),
    (err) => console.error(`${src.provider}: failed to start`, err),
  );
});
void Promise.allSettled(sourcesStarted).then(() => forgetGone("all", "start"));

async function shutdown(): Promise<void> {
  idleCloser.stop();
  push?.close();
  dashboard.close();
  // The attached tmux clients end; the shells keep running in their tmux server.
  shells.shutdown();
  server.close();
  deviceServer?.close();
  // Claude runs stay in the session host; only the connection to it closes.
  hostLink.close();
  await codexRuns.closeAll();
  threads.closeAll();
  hub.close();
  await Promise.allSettled(sources.map((s) => s.stop()));
  await codexTerminals.close();
  await usage.stop();
  projects.close();
  chosen.close();
  folds.close();
  choices.close();
  pendingSends.close();
  codexHeld.close();
  rewinds.close();
  devices.close();
  process.exit(0);
}
