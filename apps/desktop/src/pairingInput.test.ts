import { test } from "node:test";
import assert from "node:assert/strict";
import { pairingLink } from "@maru/shared";
import { readCode, readPairingInput, readPairingLink, readServer } from "./pairingInput.ts";

const LONG = `maru_p_${"A".repeat(43)}`;

test("a pasted link fills both fields, from either box", () => {
  const link = pairingLink("https://maru.example.com", LONG);
  assert.deepEqual(readPairingLink(link), { server: "https://maru.example.com", code: LONG });
  assert.deepEqual(readPairingInput("", link), { server: "https://maru.example.com", credential: LONG });
  assert.deepEqual(readPairingInput(`  ${link}\n`, "ignored"), { server: "https://maru.example.com", credential: LONG });
  assert.equal(readPairingLink("https://maru.example.com"), null);
});

test("server: https anywhere, http only on this computer's loopback, a bare host gets https", () => {
  assert.deepEqual(readServer("maru.example.com"), { server: "https://maru.example.com" });
  assert.deepEqual(readServer("HTTPS://Maru.Example.com:443/"), { server: "https://maru.example.com" });
  assert.deepEqual(readServer("https://maru.example.com:8443"), { server: "https://maru.example.com:8443" });
  assert.deepEqual(readServer("http://127.0.0.1:18101/"), { server: "http://127.0.0.1:18101" });
  assert.deepEqual(readServer("http://localhost:8025"), { server: "http://localhost:8025" });
  for (const bad of ["", "http://maru.example.com", "ftp://x", "https://user:pw@maru.example.com", "https://", "https://maru.example.com:99999"]) {
    assert.ok("error" in readServer(bad), bad);
  }
});

test("server: what the screen shows is what the app talks to (look-alikes and hidden parts are refused)", () => {
  for (const bad of [
    "https://maru.example.com%2eevil.com",
    "https://evil.com/maru.example.com",
    "https://u@evil.com\\@maru.example.com",
    "https://mаru.example.com", // Cyrillic а
    "https://maru.example.com/some/path?x=1",
    "https://maru.example.com#x",
  ]) {
    assert.ok("error" in readServer(bad), bad);
  }
  assert.ok("error" in readPairingInput(pairingLink("https://maru.example.com%2eevil.com", LONG), ""));
});

test("code: the long code, or the short one however it was typed", () => {
  assert.deepEqual(readCode(LONG), { credential: LONG });
  assert.deepEqual(readCode("abcd-efgh-jkmn"), { credential: "maru_s_ABCDEFGHJKMN" });
  assert.deepEqual(readCode(" ABCD EFGH JKMN "), { credential: "maru_s_ABCDEFGHJKMN" });
  assert.deepEqual(readCode("oooo-llll-iiii"), { credential: "maru_s_000011111111" }, "O reads as 0, I and L as 1");
  for (const bad of ["", "ABCD-EFGH", "ABCD-EFGH-JKMU", "maru_p_short", `${LONG}x`]) {
    assert.ok("error" in readCode(bad), bad);
  }
  assert.deepEqual(readPairingInput("maru.example.com", "ABCD-EFGH-JKMN"), { server: "https://maru.example.com", credential: "maru_s_ABCDEFGHJKMN" });
  assert.ok("error" in readPairingInput("http://maru.example.com", "ABCD-EFGH-JKMN"));
});
