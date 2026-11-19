// The Codex model list (GET /api/session-models) kept per account, so the composer's model button
// can say "GPT-6-Astra" (the daemon's displayName) before the picker is ever opened. The daemon's
// list belongs to the account, so one request serves every session of that account on the page.
// The button asks once per account when the first Codex composer shows; each picker open reads
// the list again (useSessionPicker) and stores the fresher answer here. Claude's list needs a
// listing CLI when its session is not running, so the Claude button reads no list.
import type { ModelOption, SessionModelsResponse } from "@maru/shared";
import { useEffect, useSyncExternalStore } from "react";

type Listener = () => void;

const byAccount = new Map<string, readonly ModelOption[]>();
const asked = new Set<string>();
const listeners = new Set<Listener>();

/** `codex:<account>:<id>` -> `codex:<account>`; the list's scope. */
export function accountScope(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}

export function storeModelOptions(key: string, options: readonly ModelOption[]): void {
  byAccount.set(accountScope(key), options);
  for (const l of listeners) l();
}

export function storedModelOptions(key: string): readonly ModelOption[] | null {
  return byAccount.get(accountScope(key)) ?? null;
}

/** Reads the list once per account (a failure is tried again the next time a composer asks). */
export function ensureModelOptions(key: string): void {
  const scope = accountScope(key);
  if (byAccount.has(scope) || asked.has(scope)) return;
  asked.add(scope);
  fetch(`/api/session-models?key=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } })
    .then(async (res) => {
      const body = (await res.json().catch(() => null)) as SessionModelsResponse | null;
      if (!res.ok || !body?.options) throw new Error(`HTTP ${res.status}`);
      storeModelOptions(key, body.options);
    })
    .catch(() => asked.delete(scope));
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The account's Codex model list for a button's label, or null until it is read (and for Claude). */
export function useCodexModelOptions(key: string, provider: string): readonly ModelOption[] | null {
  useEffect(() => {
    if (provider === "codex") ensureModelOptions(key);
  }, [key, provider]);
  return useSyncExternalStore(
    subscribe,
    () => (provider === "codex" ? storedModelOptions(key) : null),
    () => null,
  );
}
