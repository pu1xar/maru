// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc.
// Sources: routes/_chat.settings.tsx (SettingsContentLayout: section nav beside the content, a
// header with the breadcrumb; no close button here, the sidebar picks a session back and Escape closes), components/settings/SettingsSidebarNav.tsx
// (grouped section nav that turns into an icon rail on narrow screens) and
// components/settings/SettingsBreadcrumb.tsx, and the close button with Escape of
// components/AppRouteModal.tsx. Local change: the screen takes the conversation's place next to the
// session sidebar instead of opening as a route modal, so the section nav turns into its icon rail
// below xl (T3: md), where the session sidebar already takes 16rem; its tab lives in the address
// (lib/settingsRoute.ts), and the pages are maru's: usage and session management on one page (the
// rate-limit windows of every account over the session table, after an earlier dashboard's MANAGE
// tab), display and devices (phone pairing and the Android app), each a SettingsPageContainer of
// SettingsSections (settingsLayout.tsx).
import type { SessionSummary } from "@maru/shared";
import { ListIcon, MonitorIcon, SmartphoneIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useEffect } from "react";

import { closeSettings, openSettings, type MainRoute, type SettingsTab } from "~/lib/settingsRoute";
import { PAGE_VERSION } from "~/lib/pageVersion";
import { desktopBridge } from "~/lib/desktopBridge";
import { useServerVersion } from "~/lib/serverVersion";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { PageHeader } from "../PageHeader";
import { AccountsPanel } from "./AccountsPanel";
import { DevicesPanel } from "./DevicesPanel";
import { DisplayPanel } from "./DisplayPanel";
import { SettingsPageContainer } from "./settingsLayout";
import { ManageSection } from "./manage/ManagePanel";

/** Open popups that close on Escape themselves (components/ui). */
const ESCAPE_TAKERS = ["dialog", "sheet", "popover", "menu", "select"].map((p) => `[data-slot=${p}-popup][data-open]`).join(", ");

interface NavItem {
  tab: SettingsTab;
  label: string;
  icon: LucideIcon;
}

/** The menu in order, the dashboard's tabs first. A new page is an entry here and a case in SettingsContent. */
const NAV: readonly NavItem[] = [
  { tab: "sessions", label: "Sessions", icon: ListIcon },
  { tab: "accounts", label: "Accounts", icon: UsersIcon },
  { tab: "display", label: "Appearance", icon: MonitorIcon },
  { tab: "devices", label: "Devices", icon: SmartphoneIcon },
];

export function SettingsView(props: {
  route: MainRoute;
  /** The list's sessions as /ws keeps them. */
  listed: SessionSummary[];
  now: number;
  onOpenSession: (session: SessionSummary) => void;
  onRekey: (from: string, to: string, familyIds?: readonly string[]) => void;
}) {
  const { route } = props;
  const nav = NAV.find((i) => i.tab === route.tab) ?? null;
  const { isMobile, setOpenMobile } = useSidebar();
  // On phones the session list is a sheet; the settings screen shows once it is out of the way.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the phone's sidebar sheet when the settings screen opens
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  // Escape closes the screen (T3's route modal), unless it is for something else: a key a field or
  // an open popup takes (its own close, a search box clearing, a rename cancelling). Heard in the
  // capture phase, before a popup's own handler closes it (a tooltip's swallows the key), so the
  // check sees what is open when the key was pressed. The check names the popups that take Escape
  // and asks for the open ones: a toast and the phone sidebar's kept-mounted sheet carry
  // role=dialog while nothing is open, and a tooltip is no reason to keep the screen.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a window key listener for as long as the screen shows
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      if (document.querySelector(ESCAPE_TAKERS)) return;
      closeSettings();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <PageHeader>
        <WorkspaceBreadcrumb ariaLabel="Settings location" className="flex-1">
          <WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbText>Settings</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
          {nav ? (
            <>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <h1 className="min-w-0">
                  <WorkspaceBreadcrumbText>{nav.label}</WorkspaceBreadcrumbText>
                </h1>
              </WorkspaceBreadcrumbItem>
            </>
          ) : null}
        </WorkspaceBreadcrumb>
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <SettingsNav active={route.tab} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SettingsContent {...props} />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsContent(props: Parameters<typeof SettingsView>[0]) {
  const { route, listed, now } = props;
  switch (route.tab) {
    case "sessions":
      // Usage on top, the session table under it. The table is keyed by the focus so a link to
      // another session's subagents starts from its own view.
      return (
        <SettingsPageContainer width="expanded">
          <ManageSection key={route.focus ?? ""} listed={listed} now={now} focus={route.focus} onOpenSession={props.onOpenSession} onRekey={props.onRekey} />
        </SettingsPageContainer>
      );
    case "accounts":
      return <AccountsPanel />;
    case "display":
      return <DisplayPanel />;
    case "devices":
      return <DevicesPanel />;
  }
}

/** T3's SettingsSidebarNav: the pages as menu rows, an icon rail below xl. */
function SettingsNav({ active }: { active: SettingsTab }) {
  // Below xl the nav is an icon rail; its labels then show as tooltips.
  const narrow = useMediaQuery("max-xl");
  return (
    <nav
      aria-label="Settings menu"
      className="flex w-56 shrink-0 flex-col overflow-y-auto border-e border-border bg-sidebar p-2 text-sidebar-foreground max-xl:w-14"
    >
      <SidebarMenu>
        {NAV.map((item) => {
          const isActive = item.tab === active;
          return (
            <SidebarMenuItem key={item.tab}>
              <Tooltip disabled={!narrow}>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton aria-current={isActive ? "page" : undefined} isActive={isActive} onClick={() => openSettings(item.tab)} />
                  }
                >
                  <item.icon />
                  <span className="truncate max-xl:sr-only">{item.label}</span>
                </TooltipTrigger>
                <TooltipPopup side="right">{item.label}</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
      <VersionLabel />
    </nav>
  );
}

/**
 * The page's maru version (DESIGN.md 2c) at the foot of the menu, and the server's when it runs
 * another one (the sidebar's VersionNotice then offers the reload). The icon rail drops "maru".
 */
function VersionLabel() {
  const server = useServerVersion()?.version ?? null;
  const other = server && server !== PAGE_VERSION ? server : null;
  // The desktop app's own version (DESIGN.md 2e): the shell, apart from the page it shows.
  const shell = desktopBridge()?.version ?? null;
  return (
    <div
      title={`This page maru ${PAGE_VERSION ?? "-"}${other ? `, server ${other}` : ""}`}
      className="mt-auto flex flex-col gap-0.5 px-2 pt-3 pb-1 text-2xs leading-4 break-all text-muted-foreground tabular-nums select-text max-xl:px-0 max-xl:text-center">
      <span>
        <span className="max-xl:hidden">maru </span>
        {PAGE_VERSION ?? "-"}
      </span>
      {other ? (
        <span>
          <span className="max-xl:hidden">Server </span>
          {other}
        </span>
      ) : null}
      {shell ? (
        <span>
          <span className="max-xl:hidden">App </span>
          {shell}
        </span>
      ) : null}
    </div>
  );
}
