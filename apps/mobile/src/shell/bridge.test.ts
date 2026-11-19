import { test } from "node:test";
import assert from "node:assert/strict";
import { base64Encode, injection, OutputBatcher, parsePageMessage } from "./bridge.ts";

test("base64Encode equals Buffer's for every length 0 to 70 over random bytes", () => {
  for (let n = 0; n <= 70; n++) {
    const bytes = new Uint8Array(n).map(() => Math.floor(Math.random() * 256));
    assert.equal(base64Encode(bytes), Buffer.from(bytes).toString("base64"), `length ${n}`);
  }
  // Every byte value once, and the padding forms.
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(base64Encode(all), Buffer.from(all).toString("base64"));
  assert.equal(base64Encode(new TextEncoder().encode("a")), "YQ==");
  assert.equal(base64Encode(new TextEncoder().encode("ab")), "YWI=");
  assert.equal(base64Encode(new TextEncoder().encode("abc")), "YWJj");
});

test("a page message is read only in its exact shapes", () => {
  assert.deepEqual(parsePageMessage('{"t":"ready","cols":80,"rows":24}'), { t: "ready", cols: 80, rows: 24 });
  assert.deepEqual(parsePageMessage('{"t":"resize","cols":42,"rows":35}'), { t: "resize", cols: 42, rows: 35 });
  assert.deepEqual(parsePageMessage('{"t":"in","d":"ls\\r"}'), { t: "in", d: "ls\r" });
  assert.deepEqual(parsePageMessage('{"t":"bin","d":"\\u0000\\u00ff"}'), { t: "bin", d: "\0ÿ" });
  assert.deepEqual(parsePageMessage('{"t":"mode","appCursor":true}'), { t: "mode", appCursor: true });
  assert.deepEqual(parsePageMessage('{"t":"error","message":"boom"}'), { t: "error", message: "boom" });
  // A grid that is not positive whole numbers, wrong field types, unknown kinds and non-objects are refused.
  for (const bad of [
    '{"t":"ready","cols":0,"rows":24}',
    '{"t":"ready","cols":80.5,"rows":24}',
    '{"t":"resize","cols":"80","rows":24}',
    '{"t":"resize","cols":80}',
    '{"t":"in","d":5}',
    '{"t":"mode","appCursor":"yes"}',
    '{"t":"error"}',
    '{"t":"other"}',
    '{"cols":80,"rows":24}',
    "[]",
    "null",
    '"ready"',
    "not json",
    "",
  ]) {
    assert.equal(parsePageMessage(bad), null, bad);
  }
});

test("injection is a script that calls the page's receiver and ends in true", () => {
  const js = injection({ t: "out", b: "aGk=" });
  assert.equal(js, 'window.maru&&window.maru.recv({"t":"out","b":"aGk="});true;');
  // The text of a paste travels as a JSON string, quotes and line breaks included.
  const paste = injection({ t: "paste", text: 'say "hi"\n</script>' });
  assert.ok(paste.includes(String.raw`"text":"say \"hi\"\n</script>"`));
  const run = new Function("window", `${paste}`) as (w: unknown) => unknown;
  let got: unknown = null;
  run({ maru: { recv: (m: unknown) => (got = m) } });
  assert.deepEqual(got, { t: "paste", text: 'say "hi"\n</script>' });
});

function batcherRig(windowMs = 16) {
  const sent: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const batcher = new OutputBatcher({
    send: (b) => sent.push(b),
    windowMs,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
  });
  const fire = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
  return { batcher, sent, timers, fire };
}

test("output within one frame goes as one message, in order, with every byte", () => {
  const { batcher, sent, timers, fire } = batcherRig();
  const parts = ["he", "llo ", "wor", "ld"].map((s) => new TextEncoder().encode(s));
  for (const p of parts) batcher.push(p);
  assert.equal(timers.length, 1, "one timer per frame");
  assert.equal(timers[0]!.ms, 16);
  assert.deepEqual(sent, []);
  fire();
  assert.deepEqual(sent, [Buffer.from("hello world").toString("base64")]);
  // The next output starts a new frame.
  batcher.push(new TextEncoder().encode("!"));
  fire();
  assert.deepEqual(sent, [Buffer.from("hello world").toString("base64"), Buffer.from("!").toString("base64")]);
});

test("a large amount is sent whole (nothing is cut)", () => {
  const { batcher, sent, fire } = batcherRig();
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  for (let i = 0; i < 5; i++) batcher.push(chunk);
  fire();
  assert.equal(sent.length, 1);
  assert.equal(Buffer.from(sent[0]!, "base64").length, 5 * 1024 * 1024);
});

test("flush sends now, clear drops what waits, and an empty chunk is nothing", () => {
  const { batcher, sent, timers, fire } = batcherRig();
  batcher.push(new Uint8Array(0));
  assert.equal(timers.length, 0);
  batcher.push(new TextEncoder().encode("a"));
  batcher.flush();
  assert.deepEqual(sent, ["YQ=="]);
  assert.equal(timers.filter((t) => t.live).length, 0, "the timer is cancelled by the flush");
  batcher.push(new TextEncoder().encode("stale"));
  batcher.clear();
  fire();
  assert.deepEqual(sent, ["YQ=="], "cleared output is never sent");
  batcher.flush();
  assert.deepEqual(sent, ["YQ=="], "nothing waiting sends nothing");
});
