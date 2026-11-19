import { test } from "node:test";
import assert from "node:assert/strict";
import { pairingKeychain } from "./pairingKeychain.ts";
import { PairingStore, type LegacyPairing, type PairingBackend } from "./pairingStore.ts";

const PAIRING = { server: "https://maru.example.com", token: `maru_d_${"A".repeat(43)}`, device: { id: "d1", name: "Mac", kind: "desktop" } };
const TEXT = JSON.stringify(PAIRING);

function memoryBackend(initial: string | null = null): PairingBackend & { text: string | null; writes: number } {
  const b = {
    text: initial,
    writes: 0,
    read: () => b.text,
    write(t: string) {
      b.text = t;
      b.writes++;
    },
    remove() {
      b.text = null;
    },
  };
  return b;
}

function legacy(text: string | null, opts: { broken?: boolean } = {}): LegacyPairing & { present: boolean } {
  const l = {
    present: text !== null || opts.broken === true,
    exists: () => l.present,
    read() {
      if (opts.broken || text === null) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString");
      return text;
    },
    remove() {
      l.present = false;
    },
  };
  return l;
}

test("a saved pairing reads back from the backend and the old file is not touched", () => {
  const b = memoryBackend();
  const old = legacy(null);
  const store = new PairingStore(b, old);
  store.save(PAIRING as never);
  assert.deepEqual(store.load(), { pairing: PAIRING, error: null });
});

test("nothing saved and no old file is no pairing and no error", () => {
  assert.deepEqual(new PairingStore(memoryBackend(), legacy(null)).load(), { pairing: null, error: null });
});

test("an old file moves to the backend once and is deleted", () => {
  const b = memoryBackend();
  const old = legacy(TEXT);
  const store = new PairingStore(b, old);
  assert.deepEqual(store.load(), { pairing: PAIRING, error: null });
  assert.equal(b.text, TEXT);
  assert.equal(old.present, false);
  assert.deepEqual(store.load(), { pairing: PAIRING, error: null });
  assert.equal(b.writes, 1);
});

test("a backend value wins and the old file is left alone", () => {
  const b = memoryBackend(TEXT);
  const old = legacy(JSON.stringify({ ...PAIRING, server: "https://other.example.com" }));
  assert.equal(new PairingStore(b, old).load().pairing?.server, PAIRING.server);
  assert.equal(old.present, true);
});

test("an old file that cannot be decrypted says to connect again and stays", () => {
  const b = memoryBackend();
  const old = legacy(null, { broken: true });
  const r = new PairingStore(b, old).load();
  assert.equal(r.pairing, null);
  assert.match(r.error!, /Could not read the saved connection .*Connect again/);
  assert.equal(b.text, null);
});

test("when the backend cannot take the moved text, this run still uses the pairing and the file stays for the next", () => {
  const b = { ...memoryBackend(), write: () => { throw new Error("denied"); } };
  const old = legacy(TEXT);
  assert.deepEqual(new PairingStore(b, old).load(), { pairing: PAIRING, error: null });
  assert.equal(old.present, true);
});

test("a backend that throws on read, and a value that is not a pairing, are errors with the reconnect hint", () => {
  const throwing = { ...memoryBackend(), read: () => { throw new Error("boom"); } };
  assert.match(new PairingStore(throwing).load().error!, /boom.*Connect again/);
  assert.match(new PairingStore(memoryBackend("{}")).load().error!, /bad pairing/);
});

test("clear removes both the backend value and the old file", () => {
  const b = memoryBackend(TEXT);
  const old = legacy(TEXT);
  new PairingStore(b, old).clear();
  assert.equal(b.text, null);
  assert.equal(old.present, false);
});

test("the Keychain wrapper calls security with fixed arguments, no shell, the value as base64", () => {
  const calls: string[][] = [];
  const kc = pairingKeychain({ service: "svc", account: "me", run: (args) => (calls.push(args), "") });
  kc.write(TEXT);
  assert.deepEqual(calls[0]!.slice(0, 7), ["add-generic-password", "-U", "-s", "svc", "-a", "me", "-w"]);
  assert.equal(Buffer.from(calls[0]![7]!, "base64").toString("utf8"), TEXT);
  assert.equal(calls[0]!.length, 8);
});

test("the Keychain wrapper decodes what security prints and maps exit 44 to not found", () => {
  const encoded = Buffer.from(TEXT).toString("base64");
  assert.equal(pairingKeychain({ run: () => `${encoded}\n` }).read(), TEXT);
  const missing = () => { throw Object.assign(new Error("not found"), { status: 44 }); };
  assert.equal(pairingKeychain({ run: missing }).read(), null);
  assert.doesNotThrow(() => pairingKeychain({ run: missing }).remove());
  const other = () => { throw Object.assign(new Error("denied"), { status: 51 }); };
  assert.throws(() => pairingKeychain({ run: other }).read(), /exit 51/);
  assert.throws(() => pairingKeychain({ run: other }).write("x"), /exit 51/);
  assert.throws(() => pairingKeychain({ run: other }).remove(), /exit 51/);
});

test("a Keychain error message never carries the token", () => {
  const fail = () => { throw Object.assign(new Error(`Command failed: security add-generic-password -w ${PAIRING.token}`), { status: 1 }); };
  try {
    pairingKeychain({ run: fail }).write(TEXT);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!String((e as Error).message).includes("maru_d_"));
  }
});
