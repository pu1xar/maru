import { test } from "node:test";
import assert from "node:assert/strict";
import { APK_LINK_TTL_MS, ApkLinks, apkLinkToken } from "./apkLinks.ts";

test("a link redeems once, to the file it was issued for", () => {
  const links = new ApkLinks();
  const t = links.issue("dev-1", "a.apk");
  assert.equal(t.length, 43);
  assert.deepEqual(links.redeem(t), { file: "a.apk", deviceId: "dev-1" });
  assert.equal(links.redeem(t), null);
});

test("a link is redeemable until its TTL and not after, and an expired attempt spends it", () => {
  let now = 0;
  const links = new ApkLinks({ now: () => now });
  assert.equal(links.ttlMs, APK_LINK_TTL_MS);
  assert.equal(APK_LINK_TTL_MS, 120_000);
  const edge = links.issue("d", "a.apk");
  now = APK_LINK_TTL_MS - 1;
  assert.notEqual(links.redeem(edge), null);
  const dead = links.issue("d", "a.apk");
  now += APK_LINK_TTL_MS;
  assert.equal(links.redeem(dead), null);
  assert.equal(links.redeem(dead), null);
});

test("unknown and malformed tokens redeem nothing; dropDevice kills only that device's links", () => {
  const links = new ApkLinks();
  const a = links.issue("a", "a.apk");
  const b = links.issue("b", "a.apk");
  for (const bad of ["", "x", "A".repeat(43), `${a}x`, a.slice(1), "../".repeat(15)]) assert.equal(links.redeem(bad), null, bad);
  links.dropDevice("a");
  assert.equal(links.redeem(a), null);
  assert.notEqual(links.redeem(b), null);
});

test("apkLinkToken reads only the /dl/apk/ prefix", () => {
  assert.equal(apkLinkToken("/dl/apk/abc"), "abc");
  assert.equal(apkLinkToken("/dl/apk/"), "");
  assert.equal(apkLinkToken("/dl/apk"), null);
  assert.equal(apkLinkToken("/api/dl/apk/abc"), null);
});
