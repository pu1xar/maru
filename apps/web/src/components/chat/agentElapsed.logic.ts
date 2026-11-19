// Elapsed-time text of an agent row (AgentElapsed.tsx).

/** `45s`, `3m 05s`, `1h 02m`: the full form, to the second until an hour, to the minute after. */
export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * `45s`, `24m`, `1h 24m`, `2h`, `1d 6h`, `3d`: the compact form of the 작업 tab's list. Under an
 * hour it counts seconds, then whole minutes; from an hour it is hours and whole minutes (a zero
 * part is left out); from 24 hours it is days and whole hours, as the dashboard's elapsed time
 * is (dashboardModel.ts formatElapsed).
 */
export function formatCompactElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
