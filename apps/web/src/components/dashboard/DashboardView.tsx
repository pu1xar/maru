// The dashboard (DESIGN.md 6j, `?view=dashboard`): what needs the user, what runs, and how usage
// moves, for every session on the list, in the conversation's place beside the session sidebar
// like the settings screen. Two columns when the main area is wide (needs the user, then what
// runs; usage across both below), one column when it is narrow. Drawn with T3 Code's page header
// and the settings screen's sections (settingsLayout.tsx).
import type { SessionSummary } from "@maru/shared";
import { CircleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { closeDashboard } from "~/lib/dashboardRoute";
import { useDashboardWork } from "~/lib/dashboardWork";
import { openSession } from "~/lib/openSession";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { PageHeader } from "../PageHeader";
import { AttentionSection } from "./AttentionSection";
import { RunningSection } from "./RunningSection";
import { UsageSection } from "./UsageSection";

/** Leaves the dashboard for the session's conversation (the page's selection listens to openSession). */
export function openFromDashboard(key: string): void {
  closeDashboard();
  openSession(key);
}

export function DashboardView(props: {
  /** The list's sessions as /ws keeps them. */
  sessions: readonly SessionSummary[];
  /** Opens a session's conversation; the default leaves the dashboard and selects it. */
  onOpenSession?: (key: string) => void;
  /** The page's clock for times that need no second tick (App's useNow). */
  now?: number;
}) {
  const { work, error } = useDashboardWork();
  const live = useMemo(() => new Map(props.sessions.map((s) => [s.key, s])), [props.sessions]);
  const open = props.onOpenSession ?? openFromDashboard;
  const now = useClock(props.now);
  const { isMobile, setOpenMobile } = useSidebar();
  // On phones the session list is a sheet; the dashboard shows once it is out of the way.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none" data-dashboard="">
      <PageHeader>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">Dashboard</h1>
        {error ? (
          <span role="alert" className="flex min-w-0 items-center gap-1 truncate text-xs text-error-foreground" title={error}>
            <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            {error}
          </span>
        ) : null}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-dashboard-scroll="">
        <div className="@container/dashboard mx-auto w-full max-w-7xl px-5 pt-6 pb-12 sm:px-6">
          <div className="grid grid-cols-1 items-start gap-8 @min-[56rem]/dashboard:grid-cols-2">
            <AttentionSection items={work?.attention ?? null} live={live} now={now} onOpen={open} />
            <RunningSection work={work} onOpen={open} />
            <UsageSection now={now} className="@min-[56rem]/dashboard:col-span-2" />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/** The given clock, or a minute clock of the dashboard's own. */
function useClock(given: number | undefined): number {
  const [own, setOwn] = useState(() => Date.now());
  useEffect(() => {
    if (given !== undefined) return;
    const t = setInterval(() => setOwn(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [given]);
  return given ?? own;
}
