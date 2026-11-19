// The server's clock as the page sees it. The `hello` message carries the server's time at
// connect; the difference to this page's clock at that moment is kept, so a time the server
// recorded (a transcript timestamp) can be compared with "now" even when the two clocks differ.
// The error is the one-way delay of the hello (milliseconds on a LAN, a few hundred through a remote tunnel).

let offsetMs = 0;

/** Remembers the offset from a hello's `serverTime`; a hello without one keeps the previous offset. */
export function noteServerTime(serverTime: number | undefined, clientNow: number = Date.now()): void {
  if (typeof serverTime === "number" && Number.isFinite(serverTime)) offsetMs = serverTime - clientNow;
}

/** Now on the server's clock (epoch ms). */
export function serverNow(clientNow: number = Date.now()): number {
  return clientNow + offsetMs;
}

/** Tests: back to equal clocks. */
export function resetServerClock(): void {
  offsetMs = 0;
}
