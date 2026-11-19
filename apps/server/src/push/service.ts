// Pushes to the Android app (DESIGN.md 2d, 푸시 알림): the list's events and what the drivers report
// go through the policy (policy.ts); each notice goes to the devices that should get it.
import type { IndexEvent, PendingQuestionView, ServerMessage } from "@maru/shared";
import type { ThreadStatus } from "../codex/protocol/v2/ThreadStatus.ts";
import type { Turn } from "../codex/protocol/v2/Turn.ts";
import { tokenHint, type DeviceStore, type PushTarget } from "../devices/store.ts";
import { fcmMessage, fitsFcm, FCM_PAYLOAD_LIMIT, type FcmMessage, type SendResult } from "./fcm.ts";
import { claudeExitOutcome, claudeOutcome, codexOutcome, codexStatus } from "./outcome.ts";
import { PushPolicy, type PolicyContext, type PushNotice } from "./policy.ts";

export interface PushSender {
  send(message: FcmMessage): Promise<SendResult>;
}

type Unsubscribe = () => void;
type ClaudeExit = { code: "done" | "error" | "interrupted"; error?: string };

/** What the push needs from the two drivers (ClaudeRuns, CodexRuns). */
export interface DriveHooks {
  /** The session's open questions this server holds. */
  pending: (key: string) => readonly PendingQuestionView[];
  /** policy.ts PolicyContext.drives. */
  drives: (key: string) => boolean;
  /** policy.ts PolicyContext.statusFromDriver. */
  statusFromDriver: (key: string) => boolean;
  /** ClaudeRuns.onResult. */
  claudeResults: (l: (key: string, result: Record<string, unknown>) => void) => Unsubscribe;
  /** ClaudeRuns.onRunExit. */
  claudeExits: (l: (key: string, info: ClaudeExit) => void) => Unsubscribe;
  /** CodexRuns.onTurnEnd. */
  codexTurns: (l: (key: string, turn: Turn) => void) => Unsubscribe;
  /** CodexRuns.onThreadStatus. */
  codexStatuses: (l: (key: string, status: ThreadStatus) => void) => Unsubscribe;
}

interface ClaudeRunsPart {
  pendingOf(key: string): PendingQuestionView[];
  isDriven(key: string): boolean;
  onResult(l: (key: string, result: Record<string, unknown>) => void): Unsubscribe;
  onRunExit(l: (key: string, info: ClaudeExit) => void): Unsubscribe;
}

interface CodexRunsPart {
  pendingOf(key: string): PendingQuestionView[];
  isDriven(key: string): boolean;
  onTurnEnd(l: (key: string, turn: Turn) => void): Unsubscribe;
  onThreadStatus(l: (key: string, status: ThreadStatus) => void): Unsubscribe;
}

/** The hooks main.ts passes: the two drivers, each for the sessions it runs. */
export function driveHooks(claude: ClaudeRunsPart, codex: CodexRunsPart): DriveHooks {
  return {
    pending: (key) => [...claude.pendingOf(key), ...codex.pendingOf(key)],
    drives: (key) => claude.isDriven(key) || codex.isDriven(key),
    statusFromDriver: (key) => codex.isDriven(key),
    claudeResults: (l) => claude.onResult(l),
    claudeExits: (l) => claude.onRunExit(l),
    codexTurns: (l) => codex.onTurnEnd(l),
    codexStatuses: (l) => codex.onThreadStatus(l),
  };
}

export interface PushServiceDeps extends DriveHooks {
  /** The list (VisibleIndex). */
  view: { subscribe(l: (e: IndexEvent) => void): Unsubscribe };
  devices: Pick<DeviceStore, "pushTargets" | "dropPushToken">;
  /** The device has the app on screen (DeviceServer.hasOpenWs). */
  onScreen: (deviceId: string) => boolean;
  sender: PushSender;
  log?: (line: string) => void;
}

/**
 * The devices a notice goes to: those with an FCM token whose app is not on screen. An app on
 * screen shows the change itself over its /ws.
 */
export function recipients(targets: readonly PushTarget[], onScreen: (deviceId: string) => boolean): PushTarget[] {
  return targets.filter((t) => !onScreen(t.deviceId));
}

export class PushService {
  private deps: PushServiceDeps;
  private policy: PushPolicy;
  private ctx: PolicyContext;
  private unsubscribes: Unsubscribe[] = [];
  private sending = new Set<Promise<void>>();

  constructor(deps: PushServiceDeps) {
    this.deps = deps;
    this.policy = new PushPolicy((key, why) => this.log(`push: no notice for ${key}: ${why}`));
    this.ctx = { pending: deps.pending, drives: deps.drives, statusFromDriver: deps.statusFromDriver };
    this.unsubscribes.push(
      deps.view.subscribe((e) => this.guard(() => this.policy.observe(e, this.ctx))),
      deps.claudeResults((key, r) => this.guard(() => this.policy.turnEnded(key, claudeOutcome(r), this.ctx))),
      deps.claudeExits((key, info) => this.guard(() => {
        const o = claudeExitOutcome(info);
        return o ? this.policy.turnEnded(key, o, this.ctx) : [];
      })),
      deps.codexTurns((key, turn) => this.guard(() => {
        const o = codexOutcome(turn);
        return o ? this.policy.turnEnded(key, o, this.ctx) : [];
      })),
      deps.codexStatuses((key, status) => this.guard(() => {
        const s = codexStatus(status);
        return s ? this.policy.driverStatus(key, s, this.ctx) : [];
      })),
    );
  }

  /** Every message the server sends its UIs; `session.pending` carries the questions of the sessions it runs. */
  serverMessage(msg: ServerMessage): void {
    if (msg.type === "session.pending") this.guard(() => this.policy.pendingChanged(msg.key, msg.questions));
  }

  close(): void {
    for (const u of this.unsubscribes.splice(0)) u();
  }

  /** Resolves once the sends started so far have their answers. */
  async settled(): Promise<void> {
    while (this.sending.size) await Promise.allSettled([...this.sending]);
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  /** The index, the drivers and the broadcast call in here: nothing thrown may reach them. */
  private guard(decide: () => PushNotice[]): void {
    try {
      this.deliver(decide());
    } catch (err) {
      this.log(`push: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  private deliver(notices: PushNotice[]): void {
    for (const n of notices) {
      const to = recipients(this.deps.devices.pushTargets(), this.deps.onScreen);
      if (!to.length) continue;
      const brief = fitsFcm(n) ? "" : `, brief form (over FCM's ${FCM_PAYLOAD_LIMIT} bytes)`;
      this.log(`push: ${n.kind} ${n.sessionKey} to ${to.length} device(s)${brief}`);
      for (const t of to) {
        // sendOne answers every failure itself; this catch is for a log line that threw.
        const p = this.sendOne(n, t)
          .catch((err: unknown) => this.log(`push: ${n.kind} ${n.sessionKey} to device ${t.deviceId}: ${String(err)}`))
          .finally(() => this.sending.delete(p));
        this.sending.add(p);
      }
    }
  }

  private async sendOne(n: PushNotice, t: PushTarget): Promise<void> {
    let r: SendResult;
    try {
      r = await this.deps.sender.send(fcmMessage(n, t.token));
    } catch (err) {
      r = { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), tokenGone: false };
    }
    if (r.ok) return;
    if (r.tokenGone) {
      let dropped: boolean;
      try {
        dropped = this.deps.devices.dropPushToken(t.token);
      } catch (err) {
        this.log(`push: could not drop token ${tokenHint(t.token)} of device ${t.deviceId} (${r.error}): ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (dropped) {
        this.log(`push: dropped token ${tokenHint(t.token)} of device ${t.deviceId} (${r.error})`);
        return;
      }
    }
    this.log(`push: ${n.kind} ${n.sessionKey} to device ${t.deviceId} failed (${r.error})`);
  }
}
