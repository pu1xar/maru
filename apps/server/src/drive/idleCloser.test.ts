import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionSummary, UnifiedStatus } from "@maru/shared";
import { IdleCloser } from "./idleCloser.ts";

const K = "claude:acct:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MIN = 60_000;

function rig() {
  let now = 0;
  const state = { status: "open-idle" as UnifiedStatus, background: 0, pending: 0, viewed: false, agents: 0, agentsThrow: false, live: [K] };
  const closed: string[] = [];
  const closer = new IdleCloser({
    runs: {
      liveKeys: () => state.live,
      pendingOf: () => Array.from({ length: state.pending }),
      close: async (key) => {
        closed.push(key);
        state.live = state.live.filter((k) => k !== key);
      },
    },
    index: { get: () => ({ status: state.status, backgroundTasks: state.background }) as SessionSummary },
    isViewed: () => state.viewed,
    runningAgents: () => {
      if (state.agentsThrow) throw new Error("unreadable");
      return state.agents;
    },
    idleMs: 30 * MIN,
    now: () => now,
  });
  return { closer, state, closed, at: (m: number) => (now = m * MIN) };
}

test("an idle, unwatched run closes 30 minutes after it was last needed", async () => {
  const r = rig();
  r.at(0);
  assert.deepEqual(await r.closer.sweep(), [], "first sight starts the clock");
  r.at(29);
  assert.deepEqual(await r.closer.sweep(), []);
  r.at(30);
  assert.deepEqual(await r.closer.sweep(), [K]);
  assert.deepEqual(r.closed, [K]);
});

test("running, waiting, background tasks, a question, a viewer or a running subagent each keep the process and restart the clock", async () => {
  for (const hold of ["running", "waiting-input", "background", "question", "viewed", "agents", "agentsThrow"] as const) {
    const r = rig();
    r.at(0);
    await r.closer.sweep();
    r.at(40);
    if (hold === "running" || hold === "waiting-input") r.state.status = hold;
    else if (hold === "background") r.state.background = 1;
    else if (hold === "question") r.state.pending = 1;
    else if (hold === "viewed") r.state.viewed = true;
    else if (hold === "agents") r.state.agents = 2;
    else r.state.agentsThrow = true;
    assert.deepEqual(await r.closer.sweep(), [], `${hold} keeps it`);
    // Released: the 30 minutes count from the last sweep that needed it.
    r.state.status = "open-idle";
    r.state.background = 0;
    r.state.pending = 0;
    r.state.viewed = false;
    r.state.agents = 0;
    r.state.agentsThrow = false;
    r.at(69);
    assert.deepEqual(await r.closer.sweep(), [], `${hold}: 29 minutes after release`);
    r.at(70);
    assert.deepEqual(await r.closer.sweep(), [K], `${hold}: 30 minutes after release`);
  }
});

test("a run that ended on its own is forgotten", async () => {
  const r = rig();
  r.at(0);
  await r.closer.sweep();
  r.state.live = [];
  r.at(31);
  assert.deepEqual(await r.closer.sweep(), []);
  r.state.live = [K];
  r.at(32);
  assert.deepEqual(await r.closer.sweep(), [], "a new run gets the full idle time");
});
