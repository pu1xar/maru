// Context window of a Claude model, for ThreadTokenUsageSnapshot.maxTokens (DESIGN.md 6i).
//
// The values are the model catalog of Claude Code 2.1.325 (`context: {window, maximum_window,
// native_1m}` per model; read from the CLI binary's strings on 2026-11-16). The CLI runs a model at
// its window, and at its maximum window when the session uses the 1M context ([1m] model names),
// which every request then carries as a `context-1m-*` beta. The transcript records both: the model
// id of each response, and from 2.1.3xx on each request's model and betas (`api-request` lines).
// A model the CLI adds later is unknown here until this table is updated.

const K200 = 200_000;
const M1 = 1_000_000;

/** [model ids (catalog id and first-party id), window, maximum window] */
const CATALOG: Array<[string[], number, number]> = [
  [["claude-3-5-haiku", "claude-3-5-haiku-20241022"], K200, K200],
  [["claude-haiku-4-5", "claude-haiku-4-5-20251001"], K200, K200],
  [["claude-haiku-5-5"], M1, M1],
  [["claude-3-5-sonnet", "claude-3-5-sonnet-20241022"], K200, M1],
  [["claude-3-7-sonnet", "claude-3-7-sonnet-20250219"], K200, M1],
  [["claude-sonnet-4-0", "claude-sonnet-4-20250514"], K200, M1],
  [["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"], K200, M1],
  [["claude-sonnet-4-6"], K200, M1],
  [["claude-sonnet-5"], M1, M1],
  [["claude-sonnet-5-5"], M1, M1],
  [["claude-opus-4-0", "claude-opus-4-20250514"], K200, K200],
  [["claude-opus-4-1", "claude-opus-4-1-20250805"], K200, K200],
  [["claude-opus-4-5", "claude-opus-4-5-20251101"], K200, K200],
  [["claude-opus-4-6"], K200, M1],
  [["claude-opus-4-7"], M1, M1],
  [["claude-opus-4-8"], M1, M1],
  [["claude-opus-5"], M1, M1],
  [["claude-opus-5-5"], M1, M1],
  [["claude-fable-5"], M1, M1],
  [["claude-fable-5-1"], M1, M1],
  [["claude-fable-5-2"], M1, M1],
  [["claude-mythos-5"], M1, M1],
  [["claude-mythos-5-1"], M1, M1],
  [["claude-mythos-5-2"], M1, M1],
];

const WINDOWS = new Map<string, { window: number; max: number }>();
for (const [ids, window, max] of CATALOG) for (const id of ids) WINDOWS.set(id, { window, max });

const ONE_MILLION_SUFFIX = /\[1m\]$/i;

/** Whether a request's betas ask for the 1M context. */
export function hasOneMillionBeta(betas: unknown): boolean {
  return Array.isArray(betas) && betas.some((b) => typeof b === "string" && b.startsWith("context-1m-"));
}

/**
 * The context window `model` runs at. `oneMillion` is what the request said (its betas), or null
 * when no request record is known; then a context larger than the window (`peakTokens`, the
 * largest request seen) shows the 1M context. Undefined for an unknown model, and for a model
 * whose window depends on the 1M context when neither tells.
 */
export function claudeContextWindow(model: string | null | undefined, oneMillion: boolean | null, peakTokens = 0): number | undefined {
  if (typeof model !== "string" || model.length === 0) return undefined;
  const suffixed = ONE_MILLION_SUFFIX.test(model);
  const id = model.replace(ONE_MILLION_SUFFIX, "").toLowerCase();
  const w = WINDOWS.get(id) ?? WINDOWS.get(id.replace(/-\d{8}$/, ""));
  if (w === undefined) return undefined;
  if (w.window === w.max) return w.window;
  const wide = suffixed ? true : (oneMillion ?? (peakTokens > w.window ? true : null));
  if (wide === null) return undefined;
  return wide ? w.max : w.window;
}
