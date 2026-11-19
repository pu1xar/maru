// The current time, refreshed every `ms` while set.
import { useEffect, useState } from "react";

export function useNow(ms: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
