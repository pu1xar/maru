// A model id as a short label for a row (user request 2026-11-16): `claude-sonnet-4-8` reads
// "sonnet 4.8", `claude-opus-5-5[1m]` "opus 5.5 1M", `claude-3-5-haiku-20241022` "haiku 3.5".
// Ids that are not Claude's (gpt-6-luna) stay as they are.

import { isOneMillionModel, oneMillionModelOf, oneMillionWindow, type ThreadProjectionState, type ThreadTokenUsageSnapshot } from "@maru/shared";

const FAMILY_FIRST = /^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const VERSION_FIRST = /^(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku|fable)(?:-\d{8})?$/;

export function shortModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  let id = model.trim();
  const oneM = /\[1m\]$/i.test(id);
  id = id.replace(/\[1m\]$/i, "").replace(/^claude-/, "");
  const suffix = oneM ? " 1M" : "";
  let m = FAMILY_FIRST.exec(id);
  if (m) return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}${suffix}`;
  m = VERSION_FIRST.exec(id);
  if (m) return `${m[3]} ${m[1]}${m[2] ? `.${m[2]}` : ""}${suffix}`;
  return `${id}${suffix}`;
}

const CLAUDE_FAMILY = /^(opus|sonnet|haiku|fable)\b/;

/**
 * The composer's model button text (user request 2026-11-16, as T3's trigger): the same short
 * label with a Claude family capitalized, `claude-opus-5-5` reads "Opus 5.5". Other ids
 * (gpt-6-astra) stay as they are.
 */
export function composerModelLabel(model: string | null | undefined): string | null {
  const short = shortModelLabel(model);
  if (!short) return null;
  return CLAUDE_FAMILY.test(short) ? short.charAt(0).toUpperCase() + short.slice(1) : short;
}

/**
 * The model the session runs on as the thread knows it: chosen here (or reported by the process,
 * which writes `[1m]`), else the latest response's. A transcript names a model without `[1m]`, so
 * `state.oneMillion` (the latest request's 1M beta) puts it back for a model that has both windows.
 */
export function currentModel(state: ThreadProjectionState | null | undefined): string | null {
  const chosen = state?.chosen?.model;
  if (chosen) return chosen;
  const model = state?.model ?? null;
  return model !== null && state?.oneMillion === true && oneMillionModelOf(model) !== null ? `${model.replace(/\[1m\]$/i, "")}[1m]` : model;
}

const CLAUDE_MODEL_ID = /^claude-[a-z0-9.-]+(\[1m\])?$/i;

/**
 * The model the terminal footer names: a full Claude id chosen here or reported by the process
 * (`claude-opus-4-6[1m]`), else the transcript's model with its `[1m]` put back. An alias or
 * "default" chosen in the picker is not a model name, so the transcript's model stands.
 */
export function footerModel(state: ThreadProjectionState | null | undefined): string | null {
  const chosen = state?.chosen?.model;
  if (chosen && CLAUDE_MODEL_ID.test(chosen)) return chosen;
  return currentModel(state?.chosen?.model ? { ...state, chosen: null } : state);
}

/**
 * The context window the footer divides by. The snapshot's own value comes from the latest request
 * (server `claudeContextWindow`), which still names the old window right after a model change;
 * a model of the 1M table takes its window from the model as shown now (`[1m]` or not). Without
 * a `[1m]` and without a request record (`state.oneMillion` absent) the server's value stands: it
 * reads a context over 200K as the 1M run, which the table cannot.
 */
export function contextWindowOf(state: ThreadProjectionState | null | undefined, usage: ThreadTokenUsageSnapshot | null | undefined): number | undefined {
  const model = footerModel(state);
  const known = isOneMillionModel(model) || state?.oneMillion !== undefined;
  return (known ? oneMillionWindow(model) : null) ?? usage?.maxTokens ?? undefined;
}
