import { test } from "node:test";
import assert from "node:assert/strict";
import { pairingLink } from "../../../../packages/shared/src/devices.ts";
import { parsePairingLink, parseServer, reviewPairing, type PairingTarget } from "./pairingLink.ts";

const code = `maru_p_${"A".repeat(43)}`;

/**
 * Runs `fn` with URL and URLSearchParams replaced by stubs that throw. These tests run on Node's
 * WHATWG URL, but the phone runs React Native's regex polyfill, which reads hosts differently; the
 * parser must not depend on either, and this proves it does not touch them.
 */
function withoutUrl<T>(fn: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { URL: g.URL, URLSearchParams: g.URLSearchParams };
  const refuse = function () {
    throw new Error("the pairing parser must not use URL or URLSearchParams");
  };
  g.URL = refuse;
  g.URLSearchParams = refuse;
  try {
    return fn();
  } finally {
    g.URL = saved.URL;
    g.URLSearchParams = saved.URLSearchParams;
  }
}

const parse = (text: string) => withoutUrl(() => parsePairingLink(text));

test("reads back the link the web makes", () => {
  assert.deepEqual(parse(pairingLink("https://maru.example.com", code)), { server: "https://maru.example.com", code });
  assert.deepEqual(parse(`  ${pairingLink("http://127.0.0.1:8052", code)}\n`), { server: "http://127.0.0.1:8052", code });
  assert.deepEqual(parse(pairingLink("https://maru.example.com/", code)), { server: "https://maru.example.com", code });
  assert.deepEqual(parse(pairingLink("HTTPS://Maru.Example.COM:443", code)), { server: "https://maru.example.com", code });
  assert.deepEqual(parse(pairingLink("https://maru.example.com:8443", code)), { server: "https://maru.example.com:8443", code });
  assert.deepEqual(parse(pairingLink("http://localhost:8052", code)), { server: "http://localhost:8052", code });
});

test("refuses other text, bad codes and plain HTTP off the phone", () => {
  for (const text of [
    "https://maru.example.com",
    pairingLink("https://maru.example.com", "maru_p_short"),
    pairingLink("https://maru.example.com", `maru_d_${"A".repeat(43)}`),
    pairingLink("http://maru.example.com", code),
    pairingLink("http://10.0.2.2:8052", code),
    pairingLink("not a url", code),
    `maru://pair?code=${code}`,
    `maru://pair?server=%E0%A4%A&code=${code}`,
  ]) {
    assert.ok("error" in parse(text), text);
  }
});

test("refuses a server with user info, backslashes, escapes, spaces or a path (host spoofing)", () => {
  for (const server of [
    // Shown as maru.example.com by React Native's URL, sent to evil.com by OkHttp (review, 2026-11-16).
    "https://u@evil.com\\@maru.example.com",
    "https://a@b@maru.example.com",
    "https://evil.com\\maru.example.com",
    "https://evil.com@maru.example.com",
    "https://maru.example.com@evil.com",
    "https://maru.example.com%2F@evil.com",
    "https://maru.example.com /",
    "https://maru.example.com/api",
    "https://maru.example.com?x=1",
    "https://maru.example.com#x",
    "https://maru.example.com:0",
    "https://maru.example.com:65536",
    "https://-maru.example.com",
    "https://maru..example.com",
    "https://maru_example.com",
    "https://[::1]",
    "ftp://maru.example.com",
    "//maru.example.com",
  ]) {
    assert.ok("error" in parse(pairingLink(server, code)), server);
    assert.equal(withoutUrl(() => parseServer(server)), null, server);
  }
});

test("the confirmation names the link's host and what the claim replaces", () => {
  const review = (target: PairingTarget, current: string | null) => withoutUrl(() => reviewPairing(target, current));
  const target = parse(pairingLink("https://maru.example.com", code)) as PairingTarget;
  assert.deepEqual(review(target, null), {
    host: "maru.example.com",
    origin: "https://maru.example.com",
    loopback: false,
    replaces: "none",
    currentHost: null,
  });
  assert.equal(review(target, "https://maru.example.com").replaces, "same-server");
  // A look-alike host is another server: the user sees both hosts before anything is sent.
  const lookAlike = parse(pairingLink("https://maru.example.com.example.com", code)) as PairingTarget;
  const r = review(lookAlike, "https://maru.example.com");
  assert.deepEqual({ host: r.host, replaces: r.replaces }, { host: "maru.example.com.example.com", replaces: "other-server" });
  const local = parse(pairingLink("http://127.0.0.1:8052", code)) as PairingTarget;
  assert.equal(review(local, "https://maru.example.com").loopback, true);
  assert.equal(review(local, "https://maru.example.com").currentHost, "maru.example.com");
});
