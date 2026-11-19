import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DeviceInfo, DeviceKind, PairDeviceResponse } from "@maru/shared";
import { hashSecret, newSecret, secretKind } from "./secrets.ts";

/** A request's device. */
export interface Authenticated {
  device: DeviceInfo;
}

/** A device the app registered for pushes (PUT /api/device/push). */
export interface PushTarget {
  deviceId: string;
  /** The FCM registration token of the app on that device. */
  token: string;
}

/**
 * Paired devices (DESIGN.md 2d), table `devices` in the client state file. A row holds the
 * SHA-256 hash of the device's token, never the token: the server hands it out once, in the
 * pairing answer. Removing the row ends the token at once; `onRemoved` lets the device listener
 * close that device's open WebSockets.
 *
 * `push_token` is the FCM registration token the app registered, so it goes with the row. One
 * phone has one FCM token, so a token belongs to one row at most: a phone paired again takes its
 * token over from the old row, and gets each push once.
 */
export class DeviceStore {
  private db: DatabaseSync;
  private removedListeners = new Set<(id: string) => void>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(devices)").all().map((c) => String(c.name)));
    // Added with pushes (2026-11-16); rows paired before keep everything and start without a token.
    if (!columns.has("push_token")) this.db.exec("ALTER TABLE devices ADD COLUMN push_token TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS devices_push_token ON devices (push_token)");
    // The device's kind (DESIGN.md 2e) came after the table. Rows from before are phones. An older
    // release reads and writes the table by column name, so it keeps working on the new table.
    if (!columns.has("kind")) this.db.exec("ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'android'");
  }

  close(): void {
    this.db.close();
  }

  onRemoved(fn: (id: string) => void): () => void {
    this.removedListeners.add(fn);
    return () => this.removedListeners.delete(fn);
  }

  /** A new device with a fresh token; the caller passes the token to the device and drops it. */
  create(name: string, now = Date.now(), kind: DeviceKind = "android"): PairDeviceResponse {
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "Unnamed device";
    const device: DeviceInfo = { id: crypto.randomUUID(), name: clean, kind, createdAt: now, lastUsedAt: null };
    const token = newSecret("device");
    this.db
      .prepare("INSERT INTO devices (id, name, kind, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)")
      .run(device.id, device.name, kind, hashSecret(token), now);
    return { device, token };
  }

  /** Newest first. */
  list(): DeviceInfo[] {
    return this.db
      .prepare("SELECT id, name, kind, created_at, last_used_at FROM devices ORDER BY created_at DESC, id")
      .all()
      .map(toInfo);
  }

  get(id: string): DeviceInfo | null {
    const row = this.db.prepare("SELECT id, name, kind, created_at, last_used_at FROM devices WHERE id = ?").get(id);
    return row ? toInfo(row) : null;
  }

  /** The device a device token belongs to; null for any other string. */
  authenticate(secret: string): Authenticated | null {
    if (secretKind(secret) !== "device") return null;
    const row = this.db
      .prepare("SELECT id, name, kind, created_at, last_used_at FROM devices WHERE token_hash = ?")
      .get(hashSecret(secret));
    return row ? { device: toInfo(row) } : null;
  }

  touch(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(now, id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    if (Number(result.changes) === 0) return false;
    for (const fn of this.removedListeners) fn(id);
    return true;
  }

  /** The device's FCM token from now on, taken from any other row that had it. False for an unknown device. */
  setPushToken(id: string, token: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE devices SET push_token = NULL WHERE push_token = ? AND id != ?").run(token, id);
      const result = this.db.prepare("UPDATE devices SET push_token = ? WHERE id = ?").run(token, id);
      this.db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** No more pushes to the device. */
  clearPushToken(id: string): void {
    this.db.prepare("UPDATE devices SET push_token = NULL WHERE id = ?").run(id);
  }

  /** Forgets a token FCM no longer delivers to, on whichever device has it. True when one had it. */
  dropPushToken(token: string): boolean {
    return Number(this.db.prepare("UPDATE devices SET push_token = NULL WHERE push_token = ?").run(token).changes) > 0;
  }

  pushTokenOf(id: string): string | null {
    const row = this.db.prepare("SELECT push_token FROM devices WHERE id = ?").get(id);
    return row && typeof row.push_token === "string" ? row.push_token : null;
  }

  /** Every device with an FCM token, oldest pairing first. */
  pushTargets(): PushTarget[] {
    return this.db
      .prepare("SELECT id, push_token FROM devices WHERE push_token IS NOT NULL ORDER BY created_at, id")
      .all()
      .map((r) => ({ deviceId: String(r.id), token: String(r.push_token) }));
  }
}

/** The first characters of an FCM token, for logs: enough to tell tokens apart, not to use one. */
export function tokenHint(token: string): string {
  return `${token.slice(0, 8)}...`;
}

function toInfo(row: Record<string, unknown>): DeviceInfo {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind === "desktop" ? "desktop" : "android",
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}
