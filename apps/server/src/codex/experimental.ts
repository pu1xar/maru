// The daemon requests this server calls that `codex app-server generate-ts` leaves out of ./protocol
// (it writes only the stable surface; `--experimental` adds these, among 167 other files). A
// connection may send them only after declaring the `experimentalApi` capability in `initialize`
// (rpc.ts `experimentalApi`); without it the daemon answers -32600 "<method> requires
// experimentalApi capability" (measured 2026-11-16, codex-cli 0.169.0).
//
// The shapes are the generated ones (`generate-ts --experimental`, codex-cli 0.169.0), with
// bigint written as number because the wire is JSON.

/** One terminal a thread's command left running (`thread/backgroundTerminals/list`). */
export interface ThreadBackgroundTerminal {
  itemId: string;
  /** The daemon's id for the terminal, what `terminate` takes. */
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
}

export interface ThreadBackgroundTerminalsListParams {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
}

export interface ThreadBackgroundTerminalsListResponse {
  data: ThreadBackgroundTerminal[];
  nextCursor: string | null;
}

export interface ThreadBackgroundTerminalsTerminateParams {
  threadId: string;
  processId: string;
}

export interface ThreadBackgroundTerminalsTerminateResponse {
  terminated: boolean;
}

export interface ExperimentalRequests {
  "thread/backgroundTerminals/list": { params: ThreadBackgroundTerminalsListParams; result: ThreadBackgroundTerminalsListResponse };
  "thread/backgroundTerminals/terminate": { params: ThreadBackgroundTerminalsTerminateParams; result: ThreadBackgroundTerminalsTerminateResponse };
}
