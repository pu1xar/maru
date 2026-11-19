// The dashboard's 사용량 card (DESIGN.md 6j): every account's 5h and 7d windows with how much is
// used and when each resets (the live snapshot, lib/usage.ts), and how one window length moved
// over the last 7 days (lib/dashboardUsage.ts). FREE accounts stay hidden, as in the sidebar foot.
import type { AccountUsage, UsageWindow } from "@maru/shared";
import { useMemo, useState } from "react";

import { WINDOW_MINUTES, chartSeries, seriesSlots, shownAccounts, windowOf, type ChartWindow } from "~/lib/dashboardModel";
import { useUsageHistory } from "~/lib/dashboardUsage";
import { useUsage } from "~/lib/usage";
import { USAGE_STATUS_TEXT, resetIn, windowBarClass } from "~/lib/usageFormat";
import { cn } from "~/lib/utils";
import { shortAccount } from "~/model";
import { SettingsSection } from "../settings/settingsLayout";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { ProviderMark, QuietRow } from "./parts";
import { UsageTrendChart, seriesColor } from "./UsageTrendChart";

const SPAN_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_KEY = "maru_dashboard_usage_window";

function readWindow(): ChartWindow {
  try {
    return window.localStorage.getItem(WINDOW_KEY) === "5h" ? "5h" : "7d";
  } catch {
    return "7d";
  }
}

export function UsageSection(props: { now: number; className?: string }) {
  const usage = useUsage();
  const { history, error } = useUsageHistory();
  const [win, setWin] = useState<ChartWindow>(readWindow);
  const changeWin = (next: ChartWindow) => {
    setWin(next);
    try {
      window.localStorage.setItem(WINDOW_KEY, next);
    } catch {
      // Storage blocked: the choice holds for this page only.
    }
  };
  const accounts = shownAccounts(usage);
  const slots = seriesSlots(usage);
  const from = props.now - SPAN_MS;
  const series = useMemo(() => chartSeries(history, usage, win, from, props.now), [history, usage, win, from, props.now]);

  return (
    <SettingsSection
      title="Usage"
      className={props.className}
      data-dashboard-card="usage"
      headerAction={
        <ToggleGroup
          aria-label="Window for the trend"
          value={[win]}
          onValueChange={(value: unknown[]) => {
            const next = value[0];
            if (next === "7d" || next === "5h") changeWin(next);
          }}
        >
          <ToggleGroupItem value="7d" aria-label="7d window trend">
            7d
          </ToggleGroupItem>
          <ToggleGroupItem value="5h" aria-label="5h window trend">
            5h
          </ToggleGroupItem>
        </ToggleGroup>
      }
    >
      {usage === null ? (
        <QuietRow loading>Loading</QuietRow>
      ) : accounts.length === 0 ? (
        <QuietRow>No accounts to show</QuietRow>
      ) : (
        <div className="@container/usage px-3 py-3 sm:px-4">
          <ul aria-label="Usage by account" className="flex flex-col divide-y divide-border/50">
            {accounts.map((a) => (
              <AccountLine key={`${a.provider}:${a.account}`} account={a} slot={slots.get(a.account) ?? 0} now={props.now} />
            ))}
          </ul>
        </div>
      )}
      <div className="px-3 pt-3 pb-2 sm:px-4" data-usage-trend="">
        {series.length ? (
          <>
            <ul aria-label="Legend" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {series.map((s) => (
                <li key={s.account} className="flex items-center gap-1.5">
                  <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: seriesColor(s.slot) }} />
                  <ProviderMark provider={s.provider} className="size-3" />
                  <span className="text-muted-foreground">{shortAccount(s.account)}</span>
                </li>
              ))}
            </ul>
            <UsageTrendChart series={series} from={from} to={props.now} label={`Usage by account, ${win} window, last 7 days`} />
          </>
        ) : history === null && !error ? (
          <QuietRow loading>Loading trend</QuietRow>
        ) : (
          <QuietRow>{error ? `Could not load the trend: ${error}` : "No data yet"}</QuietRow>
        )}
      </div>
    </SettingsSection>
  );
}

function AccountLine({ account: a, slot, now }: { account: AccountUsage; slot: number; now: number }) {
  const windows = [windowOf(a, WINDOW_MINUTES["5h"]), windowOf(a, WINDOW_MINUTES["7d"])];
  const none = windows.every((w) => w === null || w.usedPercent === null);
  const note = none ? (a.error ?? USAGE_STATUS_TEXT[a.status] ?? null) : a.stale ? "Data older than 6 hours" : null;
  return (
    <li
      className="grid grid-cols-1 gap-x-6 gap-y-1.5 py-2 first:pt-0 last:pb-0 @min-[36rem]/usage:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)] @min-[36rem]/usage:items-center"
      data-usage-account={a.account}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm" title={a.email ?? a.account}>
        <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(slot) }} />
        <ProviderMark provider={a.provider} />
        <span className={cn("min-w-0 truncate", a.active ? "text-foreground" : "text-muted-foreground")}>{shortAccount(a.account)}</span>
      </span>
      {none ? (
        <span className="text-xs text-muted-foreground @min-[36rem]/usage:col-span-2">{note}</span>
      ) : (
        windows.map((w, i) => <WindowGauge key={i} label={i === 0 ? "5h" : "7d"} window={w} stale={a.stale} now={now} />)
      )}
    </li>
  );
}

function WindowGauge(props: { label: string; window: UsageWindow | null; stale: boolean; now: number }) {
  const w = props.window;
  if (!w || w.usedPercent === null) {
    return (
      <span className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-2 text-xs text-muted-foreground">
        <span>{props.label}</span>
        <span>-</span>
      </span>
    );
  }
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  return (
    <span className={cn("grid grid-cols-[1.5rem_minmax(0,1fr)_2.5rem_2.5rem] items-center gap-x-2 text-xs", props.stale && "opacity-60")}>
      <span className="text-muted-foreground">{props.label}</span>
      <span className="relative h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/10">
        <span className={cn("absolute inset-y-0 left-0 rounded-full", windowBarClass(w, pct))} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-right text-foreground tabular-nums">{Math.round(w.usedPercent)}%</span>
      <span className="truncate text-right text-muted-foreground tabular-nums" title={w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : undefined}>
        {props.stale ? "" : resetIn(w.resetsAt, props.now)}
      </span>
    </span>
  );
}
