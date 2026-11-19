// `node scripts/host-drain.ts [--force | --status [--json] | --cancel] [--socket <path>]`: restarts
// the Claude session host without cutting off Claude work (DESIGN.md 2b). Non-interactive, for
// people and for scripts/release.sh.
//   (no flag)  the host takes no new runs and waits until no run has a turn, a pending question or
//              permission ask, or a live background task; then it closes its runs and exits. The
//              host stays down (pm2 stop_exit_codes 0) until release.sh or a person starts it.
//   --force    the same, but every run is closed now (running turns are interrupted)
//   --status   prints the host (pid, entry realpath, release root, fingerprint) and its runs, then
//              quits; --json prints the host.status snapshot as one JSON line instead
//   --cancel   ends a drain that has not started closing runs
//   --socket   another host's socket (default: ~/.config/maru/session-host.sock)
// Output while draining: one line per change, `<time> +<seconds>s <what>`, one line per run the
// host waits for. There is no time limit; stopping this command with Ctrl-C leaves the drain
// running in the host (--cancel ends it).
// Exit 0: the host process has exited (also when no host was listening: nothing to drain), or
// --status and --cancel answered. Exit 1: the host could not be asked (permission, protocol).
import { HOST_SOCKET } from "./dataPaths.ts";
import { openHostClient } from "./client.ts";
import { describeWait, type HostInfo, type Snapshot } from "./protocol.ts";
import { connectSocket } from "./socket.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const si = args.indexOf("--socket");
const socketPath = si >= 0 && args[si + 1] ? args[si + 1]! : HOST_SOCKET;
const mode = flag("status") ? "status" : flag("cancel") ? "cancel" : flag("force") ? "force" : "drain";

const t0 = Date.now();
const line = (text: string) => console.log(`${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - t0) / 1000)}s ${text}`);

let last = "";
function show(host: HostInfo): void {
  const d = host.drain;
  const lines = !d
    ? ["not draining"]
    : d.closing
      ? [`nothing left to wait for: closing the runs${d.force ? " (forced)" : ""}, then the host exits`]
      : d.waiting.length === 0
        ? ["nothing runs"]
        : d.waiting.map((w) => `waiting: ${describeWait(w)}`);
  const text = lines.join("\n");
  if (text === last) return;
  last = text;
  for (const l of lines) line(l);
}

function printStatus(s: Snapshot): void {
  const h = s.host;
  console.log(`host pid ${h.pid}, up since ${new Date(h.startedAt).toISOString()}, protocol ${h.protocol}`);
  console.log(`entry ${h.entry ?? "?"}`);
  console.log(`root ${h.root ?? "?"}`);
  console.log(`fingerprint ${h.fingerprint ?? "?"}`);
  console.log(`drain ${h.drain ? (h.drain.closing ? "closing" : `waiting for ${h.drain.waiting.length} run(s)`) : "no"}`);
  console.log(`runs ${s.runs.length}`);
  for (const r of s.runs) {
    const cbs = s.callbacks.filter((c) => c.runId === r.runId).map((c) => (c.name === "canUseTool" ? `canUseTool(${String(c.args[0])})` : c.name));
    const tasks = r.tasks.map((t) => `${t.type ?? "task"}${t.ambient ? " (ambient)" : ""}: ${t.description}`);
    console.log(`  session ${r.sessionId ?? "?"} (${r.cwd ?? "?"}): ${r.busy ? "turn running" : "idle"}${r.closing ? ", closing" : ""}`
      + `${cbs.length ? `, waiting callbacks: ${cbs.join(", ")}` : ""}${tasks.length ? `, tasks: ${tasks.join("; ")}` : ""}`);
  }
}

let sock;
try {
  sock = await connectSocket(socketPath);
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  const text = err instanceof Error ? err.message : String(err);
  if ((code === "ENOENT" || code === "ECONNREFUSED") && (mode === "drain" || mode === "force")) {
    line(`no session host listens on ${socketPath} (${code}): nothing to drain`);
    process.exit(0);
  }
  console.error(`cannot reach the session host on ${socketPath}: ${text}`);
  process.exit(1);
}

/** Resolves once process `pid` is gone (signal 0 fails with ESRCH). */
async function gone(pid: number): Promise<void> {
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

let answered = false;
let drainedPid = 0;
const client = openHostClient(sock, {
  onEvent(e) {
    if (e.ev === "host.state" && mode !== "status") show(e.host);
  },
  onClose() {
    if (answered && (mode === "status" || mode === "cancel")) process.exit(0);
    if (mode === "drain" || mode === "force") {
      // The host closes every connection right before it exits: wait for the process itself.
      void gone(drainedPid).then(() => {
        line(`host pid ${drainedPid} exited`);
        process.exit(0);
      });
      return;
    }
    console.error("the session host closed the connection");
    process.exit(1);
  },
});

const snap = await client.request<Snapshot>({ op: "hello", client: `drain-${mode}`, watch: false });
drainedPid = snap.host.pid;
if (mode === "status") {
  if (flag("json")) console.log(JSON.stringify(snap));
  else printStatus(snap);
  answered = true;
  client.close();
} else if (mode === "cancel") {
  show(await client.request<HostInfo>({ op: "host.drainCancel" }));
  answered = true;
  client.close();
} else {
  line(`${mode === "force" ? "force-closing" : "draining"} host pid ${snap.host.pid} (${snap.runs.length} run(s)), root ${snap.host.root ?? "?"}`);
  show(await client.request<HostInfo>({ op: "host.drain", force: mode === "force" }));
}
