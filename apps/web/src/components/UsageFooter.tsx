// Account usage at the foot of the session sidebar (DESIGN.md 6a): one line per account with a
// bar per window, no numbers (user request). An account with a 5h window gets two thin bars, 5h
// in grey on top and 7d below in a color that tells how close the limit is; others get the 7d bar
// alone. The hover card is one short line per window, "5h 77% (2.1h)": used percent and the time
// left until the reset. FREE accounts stay hidden, as an earlier dashboard hid them. Each line is an
// image to assistive tech and to the keyboard, with its summary as the label (T3
// usage/UsageLimits.tsx bars).
import type { AccountUsage, UsageWindow } from "@maru/shared";
import { useUsage } from "~/lib/usage";
import {
  USAGE_STATUS_TEXT as STATUS_TEXT,
  barClass,
  fiveHourWindow,
  footerWindows,
  shortAccount,
  usageSummary,
  weeklyWindow,
  windowLine,
} from "~/lib/usageFormat";
import { cn } from "~/lib/utils";
import { ClaudeAI, OpenAI } from "./Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function UsageFooter({ className }: { className?: string }) {
  const usage = useUsage();
  if (!usage) return null;
  const shown = usage.accounts.filter((a) => !a.free);
  if (shown.length === 0) return null;
  const now = Date.now();
  return (
    <div role="group" aria-label="Account usage" className={cn("flex flex-col gap-0.5", className)}>
      {shown.map((a) => (
        <Tooltip key={`${a.provider}:${a.account}`}>
          <TooltipTrigger
            render={
              <div
                role="img"
                tabIndex={0}
                aria-label={usageSummary(a, now)}
                className="grid h-5 min-w-0 grid-cols-[0.75rem_minmax(0,3.5rem)_minmax(0,1fr)] items-center gap-x-1.5 rounded-md px-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            {a.provider === "claude" ? (
              <ClaudeAI aria-hidden className="size-3 shrink-0" />
            ) : (
              <OpenAI aria-hidden className="size-3 shrink-0 text-foreground" />
            )}
            <span className={cn("min-w-0 truncate", a.active ? "text-foreground" : "text-muted-foreground")}>
              {shortAccount(a)}
            </span>
            <WindowBars account={a} />
          </TooltipTrigger>
          <TooltipPopup side="right" align="end" className="max-w-72">
            <div className="flex flex-col gap-0.5 py-0.5 text-xs tabular-nums">
              {footerWindows(a.windows).map((w) => (
                <div key={w.id}>{windowLine(w, now, a.stale)}</div>
              ))}
              {footerWindows(a.windows).length === 0 || a.status !== "ok" ? (
                <div className="text-muted-foreground">{a.error ?? (STATUS_TEXT[a.status] || "No data")}</div>
              ) : null}
              {a.stale ? <div className="text-muted-foreground">Data older than 6 hours</div> : null}
            </div>
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

function WindowBars({ account: a }: { account: AccountUsage }) {
  const five = fiveHourWindow(a.windows);
  const week = weeklyWindow(a.windows);
  if (!five) return <Bar window={week} account={a} />;
  if (week === five) return <Bar window={five} account={a} grey />;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <Bar window={five} account={a} grey />
      <Bar window={week} account={a} />
    </span>
  );
}

function Bar({ window: w, account: a, grey = false }: { window: UsageWindow | null; account: AccountUsage; grey?: boolean }) {
  const height = "h-[3px]";
  if (!w || w.usedPercent === null) {
    // No reading: an empty track, amber when the account needs attention (token, login, error).
    const attention = !grey && (a.status === "expired" || a.status === "auth_missing" || a.status === "error");
    return <span className={cn(height, "min-w-0 rounded-full", attention ? "bg-warning/40" : "bg-foreground/10")} />;
  }
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  return (
    <span className={cn("relative min-w-0 overflow-hidden rounded-full bg-foreground/10", height, a.stale && "opacity-50")}>
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full", grey ? "bg-muted-foreground" : barClass(pct))}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
