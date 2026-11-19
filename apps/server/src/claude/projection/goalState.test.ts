// The /goal rules (goalState.ts) and the backwards file scan (claude/goalScan.ts). Fixture records
// have the shape of real goal_status attachments (kinds counted over 299 records in 2.1.3xx
// transcripts: sentinel set/clear, unmet, met, failed); every condition and reason here is invented.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { GoalScanner, scanGoalEvents } from "../goalScan.ts";
import { chooseGoal, goalEventOf, lastEventAt, liveGoalOf, reduceGoal, type GoalEvent, type LiveGoal } from "./goalState.ts";

const T0 = Date.UTC(2026, 10, 15, 0, 0, 0);
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

type Att = Record<string, unknown>;
const set = (cond = "all tests pass"): Att => ({ type: "goal_status", met: false, sentinel: true, condition: cond });
const clear = (cond = "all tests pass"): Att => ({ type: "goal_status", met: true, sentinel: true, condition: cond });
const unmet = (reason: string, cond = "all tests pass"): Att => ({ type: "goal_status", met: false, condition: cond, reason });
const met = (cond = "all tests pass"): Att => ({ type: "goal_status", met: true, condition: cond, reason: "done", iterations: 3, durationMs: 1000, tokens: 5 });
const failed = (cond = "all tests pass"): Att => ({ type: "goal_status", met: false, failed: true, condition: cond, reason: "impossible", iterations: 2 });

function events(steps: Array<[number, Att]>): GoalEvent[] {
  return steps.map(([sec, a], i) => goalEventOf(a, at(sec), i * 100)!);
}

describe("reduceGoal: transcript records to a goal", () => {
  test("a set alone is an active goal with no checks", () => {
    const g = reduceGoal(events([[0, set()]]))!;
    assert.equal(g.objective, "all tests pass");
    assert.equal(g.status, "active");
    assert.deepEqual(g.claude, { checks: 0, setAt: T0, lastReason: null });
  });

  test("each unmet adds a check and the newest reason stands", () => {
    const g = reduceGoal(events([[0, set()], [10, unmet("first")], [20, unmet("second")], [30, unmet("third")]]))!;
    assert.deepEqual(g.claude, { checks: 3, setAt: T0, lastReason: "third" });
  });

  test("a met ends the goal", () => {
    assert.equal(reduceGoal(events([[0, set()], [10, unmet("x")], [20, met()]])), null);
  });

  test("a failed ends the goal", () => {
    assert.equal(reduceGoal(events([[0, set()], [10, failed()]])), null);
  });

  test("a clear ends the goal", () => {
    assert.equal(reduceGoal(events([[0, set()], [10, unmet("x")], [20, clear()]])), null);
  });

  test("a goal set again after the end starts from zero", () => {
    const g = reduceGoal(events([[0, set("a")], [10, unmet("x", "a")], [20, met("a")], [30, set("b")]]))!;
    assert.equal(g.objective, "b");
    assert.deepEqual(g.claude, { checks: 0, setAt: T0 + 30_000, lastReason: null });
  });

  test("a new goal set over an active one replaces it", () => {
    const g = reduceGoal(events([[0, set("a")], [10, unmet("x", "a")], [20, set("b")], [30, unmet("y", "b")]]))!;
    assert.equal(g.objective, "b");
    assert.deepEqual(g.claude, { checks: 1, setAt: T0 + 20_000, lastReason: "y" });
  });

  test("an unmet with no set before it (older than what was read) is an active goal with one check", () => {
    const g = reduceGoal(events([[10, unmet("only")]]))!;
    assert.deepEqual(g.claude, { checks: 1, setAt: T0 + 10_000, lastReason: "only" });
  });

  test("an unmet of another condition than the active one is taken as a goal of its own", () => {
    const g = reduceGoal(events([[0, set("a")], [10, unmet("x", "b")]]))!;
    assert.equal(g.objective, "b");
    assert.equal(g.claude!.checks, 1);
  });

  test("no records, no goal", () => {
    assert.equal(reduceGoal([]), null);
  });

  test("a record without a timestamp leaves the set time unknown, an empty reason is none", () => {
    const e = [goalEventOf(set(), null, 0)!, goalEventOf(unmet("  "), null, 1)!];
    const g = reduceGoal(e)!;
    assert.deepEqual(g.claude, { checks: 1, setAt: null, lastReason: null });
    assert.equal(lastEventAt(e), null);
  });

  test("the restore rule of the CLI: the newest record alone decides active or not", () => {
    // eer: the newest goal_status; met or failed gives none, any other gives the goal.
    for (const [att, active] of [[set(), true], [unmet("x"), true], [met(), false], [failed(), false], [clear(), false]] as Array<[Att, boolean]>) {
      assert.equal(reduceGoal(events([[0, att]])) !== null, active, JSON.stringify(att));
    }
  });
});

describe("goalEventOf", () => {
  test("only a goal_status attachment is an event", () => {
    assert.equal(goalEventOf({ type: "date" }, at(0), 0), null);
    assert.equal(goalEventOf(set(), at(0), 7)!.offset, 7);
  });
});

describe("chooseGoal: the transcript's goal against a live process's", () => {
  const fromTranscript = reduceGoal(events([[0, set()], [10, unmet("t")]]));
  const liveAt = (ms: number, value: LiveGoal["value"]): LiveGoal => ({ value, receivedAt: ms });
  const liveValue = { condition: "all tests pass", iterations: 4, setAt: T0, lastReason: "live" };

  test("no live message: the transcript's goal", () => {
    assert.equal(chooseGoal(fromTranscript, T0 + 10_000, undefined), fromTranscript);
  });

  test("a live message newer than the transcript's newest record wins", () => {
    const g = chooseGoal(fromTranscript, T0 + 10_000, liveAt(T0 + 20_000, liveValue))!;
    assert.deepEqual(g.claude, { checks: 4, setAt: T0, lastReason: "live" });
  });

  test("a live clear newer than the transcript's records is no goal", () => {
    assert.equal(chooseGoal(fromTranscript, T0 + 10_000, liveAt(T0 + 20_000, null)), null);
  });

  test("a transcript record newer than the live message takes over again (the live one is stale)", () => {
    assert.equal(chooseGoal(null, T0 + 30_000, liveAt(T0 + 20_000, liveValue)), null);
    assert.equal(chooseGoal(fromTranscript, T0 + 10_000, liveAt(T0 + 10_000, liveValue)), fromTranscript);
  });

  test("a live goal with no transcript record at all shows", () => {
    assert.equal(chooseGoal(null, null, liveAt(T0, liveValue))!.objective, "all tests pass");
  });
});

describe("liveGoalOf: an active_goal message", () => {
  test("a goal, a clear, and things that are not one", () => {
    const v = { condition: "c", iterations: 2, set_at: 5, tokens_at_start: 9, last_reason: "why" };
    assert.deepEqual(liveGoalOf({ type: "active_goal", value: v }, 1), { value: { condition: "c", iterations: 2, setAt: 5, lastReason: "why" }, receivedAt: 1 });
    assert.deepEqual(liveGoalOf({ type: "active_goal", value: null }, 2), { value: null, receivedAt: 2 });
    assert.equal(liveGoalOf({ type: "result" }, 3), null);
    assert.equal(liveGoalOf({ type: "active_goal", value: { condition: 1 } }, 4), null);
  });
});

describe("scanGoalEvents: the whole file read backwards", () => {
  function withFile(lines: string[], fn: (file: string) => Promise<void>, tail = "\n"): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goalscan-"));
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, lines.join("\n") + tail);
    return fn(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const rec = (att: Att, sec: number) => JSON.stringify({ type: "attachment", attachment: att, timestamp: at(sec), uuid: `u${sec}` });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "user", message: { role: "user", content: `line ${i} ${"x".repeat(200)}` } }));

  test("reads back to the newest set and no further", async () => {
    await withFile([rec(set("old"), 1), rec(met("old"), 2), ...filler(5), rec(set(), 10), ...filler(5), rec(unmet("a"), 20), ...filler(3), rec(unmet("b"), 30), ...filler(2)], async (file) => {
      const scan = await scanGoalEvents(file);
      assert.deepEqual(scan.events.map((e) => e.kind), ["set", "unmet", "unmet"]);
      assert.equal(scan.endOffset, fs.statSync(file).size);
      const g = reduceGoal(scan.events)!;
      assert.deepEqual(g.claude, { checks: 2, setAt: T0 + 10_000, lastReason: "b" });
    });
  });

  test("stops at a met after the newest set: events are the met alone, and no goal", async () => {
    await withFile([rec(set(), 1), rec(unmet("a"), 2), rec(met(), 3), ...filler(4)], async (file) => {
      const scan = await scanGoalEvents(file);
      assert.deepEqual(scan.events.map((e) => e.kind), ["met"]);
      assert.equal(reduceGoal(scan.events), null);
    });
  });

  test("offsets are the byte offsets of the lines, also past a chunk boundary", async () => {
    // 3 MB of lines, so the scan crosses 1 MB chunks, with multibyte text in the lines
    const big = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ type: "user", message: { role: "user", content: `${"한".repeat(300)} ${i}` } }));
    await withFile([rec(set(), 1), ...big, rec(unmet("late"), 50), ...big.slice(0, 10)], async (file) => {
      const scan = await scanGoalEvents(file);
      assert.deepEqual(scan.events.map((e) => e.kind), ["set", "unmet"]);
      const buf = fs.readFileSync(file);
      for (const e of scan.events) {
        const lineEnd = buf.indexOf(10, e.offset);
        const parsed = JSON.parse(buf.subarray(e.offset, lineEnd).toString("utf8"));
        assert.equal(parsed.attachment.type, "goal_status");
        assert.equal(Date.parse(parsed.timestamp), e.at);
      }
    });
  });

  test("a file with no goal_status line gives no events; an unfinished last line is left out and endOffset stops before it", async () => {
    await withFile(filler(20), async (file) => {
      assert.deepEqual((await scanGoalEvents(file)).events, []);
    });
    const done = [rec(set(), 1), rec(unmet("a"), 2)];
    const partial = rec(unmet("b"), 3).slice(0, 40);
    await withFile(done, async (file) => {
      const scan = await scanGoalEvents(file);
      assert.deepEqual(scan.events.map((e) => e.kind), ["set", "unmet"]);
      assert.equal(scan.endOffset, Buffer.byteLength(done.join("\n") + "\n"));
    }, `\n${partial}`);
  });

  test("an empty file", async () => {
    await withFile([], async (file) => {
      const scan = await scanGoalEvents(file);
      assert.deepEqual(scan, { events: [], endOffset: 0 });
    }, "");
  });

  test("a line that only mentions goal_status in text is not an event", async () => {
    await withFile([JSON.stringify({ type: "user", message: { role: "user", content: 'the "goal_status" attachment' } }), rec(set(), 1)], async (file) => {
      assert.deepEqual((await scanGoalEvents(file)).events.map((e) => e.kind), ["set"]);
    });
  });
});

describe("GoalScanner: a remembered scan reads only what was appended", () => {
  const rec = (att: Att, sec: number) => JSON.stringify({ type: "attachment", attachment: att, timestamp: at(sec), uuid: `u${sec}` }) + "\n";
  const filler = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "user", message: { role: "user", content: `l${i} ${"x".repeat(300)}` } }) + "\n").join("");

  async function inDir(fn: (file: string) => Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goalmemo-"));
    try {
      await fn(path.join(dir, "s.jsonl"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const same = async (file: string, got: unknown) => assert.deepEqual(got, await scanGoalEvents(file));

  test("the second scan reads the appended part (and a small seal), and joins to the same result as a full scan", async () => {
    await inDir(async (file) => {
      fs.writeFileSync(file, filler(3000) + rec(set(), 1) + filler(50) + rec(unmet("a"), 2));
      const sc = new GoalScanner();
      const first = { bytes: 0 };
      await sc.scan(file, first);
      assert.ok(first.bytes >= fs.statSync(file).size, "the first scan reads the file");
      const size1 = fs.statSync(file).size;

      fs.appendFileSync(file, filler(5) + rec(unmet("b"), 3) + filler(5));
      const second = { bytes: 0 };
      const got = await sc.scan(file, second);
      const appended = fs.statSync(file).size - size1;
      assert.ok(second.bytes <= appended + 2 * 4096 * 2, `read ${second.bytes} bytes for ${appended} appended`);
      assert.ok(second.bytes < size1 / 10);
      await same(file, got);
      assert.deepEqual(got.events.map((e) => e.kind), ["set", "unmet", "unmet"]);

      // nothing appended: only the seal is read
      const third = { bytes: 0 };
      await same(file, await sc.scan(file, third));
      assert.ok(third.bytes <= 2 * 4096 * 2);
    });
  });

  test("a boundary in the appended part starts the events there; no boundary appends to the remembered ones", async () => {
    await inDir(async (file) => {
      fs.writeFileSync(file, rec(set(), 1) + rec(unmet("a"), 2) + filler(10));
      const sc = new GoalScanner();
      await sc.scan(file);
      fs.appendFileSync(file, rec(met(), 3) + rec(set("b"), 4) + rec(unmet("c", "b"), 5));
      let got = await sc.scan(file);
      assert.deepEqual(got.events.map((e) => e.kind), ["set", "unmet"]);
      assert.equal(reduceGoal(got.events)!.objective, "b");
      await same(file, got);
      fs.appendFileSync(file, rec(clear("b"), 6));
      got = await sc.scan(file);
      assert.deepEqual(got.events.map((e) => e.kind), ["clear"]);
      await same(file, got);
    });
  });

  test("an unfinished last line waits: it is read once complete and counted once", async () => {
    await inDir(async (file) => {
      fs.writeFileSync(file, rec(set(), 1));
      const sc = new GoalScanner();
      await sc.scan(file);
      const line = rec(unmet("late"), 2);
      fs.appendFileSync(file, line.slice(0, 30));
      const half = await sc.scan(file);
      assert.deepEqual(half.events.map((e) => e.kind), ["set"]);
      fs.appendFileSync(file, line.slice(30));
      const got = await sc.scan(file);
      assert.deepEqual(got.events.map((e) => e.kind), ["set", "unmet"]);
      await same(file, got);
    });
  });

  test("a file that shrank, was replaced, or was rewritten in place is read from the start again", async () => {
    await inDir(async (file) => {
      const sc = new GoalScanner();
      fs.writeFileSync(file, filler(200) + rec(set("old"), 1) + filler(20));
      await sc.scan(file);

      // shorter (a rewind that cut the file): the remembered end is past the end
      fs.writeFileSync(file, filler(5) + rec(set("new"), 2));
      const io1 = { bytes: 0 };
      const a = await sc.scan(file, io1);
      assert.ok(io1.bytes >= fs.statSync(file).size);
      assert.equal(reduceGoal(a.events)!.objective, "new");
      await same(file, a);

      // same length class but rewritten in place (every line changed, as a rehome does), and longer
      fs.writeFileSync(file, filler(5).replaceAll("user", "usr2") + filler(20) + rec(set("third"), 3));
      const io2 = { bytes: 0 };
      const b = await sc.scan(file, io2);
      assert.ok(io2.bytes >= fs.statSync(file).size, "rewritten bytes make the seal differ, so the whole file is read");
      assert.equal(reduceGoal(b.events)!.objective, "third");
      await same(file, b);

      // replaced by another file (new inode) that is longer
      const other = file + ".new";
      fs.writeFileSync(other, filler(400) + rec(set("fourth"), 4));
      fs.renameSync(other, file);
      const io3 = { bytes: 0 };
      const c = await sc.scan(file, io3);
      assert.ok(io3.bytes >= fs.statSync(file).size);
      assert.equal(reduceGoal(c.events)!.objective, "fourth");
      await same(file, c);
    });
  });

  test("files are remembered apart", async () => {
    await inDir(async (file) => {
      const other = file + ".2";
      fs.writeFileSync(file, rec(set("a"), 1));
      fs.writeFileSync(other, rec(set("b"), 1));
      const sc = new GoalScanner();
      await sc.scan(file);
      await sc.scan(other);
      fs.appendFileSync(other, rec(unmet("x", "b"), 2));
      assert.equal(reduceGoal((await sc.scan(file)).events)!.objective, "a");
      assert.equal(reduceGoal((await sc.scan(other)).events)!.claude!.checks, 1);
    });
  });
});
