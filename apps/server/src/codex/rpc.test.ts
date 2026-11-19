import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDaemon, makeThread, waitFor } from "./fake-daemon.ts";
import { CodexRpc, METHOD_NOT_FOUND, NO_ANSWER, RpcError, RpcTransportError, connect } from "./rpc.ts";
import type { CodexRpcOptions } from "./rpc.ts";

const FAST: CodexRpcOptions = { backoff: { initialMs: 10, maxMs: 40 }, connectTimeoutMs: 2000 };

async function daemon(t: { after: (fn: () => Promise<void>) => void }): Promise<FakeDaemon> {
  const d = FakeDaemon.create();
  await d.listen();
  t.after(() => d.cleanup());
  return d;
}

test("each connection sends initialize, then initialized, then requests", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());

  const res = await rpc.request("thread/loaded/list", {});
  assert.deepEqual(res, { data: [], nextCursor: null });
  assert.deepEqual(d.methodsOf(1), ["initialize", "initialized", "thread/loaded/list"]);
  const init = d.calls("initialize")[0]!;
  assert.deepEqual(init.params, { clientInfo: { name: "maru", title: null, version: "0.0.0" }, capabilities: null });
  assert.equal(d.received[1]!.id, null, "initialized is a notification");
  assert.equal(rpc.initializeResult?.codexHome, d.home);
});

test("experimentalApi declares the capability in initialize; the default sends none", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, { ...FAST, experimentalApi: true });
  t.after(() => rpc.close());
  assert.deepEqual(d.calls("initialize")[0]!.params, {
    clientInfo: { name: "maru", title: null, version: "0.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
});

test("an error answer rejects with RpcError carrying the code", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());

  await assert.rejects(rpc.request("thread/read", { threadId: "nope" }), (err: unknown) => {
    assert.ok(err instanceof RpcError);
    assert.equal(err.code, -32600);
    assert.equal(err.method, "thread/read");
    return true;
  });
  assert.equal(rpc.stats().errorResponses, 1);
});

test("a request past its timeout rejects, and its late answer is counted as stray", async (t) => {
  const d = await daemon(t);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  d.handlers.set("thread/read", async () => {
    await gate;
    return { thread: makeThread("a") };
  });
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());

  await assert.rejects(rpc.request("thread/read", { threadId: "a" }, { timeoutMs: 30 }), (err: unknown) => {
    assert.ok(err instanceof RpcTransportError);
    assert.equal(err.kind, "timeout");
    return true;
  });
  release();
  await waitFor(() => rpc.stats().strayResponses === 1, "stray response");
  assert.equal(rpc.stats().timeouts, 1);
});

test("a server request without a handler gets no answer by default, so the client driving the thread answers", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());
  const reply = d.request("item/commandExecution/requestApproval", { threadId: "a" });
  await waitFor(() => rpc.stats().serverRequestsIgnored === 1, "request seen");
  const raced = await Promise.race([reply.then(() => "answered"), new Promise((r) => setTimeout(() => r("silent"), 150))]);
  assert.equal(raced, "silent");
  assert.equal(rpc.stats().serverRequestsRejected, 0);
});

test("with unhandledRequests reject, a server request without a handler is answered with METHOD_NOT_FOUND", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, { ...FAST, unhandledRequests: "reject" });
  t.after(() => rpc.close());

  const reply = await d.request("item/tool/requestUserInput", { threadId: "a", questions: [] });
  assert.equal(reply.id, "srv-1");
  assert.equal((reply.error as { code: number }).code, METHOD_NOT_FOUND);
  assert.equal(reply.result, undefined);

  rpc.onRequest("item/tool/requestUserInput", (params) => ({ answers: {}, echoed: params.threadId }));
  const answered = await d.request("item/tool/requestUserInput", { threadId: "b", questions: [] });
  assert.deepEqual(answered.result, { answers: {}, echoed: "b" });

  rpc.onRequest("item/fileChange/requestApproval", () => {
    throw new RpcError("item/fileChange/requestApproval", -32000, "declined");
  });
  const failed = await d.request("item/fileChange/requestApproval", {});
  assert.equal((failed.error as { code: number }).code, -32000);

  const s = rpc.stats();
  assert.deepEqual(s.serverRequests, { "item/tool/requestUserInput": 2, "item/fileChange/requestApproval": 1 });
  assert.equal(s.serverRequestsRejected, 1);
});

test("a handler sees the request id, and NO_ANSWER leaves the request unanswered for another client", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());
  const seen: unknown[] = [];
  rpc.onRequest("item/tool/requestUserInput", (params, ctx) => {
    seen.push(ctx.id);
    return params.threadId === "mine" ? { answers: {} } : NO_ANSWER;
  });
  const other = d.serverRequest("item/tool/requestUserInput", { threadId: "theirs", questions: [] });
  const mine = d.serverRequest("item/tool/requestUserInput", { threadId: "mine", questions: [] });
  assert.deepEqual((await mine.reply).result, { answers: {} });
  assert.deepEqual(seen, [other.id, mine.id]);
  assert.deepEqual(d.repliesTo(other.id), []);
  assert.equal(rpc.stats().serverRequestsIgnored, 1);
});

test("notifications reach their handlers and every method is counted", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());

  const names: (string | undefined)[] = [];
  const off = rpc.on("thread/name/updated", (p) => names.push(p.threadName));
  d.notify("thread/name/updated", { threadId: "a", threadName: "one" });
  d.notify("account/updated", {});
  await waitFor(() => (rpc.stats().notifications["account/updated"] ?? 0) === 1, "notifications");
  off();
  d.notify("thread/name/updated", { threadId: "a", threadName: "two" });
  await waitFor(() => rpc.stats().notifications["thread/name/updated"] === 2, "second rename");
  assert.deepEqual(names, ["one"]);
});

test("ping frames are answered with pong", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());
  await d.ping();
});

test("a dropped connection is re-established and initialized again; pending requests reject", async (t) => {
  const d = await daemon(t);
  d.handlers.set("thread/read", () => new Promise(() => {}));
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());
  let connects = 0;
  let disconnects = 0;
  rpc.onConnected(() => connects++);
  rpc.onDisconnected(() => disconnects++);

  const pending = rpc.request("thread/read", { threadId: "a" });
  await waitFor(() => d.calls("thread/read").length === 1, "request sent");
  d.dropConnections();
  await assert.rejects(pending, (err: unknown) => err instanceof RpcTransportError && err.kind === "closed");
  await waitFor(() => connects === 1, "reconnect");
  assert.equal(disconnects, 1);
  // onConnected fires on the initialize answer; the `initialized` notification reaches the
  // daemon a moment later, later still under load.
  await waitFor(() => d.methodsOf(2).length >= 2, "initialized notification");
  assert.deepEqual(d.methodsOf(2).slice(0, 2), ["initialize", "initialized"]);
  assert.equal(rpc.connected, true);
  const s = rpc.stats();
  assert.equal(s.connects, 2);
  assert.equal(s.orphanedRequests, 1);
});

test("without a daemon the first attempt fails; retryNow connects once it appears", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  // A long backoff, so only retryNow can explain a quick connect.
  const rpc = new CodexRpc(d.home, { backoff: { initialMs: 60_000, maxMs: 60_000 } });
  t.after(() => rpc.close());
  const failures: string[] = [];
  rpc.onConnectFailed((reason) => failures.push(reason));

  assert.equal(await rpc.start(), false);
  assert.equal(failures.length, 1);
  await assert.rejects(rpc.request("thread/list", {}), (err: unknown) => err instanceof RpcTransportError && err.kind === "not-connected");

  await d.listen();
  rpc.retryNow();
  await waitFor(() => rpc.connected, "connected after retryNow");
  assert.equal(rpc.stats().failedAttempts, 1);
});

test("failed attempts wait twice as long each time, up to the cap", async (t) => {
  const d = FakeDaemon.create();
  t.after(() => d.cleanup());
  const rpc = new CodexRpc(d.home, { backoff: { initialMs: 10, maxMs: 40 } });
  t.after(() => rpc.close());
  const at: number[] = [];
  rpc.onConnectFailed(() => at.push(performance.now()));
  await rpc.start();
  await waitFor(() => at.length >= 7, "seven failed attempts");
  await rpc.close();

  const gaps = at.slice(1).map((v, i) => v - at[i]!);
  // Expected waits 10, 20, 40, 40, 40, 40 ms. Timers never fire early by more than ~1 ms;
  // load can only make gaps longer, so lower bounds check growth and a loose upper bound the cap
  // (uncapped, the sixth wait would be 320 ms).
  assert.ok(gaps[0]! >= 9, `first wait ${gaps[0]}`);
  assert.ok(gaps[1]! >= 19, `second wait ${gaps[1]}`);
  assert.ok(gaps[2]! >= 39, `third wait ${gaps[2]}`);
  assert.ok(gaps[5]! < 200, `sixth wait ${gaps[5]} is capped`);
});

test("an initialize error fails the attempt", async (t) => {
  const d = await daemon(t);
  d.handlers.set("initialize", () => {
    throw new Error("not ready");
  });
  await assert.rejects(connect(d.home, FAST), /not ready/);
});

test("fail() closes the connection and counts it as a failed attempt", async (t) => {
  const d = await daemon(t);
  const rpc = await connect(d.home, FAST);
  t.after(() => rpc.close());
  const failures: string[] = [];
  rpc.onConnectFailed((reason) => failures.push(reason));

  rpc.fail("snapshot broke");
  await waitFor(() => failures.length === 1 && rpc.connected, "reconnected after fail");
  assert.equal(failures[0], "snapshot broke");
  assert.equal(rpc.stats().failedConnections, 1);
});
