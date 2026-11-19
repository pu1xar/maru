// The 1M-context rows of the Claude model picker (DESIGN.md 6m).
//
// A model whose default window is 200K runs at 1M when its name carries `[1m]` (the CLI then sends
// the `context-1m-2025-08-07` beta). The SDK's supportedModels() has no field for this, so the
// picker adds a "(1M)" row under each model below, as the CLI's own picker does ("Opus 4.6 (1M
// context)"). Models whose window is already 1M (Opus 4.7 and later, Sonnet 5, Haiku 5.5, Fable)
// take no `[1m]` and get no row.
//
// Source of the table: the model catalog inside Claude Code CLI 2.1.325 (the
// `claude-agent-sdk-darwin-arm64/claude` binary of SDK 0.3.321), read from the binary's strings on
// 2026-11-16. Each catalog entry has `context:{window, maximum_window, supports_1m_beta,
// supports_1m_suffix}`. A model is listed here when
//   supports_1m_suffix && supports_1m_beta && maximum_window > window
// The beta flag is part of the rule because the suffix alone is not enough: Haiku 4.5 and Opus 4,
// 4.1, 4.5 have `supports_1m_suffix` with no beta and no maximum_window, and `claude-haiku-4-5[1m]`
// was answered with "API Error: 400 The long context beta is not yet available for this
// subscription" (measured 2026-11-16). Opus 4.6 `[1m]` ran (getContextUsage maxTokens 1000000).
//
// Raising the SDK means reading the catalog again: `oneMillion.test.ts` (apps/server) compares
// ONE_MILLION_SDK_VERSION with the installed SDK and fails until this table is checked.

export const ONE_MILLION_CLI_VERSION = "2.1.325";
export const ONE_MILLION_SDK_VERSION = "0.3.321";

export interface OneMillionModel {
  /** Model ids the catalog and the picker know the model by (first-party id, undated id, alias id). */
  ids: readonly string[];
  /** The catalog's display_name. */
  name: string;
  /** The catalog's context.window (without `[1m]`) and context.maximum_window (with it). */
  window: number;
  maxWindow: number;
}

export const ONE_MILLION_MODELS: readonly OneMillionModel[] = [
  { ids: ["claude-sonnet-4-20250514", "claude-sonnet-4-0"], name: "Sonnet 4", window: 200_000, maxWindow: 1_000_000 },
  { ids: ["claude-sonnet-4-5-20250929"], name: "Sonnet 4.5", window: 200_000, maxWindow: 1_000_000 },
  { ids: ["claude-sonnet-4-6"], name: "Sonnet 4.6", window: 200_000, maxWindow: 1_000_000 },
  { ids: ["claude-opus-4-6"], name: "Opus 4.6", window: 200_000, maxWindow: 1_000_000 },
];

const ONE_M_SUFFIX = /\[1m\]$/i;
const DATE_SUFFIX = /-\d{8}$/;

/** Whether a model value or id names the 1M-context run (`claude-opus-4-6[1m]`). */
export function isOneMillionModel(model: string | null | undefined): boolean {
  return !!model && ONE_M_SUFFIX.test(model);
}

/** The model without a trailing `[1m]`. */
export function withoutOneMillion(model: string): string {
  return model.replace(ONE_M_SUFFIX, "");
}

/** The table's entry for a model id (a date suffix is ignored), or null: the model has no 1M variant. */
export function oneMillionModelOf(model: string | null | undefined): OneMillionModel | null {
  if (!model) return null;
  const id = withoutOneMillion(model).toLowerCase();
  const bare = id.replace(DATE_SUFFIX, "");
  return ONE_MILLION_MODELS.find((m) => m.ids.some((x) => x === id || x.replace(DATE_SUFFIX, "") === bare)) ?? null;
}

/**
 * The context window `model` runs at when it is one of the table's: the maximum window with `[1m]`,
 * else the default window. Null for any other model (its window is not this table's to say).
 */
export function oneMillionWindow(model: string | null | undefined): number | null {
  const entry = oneMillionModelOf(model);
  if (entry === null || !model) return null;
  return isOneMillionModel(model) ? entry.maxWindow : entry.window;
}

/** The option fields the rows need; ModelOption (sessionControls.ts) is this plus more. */
interface RowLike {
  value: string;
  resolved: string | null;
  efforts: string[];
  isDefault: boolean;
  fast?: boolean;
  label: string;
  description: string;
}

/**
 * `options` with a "(1M)" row right under the first row of each model in the table. The row's value
 * is the model's id plus `[1m]` (`claude-opus-4-6[1m]`, as `/model` and setModel take it); it keeps
 * the row's effort levels and fast mode. A row that resolves to a model outside the table (an alias
 * of a model already at 1M) gets none, and a model gets one row even when two rows resolve to it.
 */
export function withOneMillionRows<T extends RowLike>(options: readonly T[]): Array<T & { oneMillion?: true }> {
  const out: Array<T & { oneMillion?: true }> = [];
  const added = new Set<string>();
  for (const o of options) {
    out.push(o);
    const id = o.resolved ?? o.value;
    const entry = oneMillionModelOf(id);
    if (!entry || isOneMillionModel(o.value) || added.has(entry.name)) continue;
    added.add(entry.name);
    out.push({
      ...o,
      value: `${withoutOneMillion(id)}[1m]`,
      label: `${entry.name} (1M)`,
      description: `${entry.name} for long sessions`,
      isDefault: false,
      oneMillion: true,
    });
  }
  return out;
}
